# whatsappBot — deploy

WhatsApp Cloud API webhook for MediaOne client support / FAQ.
Region: `ap-southeast-1`, account `167633412846`.

## ✅ This package bundles NO dependencies — a single-file zip is SAFE

`urllib3`, `boto3`, `hmac`, `hashlib`, `base64` are all in the python3.13 runtime.
There is nothing at the zip root but `lambda_function.py`.

**Do NOT apply the download-unzip-repack "safe deploy recipe" from
`lambdas/socialMediaAudit/DEPLOY.md` here.** That recipe exists only because that
function bundles `requests` next to its handler, so a bare zip wipes its deps.
This function deliberately uses `urllib3` instead precisely so that whole class of
drift cannot happen. Deploy is just:

```bash
cd lambdas/whatsappBot
zip -q whatsappBot.zip lambda_function.py
aws lambda update-function-code --region ap-southeast-1 \
  --function-name whatsappBot --zip-file fileb://whatsappBot.zip
aws lambda wait function-updated --region ap-southeast-1 --function-name whatsappBot
```

Keep it that way: if you ever need a library that isn't in the runtime, prefer
rewriting the call in `urllib3` over bundling.

## DEPLOYED (2026-07-15) — live resources

| | |
|---|---|
| Lambda | `whatsappBot` (python3.13, timeout 120, mem 256, reserved concurrency 10) |
| Role | `whatsappBot-role` (AWSLambdaBasicExecutionRole + inline `whatsappBot-ddb-selfinvoke`) |
| Function URL | `https://qiiqig6wcrmkxlknp3nomiomdm0athvb.lambda-url.ap-southeast-1.on.aws/` |
| DynamoDB | `wa_dedupe` (PK msg_id, TTL ttl), `wa_conversations` (PK wa_id, **no TTL**), `dm-bot-prompts` (PK prompt_id, no TTL), `dm-client-directory` (PK wa_id, no TTL) |
| Meta app | **MediaOne Client Support**, App ID `2034376497168449`, unpublished |
| Business portfolio | MediaOne Business Group (`1538686332865690`), verification complete |
| Test number | `+1 555 617 9696`, Phone number ID `253052104567619` |
| WABA ID | `239474995927242` |
| Graph version | **v25.0** (what the Meta console emits; not the repo's usual v23.0) |

Webhook verified 2026-07-15 (`[VERIFY] handshake ok`), subscribed to `messages` only.
Meta's own signed sample payload validated against `_verify_signature` on the first
try — the raw-body/base64 handling is confirmed correct against a real Meta signer,
not just against our own test harness.

`WA_ACCESS_TOKEN` is set (confirmed live 2026-07-16) — an earlier revision of this
file said it was outstanding; it isn't, and the bot can send. `WA_ALLOWED_WA_IDS`
is still populated, so the bot only talks to the listed test number. **Clearing it
is what opens the bot to the public** — see §7.

## Architecture in one paragraph

Meta POSTs to a Lambda Function URL. The webhook path verifies the
`X-Hub-Signature-256` HMAC, drops delivery receipts, claims the message id in
`wa_dedupe`, async self-invokes itself, and returns 200 — all in well under a
second. The worker invocation does the slow part: searches the knowledge base via
the `monday` Lambda, asks DeepSeek (or Haiku for images), and sends the reply.
**The split exists because Meta retries any webhook that is slow to ACK**, which
would double-message the client and eventually get the subscription throttled.

## 1. DynamoDB tables

```bash
aws dynamodb create-table --region ap-southeast-1 \
  --table-name wa_dedupe \
  --attribute-definitions AttributeName=msg_id,AttributeType=S \
  --key-schema AttributeName=msg_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
aws dynamodb update-time-to-live --region ap-southeast-1 \
  --table-name wa_dedupe --time-to-live-specification "Enabled=true,AttributeName=ttl"

aws dynamodb create-table --region ap-southeast-1 \
  --table-name wa_conversations \
  --attribute-definitions AttributeName=wa_id,AttributeType=S \
  --key-schema AttributeName=wa_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
# NO TTL on this one — see "Retention" below. wa_dedupe keeps its 24h TTL; that one is a
# delivery guard, not a record.

# Staff-editable prompt blocks. NO TTL — a prompt that quietly expired would
# revert the bot's wording with nobody touching anything.
aws dynamodb create-table --region ap-southeast-1 \
  --table-name dm-bot-prompts \
  --attribute-definitions AttributeName=prompt_id,AttributeType=S \
  --key-schema AttributeName=prompt_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

`dm-bot-prompts` needs no seeding: the bot writes its own code defaults into any
missing block the first time it reads (`_seed_prompt`), which is also what gives
index.html's "Restore built-in wording" something to restore (`default_text`).

## 2. IAM

Exec role `whatsappBot-role` needs `AWSLambdaBasicExecutionRole` plus an inline
policy granting:
- `dynamodb:PutItem/GetItem/UpdateItem/DeleteItem` on `wa_dedupe` + `wa_conversations`
- `dynamodb:GetItem/PutItem` on `dm-bot-prompts` (read the staff-edited prompt;
  PutItem only for the first-read seed). **Optional by design** — without it the
  bot logs `[PROMPT] read failed … using the code default` and answers normally
  off the compiled-in prompt. Verified live 2026-07-16.
- `lambda:InvokeFunction` on **itself** (the worker self-invoke). Without this the
  webhook releases every claim and 500s, and Meta retries forever.

`staffAuth-role` needs a matching inline policy (`staffAuth-bot-prompts-invoke`):
- `dynamodb:GetItem/PutItem` on `dm-bot-prompts` — the editor's read/save
- `lambda:InvokeFunction` on `whatsappBot` — how a staff reply or a pause toggle
  reaches the bot

> Note what staffAuth deliberately does NOT get: any write on `wa_conversations`,
> and any Graph credential. It is an internet-facing API with `Access-Control-
> Allow-Origin: *`. Every send and every turn write happens inside `whatsappBot`,
> reached by invoke, so `WA_ACCESS_TOKEN` exists in exactly one function. Don't
> collapse the hop "for simplicity".

## 3. Create the function

```bash
aws lambda create-function --region ap-southeast-1 \
  --function-name whatsappBot \
  --runtime python3.13 --handler lambda_function.lambda_handler \
  --timeout 120 --memory-size 256 \
  --role arn:aws:iam::167633412846:role/whatsappBot-role \
  --zip-file fileb://whatsappBot.zip
```

Timeout 120s is for the **worker** path (LLM). The webhook path returns in
milliseconds and never approaches it.

Reserved concurrency caps a retry storm:

```bash
aws lambda put-function-concurrency --region ap-southeast-1 \
  --function-name whatsappBot --reserved-concurrent-executions 10
```

## 4. Function URL

`AuthType: NONE` is correct here, not a compromise: **the HMAC signature is the
authentication**, and Meta cannot sign SigV4 — there is no AWS credential on
their side. Any webhook endpoint is public by construction; the same is true of
the Stripe webhook in `saas/backend`.

> ### ⚠️ You need TWO permission statements, not one
> This is the single biggest trap here, and it cost this repo a whole REST API
> once already (see `lambdas/socialMediaAudit/DEPLOY.md`, which recorded the
> symptom as "Function URLs are blocked at the account level" — they are not).
>
> With only the first statement below, **every** request, including the GET
> handshake, is rejected by Lambda's own auth layer with:
> ```
> {"Message":"Forbidden. For troubleshooting Function URL authorization issues,
>  see: https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html"}
> ```
> ...before it ever reaches `lambda_function.py`. It looks exactly like an
> account-level block. It isn't. Verified live 2026-07-15.

```bash
aws lambda create-function-url-config --region ap-southeast-1 \
  --function-name whatsappBot --auth-type NONE

# (1) lets the URL accept the request
aws lambda add-permission --region ap-southeast-1 \
  --function-name whatsappBot \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl --principal '*' \
  --function-url-auth-type NONE

# (2) lets that request actually invoke the function. WITHOUT THIS: Forbidden.
aws lambda add-permission --region ap-southeast-1 \
  --function-name whatsappBot \
  --statement-id FunctionURLInvokeAllowPublicAccess \
  --action lambda:InvokeFunction --principal '*' \
  --invoked-via-function-url
```

The resulting policy must have both, matching what SAM emits for
`digimetrics-saas-ChatStreamFn` (a working public Function URL in this account):

```
lambda:InvokeFunctionUrl | {'lambda:FunctionUrlAuthType': 'NONE'}
lambda:InvokeFunction    | {'lambda:InvokedViaFunctionUrl': 'true'}
```

Note the returned URL — it goes in the Meta dashboard.

## 5. Env vars

```bash
aws lambda update-function-configuration --region ap-southeast-1 \
  --function-name whatsappBot \
  --environment "Variables={WA_VERIFY_TOKEN=xxx,WA_APP_SECRET=xxx,\
WA_ACCESS_TOKEN=xxx,WA_PHONE_NUMBER_ID=xxx,\
DEEPSEEK_API_KEY=xxx,ANTHROPIC_API_KEY=xxx,\
GCHAT_WEBHOOK_URL=https://chat.googleapis.com/...,\
WA_ALLOWED_WA_IDS=6591234567}"
```

| Var | Where it comes from |
|---|---|
| `WA_VERIFY_TOKEN` | invent one (`openssl rand -hex 16`); must match the dashboard |
| `WA_APP_SECRET` | Meta app → Settings → Basic → App Secret → Show |
| `WA_ACCESS_TOKEN` | **System User token, expiry Never** — see the warning below |
| `WA_PHONE_NUMBER_ID` | WhatsApp → API Setup |
| `WA_GRAPH_VERSION` | optional, default `v23.0` |
| `WA_ALLOWED_WA_IDS` | comma-separated allowlist. **Empty = everyone.** Set it while testing. |
| `DEEPSEEK_API_KEY` | same key as the `monday` Lambda |
| `ANTHROPIC_API_KEY` | images only; `ANTHROPIC_API_KEY_BACKUP` is retried on 429/529 |
| `GCHAT_WEBHOOK_URL` | the space that receives escalations |
| `KB_SEARCH_URL` | optional, defaults to the `monday` endpoint |
| `KB_SCORE_FLOOR` | optional, default `0.6` (mirrors `monday_lambda.py:86`) |
| `WA_PROMPT_TABLE` | optional, default `dm-bot-prompts` — the staff-editable prompt |

Every var **fails closed** if unset — no code path falls back to a literal
credential. Keep real values out of this file; `.gitguardian.yaml` scanning is on.

> ### ⚠️ `WA_ACCESS_TOKEN` must be a System User token with expiry **Never**
> The 24-hour token on the API Setup page is fine for one smoke test and nothing
> else. This repo has already been burned by expiring Meta tokens silently killing
> a scheduled job — see the `META_ACCESS_TOKEN` note in
> `lambdas/socialMediaAudit/DEPLOY.md`. Generate from Business Settings → Users →
> System Users → Add → assign the app → Generate token with
> `whatsapp_business_messaging` + `whatsapp_business_management`, expiry **Never**.

## 6. Meta dashboard

1. developers.facebook.com → **Create App** → type **Business**.
   **Not** the existing "Media Buy" app (`1116760423638082`) — its overdue Annual
   Data Use Checkup is disrupting that app's API access, and WhatsApp would
   inherit the problem.
2. **Add product → WhatsApp → Set up.** Creates a test WABA + a free test number.
   Note the **Phone number ID**.
3. **API Setup** → add your mobile as a verified recipient (test numbers reach 5).
4. **App Settings → Basic → App Secret → Show** → `WA_APP_SECRET`.
5. Generate the System User token (see warning above) → `WA_ACCESS_TOKEN`.
6. Deploy steps 1–5 above first — the next step needs a live endpoint.
7. **WhatsApp → Configuration → Webhook → Edit.** Callback URL = the Function URL,
   Verify token = `WA_VERIFY_TOKEN` → **Verify and save** (fires the GET handshake).
8. **Webhook fields → Manage → subscribe to `messages` only.** Unsubscribed fields
   never arrive, which is cheaper than filtering them.

## 7. Going live on MediaOne's real number — ⚠️ IRREVERSIBLE

Prove the bot on the test number first. When you're ready:

**A number already active on the WhatsApp Business app must be deleted from that
app before it can join the Cloud API. That wipes its chat history on the app and
cannot be undone.** Both cannot run on the same number. Schedule it deliberately;
it is not part of a routine deploy.

Then: Business Settings → WhatsApp Accounts → Add phone number, verify by
SMS/voice, update `WA_PHONE_NUMBER_ID`, and clear `WA_ALLOWED_WA_IDS`.

Also confirm current **service-conversation pricing** in the dashboard before
launch — Meta reprices this periodically.

## 8. Verify

```bash
URL=https://<your-function-url>.lambda-url.ap-southeast-1.on.aws
TOK=<WA_VERIFY_TOKEN>

# 1. handshake -> prints exactly: abc123  (no quotes)
curl -s "$URL?hub.mode=subscribe&hub.verify_token=$TOK&hub.challenge=abc123"; echo

# 2. wrong token -> 403
curl -s -o /dev/null -w '%{http_code}\n' "$URL?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123"

# 3/4. signed vs tampered POST — see the harness note below
```

The full local harness (signature, dedupe, claim-release, stale-window, the
guardrails against the real KB + DeepSeek) is not committed; it stubs DynamoDB and
the Graph API and runs the handler in-process. Reproduce with:
`python3 -c "import lambda_function"` after stubbing `boto3`, or re-derive from the
verify table in the plan.

Live checks after the webhook is connected:

| Test | Expect |
|---|---|
| message from your phone | reply arrives in-app |
| send an image | Haiku describes it |
| "how much does SEO cost?" | must **not** pivot to a paid-ads pitch (see below) |
| "what's my campaign ROI this month?" | escalation + a Google Chat post, never a number |
| CloudWatch `Duration`, webhook path | <200ms warm — the fast-ACK proof |

## Retention — conversations are KEPT (changed 2026-07-16)

`wa_conversations` had a 30-day TTL from the last message. It no longer does: TTL is
**disabled on the table** and the code writes no `ttl` attribute (`CONVO_TTL_SEC = None`).

Why it changed: a 30-day rolling window was fine when this was a read-only viewer. It isn't
now — staff reply from index.html, so a thread is the record of **what MediaOne told a
client**, which is exactly what you want months later in a dispute. And there was no safety
net: PITR **disabled**, no Streams, no backups. An expiry was a permanent, silent loss.

What it costs: client PII now accumulates indefinitely, in a table that **any authenticated
@mediaone.co identity can read** (`staffAuth._require_platform_user` checks identity, not
per-tool grants). If retention ever needs bounding again under PDPA, bound it deliberately —
Streams → Lambda → S3 on the way out — rather than reinstating a TTL that deletes into the
void. Do not simply re-enable TTL.

Staff can pull a single conversation out as plain text (Transcript button in the
conversation header). The CSV export next to it is the LIST only — numbers, counts, a
120-char preview — not the messages.

## The prompt is staff-editable — what that does and does not cover

Staff edit the prompt from index.html → Others → WhatsApp Support Logs → **Bot
prompt**. Saves land in `dm-bot-prompts` and go live within ~60s (the bot's
per-container `PROMPT_CACHE_TTL`). There is no deploy step and no approval step.

The prompt is assembled at runtime from three pieces, and only the first two are
editable:

| Block | Editable | Shared with the client portal bot? |
|---|---|---|
| `shared_persona` — identity, tone, anti-fabrication | yes | **that's the intent** |
| `whatsapp_scope` — "no account data", snippet warning, WhatsApp style | yes | no |
| `FIXED_CONTRACT` — the JSON envelope + escalate triggers | **no** | no |

`FIXED_CONTRACT` is concatenated on by `_system_prompt()` every time. It is not
editable because breaking it breaks `_parse_llm_json()` — every reply would then
fail closed to a human — and because deleting the escalate triggers would quietly
disable Layer 3 of the anti-fabrication design below. `ESCALATION_REPLY` is not
editable either: `staffAuth._wa_summary` exact-matches that string to decide
whether a conversation shows as Escalated.

Anything unreadable, blank or oversized falls back to the compiled-in default per
block, so a DynamoDB outage cannot drop the scope policy and leave the bot free to
guess.

### Follow-up: wiring `shared_persona` into the client portal bot

Not built yet — the AWS side shipped first. The client portal is a **separate
repo and stack** (`github.com/anmediaone/client_portal`: FastAPI + Postgres on
EC2, Firebase-hosted SPAs, manual deploys, no CI). The intended shape:

1. The portal fetches `shared_persona` **server-side** from `staffAuth` and folds
   it into `_effective_instructions()` (`app/services/ai_assistant_manager_service.py`),
   cached ~5min, **failing open** to today's behaviour if unreachable.
2. Server-side, not browser-side: the portal API is `http://54.254.199.252:8000`,
   and an HTTPS page cannot call it (mixed content). The portal already calls out
   to an AWS Lambda this way (`endpoints/analytics.py`), so the path is proven.
3. `staffAuth` will need a machine-auth read action — the portal has no staff
   token. `INTERNAL_API_KEY` already exists there for Lambda↔portal calls.

**Only `shared_persona` transfers.** Do NOT ship `whatsapp_scope` to the portal:
it asserts the bot has no client data, and the portal bot genuinely *does* have it
via its `query_campaign_data` tool. That block there would be a lie that makes it
refuse questions it can actually answer. And the portal's own prompt has a
separate, non-overridable `_RUNTIME_TOOL_POLICY_SUFFIX`, so the shared block must
be additive, never a replacement.

## Staff replies and the bot handoff

Staff reply from the same tool. `staffAuth.wa_send_message` → invoke
`whatsappBot {action:"wa_agent_send"}` → Graph. Turns land with `role:"agent"`
(never `assistant` — the transcript must not credit a colleague's words to the
bot) plus the sender in `turn.agent`.

Two rules the UI depends on:

- **24h service window.** Meta only allows a free-form reply within 24h of the
  client's last inbound message; past that Graph rejects it with **131047** and
  you need an approved template from the Business Inbox. Enforced in
  `_agent_send` against `last_user_ts`, *not* only in the browser, whose clock
  drifts while the page sits open. The turn is written only after Graph accepts,
  so a rejected send never leaves a message in the transcript that the client
  never got.
- **`bot_paused`.** Set automatically on **every escalation** (we've just promised
  a human will follow up — the bot must stop) and on any staff reply. While
  paused the worker records inbound messages and still pings Google Chat, but
  does not reply. Cleared only by a human, from index.html.

The trade-off in auto-pausing on escalation: a client whose account question was
escalated will *not* get an auto-answer to their next question either, until
someone resumes the bot. That is deliberate — the alternative is the bot talking
over a colleague mid-conversation — but it means escalations now need someone to
actually pick them up. Watch the "You reply" pill in the tool.

## Why the guardrails are three layers, not a prompt

The KB retriever returns **confident false matches**. Verified live 2026-07-15:
`"how much does SEO cost"` returns *"Is it necessary to do paid ads when I am doing
SEO?"* at score **0.79** — well above the 0.6 floor — and none of the top matches
contain a price at all. A model told to "ground your answer in these snippets"
will answer a pricing question with a paid-ads pitch.

So: (1) a deterministic regex escalates account-specific questions before any LLM
runs; (2) the system prompt states outright that the snippets may be irrelevant and
must not be force-fitted; (3) the user-facing escalation text is a **compile-time
constant** — on escalation the model's `reply` is discarded, so it cannot invent a
response time or a colleague's name. The bot **fails closed to a human** on an LLM
error, unparseable JSON, or zero KB matches — never to an improvised answer.

If you loosen any of these, re-run the `"how much does SEO cost?"` check.
