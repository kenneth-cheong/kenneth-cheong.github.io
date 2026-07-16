"""
whatsappBot — WhatsApp Cloud API webhook for MediaOne client support / FAQ.

Answers inbound WhatsApp messages from the existing MongoDB Atlas knowledge base
(reused over HTTP via the `monday` Lambda's search_knowledge_base action — NOT
reimplemented here), using DeepSeek for text and Claude Haiku for images.
Anything account-specific is escalated to a human via Google Chat.

THREE ENTRY POINTS, one function:

  GET  ?hub.mode&hub.verify_token&hub.challenge  -> Meta's verify handshake
  POST (signed with X-Hub-Signature-256)         -> ACK fast, hand off to worker
  async invoke {action:"wa_process", ...}        -> the worker: KB -> LLM -> send

WHY THE WORKER IS A SEPARATE ASYNC INVOKE: Meta wants a prompt 200 on the
webhook or it retries the delivery — which would send the client duplicate
replies and eventually get the subscription throttled. An LLM turn takes
5-60s, so it cannot run on the webhook path. The webhook does signature ->
filter -> claim -> invoke -> 200 and nothing else.

NO CORS, NO OPTIONS BRANCH. Every other Lambda here is called from a browser;
this one is called only by Meta's servers. Wildcard CORS would be noise. Please
don't "fix" it back in.

DEPENDENCIES: none bundled. urllib3, boto3, hmac, hashlib, base64 are all in the
python3.13 runtime. A single-file zip is SAFE here — do NOT apply the
download-unzip-repack recipe from lambdas/socialMediaAudit/DEPLOY.md, which
exists only because that function bundles `requests` at the zip root.

Env vars (see DEPLOY.md):
  WA_VERIFY_TOKEN      — random string we choose; echoed back in the handshake
  WA_APP_SECRET        — Meta app secret; verifies X-Hub-Signature-256
  WA_ACCESS_TOKEN      — Graph send token (System User, expiry NEVER)
  WA_PHONE_NUMBER_ID   — sender id from the WhatsApp API Setup page
  WA_GRAPH_VERSION     — default v23.0
  WA_ALLOWED_WA_IDS    — comma-separated allowlist; EMPTY = allow everyone
  DEEPSEEK_API_KEY     — text replies
  ANTHROPIC_API_KEY    — image replies (vision)
  ANTHROPIC_API_KEY_BACKUP — retried on 429/529
  GCHAT_WEBHOOK_URL    — human escalation channel
  KB_SEARCH_URL        — monday Lambda endpoint
  KB_SCORE_FLOOR       — default 0.6, mirrors monday_lambda.py:86
  WA_PROMPT_TABLE      — staff-editable prompt blocks (default dm-bot-prompts)

DynamoDB tables (region ap-southeast-1):
  wa_dedupe         PK: msg_id (S), TTL ttl  — at-least-once delivery guard, ~24h
  wa_conversations  PK: wa_id  (S), TTL ttl  — rolling chat context, ~30d
  dm-bot-prompts    PK: prompt_id (S), no TTL — the staff-editable half of the
                    system prompt, written from index.html via staffAuth and read
                    here at runtime. See the prompt section below for what is and
                    is not editable, and why. NOT having this table is survivable:
                    every read falls back to the code defaults.

See DEPLOY.md in this folder for the create-infra commands.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import time

import boto3
import urllib3

# ──────────────────────────────────────────────────────────────────────────────
# Config — fail closed. Never `os.environ.get(X) or "<literal-credential>"`.
# ──────────────────────────────────────────────────────────────────────────────
REGION            = os.environ.get('AWS_REGION', 'ap-southeast-1')

WA_VERIFY_TOKEN   = os.environ.get('WA_VERIFY_TOKEN', '')
WA_APP_SECRET     = os.environ.get('WA_APP_SECRET', '')
WA_ACCESS_TOKEN   = os.environ.get('WA_ACCESS_TOKEN', '')
WA_PHONE_NUMBER_ID = os.environ.get('WA_PHONE_NUMBER_ID', '')
WA_GRAPH_VERSION  = os.environ.get('WA_GRAPH_VERSION', 'v23.0')
WA_ALLOWED_WA_IDS = [s.strip() for s in os.environ.get('WA_ALLOWED_WA_IDS', '').split(',') if s.strip()]

DEEPSEEK_API_KEY  = os.environ.get('DEEPSEEK_API_KEY', '')
DEEPSEEK_MODEL    = os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')
ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
ANTHROPIC_API_KEY_BACKUP = os.environ.get('ANTHROPIC_API_KEY_BACKUP', '')
VISION_MODEL      = os.environ.get('VISION_MODEL', 'claude-haiku-4-5')

GCHAT_WEBHOOK_URL = os.environ.get('GCHAT_WEBHOOK_URL', '')
KB_SEARCH_URL     = os.environ.get('KB_SEARCH_URL', 'https://1rxrp7gth2.execute-api.ap-southeast-1.amazonaws.com/monday')
KB_SCORE_FLOOR    = float(os.environ.get('KB_SCORE_FLOOR', '0.6'))
KB_TOP_K          = int(os.environ.get('KB_TOP_K', '4'))

DEDUPE_TABLE      = os.environ.get('WA_DEDUPE_TABLE', 'wa_dedupe')
CONVO_TABLE       = os.environ.get('WA_CONVO_TABLE', 'wa_conversations')
PROMPT_TABLE      = os.environ.get('WA_PROMPT_TABLE', 'dm-bot-prompts')
# Staff-maintained "who is this number". Read ONLY to label escalation pings for
# colleagues — never fed to the model, never used to decide what to tell a client.
CLIENT_DIR_TABLE  = os.environ.get('CLIENT_DIR_TABLE', 'dm-client-directory')

PROMPT_CACHE_TTL  = 60          # seconds a warm container may serve a stale prompt
MAX_PROMPT_CHARS  = 8000        # per block; mirrors staffAuth's save-side limit

DEDUPE_TTL_SEC    = 24 * 3600
CONVO_TTL_SEC     = 30 * 86400
MAX_TURNS         = 10          # trimmed on read
MAX_TURN_CHARS    = 2000        # 400KB item ceiling is otherwise reachable
SERVICE_WINDOW_SEC = 23 * 3600  # Meta's is 24h; leave an hour of headroom

GRAPH_BASE = f'https://graph.facebook.com/{WA_GRAPH_VERSION}'

http = urllib3.PoolManager()
_ddb = boto3.resource('dynamodb', region_name=REGION)


# ──────────────────────────────────────────────────────────────────────────────
# Anti-fabrication
#
# This bot has NO access to any client's data, and clients WILL ask about their
# accounts anyway. A prompt alone is provably not enough: the KB retriever
# returns confident false matches. Live example — "how much does SEO cost"
# returns "Is it necessary to do paid ads when I am doing SEO?" at score 0.79,
# well above the floor, and none of the top matches contain a price at all.
# Told to "ground your answer in these snippets", a model answers a pricing
# question with a paid-ads pitch. Hence three independent layers.
# ──────────────────────────────────────────────────────────────────────────────

# Layer 1a: deterministic, and it applies to EVERYONE — including a client whose
# number is linked and switched on. Money and contracts are a human's job, full stop.
#
# This is the load-bearing half of the split below. The prompt also tells the model to
# escalate these, but a prompt can be talked round and a regex cannot, and the cost of
# being wrong here is a client's contract value or payment status going out over
# WhatsApp. It runs before the LLM, before the KB, and before any client lookup.
# Scoped to THEIR money, not money in general. "How much does SEO cost?" is a
# published-price FAQ the knowledge base is meant to answer, and DEPLOY.md keeps it as
# the standing regression test; blocking it here would quietly kill that. "How much am
# I paying?" is a different question with a different answer, and that one is a human's.
FINANCIAL_RE = re.compile(
    r'('
    # (?:\w+\s+){0,2} so a qualifier between the possessive and the noun doesn't slip
    # past: "my AD spend", "my MONTHLY fee", "my SEO campaign budget".
    r'\b(my|our)\s+(?:\w+\s+){0,2}(invoice|invoices|bill|billing|payment|payments'
    r'|contract|contracts|agreement|fee|fees|price|pricing|rate|rates|budget|budgets'
    r'|spend|spending|plan|package|subscription|balance|deposit|retainer)\b'
    r'|\bhow\s+much\s+(am\s+i|are\s+we|do\s+i|do\s+we|did\s+i|did\s+we|have\s+i|have\s+we|'
    r'was\s+i|were\s+we)\s+\w*\s*(pay|paying|paid|spend|spending|spent|owe|owing|charged|billed)\b'
    r'|\b(i|we)\s+(owe|owing)\b'
    r'|\b(invoice|invoices|billing|refund|refunds|credit\s+note|outstanding\s+(balance|amount)'
    r'|top\s*up|topup)\b'
    r'|\bcharge(d)?\s+(me|us)\b'
    r'|\bcancel(ling|lation)?\s+(my|our|the)\s+(plan|subscription|contract|service|campaign|account)\b'
    r'|\bterminate\s+(my|our)\s+(contract|agreement|service|campaign)\b'
    r'|\b(my|our)\s+contract\s+(expire|expires|expiry|end|ends|renew|renews|renewal)\b'
    r'|\bwhen\s+(does|will)\s+(my|our)\s+(contract|plan|subscription)\b'
    r')',
    re.IGNORECASE,
)

# Layer 1b: deterministic. Applies ONLY to numbers we have NOT linked to a campaign
# and switched on — for those, this is still the wall it always was. For a linked
# client the whole point is that they can ask these, so it is skipped and the model
# answers from the pre-fetched facts (or escalates when they don't cover it).
ACCOUNT_SPECIFIC_RE = re.compile(
    r'\b('
    r'my\s+(campaign|ranking|rankings|invoice|bill|billing|account|website|site|ads?|budget|spend|report|results?|traffic|keywords?)'
    r'|our\s+(campaign|ranking|rankings|invoice|account|results?|report)'
    r'|how\s+much\s+(am\s+i|are\s+we|do\s+i|do\s+we)\s+(paying|pay|spending|spend|owe)'
    r'|when\s+will\s+(i|we|my|our)\b'
    r'|why\s+(is|are|did|has)\s+(my|our)\b'
    r'|refund|cancel\s+(my|our|the)\s+(plan|subscription|contract|service)'
    r'|terminate\s+(my|our)\s+contract'
    r'|speak\s+to\s+(a\s+)?(human|person|someone|manager|consultant)'
    r'|talk\s+to\s+(a\s+)?(human|person|someone|manager|consultant)'
    r')\b',
    re.IGNORECASE,
)

# Layer 3: the user-facing handoff text is a compile-time constant, never
# model-generated, so it cannot invent a response time or a colleague's name.
ESCALATION_REPLY = (
    "That's one for a human colleague — I've passed this to the MediaOne team "
    "and someone will follow up with you here."
)

UNSUPPORTED_MEDIA_REPLY = (
    "I can read text and images here. I've let the MediaOne team know so someone "
    "can take a look at what you sent."
)

# Layer 2. The "MAY BE IRRELEVANT" paragraph exists specifically because of the
# 0.79 false match above. Mirrors the shape of monday_lambda.py:3288-3305 — state
# the limit as absolute, say the tools are hard-limited so don't try, and say
# exactly what to do instead.
#
# ── THE PROMPT IS STAFF-EDITABLE, IN THREE PIECES ───────────────────────────────
# Staff edit the first two from index.html (Others -> WhatsApp Support Logs). They
# are stored in DynamoDB `dm-bot-prompts` and read here at runtime. The third is
# NOT editable and is concatenated on afterwards, by this file, every time.
#
# Why the split is where it is:
#
#   SHARED_PERSONA  — identity + grounding. The ONLY block that is portable to
#       another surface, because it asserts nothing about what data the bot can
#       reach. The client portal's chatbot (separate repo/stack) is intended to
#       fetch exactly this block and fold it into its own instructions, so that
#       one edit moves both bots' voice and anti-fabrication policy. Keep it free
#       of anything WhatsApp-specific, and free of any claim about tools —
#       the portal bot HAS client campaign data and this text must stay true there.
#
#   WHATSAPP_SCOPE  — the "you have NO account data" policy, the snippet-relevance
#       warning, and WhatsApp styling. NOT portable: the portal bot genuinely can
#       read a client's campaign via its query_campaign_data tool, so shipping this
#       block there would be a lie that breaks it.
#
#   FIXED_CONTRACT  — the JSON envelope and the escalate= trigger list. Compiled
#       in, never editable, always appended last. If staff could edit this they
#       could break _parse_llm_json() (every reply then fails closed to a human) or
#       delete the escalation triggers, quietly disabling Layer 3. A prompt editor
#       that can disable the guardrails is not a prompt editor, it's an outage.
#
# ESCALATION_REPLY is likewise not editable, and must not become so: staffAuth
# detects an escalated conversation by exact-matching that string.
DEFAULT_SHARED_PERSONA = """You are MediaOne's support assistant. MediaOne is a digital marketing agency in Singapore (SEO, paid ads, social media, content).

