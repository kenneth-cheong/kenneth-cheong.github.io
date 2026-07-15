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

DynamoDB tables (region ap-southeast-1):
  wa_dedupe         PK: msg_id (S), TTL ttl  — at-least-once delivery guard, ~24h
  wa_conversations  PK: wa_id  (S), TTL ttl  — rolling chat context, ~30d

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

# Layer 1: deterministic. No LLM involved, so it cannot be argued out of it.
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
SYSTEM_PROMPT = """You are MediaOne's WhatsApp FAQ assistant. MediaOne is a digital marketing agency in Singapore (SEO, paid ads, social media, content).

SCOPE POLICY — ABSOLUTE: You have NO access to any client's account, campaign, ranking, spend, invoice, contract or timeline data. Not limited access. NONE. There is no tool you can call to get it, so do not try. Any such number, date or status you produced would be fabricated. If you are asked anything account-specific, escalate to a human — do not apologise and then guess anyway.

ABOUT THE SNIPPETS: The knowledge-base snippets below were retrieved by semantic similarity, and similarity is NOT relevance. They are frequently about a DIFFERENT question than the one asked. Judge for yourself whether they actually answer THIS question. If they do not, escalate — do NOT force-fit a near-miss snippet into an answer. Answering "how much does SEO cost" with a snippet about paid advertising is exactly the failure to avoid.

GROUNDING: Never state a price, timeline, percentage, guarantee or metric that is not written verbatim in a snippet. General marketing explanation is fine. Inventing specifics is not.

STYLE: WhatsApp — warm, plain, brief. Two short paragraphs at most. No markdown, no bullet lists, no headings.

Reply with a JSON object and nothing else:
{"reply": "<your message to the user>", "escalate": <true|false>, "reason": "<why, if escalating>"}

Set escalate=true when: the question is account-specific; the snippets do not genuinely answer it; you would have to guess a specific fact; or the person asks for a human. When escalate=true the reply field is discarded, so do not labour over it."""


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
def _append_turn(wa_id, role, text, touch_user_ts=False):
    """Atomic list_append. NOT read-modify-write: two messages arriving together
    run as two concurrent workers, and RMW silently drops one of the turns."""
    now = int(time.time())
    turn = {'role': role, 'text': (text or '')[:MAX_TURN_CHARS], 'ts': now}
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


def _get_convo(wa_id):
    try:
        item = (_ddb.Table(CONVO_TABLE).get_item(Key={'wa_id': wa_id}) or {}).get('Item') or {}
    except Exception as e:
        print(f'[CONVO] read failed for {wa_id}: {e}')
        return [], 0
    turns = (item.get('turns') or [])[-MAX_TURNS:]
    return turns, int(item.get('last_user_ts') or 0)


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


def _ask_deepseek(question, kb_matches, turns):
    if not DEEPSEEK_API_KEY:
        print('[LLM] DEEPSEEK_API_KEY not configured')
        return None
    messages = [{'role': 'system', 'content': SYSTEM_PROMPT}]
    for t in turns[:-1]:      # history, excluding the turn we just appended
        messages.append({'role': 'assistant' if t.get('role') == 'assistant' else 'user',
                         'content': t.get('text') or ''})
    messages.append({'role': 'user',
                     'content': f"KNOWLEDGE-BASE SNIPPETS:\n{_kb_block(kb_matches)}\n\n"
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


def _ask_haiku_vision(caption, image_b64, mime, kb_matches):
    """Images go to Haiku — DeepSeek is text-only. Mirrors the routing shim at
    monday_lambda.py:3185-3212, and the backup-key retry at 4150-4165."""
    if not ANTHROPIC_API_KEY:
        print('[LLM] ANTHROPIC_API_KEY not configured')
        return None
    payload = {
        'model': VISION_MODEL,
        'max_tokens': 700,
        'system': SYSTEM_PROMPT,
        'messages': [{'role': 'user', 'content': [
            {'type': 'image', 'source': {'type': 'base64', 'media_type': mime, 'data': image_b64}},
            {'type': 'text', 'text': f"KNOWLEDGE-BASE SNIPPETS:\n{_kb_block(kb_matches)}\n\n"
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


def _escalate(wa_id, question, reason, turns=None):
    lines = [f'*WhatsApp escalation* — +{wa_id}',
             f'*Reason:* {reason}',
             f'*Their message:* {question[:600]}']
    if turns:
        recent = ' | '.join(f"{t.get('role')}: {(t.get('text') or '')[:120]}" for t in turns[-4:])
        lines.append(f'*Recent context:* {recent}')
    lines.append('_Reply to them in the WhatsApp Business Inbox._')
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
    turns, last_user_ts = _get_convo(wa_id)

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

    # Layer 1 — deterministic, before any LLM or KB spend.
    if ACCOUNT_SPECIFIC_RE.search(question):
        print(f'[WORKER] {msg_id} matched the account-specific pre-filter — escalating')
        _send_text(wa_id, ESCALATION_REPLY)
        _append_turn(wa_id, 'assistant', ESCALATION_REPLY)
        _escalate(wa_id, question, 'account-specific question (deterministic pre-filter)', turns)
        _mark_replied(msg_id)
        return {'ok': True, 'escalated': True}

    kb = _kb_search(question) if question else []

    if mtype == 'image':
        b64, mime = _fetch_media((msg.get('image') or {}).get('id'))
        result = _ask_haiku_vision(question, b64, mime, kb) if b64 else None
    else:
        # No snippets at all -> nothing to ground on. Fail closed to a human.
        result = _ask_deepseek(question, kb, turns) if kb else None
        if not kb:
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
def lambda_handler(event, context):
    # The async worker invoke has no httpMethod — check it before any HTTP parsing.
    if event.get('action') == 'wa_process':
        return _worker(event)

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