GROUNDING — ABSOLUTE: Never state a price, timeline, percentage, guarantee or metric that is not written verbatim in the source material you have been given. General marketing explanation is fine. Inventing specifics is not.

HONESTY: If the material you were given does not genuinely answer the question that was asked, say so and hand off to a human. Do not force-fit a near-miss into an answer. Retrieval similarity is NOT relevance."""

DEFAULT_WHATSAPP_SCOPE = """SCOPE POLICY — ABSOLUTE: You have NO access to any client's account, campaign, ranking, spend, invoice, contract or timeline data. Not limited access. NONE. There is no tool you can call to get it, so do not try. Any such number, date or status you produced would be fabricated. If you are asked anything account-specific, escalate to a human — do not apologise and then guess anyway.

ABOUT THE SNIPPETS: The knowledge-base snippets below were retrieved by semantic similarity, and similarity is NOT relevance. They are frequently about a DIFFERENT question than the one asked. Judge for yourself whether they actually answer THIS question. If they do not, escalate — do NOT force-fit a near-miss snippet into an answer. Answering "how much does SEO cost" with a snippet about paid advertising is exactly the failure to avoid.

STYLE: WhatsApp — warm, plain, brief. Two short paragraphs at most. No markdown, no bullet lists, no headings."""

# Used INSTEAD of DEFAULT_WHATSAPP_SCOPE, and only when staff have linked this exact
# number to a campaign AND ticked "let the bot discuss this client's account". Every
# other number still gets the block above, which says it has no account data at all.
#
# The facts are pre-fetched and pasted in by _campaign_facts_block() — the bot has no
# tools and cannot go looking. That is the point: it can only ever repeat an
# allow-listed column that was fetched for THIS number's campaign, so the worst case
# is "I don't know", never a number it made up or another client's row.
DEFAULT_WHATSAPP_CLIENT_SCOPE = """SCOPE POLICY — ABSOLUTE: A colleague has confirmed this WhatsApp number belongs to the client named in YOUR CLIENT'S DETAILS below, so you may answer from that section — and from nothing else. It is the entire extent of what you know about them. There is no tool you can call for more, so do not try.

MONEY IS ALWAYS A HUMAN'S JOB: Never discuss invoices, payment, fees, contract value, contract terms, budgets, ad spend, refunds or cancellation — not even if the answer looks like it is below, and not even if they push. Escalate every one of those, every time. Say a colleague will pick it up; do not explain why.

IF IT ISN'T LISTED, YOU DON'T KNOW IT: Anything account-specific that is not written verbatim in YOUR CLIENT'S DETAILS is something you cannot answer. Do not infer it, do not estimate it, do not reason it out from what is there. Escalate instead.

ABOUT THE SNIPPETS: The knowledge-base snippets below were retrieved by semantic similarity, and similarity is NOT relevance. They are frequently about a DIFFERENT question than the one asked. Judge for yourself whether they actually answer THIS question. If they do not, escalate — do NOT force-fit a near-miss snippet into an answer.

STYLE: WhatsApp — warm, plain, brief. Two short paragraphs at most. No markdown, no bullet lists, no headings."""

# NOT staff-editable. Appended by _system_prompt() after the two blocks above.
FIXED_CONTRACT = """Reply with a JSON object and nothing else:
{"reply": "<your message to the user>", "escalate": <true|false>, "reason": "<why, if escalating>"}

Set escalate=true when: the question is account-specific; the snippets do not genuinely answer it; you would have to guess a specific fact; or the person asks for a human. When escalate=true the reply field is discarded, so do not labour over it."""

# Order matters: persona (who you are) -> scope (what you may not do) -> contract
# (how to reply). Same content the single SYSTEM_PROMPT constant used to carry.
PROMPT_KEYS = ('shared_persona', 'whatsapp_scope', 'whatsapp_client_scope')
PROMPT_DEFAULTS = {
    'shared_persona': DEFAULT_SHARED_PERSONA,
    'whatsapp_scope': DEFAULT_WHATSAPP_SCOPE,
    'whatsapp_client_scope': DEFAULT_WHATSAPP_CLIENT_SCOPE,
}

# {key: text} plus the epoch it was fetched. Module-level, so it survives across
# invocations in a warm container and a prompt edit goes live within ~60s.
_prompt_cache = {'ts': 0, 'blocks': None}


def _seed_prompt(key, text):
    """Write the code default into the table the first time we see it missing.

    Conditional, so concurrent workers can't clobber a staff edit that landed
    between our read and our write. `default_text` is what index.html's "Restore
    default" reverts to — the editor has no other way to know the built-in text.
    """
    try:
        now = int(time.time())
        _ddb.Table(PROMPT_TABLE).put_item(
            Item={'prompt_id': key, 'text': text, 'default_text': text,
                  'updated_at': now, 'updated_by': 'system:seed', 'history': []},
            ConditionExpression='attribute_not_exists(prompt_id)')
        print(f'[PROMPT] seeded {key} from the code default')
    except _ddb.meta.client.exceptions.ConditionalCheckFailedException:
        pass                      # someone else seeded it first — fine
    except Exception as e:
        # Seeding is best-effort. A read-only role still serves the code default.
        print(f'[PROMPT] seed failed for {key}: {e}')


def _prompt_blocks(force=False):
    """{key: text}, cached for PROMPT_CACHE_TTL. force=True skips the cache.

    FAILS SAFE, NOT CLOSED: any error, missing item, or blank override falls back
    to the code default for that block. A DynamoDB outage must not take the bot
    down or, worse, drop the scope policy and let it start guessing.
    """
    now = int(time.time())
    if not force and _prompt_cache['blocks'] is not None and now - _prompt_cache['ts'] < PROMPT_CACHE_TTL:
        return _prompt_cache['blocks']

    blocks = dict(PROMPT_DEFAULTS)
    for key in PROMPT_KEYS:
        try:
            item = (_ddb.Table(PROMPT_TABLE).get_item(Key={'prompt_id': key}) or {}).get('Item')
        except Exception as e:
            print(f'[PROMPT] read failed for {key}: {e} — using the code default')
            continue
        if not item:
            _seed_prompt(key, PROMPT_DEFAULTS[key])
            continue
        text = (item.get('text') or '').strip()
        if text:
            blocks[key] = text[:MAX_PROMPT_CHARS]
        else:
            # Present but blank: treat as "revert to default" rather than sending
            # the model an empty policy section.
            print(f'[PROMPT] {key} is blank — using the code default')

    _prompt_cache['blocks'] = blocks
    _prompt_cache['ts'] = now
    return blocks


def _system_prompt(force=False, client_mode=False):
    """client_mode swaps ONE block: the scope policy. Persona and the fixed contract
    are identical either way, so the escalate-on-doubt machinery is the same for a
    linked client as for a stranger."""
    b = _prompt_blocks(force=force)
    scope = b['whatsapp_client_scope'] if client_mode else b['whatsapp_scope']
    return '\n\n'.join((b['shared_persona'], scope, FIXED_CONTRACT))


def _agent_prompt_info(event):
    """Everything index.html's prompt editor needs, sourced from the one file that
    owns the defaults. Invoked (RequestResponse) by staffAuth.

    Exists so staffAuth never holds a second copy of the prompt text. This repo
    already has that bug once — WA_ESCALATION_REPLY is duplicated in staffAuth
    with a "keep in sync or the Escalated flag silently breaks" warning — and a
    2KB prompt would be a far worse thing to duplicate than a one-line constant.

    Seeds any missing block as a side effect (via _prompt_blocks), so opening the
    editor on a cold install shows real text instead of an empty box. Returns the
    COMPOSED prompt so the editor can show staff exactly what the model receives,
    including the parts they cannot edit. force=True: a save made seconds ago must
    not be hidden behind this container's 60s cache.
    """
    return {'ok': True,
            'blocks': _prompt_blocks(force=True),
            'defaults': dict(PROMPT_DEFAULTS),
            'fixed_contract': FIXED_CONTRACT,
            'composed': _system_prompt(force=True),
            'editable_keys': list(PROMPT_KEYS)}


# ──────────────────────────────────────────────────────────────────────────────
# HTTP event helpers — Function URLs use payload v2, API Gateway v1 uses v1.
# Support both so the transport can change without touching this code.
# ──────────────────────────────────────────────────────────────────────────────
def _http_method(event):
    m = event.get('httpMethod')
    if m:
        return m.upper()
    return (((event.get('requestContext') or {}).get('http') or {}).get('method') or '').upper()


def _headers_lower(event):
    return {str(k).lower(): v for k, v in (event.get('headers') or {}).items()}


def _raw_body_bytes(event):
    """The VERBATIM bytes Meta signed. Never re-serialize JSON before hashing —
    key order and separators shift and the digest breaks."""
    body = event.get('body') or ''
    if event.get('isBase64Encoded'):
        return base64.b64decode(body)
    return body.encode('utf-8')


def _json(status, payload):
    return {"statusCode": status,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(payload)}


# ──────────────────────────────────────────────────────────────────────────────
# GET — Meta's verify handshake
# ──────────────────────────────────────────────────────────────────────────────
def _handle_verify(event):
    qs = event.get('queryStringParameters') or {}
    mode = qs.get('hub.mode', '')
    token = qs.get('hub.verify_token', '')
    challenge = qs.get('hub.challenge', '')

    if not WA_VERIFY_TOKEN:
        print('[VERIFY] WA_VERIFY_TOKEN is not configured — refusing the handshake')
        return {"statusCode": 500, "body": "not configured"}

    if mode != 'subscribe' or not hmac.compare_digest(token, WA_VERIFY_TOKEN):
        print(f'[VERIFY] rejected: mode={mode!r} token_match=False')
        return {"statusCode": 403, "body": "forbidden"}

    print('[VERIFY] handshake ok')
    # RAW text. json.dumps() would wrap it in quotes and Meta rejects the
    # handshake — this endpoint deliberately breaks the repo's usual shape.
    return {"statusCode": 200,
            "headers": {"Content-Type": "text/plain"},
            "body": challenge}


# ──────────────────────────────────────────────────────────────────────────────
# POST — signature, filter, claim, hand off. Nothing slow on this path.
# ──────────────────────────────────────────────────────────────────────────────
def _verify_signature(event):
    if not WA_APP_SECRET:
        print('[SIG] WA_APP_SECRET is not configured — refusing')
        return False
    raw = _raw_body_bytes(event)
    got = _headers_lower(event).get('x-hub-signature-256', '')
    expected = 'sha256=' + hmac.new(WA_APP_SECRET.encode('utf-8'), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, got)


def _extract_messages(payload):
    """Yield (value, message) for real inbound messages only.

    Meta fires a `statuses` webhook for every sent/delivered/read receipt. Those
    have no `messages` key — invoking a worker for each would burn money doing
    nothing. (We also subscribe to `messages` only in the dashboard, so these
    should be rare; this is the belt to that braces.)
    """
    for entry in payload.get('entry') or []:
        for change in entry.get('changes') or []:
            value = change.get('value') or {}
            for msg in value.get('messages') or []:
                yield value, msg


def _handle_webhook(event):
    if not _verify_signature(event):
        # 403, not 200. A bad signature means this isn't Meta, or WA_APP_SECRET
        # is wrong. 403 makes Meta retry and eventually flag the webhook — loud.
        # 200 would make it a silent black hole.
        print('[SIG] signature mismatch — rejecting')
        return {"statusCode": 403, "body": "bad signature"}

    try:
        payload = json.loads(_raw_body_bytes(event))
    except Exception as e:
        print(f'[WEBHOOK] unparseable body: {e}')
        return {"statusCode": 400, "body": "bad json"}

    dispatched = 0
    for value, msg in _extract_messages(payload):
        msg_id = msg.get('id')
        wa_id = (msg.get('from') or '').strip()
        if not msg_id or not wa_id:
            continue

        if WA_ALLOWED_WA_IDS and wa_id not in WA_ALLOWED_WA_IDS:
            print(f'[WEBHOOK] {wa_id} not in allowlist — ignoring')
            continue

        if not _claim(msg_id):
            print(f'[WEBHOOK] {msg_id} already claimed — duplicate delivery, skipping')
            continue

        try:
            _self_invoke({'action': 'wa_process', 'msg_id': msg_id, 'wa_id': wa_id, 'message': msg})
            dispatched += 1
        except Exception as e:
            # Do NOT swallow this (socialMediaAudit's _self_invoke does — in a
            # webhook that's silent message loss). Release the claim and 500 so
            # Meta redelivers; the claim would otherwise block the retry forever.
            print(f'[WEBHOOK] self-invoke failed for {msg_id}: {e} — releasing claim')
            _release(msg_id)
            return {"statusCode": 500, "body": "dispatch failed"}

    return {"statusCode": 200, "body": json.dumps({"ok": True, "dispatched": dispatched})}


def _self_invoke(payload):
    boto3.client('lambda', region_name=REGION).invoke(
        FunctionName=os.environ.get('AWS_LAMBDA_FUNCTION_NAME', 'whatsappBot'),
        InvocationType='Event',
        Payload=json.dumps(payload).encode())


# ──────────────────────────────────────────────────────────────────────────────
# Dedupe — two-phase claim.
#
# Guards two DIFFERENT retry sources:
#   Meta retry (we were slow or 5xx'd)  -> the claim below short-circuits it
#   Lambda async retry (worker crashed) -> the 'replied' mark short-circuits it,
#       so a worker that dies AFTER sending doesn't send twice
# ──────────────────────────────────────────────────────────────────────────────
def _claim(msg_id):
    try:
        _ddb.Table(DEDUPE_TABLE).put_item(
            Item={'msg_id': msg_id, 'status': 'claimed',
                  'ts': int(time.time()), 'ttl': int(time.time()) + DEDUPE_TTL_SEC},
            ConditionExpression='attribute_not_exists(msg_id)')
        return True
    except _ddb.meta.client.exceptions.ConditionalCheckFailedException:
        return False


def _release(msg_id):
    try:
        _ddb.Table(DEDUPE_TABLE).delete_item(Key={'msg_id': msg_id})
    except Exception as e:
        print(f'[DEDUPE] release failed for {msg_id}: {e}')


def _already_replied(msg_id):
    try:
        item = (_ddb.Table(DEDUPE_TABLE).get_item(Key={'msg_id': msg_id}) or {}).get('Item') or {}
        return item.get('status') == 'replied'
    except Exception as e:
        print(f'[DEDUPE] read failed for {msg_id}: {e}')
        return False


def _mark_replied(msg_id):
    try:
        _ddb.Table(DEDUPE_TABLE).update_item(
            Key={'msg_id': msg_id},
            UpdateExpression='SET #st = :s',
            ExpressionAttributeNames={'#st': 'status'},   # 'status' is reserved
            ExpressionAttributeValues={':s': 'replied'})
    except Exception as e:
        print(f'[DEDUPE] mark-replied failed for {msg_id}: {e}')


# ──────────────────────────────────────────────────────────────────────────────
# Conversation memory — one item per wa_id
# ──────────────────────────────────────────────────────────────────────────────
def _append_turn(wa_id, role, text, touch_user_ts=False, agent=None):
    """Atomic list_append. NOT read-modify-write: two messages arriving together
    run as two concurrent workers, and RMW silently drops one of the turns.

    role is 'user', 'assistant' (the bot) or 'agent' (a human colleague replying
    from index.html). 'agent' is deliberately NOT stored as 'assistant': the logs
    viewer labels each bubble from this field, and merging the two would credit a
    colleague's words to the bot in a transcript staff read as evidence.
    """
    now = int(time.time())
    turn = {'role': role, 'text': (text or '')[:MAX_TURN_CHARS], 'ts': now}
    if agent:
        turn['agent'] = str(agent)[:120]
    expr = ('SET turns = list_append(if_not_exists(turns, :empty), :new), '
            '#ttl = :ttl')
    vals = {':empty': [], ':new': [turn], ':ttl': now + CONVO_TTL_SEC}
    if touch_user_ts:
        expr += ', last_user_ts = :now'
        vals[':now'] = now
    try:
        _ddb.Table(CONVO_TABLE).update_item(
            Key={'wa_id': wa_id},
            UpdateExpression=expr,
            ExpressionAttributeNames={'#ttl': 'ttl'},     # 'ttl' is reserved
            ExpressionAttributeValues=vals)
    except Exception as e:
        print(f'[CONVO] append failed for {wa_id}: {e}')


def _set_paused(wa_id, paused, who):
    """Hand the conversation to a human, or hand it back to the bot.

    While paused the bot still records inbound messages and still pings Google
    Chat — it just doesn't reply. Set automatically the moment we escalate: at
    that point the client has been TOLD a colleague will follow up, so an
    auto-reply to their next message is the bot talking over our own promise.
    Also set whenever a colleague sends a reply. Cleared only by a human.
    """
    now = int(time.time())
    try:
        _ddb.Table(CONVO_TABLE).update_item(
            Key={'wa_id': wa_id},
            UpdateExpression='SET bot_paused = :p, paused_at = :t, paused_by = :w, #ttl = :ttl',
            ExpressionAttributeNames={'#ttl': 'ttl'},
            ExpressionAttributeValues={
                ':p': bool(paused), ':t': now, ':w': str(who or 'system')[:120],
                ':ttl': now + CONVO_TTL_SEC})
        return True
    except Exception as e:
        print(f'[CONVO] pause={paused} failed for {wa_id}: {e}')
        return False


def _get_convo(wa_id):
    """(turns, last_user_ts, bot_paused).

    On a read failure we report paused=False — i.e. the bot keeps answering. The
    alternative (fail to paused) would silently mute the bot for every client
    during a DynamoDB blip, which is a worse and much quieter failure than one
    duplicate reply.
    """
    try:
        item = (_ddb.Table(CONVO_TABLE).get_item(Key={'wa_id': wa_id}) or {}).get('Item') or {}
    except Exception as e:
        print(f'[CONVO] read failed for {wa_id}: {e}')
        return [], 0, False
    turns = (item.get('turns') or [])[-MAX_TURNS:]
    return turns, int(item.get('last_user_ts') or 0), bool(item.get('bot_paused'))


# ──────────────────────────────────────────────────────────────────────────────
# Knowledge base — reuse the monday Lambda's vector search over HTTP
# ──────────────────────────────────────────────────────────────────────────────
def _kb_search(query):
    """Returns a list of {question, answer, score, ...} above KB_SCORE_FLOOR.

    NOTE the double decode. The endpoint returns {"statusCode":200,"body":"<json
    string>"} — the payload is JSON-encoded twice. Wrapped in try/except partly
    because a monday_lambda refactor that fixed the double-encoding would
    otherwise silently break this caller.
    """
    try:
        r = http.request(
            'POST', KB_SEARCH_URL,
            headers={'Content-Type': 'application/json'},
            body=json.dumps({'action': 'search_knowledge_base',
                             'query': query, 'top_k': KB_TOP_K}),
            timeout=urllib3.Timeout(total=15))
        if r.status != 200:
            print(f'[KB] http {r.status}: {r.data[:300]}')
            return []
        outer = json.loads(r.data.decode('utf-8'))
        inner = outer.get('body')
        data = json.loads(inner) if isinstance(inner, str) else (inner or outer)
        matches = data.get('matches') or []
    except Exception as e:
        print(f'[KB] search failed: {e}')
        return []
    return [m for m in matches if float(m.get('score') or 0) >= KB_SCORE_FLOOR]


def _kb_block(matches):
    if not matches:
        return 'No knowledge-base snippets were retrieved for this question.'
    lines = []
    for i, m in enumerate(matches, 1):
        lines.append(f"[{i}] (similarity {float(m.get('score') or 0):.2f})\n"
                     f"Q: {m.get('question', '')}\n"
                     f"A: {m.get('answer', '')}")
    return '\n\n'.join(lines)


# ──────────────────────────────────────────────────────────────────────────────
# LLM
# ──────────────────────────────────────────────────────────────────────────────
def _parse_llm_json(text):
    """DeepSeek may fence the JSON or prepend prose. Returns None if unusable —
    the caller escalates rather than sending unparsed model output to a client."""
    t = (text or '').strip()
    if t.startswith('```'):
        t = re.sub(r'^```(?:json)?\s*', '', t)
        t = re.sub(r'\s*```$', '', t)
    try:
        obj = json.loads(t)
    except Exception:
        m = re.search(r'\{.*\}', t, re.DOTALL)
        if not m:
            return None
        try:
            obj = json.loads(m.group(0))
        except Exception:
            return None
    if not isinstance(obj, dict) or 'reply' not in obj:
        return None
    return obj


def _ask_deepseek(question, kb_matches, turns, facts=None):
    if not DEEPSEEK_API_KEY:
        print('[LLM] DEEPSEEK_API_KEY not configured')
        return None
    messages = [{'role': 'system', 'content': _system_prompt(client_mode=bool(facts))}]
    for t in turns[:-1]:      # history, excluding the turn we just appended
        # 'agent' (a human colleague) maps to assistant: it is an outbound message
        # from our side. Letting it fall through to 'user' would replay a
        # colleague's words back to the model as if the CLIENT had said them.
        messages.append({'role': 'assistant' if t.get('role') in ('assistant', 'agent') else 'user',
                         'content': t.get('text') or ''})
    facts_block = (_campaign_facts_block(facts) + '\n\n') if facts else ''
    messages.append({'role': 'user',
                     'content': f"{facts_block}KNOWLEDGE-BASE SNIPPETS:\n{_kb_block(kb_matches)}\n\n"
                                f"QUESTION: {question}\n\nReply with the JSON object."})
    try:
        r = http.request(
            'POST', 'https://api.deepseek.com/chat/completions',
            headers={'Authorization': f'Bearer {DEEPSEEK_API_KEY}',
                     'Content-Type': 'application/json'},
            body=json.dumps({'model': DEEPSEEK_MODEL, 'max_tokens': 700,
                             'response_format': {'type': 'json_object'},
                             'messages': messages}),
            timeout=urllib3.Timeout(total=90))
        if r.status != 200:
            print(f'[LLM] deepseek {r.status}: {r.data[:400]}')
            return None
        data = json.loads(r.data.decode('utf-8'))
        return _parse_llm_json((data['choices'][0]['message'].get('content')) or '')
    except Exception as e:
        print(f'[LLM] deepseek failed: {e}')
        return None


def _ask_haiku_vision(caption, image_b64, mime, kb_matches, facts=None):
    """Images go to Haiku — DeepSeek is text-only. Mirrors the routing shim at
    monday_lambda.py:3185-3212, and the backup-key retry at 4150-4165."""
    if not ANTHROPIC_API_KEY:
        print('[LLM] ANTHROPIC_API_KEY not configured')
        return None
    facts_block = (_campaign_facts_block(facts) + '\n\n') if facts else ''
    payload = {
        'model': VISION_MODEL,
        'max_tokens': 700,
        'system': _system_prompt(client_mode=bool(facts)),
        'messages': [{'role': 'user', 'content': [
            {'type': 'image', 'source': {'type': 'base64', 'media_type': mime, 'data': image_b64}},
            {'type': 'text', 'text': f"{facts_block}KNOWLEDGE-BASE SNIPPETS:\n{_kb_block(kb_matches)}\n\n"
                                     f"The user sent this image with the caption: {caption or '(no caption)'}\n\n"
                                     f"Reply with the JSON object."},
        ]}],
    }
    key = ANTHROPIC_API_KEY
    for attempt in (1, 2):
        try:
            r = http.request(
                'POST', 'https://api.anthropic.com/v1/messages',
                headers={'x-api-key': key, 'anthropic-version': '2023-06-01',
                         'Content-Type': 'application/json'},
                body=json.dumps(payload), timeout=urllib3.Timeout(total=90))
            if r.status in (429, 529) and attempt == 1 and ANTHROPIC_API_KEY_BACKUP and key != ANTHROPIC_API_KEY_BACKUP:
                print('[LLM] primary key rate-limited — retrying with backup')
                key = ANTHROPIC_API_KEY_BACKUP
                continue
            if r.status != 200:
                print(f'[LLM] anthropic {r.status}: {r.data[:400]}')
                return None
            data = json.loads(r.data.decode('utf-8'))
            text = ''.join(b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text')
            return _parse_llm_json(text)
        except Exception as e:
            print(f'[LLM] anthropic failed: {e}')
            return None
    return None


# ──────────────────────────────────────────────────────────────────────────────
# WhatsApp Graph API
# ──────────────────────────────────────────────────────────────────────────────
def _send_text(wa_id, text):
    if not WA_ACCESS_TOKEN or not WA_PHONE_NUMBER_ID:
        print('[SEND] WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID not configured')
        return False
    try:
        r = http.request(
            'POST', f'{GRAPH_BASE}/{WA_PHONE_NUMBER_ID}/messages',
            headers={'Authorization': f'Bearer {WA_ACCESS_TOKEN}',
                     'Content-Type': 'application/json'},
            body=json.dumps({'messaging_product': 'whatsapp', 'to': wa_id,
                             'type': 'text', 'text': {'body': text}}),
            timeout=urllib3.Timeout(total=20))
        if r.status != 200:
            print(f'[SEND] graph {r.status}: {r.data[:400]}')
            return False
        return True
    except Exception as e:
        print(f'[SEND] failed: {e}')
        return False


def _fetch_media(media_id):
    """Two steps, and the second one still needs the bearer token — fetching the
    returned URL without the Authorization header 401s. Returns (b64, mime)."""
    try:
        r = http.request('GET', f'{GRAPH_BASE}/{media_id}',
                         headers={'Authorization': f'Bearer {WA_ACCESS_TOKEN}'},
                         timeout=urllib3.Timeout(total=20))
        if r.status != 200:
            print(f'[MEDIA] lookup {r.status}: {r.data[:300]}')
            return None, None
        meta = json.loads(r.data.decode('utf-8'))
        url, mime = meta.get('url'), meta.get('mime_type', 'image/jpeg')
        if not url:
            return None, None

        r2 = http.request('GET', url,
                          headers={'Authorization': f'Bearer {WA_ACCESS_TOKEN}'},
                          timeout=urllib3.Timeout(total=30))
        if r2.status != 200:
            print(f'[MEDIA] download {r2.status}')
            return None, None
        return base64.b64encode(r2.data).decode('ascii'), (mime or '').split(';')[0]
    except Exception as e:
        print(f'[MEDIA] fetch failed: {e}')
        return None, None


def _post_gchat(text):
    """Human escalation. Rewritten with urllib3 from monday_lambda.py:727."""
    if not GCHAT_WEBHOOK_URL:
        print('[GCHAT] GCHAT_WEBHOOK_URL not configured — escalation not delivered')
        return False
    try:
        r = http.request('POST', GCHAT_WEBHOOK_URL,
                         headers={'Content-Type': 'application/json'},
                         body=json.dumps({'text': text}),
                         timeout=urllib3.Timeout(total=10))
        return r.status < 300
    except Exception as e:
        print(f'[GCHAT] post failed: {e}')
        return False


# ──────────────────────────────────────────────────────────────────────────────
# Client account facts — the ONLY client data this bot can ever state.
#
# AN ALLOW-LIST, AND IT HAS TO BE. The ICIR board carries 121 columns. Among them:
# "[BD] SEO Contract Value", "[BD] GEO Contract Value", "[FINANCE] Payment Status of
# Campaign Fee", "[MB] Total Ad Budget", "SEM Payment terms" — and internal notes no
# client should ever read, like "Contact for Upsell" and "[6Jan25] Intervention".
# Sending the row and trusting the prompt to hold the line would put a client's
# contract value one jailbreak away from their phone.
#
# So: nothing reaches the model unless it is listed here. Adding a column is a
# deliberate act. Before you add one, ask whether you would be happy for it to be
# screenshotted into a group chat, because that is the threat model.
#
# The value is the label the client sees, so keep them plain — internal prefixes like
# "[CSM]" and "[Reg]" mean nothing to them.
CLIENT_FACT_COLS = {
    # who is on their account
    'people2':                  'Client Success Manager',
    'multiple_person':          'Assistant Client Success Manager',
    'people6':                  'SEO consultant',
    'dup__of_people':           'Assistant SEO consultant',
    'multiple_person_mm1mcx4v': 'GEO consultant',
    'people4':                  'Social / content lead',
    # what they have with us
    'tags':                     'Services',
    'status':                   'SEO campaign type',
    'text6':                    'Industry',
    # where it stands
    'status0':                  'Overall campaign status',
    'color1':                   'SEO campaign status',
    'color_mm1mymh5':           'GEO campaign status',
    'status3':                  'Paid media campaign status',
    'status929':                'Social media status',
    # when
    'start_live_date':          'Campaign timeline',
    'timeline5':                'SEO timeline',
    'timerange_mm1s32zv':       'GEO timeline',
    'timeline39':               'Social media timeline',
    'timeline1':                'Paid media timeline',
    # deliverables + KPI progress (counts and percentages, never money)
    'total_kws':                'Guaranteed keywords',
    'numbers3':                 'KPI keywords',
    'formula9':                 'SEO KPI status',
    'dup__of_kpi_status0':      'SEO KPI hit rate',
    'numeric_mm1yf15f':         'GEO KPI status (%)',
    'numbers70':                'SEO articles',
    # reporting
    'text9__1':                 'Report due date',
    'color94__1':               'Latest SEO report sent',
    'color5__1':                'Latest social report sent',
}


def _campaign_facts(campaign_id):
    """The allow-listed columns for ONE ICIR item, as {label: value}.

    Reuses the monday Lambda over HTTP (same endpoint as the KB) rather than talking
    to Monday directly, so the API key stays where it already lives. Returns None on
    ANY failure — the caller escalates rather than answering from a half-empty row,
    because a missing fact is indistinguishable from "they don't have that service"
    and the bot would happily tell a client the wrong one.
    """
    ids = '","'.join(CLIENT_FACT_COLS.keys())
    query = ('{ items(ids:[' + str(campaign_id) + ']){ name column_values(ids:["' + ids + '"])'
             '{ id text ... on FormulaValue { display_value } } } }')
    try:
        r = http.request(
            'POST', KB_SEARCH_URL,
            headers={'Content-Type': 'application/json'},
            body=json.dumps({'action': 'get_monday_data', 'query': query}),
            timeout=urllib3.Timeout(total=20))
        if r.status != 200:
            print(f'[FACTS] http {r.status}: {r.data[:200]}')
            return None
        outer = json.loads(r.data.decode('utf-8'))
        inner = outer.get('body')
        data = json.loads(inner) if isinstance(inner, str) else (inner or outer)
        items = (data.get('data') or data).get('items') or []
        if not items:
            print(f'[FACTS] no item {campaign_id}')
            return None
        item = items[0]
    except Exception as e:
        print(f'[FACTS] fetch failed for {campaign_id}: {e}')
        return None

    facts = {'Campaign': item.get('name') or ''}
    for cv in (item.get('column_values') or []):
        label = CLIENT_FACT_COLS.get(cv.get('id'))
        if not label:
            continue                       # not on the allow-list — cannot happen, but belt
        val = (cv.get('display_value') or cv.get('text') or '').strip()
        if val:
            facts[label] = val
    return facts


def _campaign_facts_block(facts):
    lines = [f'{k}: {v}' for k, v in facts.items() if v]
    return "YOUR CLIENT'S DETAILS (everything you know about them — nothing else exists):\n" \
        + '\n'.join(lines)


def _client_ctx(wa_id):
    """{company, name, campaign_id, enabled} for a number, or {} if unknown.

    `enabled` is the per-number switch a colleague ticked in index.html. It is the
    difference between a bot that discusses someone's campaign and one that doesn't,
    so it is read fresh on every message — never cached — and it fails to False.
    """
    try:
        item = (_ddb.Table(CLIENT_DIR_TABLE).get_item(Key={'wa_id': wa_id}) or {}).get('Item') or {}
    except Exception as e:
        print(f'[CLIENT] lookup failed for {_mask(wa_id)}: {e}')
        return {}
    return {
        'company': item.get('company') or '',
        'name': item.get('name') or '',
        'campaign_id': (item.get('campaign_id') or '').strip(),
        'enabled': bool(item.get('account_data_enabled')),
    }


def _client_label(wa_id):
    """"Acme Pte Ltd — Jane Tan" if staff have named this number, else ''.

    STAFF-FACING ONLY. This never reaches the model or the client: it goes in the
    Google Chat ping so whoever picks up an escalation knows who they're talking to.
    The bot still has no client data and `whatsapp_scope` still says so — a phone
    number is possession of a SIM, not proof of who is holding it.
    """
    try:
        item = (_ddb.Table(CLIENT_DIR_TABLE).get_item(Key={'wa_id': wa_id}) or {}).get('Item') or {}
    except Exception as e:
        print(f'[CLIENT] lookup failed for {_mask(wa_id)}: {e}')
        return ''
    bits = [b for b in (item.get('company'), item.get('name')) if b]
    return ' — '.join(bits)


def _escalate(wa_id, question, reason, turns=None):
    # Stand the bot down BEFORE the ping. We've just told the client a colleague
    # will follow up; if the bot answers their next message it contradicts that,
    # and it may talk straight over a colleague who is mid-reply. A human clears
    # this from index.html when they're done.
    _set_paused(wa_id, True, 'system:escalation')

    who = _client_label(wa_id)
    lines = [f'*WhatsApp escalation* — +{wa_id}' + (f'  ({who})' if who else '  (unknown number)'),
             f'*Reason:* {reason}',
             f'*Their message:* {question[:600]}']
    if turns:
        recent = ' | '.join(f"{t.get('role')}: {(t.get('text') or '')[:120]}" for t in turns[-4:])
        lines.append(f'*Recent context:* {recent}')
    lines.append('_The bot has stopped replying to this person. Answer them from '
                 'index.html → Others → WhatsApp Support Logs, or in the WhatsApp '
                 'Business Inbox, then resume the bot there when you\'re done._')
    _post_gchat('\n'.join(lines))


# ──────────────────────────────────────────────────────────────────────────────
# Worker — runs on the async invoke. Slow work lives here, never on the webhook.
# ──────────────────────────────────────────────────────────────────────────────
def _worker(event):
    msg_id = event.get('msg_id')
    wa_id = event.get('wa_id')
    msg = event.get('message') or {}

    # Lambda retries a failed async invoke twice on its own. If a previous
    # attempt crashed AFTER sending, replying again would double-message.
    if _already_replied(msg_id):
        print(f'[WORKER] {msg_id} already replied — skipping')
        return {'ok': True, 'skipped': 'already_replied'}

    mtype = msg.get('type')
    if mtype == 'text':
        question = ((msg.get('text') or {}).get('body') or '').strip()
    elif mtype == 'image':
        question = ((msg.get('image') or {}).get('caption') or '').strip()
    else:
        # audio/video/document/sticker/location — escalate rather than guess.
        print(f'[WORKER] unsupported message type {mtype!r} — escalating')
        _append_turn(wa_id, 'user', f'({mtype} message)', touch_user_ts=True)
        _escalate(wa_id, f'({mtype} message — not readable by the bot)', f'unsupported type: {mtype}')
        _send_text(wa_id, UNSUPPORTED_MEDIA_REPLY)
        _mark_replied(msg_id)
        return {'ok': True, 'escalated': True}

    _append_turn(wa_id, 'user', question or f'({mtype})', touch_user_ts=True)
    turns, last_user_ts, paused = _get_convo(wa_id)

    # A colleague owns this conversation. Record and notify, but do NOT reply —
    # the whole point of the handoff is that the client hears one voice. Checked
    # after the turn is appended so index.html still shows the new message, and
    # before the KB/LLM spend, which would be wasted.
    if paused:
        print(f'[WORKER] {wa_id} is handed off to a human — recorded, not replying')
        _who = _client_label(wa_id)
        _post_gchat(f'*WhatsApp — new message on a handed-off chat* — +{wa_id}'
                    + (f'  ({_who})' if _who else '') + '\n'
                    f'*Their message:* {question[:600]}\n'
                    '_The bot is paused for this person. Reply from index.html → '
                    'Others → WhatsApp Support Logs._')
        _mark_replied(msg_id)
        return {'ok': True, 'skipped': 'handed_off'}

    # 24h service window. We only ever reply to a message that just arrived, so
    # we're structurally inside it — unless the worker was delayed (DLQ redrive,
    # retry storm). A 3-day-late robot reply is worse than none, and Meta would
    # reject it with error 131047 anyway.
    age = int(time.time()) - (last_user_ts or 0)
    if last_user_ts and age > SERVICE_WINDOW_SEC:
        print(f'[WORKER] {msg_id} is {age}s old — outside the service window, not sending')
        _escalate(wa_id, question, f'message sat for {age // 3600}h — outside the 24h window, bot did not reply', turns)
        _mark_replied(msg_id)
        return {'ok': True, 'skipped': 'stale'}

    # Layer 1a — money, always, for everyone. Before any lookup, LLM or KB spend.
    if FINANCIAL_RE.search(question):
        print(f'[WORKER] {msg_id} matched the financial pre-filter — escalating')
        _send_text(wa_id, ESCALATION_REPLY)
        _append_turn(wa_id, 'assistant', ESCALATION_REPLY)
        _escalate(wa_id, question, 'money / contract question (deterministic pre-filter)', turns)
        _mark_replied(msg_id)
        return {'ok': True, 'escalated': True}

    # Is this number one a colleague has linked to a campaign AND switched on?
    # Read fresh every message: the switch is how a client's account data is allowed
    # out, so a stale cached "yes" is exactly the thing we can't have.
    ctx = _client_ctx(wa_id)
    facts = None
    if ctx.get('enabled') and ctx.get('campaign_id'):
        facts = _campaign_facts(ctx['campaign_id'])
        if facts is None:
            # Fetch failed. Do NOT fall through to the no-account-data prompt and let
            # the model wing it — a half-known client is worse than an unknown one.
            print(f'[WORKER] {msg_id} facts fetch failed for campaign '
                  f'{ctx.get("campaign_id")} — escalating')
            _send_text(wa_id, ESCALATION_REPLY)
            _append_turn(wa_id, 'assistant', ESCALATION_REPLY)
            _escalate(wa_id, question, "could not read this client's campaign row", turns)
            _mark_replied(msg_id)
            return {'ok': True, 'escalated': True}
        print(f'[WORKER] {msg_id} answering as linked client '
              f'{ctx.get("company") or "?"} ({len(facts)} facts)')

    # Layer 1b — for everyone we have NOT linked and switched on, account questions
    # are still a hard stop before any LLM. A linked client skips this: answering them
    # is the entire point, and the facts block bounds what "answering" can mean.
    if not facts and ACCOUNT_SPECIFIC_RE.search(question):
        print(f'[WORKER] {msg_id} matched the account-specific pre-filter — escalating')
        _send_text(wa_id, ESCALATION_REPLY)
        _append_turn(wa_id, 'assistant', ESCALATION_REPLY)
        _escalate(wa_id, question, 'account-specific question (deterministic pre-filter)', turns)
        _mark_replied(msg_id)
        return {'ok': True, 'escalated': True}

    kb = _kb_search(question) if question else []

    if mtype == 'image':
        b64, mime = _fetch_media((msg.get('image') or {}).get('id'))
        result = _ask_haiku_vision(question, b64, mime, kb, facts=facts) if b64 else None
    else:
        # "Who is my CSM?" will never match a knowledge-base snippet, so for a linked
        # client the facts block is a legitimate thing to ground on all by itself.
        # With neither facts nor snippets there is still nothing to answer from, and
        # it fails closed to a human exactly as before.
        result = _ask_deepseek(question, kb, turns, facts=facts) if (kb or facts) else None
        if not kb and not facts:
            print(f'[WORKER] no KB matches above {KB_SCORE_FLOOR} — escalating')

    # Fail closed: LLM error, unparseable JSON, or an explicit escalate all end
    # up with a human. Never with an improvised answer.
    if result is None:
        _send_text(wa_id, ESCALATION_REPLY)
        _append_turn(wa_id, 'assistant', ESCALATION_REPLY)
        _escalate(wa_id, question, 'no usable KB match, or the model failed to answer', turns)
        _mark_replied(msg_id)
        return {'ok': True, 'escalated': True}

    if result.get('escalate'):
        reason = result.get('reason') or 'model chose to escalate'
        print(f'[WORKER] {msg_id} model escalated: {reason}')
        # result['reply'] is deliberately discarded — the handoff text the user
        # sees is a constant so it can't invent a response time or a name.
        _send_text(wa_id, ESCALATION_REPLY)
        _append_turn(wa_id, 'assistant', ESCALATION_REPLY)
        _escalate(wa_id, question, reason, turns)
        _mark_replied(msg_id)
        return {'ok': True, 'escalated': True}

    reply = (result.get('reply') or '').strip()
    if not reply:
        _send_text(wa_id, ESCALATION_REPLY)
        _append_turn(wa_id, 'assistant', ESCALATION_REPLY)
        _escalate(wa_id, question, 'model returned an empty reply', turns)
        _mark_replied(msg_id)
        return {'ok': True, 'escalated': True}

    if not _send_text(wa_id, reply):
        # Don't mark replied — let Lambda's async retry have another go.
        raise RuntimeError(f'send failed for {msg_id}')

    _append_turn(wa_id, 'assistant', reply)
    _mark_replied(msg_id)
    return {'ok': True, 'replied': True}


# ──────────────────────────────────────────────────────────────────────────────
# Human colleague replying from index.html.
#
# WHY THESE LIVE HERE AND NOT IN staffAuth: WA_ACCESS_TOKEN stays in exactly one
# function, and staffAuth's exec role stays read-only on wa_conversations (Scan +
# GetItem, nothing else). staffAuth authenticates the person and invokes these
# synchronously; every write to the conversation happens on this side.
# ──────────────────────────────────────────────────────────────────────────────
AGENT_MAX_CHARS = 4096      # WhatsApp's own ceiling for a text body


def _agent_send(event):
    wa_id = (event.get('wa_id') or '').strip()
    text = (event.get('text') or '').strip()
    who = (event.get('agent') or 'staff').strip()
    if not wa_id or not text:
        return {'ok': False, 'error': 'wa_id and text are required.'}
    if len(text) > AGENT_MAX_CHARS:
        return {'ok': False,
                'error': f'Message is too long ({len(text)} characters, max {AGENT_MAX_CHARS}).'}

    _, last_user_ts, _ = _get_convo(wa_id)
    if not last_user_ts:
        return {'ok': False,
                'error': 'This person has never messaged us — there is no open conversation to reply to.'}

    # Meta's 24h service window, re-checked HERE and not only in the browser: the
    # page's copy of last_user_ts can be many minutes stale, and a send outside the
    # window fails at Graph with 131047 — after we'd already have written the turn.
    age = int(time.time()) - last_user_ts
    if age > SERVICE_WINDOW_SEC:
        return {'ok': False, 'outside_window': True,
                'error': (f'Their last message was {age // 3600}h ago. WhatsApp only allows '
                          'free-form replies within 24 hours of the client writing to us. '
                          'Use an approved template in the WhatsApp Business Inbox instead.')}

    if not _send_text(wa_id, text):
        return {'ok': False, 'error': 'WhatsApp rejected the message — check the CloudWatch logs.'}

    # Strictly after a confirmed send. Recording first would leave a turn in the
    # transcript that the client never actually received, which is worse than a
    # lost reply: staff would read it as delivered.
    _append_turn(wa_id, 'agent', text, agent=who)
    _set_paused(wa_id, True, who)
    print(f'[AGENT] {who} replied to {_mask(wa_id)} ({len(text)} chars)')
    return {'ok': True}


def _agent_set_paused(event):
    wa_id = (event.get('wa_id') or '').strip()
    who = (event.get('agent') or 'staff').strip()
    if not wa_id:
        return {'ok': False, 'error': 'wa_id is required.'}
    paused = bool(event.get('paused'))
    if not _set_paused(wa_id, paused, who):
        return {'ok': False, 'error': 'Could not update this conversation.'}
    print(f'[AGENT] {who} set paused={paused} on {_mask(wa_id)}')
    return {'ok': True, 'paused': paused}


def _mask(wa_id):
    """Last 4 digits only — CloudWatch retention on this account is indefinite and
    an audit line does not need the client's whole phone number."""
    s = str(wa_id or '')
    return '***' + s[-4:] if len(s) >= 4 else '***'


# ──────────────────────────────────────────────────────────────────────────────
def lambda_handler(event, context):
    # The async worker invoke has no httpMethod — check it before any HTTP parsing.
    if event.get('action') == 'wa_process':
        return _worker(event)
    # Invoked synchronously by staffAuth, which has already authenticated the
    # colleague. Never reachable from the Function URL: Meta's requests are HTTP
    # POSTs with a body, and _handle_webhook is the only thing that reads those.
    if event.get('action') == 'wa_agent_send':
        return _agent_send(event)
    if event.get('action') == 'wa_set_paused':
        return _agent_set_paused(event)
    if event.get('action') == 'wa_prompt_info':
        return _agent_prompt_info(event)

    method = _http_method(event)
    if method == 'GET':
        return _handle_verify(event)
    if method == 'POST':
        try:
            return _handle_webhook(event)
        except Exception as e:
            # 500 so Meta retries, and so the error alarm fires.
            print(f'[WEBHOOK] unhandled: {e}')
            return {"statusCode": 500, "body": "error"}
    return {"statusCode": 405, "body": "method not allowed"}
