import json
import requests
import os
import re
import base64
import time
import hashlib
import traceback
from datetime import datetime, timezone, timedelta
from pymongo import MongoClient, UpdateOne

SGT = timezone(timedelta(hours=8))  # Singapore time, for error-report display


def _fmt_sgt(dt_str):
    """Render an ISO timestamp (UTC 'Z', offset, or naive=UTC) as Singapore time."""
    try:
        d = datetime.fromisoformat(str(dt_str).replace('Z', '+00:00'))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
    except Exception:
        d = datetime.now(timezone.utc)
    return d.astimezone(SGT).strftime('%Y-%m-%d %H:%M:%S SGT')
from bson import ObjectId

def clean_email(raw):
    """Extract a bare email address from a value that may be wrapped in escaped
    quotes/backslashes (clientEmail in localStorage sometimes is). Returns a
    lowercased address, or 'unknown' when none is found."""
    if not raw:
        return 'unknown'
    m = re.search(r'[\w.+-]+@[\w-]+\.[\w.-]*[\w]', str(raw))
    return m.group(0).lower() if m else 'unknown'


def ahrefs_bare_domain(raw):
    """Reduce any user/LLM-supplied target to a bare registrable host for Ahrefs.

    Handles full URLs (strips scheme + path + query), 'www.', ports and stray
    whitespace. NOTE: never use str.lstrip('https://') for this — lstrip strips a
    *character set*, so 'shinesecurity.sg'.lstrip('https://') => 'inesecurity.sg'.
    """
    if not raw:
        return ""
    host = str(raw).strip()
    # If it looks like a URL (has a scheme or a path), parse out the netloc.
    if "//" in host:
        host = host.split("//", 1)[1]
    # Drop anything after the first '/', '?' or '#'.
    for sep in ("/", "?", "#"):
        host = host.split(sep, 1)[0]
    host = host.strip().lower()
    if host.startswith("www."):
        host = host[4:]
    # Strip an explicit port (example.com:443).
    host = host.split(":", 1)[0]
    return host

MONDAY_API_KEY = os.environ.get('MONDAY_API_KEY') or os.environ.get('MONDAY_TOKEN')
MONDAY_API_URL = "https://api.monday.com/v2"
SERANKING_TOKEN = os.environ.get('SERANKING_TOKEN') or "4181980cafdc89bc7bd8c7e9d26725f18cd617ef"
DATAFORSEO_API_KEY = os.environ.get('DATAFORSEO_API_KEY') or os.environ.get('API_KEY')
AHREFS_API_KEY = os.environ.get('AHREFS_API_KEY')
# Moz Domain/Page Authority — same endpoint the standalone SEO tools use
MOZ_API_URL = os.environ.get('MOZ_API_URL') or "https://a7hptjtc8e.execute-api.ap-southeast-1.amazonaws.com/new"
# Google Chat webhook for automated client-side error reports (set via env, never hardcoded)
GCHAT_WEBHOOK_URL = os.environ.get('GCHAT_WEBHOOK_URL', '')
_error_report_recent = {}  # signature -> epoch, per-container dedup so crash loops don't flood chat

# TikTok Marketing API config
TIKTOK_APP_ID = os.environ.get('TIKTOK_APP_ID') or "7530162592132792321"
TIKTOK_APP_SECRET = os.environ.get('TIKTOK_APP_SECRET') or "622e73187d25951998792c27e8c85c9ec1c6a831"
TIKTOK_API_BASE = "https://business-api.tiktok.com/open_api/v1.3"

# MongoDB Config
MONGODB_URI = os.environ.get('MONGODB_URI')
MONGODB_DATABASE = 'monday_db'
mongo_client = None

# Knowledge Base (RAG) Config
KB_COLLECTION   = 'knowledge_base'
KB_VECTOR_INDEX = 'kb_vector_index'
KB_EMBED_MODEL  = os.environ.get('KB_EMBED_MODEL', 'text-embedding-3-small')
KB_EMBED_DIMS   = 1536
KB_WRITE_KEY    = os.environ.get('KB_WRITE_KEY')   # shared secret for the Apps Script sync
KB_SCORE_FLOOR  = float(os.environ.get('KB_SCORE_FLOOR', '0.6'))  # cosine vectorSearchScore (0..1)

def get_db():
    global mongo_client
    if mongo_client is None:
        if not MONGODB_URI:
            return None
        try:
            mongo_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
            mongo_client.admin.command('ping')
        except Exception as e:
            print(f"MongoDB connection error: {str(e)}")
            return None
    return mongo_client[MONGODB_DATABASE]


def forward_error_report(body, event):
    """Forward a client-side error report to the team Google Chat space.
    Bounded by a per-container dedup throttle + field truncation so a crash
    loop can't flood the space. Returns a Lambda proxy response dict."""
    def _trunc(v, n):
        s = '' if v is None else str(v)
        return s if len(s) <= n else s[:n] + ' …[truncated]'

    if not GCHAT_WEBHOOK_URL:
        return {"statusCode": 500, "body": json.dumps({"error": "GCHAT_WEBHOOK_URL not configured"})}

    app_name = _trunc(body.get('app', 'unknown'), 80)
    user     = _trunc(body.get('user', 'anonymous'), 200)
    fn       = _trunc(body.get('function', 'unknown'), 200)
    inputs   = _trunc(body.get('inputs', ''), 3000)
    error    = _trunc(body.get('error', ''), 2000)
    stack    = _trunc(body.get('stack', ''), 1500)
    api_resp = _trunc(body.get('apiResponse', ''), 3000)
    dt       = _trunc(body.get('datetime', ''), 60)
    page_url = _trunc(body.get('url', ''), 400)
    ua       = _trunc(body.get('userAgent', ''), 300)

    now = time.time()
    for k in [k for k, v in list(_error_report_recent.items()) if now - v > 60]:
        _error_report_recent.pop(k, None)
    sig = hashlib.sha1(f'{app_name}|{fn}|{error}'.encode('utf-8', 'ignore')).hexdigest()
    if _error_report_recent.get(sig) and now - _error_report_recent[sig] < 60:
        return {"statusCode": 200, "body": json.dumps({"status": "deduped"})}
    _error_report_recent[sig] = now

    text = (
        f"🐞 *Error report — {app_name}*\n"
        f"*User:* {user}\n"
        f"*Function:* `{fn}`\n"
        f"*When:* {_fmt_sgt(dt)}\n"
        f"*Error:* {error}\n"
    )
    if inputs:   text += f"*Inputs:*\n```\n{inputs}\n```\n"
    if api_resp: text += f"*API return:*\n```\n{api_resp}\n```\n"
    if stack:    text += f"*Stack:*\n```\n{stack}\n```\n"
    if page_url: text += f"*Page:* {page_url}\n"
    if ua:       text += f"_{ua}_"

    try:
        r = requests.post(GCHAT_WEBHOOK_URL, json={"text": text}, timeout=10)
        if r.status_code < 300:
            return {"statusCode": 200, "body": json.dumps({"status": "sent"})}
        return {"statusCode": 502, "body": json.dumps({"error": f"gchat HTTP {r.status_code}", "detail": r.text[:300]})}
    except Exception as e:
        return {"statusCode": 502, "body": json.dumps({"error": str(e)})}


def _report_tool_failures(content_blocks, tool_results, messages, body, event=None):
    """Report ANY failed tool call inside a chatbot turn to Google Chat.

    The model usually recovers from a tool error (it's fed back as a tool_result),
    so these never surface to the frontend — this gives visibility into every
    flaky tool (DataForSEO, Moz, Ahrefs, SE Ranking, GSC/GA4/Ads, Meta/LinkedIn/
    TikTok, monday_graphql, KB search, …). Captures the tool's own arguments plus
    the user's prompt as inputs. Best-effort; never raises into the chat flow."""
    if not GCHAT_WEBHOOK_URL:
        return
    meta = {}  # tool_use_id -> (tool_name, tool_input args)
    for b in content_blocks or []:
        if isinstance(b, dict) and b.get("type") == "tool_use":
            meta[b.get("id")] = (b.get("name", "unknown"), b.get("input", {}))
    user_prompt = ""
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            user_prompt = m["content"]
            break
    for tr in tool_results or []:
        if not isinstance(tr, dict):
            continue
        content = tr.get("content")
        content_str = content if isinstance(content, str) else json.dumps(content)
        err_text = None
        if tr.get("is_error"):
            err_text = content_str
        else:
            # Some handlers signal failure via {"error": ...} content without is_error.
            try:
                parsed = json.loads(content_str)
                if isinstance(parsed, dict) and parsed.get("error"):
                    err_text = json.dumps(parsed.get("error"))
            except Exception:
                pass
        if not err_text:
            continue
        name, targs = meta.get(tr.get("tool_use_id"), ("unknown", {}))
        try:
            inputs_blob = json.dumps({"tool_args": targs, "user_prompt": user_prompt[:600]})
        except Exception:
            inputs_blob = str(targs)
        try:
            _r = forward_error_report({
                "app":         body.get("app_source", "chatbot"),
                "user":        body.get("client_email") or "anonymous",
                "function":    f"tool:{name}",
                "inputs":      inputs_blob,
                "error":       err_text[:1500],
                "apiResponse": content_str[:2500],
                "datetime":    datetime.now().isoformat(),
                "url":         body.get("app_source", ""),
            }, event)
            print(f"[tool-report] tool:{name} failed -> gchat {(_r or {}).get('statusCode')}")
        except Exception as _e:
            print(f"[tool-report] skipped {name}: {_e}")


class JSONEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, ObjectId): return str(o)
        if isinstance(o, datetime): return o.isoformat()
        return super(JSONEncoder, self).default(o)

def get_clean_openai_key(body):
    raw_key = body.get('openai_key') or os.environ.get('OPENAI_API_KEY') or os.environ.get('GPT_KEY')
    if not raw_key or str(raw_key).lower() in ["null", "undefined", ""]:
        raw_key = os.environ.get('GPT_KEY') or os.environ.get('OPENAI_API_KEY')
    if not raw_key:
        return None
    s_key = str(raw_key).strip()
    if s_key.lower().startswith('bearer '):
        s_key = s_key[7:].strip()
    s_key = s_key.replace('"', '').replace("'", "")
    if len(s_key) > 8:
        print(f"[DEBUG] Using Key: {s_key[:4]}...{s_key[-4:]}")
    return s_key

# ── Knowledge Base (RAG) helpers ──────────────────────────────────────────────

def embed_texts(texts, body=None):
    """Embed a list of strings via OpenAI embeddings. Returns a list of vectors."""
    key = get_clean_openai_key(body or {})
    if not key:
        raise RuntimeError("OpenAI key missing for embeddings")
    out = []
    for i in range(0, len(texts), 100):   # API accepts batches; 100 is comfortable
        chunk = texts[i:i + 100]
        r = requests.post(
            "https://api.openai.com/v1/embeddings",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": KB_EMBED_MODEL, "input": chunk},
            timeout=60
        )
        if r.status_code != 200:
            raise RuntimeError(f"Embedding API error {r.status_code}: {r.text[:300]}")
        data = sorted(r.json()["data"], key=lambda d: d["index"])
        out.extend([d["embedding"] for d in data])
    return out

# Rows that EXPOSE a secret (a password value, wifi password, or email+password
# pair) must never be embedded into a client-facing knowledge base. These patterns
# look for a value-bearing leak, not just the word "password" (so legitimate
# "how do I reset my password" Q&As are kept).
_KB_SECRET_PATTERNS = [
    re.compile(r'password\s*(?:is|:|=)\s*\S', re.I),
    re.compile(r'wi-?fi\s+password', re.I),
    re.compile(r'[a-z0-9._%+-]+@[a-z0-9.-]+\.\w+[\s/|,;:-]*password', re.I),
]

def _looks_like_secret(text):
    if not text:
        return False
    return any(p.search(text) for p in _KB_SECRET_PATTERNS)

def _normalize_tags(tags):
    if isinstance(tags, list):
        return [str(t).strip() for t in tags if str(t).strip()]
    if isinstance(tags, str):
        return [t.strip() for t in re.split(r'[;,/]| {2,}', tags) if t.strip()]
    return []

def sync_knowledge_base(body):
    """Ingest Q&A rows from the source Sheet into MongoDB with embeddings.

    Body: { write_key, rows: [{question, answer, tags, sheet_tab}], full_sync? }
    Only rows whose content changed are re-embedded. With full_sync (default True)
    rows no longer present in the Sheet are removed.
    """
    if KB_WRITE_KEY and body.get('write_key') != KB_WRITE_KEY:
        return {"statusCode": 401, "body": json.dumps({"error": "Invalid or missing write_key"})}
    db = get_db()
    if db is None:
        return {"statusCode": 500, "body": json.dumps({"error": "MongoDB unavailable"})}
    coll = db[KB_COLLECTION]

    rows = body.get('rows', [])
    if not isinstance(rows, list):
        return {"statusCode": 400, "body": json.dumps({"error": "'rows' must be a list"})}

    clean = []
    seen_qids = set()
    skipped_secret = 0
    for row in rows:
        q = (row.get('question') or '').strip()
        a = (row.get('answer') or '').strip()
        if not q or not a:
            continue
        if _looks_like_secret(f"{q}\n{a}\n{row.get('tags', '')}"):
            skipped_secret += 1
            continue
        qid = hashlib.sha256(q.lower().encode('utf-8')).hexdigest()[:24]
        if qid in seen_qids:   # de-dupe identical questions within the batch
            continue
        seen_qids.add(qid)
        clean.append({
            "qid":          qid,
            "question":     q,
            "answer":       a,
            "tags":         _normalize_tags(row.get('tags')),
            "sheet_tab":    (row.get('sheet_tab') or row.get('tab') or '').strip(),
            "content_hash": hashlib.sha256((q + "␟" + a).encode('utf-8')).hexdigest(),
        })

    # Only (re)embed rows whose content changed
    existing = {d['qid']: d.get('content_hash') for d in coll.find({}, {"qid": 1, "content_hash": 1})}
    to_embed = [c for c in clean if existing.get(c['qid']) != c['content_hash']]
    if to_embed:
        vectors = embed_texts([f"{c['question']}\n{c['answer']}" for c in to_embed], body)
        for c, v in zip(to_embed, vectors):
            c['embedding'] = v

    now = datetime.utcnow()
    ops = []
    for c in clean:
        update = {
            "question":     c['question'],
            "answer":       c['answer'],
            "tags":         c['tags'],
            "sheet_tab":    c['sheet_tab'],
            "content_hash": c['content_hash'],
            "updated_at":   now,
        }
        if 'embedding' in c:
            update['embedding'] = c['embedding']
        ops.append(UpdateOne({"qid": c['qid']}, {"$set": update}, upsert=True))
    if ops:
        coll.bulk_write(ops, ordered=False)

    deleted = 0
    if body.get('full_sync', True):
        deleted = coll.delete_many({"qid": {"$nin": list(seen_qids)}}).deleted_count

    return {"statusCode": 200, "body": json.dumps({
        "received":       len(rows),
        "synced":         len(clean),
        "embedded":       len(to_embed),
        "skipped_secret": skipped_secret,
        "deleted":        deleted,
    })}

def kb_ensure_index(body):
    """One-time admin: create the Atlas Vector Search index on knowledge_base."""
    if KB_WRITE_KEY and body.get('write_key') != KB_WRITE_KEY:
        return {"statusCode": 401, "body": json.dumps({"error": "Invalid or missing write_key"})}
    db = get_db()
    if db is None:
        return {"statusCode": 500, "body": json.dumps({"error": "MongoDB unavailable"})}
    coll = db[KB_COLLECTION]
    try:
        existing = [i["name"] for i in coll.list_search_indexes()]
    except Exception as e:
        existing = []
        print(f"[KB] list_search_indexes failed: {e}")
    if KB_VECTOR_INDEX in existing:
        return {"statusCode": 200, "body": json.dumps({"status": "exists", "indexes": existing})}
    try:
        from pymongo.operations import SearchIndexModel
        model = SearchIndexModel(
            definition={"fields": [{
                "type": "vector", "path": "embedding",
                "numDimensions": KB_EMBED_DIMS, "similarity": "cosine"
            }]},
            name=KB_VECTOR_INDEX, type="vectorSearch"
        )
        coll.create_search_index(model)
        return {"statusCode": 200, "body": json.dumps({"status": "created", "index": KB_VECTOR_INDEX})}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": f"create_search_index failed: {e}"})}

def search_knowledge_base_db(query, top_k=4, body=None):
    """Semantic search over the knowledge base via Atlas Vector Search."""
    query = (query or '').strip()
    if not query:
        return {"matches": [], "returned": 0, "error": "empty query"}
    db = get_db()
    if db is None:
        return {"matches": [], "returned": 0, "error": "Knowledge base unavailable"}
    try:
        qvec = embed_texts([query], body)[0]
    except Exception as e:
        return {"matches": [], "returned": 0, "error": f"Embedding failed: {e}"}
    try:
        top_k = max(1, min(int(top_k or 4), 10))
    except (TypeError, ValueError):
        top_k = 4
    try:
        pipeline = [
            {"$vectorSearch": {
                "index":         KB_VECTOR_INDEX,
                "path":          "embedding",
                "queryVector":   qvec,
                "numCandidates": 100,
                "limit":         top_k,
            }},
            {"$project": {
                "_id": 0, "question": 1, "answer": 1, "tags": 1, "sheet_tab": 1,
                "score": {"$meta": "vectorSearchScore"},
            }},
        ]
        results = list(db[KB_COLLECTION].aggregate(pipeline))
    except Exception as e:
        return {"matches": [], "returned": 0, "error": f"Vector search failed: {e}"}
    matches = [r for r in results if r.get('score', 0) >= KB_SCORE_FLOOR]
    return {"query": query, "matches": matches, "returned": len(matches)}


def openai_proxy(body):
    openai_key = get_clean_openai_key(body)
    if not openai_key:
        return {"statusCode": 401, "body": json.dumps({"error": "OpenAI Key Missing"})}
    params = body.get('data', body)
    url = f"https://api.openai.com/v1{params.get('endpoint') or body.get('endpoint')}"
    method = params.get('method') or body.get('method', 'POST')
    headers = {
        "Authorization": f"Bearer {openai_key}",
        "OpenAI-Beta": "assistants=v2",
        "Content-Type": "application/json"
    }
    try:
        if method == 'GET':
            r = requests.get(url, headers=headers, timeout=30)
        elif method == 'DELETE':
            r = requests.delete(url, headers=headers, timeout=30)
        else:
            r = requests.post(url, headers=headers, json=params.get('data', body.get('data', {})), timeout=30)
        return {"statusCode": r.status_code, "body": r.text}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def openai_upload(body):
    openai_key = get_clean_openai_key(body)
    params = body.get('data', body)
    content_b64 = params.get('content') or body.get('content')
    if not openai_key or not content_b64:
         return {"statusCode": 400, "body": json.dumps({"error": "Missing key or content"})}
    file_bytes = base64.b64decode(content_b64)
    files = {'file': (params.get('filename') or body.get('filename', 'file.json'), file_bytes), 'purpose': (None, 'assistants')}
    headers = {"Authorization": f"Bearer {openai_key}"}
    try:
        r = requests.post("https://api.openai.com/v1/files", headers=headers, files=files, timeout=60)
        return {"statusCode": r.status_code, "body": r.text}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def download_file(body):
    params = body.get('data', body)
    headers = {"Authorization": MONDAY_API_KEY}
    fileUrl = params.get('fileUrl') or body.get('fileUrl')
    try:
        r = requests.get(fileUrl, headers=headers, timeout=60)
        return {
            "statusCode": 200,
            "body": json.dumps({
                "content": base64.b64encode(r.content).decode('utf-8'),
                "contentType": r.headers.get('Content-Type')
            })
        }
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def google_token_exchange(body):
    params = body.get('data', body)
    code = params.get('code') or body.get('code')
    client_id = params.get('client_id') or body.get('client_id')
    redirect_uri = params.get('redirect_uri') or body.get('redirect_uri', 'postmessage')
    client_secret = os.environ.get('GOOGLE_CLIENT_SECRET')
    if not code or not client_id:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing code or client_id"})}
    if not client_secret:
        return {"statusCode": 500, "body": json.dumps({"error": "GOOGLE_CLIENT_SECRET environment variable not configured"})}
    try:
        r = requests.post('https://oauth2.googleapis.com/token', data={
            'code': code,
            'client_id': client_id,
            'client_secret': client_secret,
            'redirect_uri': redirect_uri,
            'grant_type': 'authorization_code'
        }, timeout=15)
        return {"statusCode": r.status_code, "body": r.text}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def google_refresh_token(body):
    refresh_token = body.get('refresh_token')
    client_id = body.get('client_id')
    client_secret = os.environ.get('GOOGLE_CLIENT_SECRET')
    if not refresh_token or not client_id:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing refresh_token or client_id"})}
    if not client_secret:
        return {"statusCode": 500, "body": json.dumps({"error": "GOOGLE_CLIENT_SECRET environment variable not configured"})}
    try:
        r = requests.post('https://oauth2.googleapis.com/token', data={
            'refresh_token': refresh_token,
            'client_id': client_id,
            'client_secret': client_secret,
            'grant_type': 'refresh_token'
        }, timeout=15)
        return {"statusCode": r.status_code, "body": r.text}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

# ══════════════════════════════════════════════════════════════════════
# Ads Access & Budget Monitor — offline auth + scheduled budget sweep.
#   • ads_offline_authorize: one-time; exchanges an auth code for an MCC
#     refresh token, stored in Mongo (db.google_ads_auth) so the sweep runs
#     headless (no signed-in browser).
#   • ads_budget_sweep: EventBridge {"action":"ads_budget_sweep"} (and
#     on-demand). Reads the team-wide monitor config from the
#     clientContextEngine blob (config.adsBudgetMonitor), pulls MTD spend per
#     enabled account, and posts a Google Chat alert once per threshold-crossing.
#   • ads_test_webhook: sends a "hello" to a webhook so users can verify it.
# ══════════════════════════════════════════════════════════════════════
_ADS_TOKEN_CACHE = {}  # doc _id (email) -> {"token": ..., "exp": ...}

# The monitor config (webhook, accounts, mappings) lives in Mongo
# (db.google_ads_config singleton) — NOT the clientContextEngine blob, whose
# save_config is admin-only. Anyone signed in can save here, and the sweep
# reads it directly (no cross-Lambda hop).
def _ads_get_config():
    db = get_db()
    doc = db.google_ads_config.find_one({"_id": "singleton"}) if db is not None else None
    return (doc or {}).get("config", {}) or {}

def _jwt_email(id_token):
    """Extract the email claim from an OIDC id_token (no signature check needed —
    it came straight from Google's token endpoint over TLS)."""
    try:
        payload = (id_token or '').split('.')[1]
        payload += '=' * (-len(payload) % 4)
        return (json.loads(base64.urlsafe_b64decode(payload)) or {}).get('email', '')
    except Exception:
        return ''

def _ads_auth_docs():
    db = get_db()
    if db is None:
        return []
    return [d for d in db.google_ads_auth.find({}) if d.get("refresh_token")]

def _ads_auth_info():
    accounts = [{"email": d.get("email") or d.get("_id"),
                 "at": d.get("authorized_at", ""),
                 "by": d.get("authorized_by", "")} for d in _ads_auth_docs()]
    return {"authorized": bool(accounts), "accounts": accounts}

def ads_config_get(body):
    return {"statusCode": 200, "body": json.dumps({"config": _ads_get_config(), "auth": _ads_auth_info()})}

def ads_config_save(body):
    cfg = body.get('config')
    if not isinstance(cfg, dict):
        return {"statusCode": 400, "body": json.dumps({"error": "missing config object"})}
    db = get_db()
    if db is not None:
        db.google_ads_config.update_one(
            {"_id": "singleton"},
            {"$set": {"config": cfg, "updated_by": body.get('userEmail', ''),
                      "updated": datetime.now(timezone.utc).isoformat()}}, upsert=True)
    return {"statusCode": 200, "body": json.dumps({"ok": True})}

def ads_auth_status(body):
    return {"statusCode": 200, "body": json.dumps(_ads_auth_info())}

def ads_auth_revoke(body):
    """Remove one authorized Google account (by email / doc id)."""
    email = (body.get('email') or '').strip()
    if not email:
        return {"statusCode": 400, "body": json.dumps({"error": "missing email"})}
    db = get_db()
    if db is not None:
        db.google_ads_auth.delete_one({"_id": email})
    _ADS_TOKEN_CACHE.pop(email, None)
    return {"statusCode": 200, "body": json.dumps({"ok": True})}

def ads_offline_authorize(body):
    code = body.get('code')
    client_id = body.get('client_id') or os.environ.get('GOOGLE_CLIENT_ID')
    redirect_uri = body.get('redirect_uri', 'postmessage')
    client_secret = os.environ.get('GOOGLE_CLIENT_SECRET')
    if not code:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing authorization code"})}
    if not client_secret or not client_id:
        return {"statusCode": 500, "body": json.dumps({"error": "GOOGLE_CLIENT_SECRET / GOOGLE_CLIENT_ID not configured"})}
    try:
        r = requests.post('https://oauth2.googleapis.com/token', data={
            'code': code, 'client_id': client_id, 'client_secret': client_secret,
            'redirect_uri': redirect_uri, 'grant_type': 'authorization_code'
        }, timeout=15)
        tok = r.json()
        refresh = tok.get('refresh_token')
        if not refresh:
            return {"statusCode": 400, "body": json.dumps({"error": "Google did not return a refresh token. Revoke this app at myaccount.google.com/permissions, then authorize again to force offline consent."})}
        # One stored token per Google account, keyed by email (from the id_token).
        email = _jwt_email(tok.get('id_token', '')) or (body.get('authorized_by') or '').strip() or 'account'
        db = get_db()
        if db is not None:
            db.google_ads_auth.update_one(
                {"_id": email},
                {"$set": {"refresh_token": refresh, "client_id": client_id, "email": email,
                          "authorized_by": (body.get('authorized_by') or '') or email,
                          "authorized_at": datetime.now(timezone.utc).isoformat()}},
                upsert=True)
        _ADS_TOKEN_CACHE.pop(email, None)
        return {"statusCode": 200, "body": json.dumps({"ok": True, "email": email})}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def _ads_token_for(doc):
    """Mint (and cache) a Google Ads access token for one stored auth doc."""
    key = doc.get("_id")
    now = datetime.now(timezone.utc).timestamp()
    cached = _ADS_TOKEN_CACHE.get(key)
    if cached and cached["exp"] - 60 > now:
        return cached["token"]
    client_secret = os.environ.get('GOOGLE_CLIENT_SECRET')
    client_id = doc.get("client_id") or os.environ.get('GOOGLE_CLIENT_ID')
    if not doc.get("refresh_token") or not client_secret or not client_id:
        return None
    try:
        r = requests.post('https://oauth2.googleapis.com/token', data={
            'refresh_token': doc["refresh_token"], 'client_id': client_id,
            'client_secret': client_secret, 'grant_type': 'refresh_token'
        }, timeout=15)
        tok = r.json()
    except Exception as e:
        print(f"[ADS_SWEEP] token refresh failed for {key}: {e}")
        return None
    at = tok.get('access_token')
    if at:
        _ADS_TOKEN_CACHE[key] = {"token": at, "exp": now + int(tok.get('expires_in', 3600))}
    return at

def _ads_all_tokens():
    """Access tokens for every authorized Google account."""
    out = []
    for d in _ads_auth_docs():
        t = _ads_token_for(d)
        if t:
            out.append({"email": d.get("email") or d.get("_id"), "token": t})
    return out

def _post_gchat(webhook_url, text):
    if not webhook_url:
        return False
    try:
        requests.post(webhook_url, json={"text": text}, timeout=10)
        return True
    except Exception as e:
        print(f"[ADS_SWEEP] gchat post failed: {e}")
        return False

def ads_test_webhook(body):
    url = (body.get('webhook_url') or '').strip()
    if not url.startswith('https://chat.googleapis.com/'):
        return {"statusCode": 400, "body": json.dumps({"error": "Not a Google Chat webhook URL"})}
    ok = _post_gchat(url, "✅ *Ads Budget Monitor* test — this space will receive budget-spend alerts.")
    return {"statusCode": 200 if ok else 502, "body": json.dumps({"ok": ok})}

def _ads_month_cost(customer_id, token):
    q = "SELECT metrics.cost_micros FROM customer WHERE segments.date DURING THIS_MONTH"
    res = run_google_ads_report(customer_id, q, token)
    if isinstance(res, dict) and res.get('error'):
        raise RuntimeError(res.get('error'))
    micros = 0
    batches = res if isinstance(res, list) else [res]
    for b in batches:
        for row in (b or {}).get('results', []) or []:
            micros += int((row.get('metrics') or {}).get('costMicros') or 0)
    return micros / 1_000_000.0

def ads_budget_sweep(body, event):
    tokens = _ads_all_tokens()
    if not tokens:
        return {"statusCode": 200, "body": json.dumps({"skipped": "no offline authorization stored"})}
    cfg = _ads_get_config()
    webhook = (cfg.get('webhookUrl') or '').strip()
    accounts = cfg.get('accounts', []) or []
    month = datetime.now(timezone.utc).strftime('%Y-%m')
    db = get_db()
    alerts, checked = [], 0
    for a in accounts:
        if a.get('enabled') is False:
            continue
        cid = str(a.get('customerId') or '').replace('-', '').strip()
        try:
            cap = float(a.get('monthlyCap') or 0)
        except (TypeError, ValueError):
            cap = 0
        if not cid or cap <= 0:
            continue
        checked += 1
        # Try each authorized account's token until one can read this customer.
        cost, last_err = None, None
        for tk in tokens:
            try:
                cost = _ads_month_cost(cid, tk["token"])
                break
            except Exception as e:
                last_err = e
                continue
        if cost is None:
            print(f"[ADS_SWEEP] {cid} no authorized account had access: {last_err}")
            continue
        pct = round(cost / cap * 100)
        try:
            alert_at = float(a.get('alertPct') or 80)
        except (TypeError, ValueError):
            alert_at = 80.0
        thresholds = sorted({alert_at, 100.0})
        state = db.google_ads_alerts.find_one({"_id": cid}) if db is not None else None
        alerted = set(state.get('alerted', [])) if state and state.get('month') == month else set()
        newly = [t for t in thresholds if pct >= t and t not in alerted]
        if newly:
            label = a.get('label') or cid
            cur = a.get('currency') or 'SGD'
            alerts.append(f"• *{label}* ({cid}): {pct}% of cap — {cur} {cost:,.0f} / {cur} {cap:,.0f}")
            alerted.update(newly)
            if db is not None:
                db.google_ads_alerts.update_one(
                    {"_id": cid},
                    {"$set": {"month": month, "alerted": sorted(alerted), "pct": pct,
                              "updated": datetime.now(timezone.utc).isoformat()}}, upsert=True)
    posted = False
    if alerts and webhook:
        header = f"⚠️ *Google Ads budget alert* — {len(alerts)} account(s) over threshold ({month})"
        posted = _post_gchat(webhook, header + "\n" + "\n".join(alerts))
    return {"statusCode": 200, "body": json.dumps({"checked": checked, "alerts": len(alerts), "posted": posted})}

def tiktok_auth(body):
    auth_code = body.get('auth_code')
    if not auth_code:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing auth_code"})}
    try:
        r = requests.post(
            f'{TIKTOK_API_BASE}/oauth2/access_token/',
            json={
                "app_id": TIKTOK_APP_ID,
                "secret": TIKTOK_APP_SECRET,
                "auth_code": auth_code
            },
            headers={"Content-Type": "application/json"},
            timeout=15
        )
        data = r.json()
        access_token = data.get('data', {}).get('access_token')
        if access_token:
            return {"statusCode": 200, "body": json.dumps({"access_token": access_token})}
        return {"statusCode": 400, "body": json.dumps({"error": data.get('message', 'Auth failed'), "raw": data})}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def tiktok_get_advertisers(body):
    """List the advertiser (ad account) IDs an access token can manage."""
    access_token = body.get('access_token')
    if not access_token:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing access_token"})}
    try:
        r = requests.get(
            f'{TIKTOK_API_BASE}/oauth2/advertiser/get/',
            headers={"Access-Token": access_token, "Content-Type": "application/json"},
            params={"app_id": TIKTOK_APP_ID, "secret": TIKTOK_APP_SECRET},
            timeout=15
        )
        data = r.json()
        if data.get('code') != 0:
            return {"statusCode": 200, "body": json.dumps({"error": data.get('message', 'Failed to list advertisers'), "list": [], "raw": data})}
        adv_list = data.get('data', {}).get('list', [])
        return {"statusCode": 200, "body": json.dumps({"list": adv_list})}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

# Report data_level -> the entity it groups by. Each entry gives the id field that
# identifies a row, the name field we want on the row, and the management endpoint that
# maps id -> name. TikTok's integrated report does NOT reliably return entity names
# (campaign_name etc.), only ids — so for these levels we resolve names ourselves via the
# management endpoints and stitch them onto each row. This is what lets the chatbot match
# TikTok campaigns to monday boards by name instead of only by opaque id.
TIKTOK_ENTITY_BY_LEVEL = {
    "AUCTION_CAMPAIGN": {"id": "campaign_id", "name": "campaign_name",
                         "endpoint": "/campaign/get/", "ids_filter": "campaign_ids"},
    "AUCTION_ADGROUP":  {"id": "adgroup_id",  "name": "adgroup_name",
                         "endpoint": "/adgroup/get/",  "ids_filter": "adgroup_ids"},
    "AUCTION_AD":       {"id": "ad_id",       "name": "ad_name",
                         "endpoint": "/ad/get/",       "ids_filter": "ad_ids"},
}

def tiktok_resolve_entity_names(access_token, advertiser_id, entity, ids):
    """Build an {id: name} map for a set of TikTok campaign/adgroup/ad ids.

    Uses the entity's management endpoint (e.g. /campaign/get/). Filters by the requested
    ids in chunks so we only fetch what the report actually returned. Best-effort: on any
    error it returns whatever it resolved (possibly empty) rather than failing the report."""
    id_field, name_field = entity["id"], entity["name"]
    ids = [str(i) for i in ids if i is not None and str(i) != ""]
    out = {}
    if not ids:
        return out
    # De-dupe while preserving order, then chunk (TikTok caps filter list sizes).
    seen, unique_ids = set(), []
    for i in ids:
        if i not in seen:
            seen.add(i); unique_ids.append(i)
    for start in range(0, len(unique_ids), 100):
        chunk = unique_ids[start:start + 100]
        try:
            r = requests.get(
                f'{TIKTOK_API_BASE}{entity["endpoint"]}',
                headers={"Access-Token": access_token, "Content-Type": "application/json"},
                params={
                    "advertiser_id": str(advertiser_id),
                    "filtering": json.dumps({entity["ids_filter"]: chunk}),
                    "fields": json.dumps([id_field, name_field]),
                    "page": 1,
                    "page_size": 100,
                },
                timeout=20
            )
            data = r.json()
            if data.get('code') != 0:
                continue
            for item in data.get('data', {}).get('list', []):
                ent_id = str(item.get(id_field, ""))
                if ent_id:
                    out[ent_id] = item.get(name_field)
        except Exception:
            continue
    return out

def run_tiktok_report(access_token, advertiser_id, start_date, end_date,
                      dimensions=None, metrics=None, data_level="AUCTION_ADVERTISER"):
    """Fetch a TikTok integrated BASIC report for a single advertiser.

    For campaign/adgroup/ad levels the entity name is resolved and attached to every row
    (report rows only carry ids), so downstream matching by campaign name works."""
    if not access_token:
        return {"error": "Missing TikTok access token. Connect TikTok Ads first."}
    if not advertiser_id:
        return {"error": "Missing advertiser_id"}
    if not start_date or not end_date:
        return {"error": "start_date and end_date (YYYY-MM-DD) are required"}
    entity = TIKTOK_ENTITY_BY_LEVEL.get(data_level)
    if not dimensions:
        # Default the grouping dimension to the report's own level so campaign-level
        # requests actually break down by campaign instead of defaulting to a daily total.
        dimensions = [entity["id"]] if entity else ["stat_time_day"]
    if not metrics:
        metrics = ["spend", "impressions", "clicks", "ctr", "cpc", "cpm",
                   "conversion", "cost_per_conversion", "conversion_rate",
                   "reach", "result", "cost_per_result"]
    # Ensure the entity id is in dimensions so each row is identifiable and name-joinable.
    if entity and entity["id"] not in dimensions:
        dimensions = [entity["id"]] + list(dimensions)
    params = {
        "advertiser_id": str(advertiser_id),
        "report_type": "BASIC",
        "data_level": data_level,
        "dimensions": json.dumps(dimensions),
        "metrics": json.dumps(metrics),
        "start_date": start_date,
        "end_date": end_date,
        "page": 1,
        "page_size": 100,
    }
    try:
        r = requests.get(
            f'{TIKTOK_API_BASE}/report/integrated/get/',
            headers={"Access-Token": access_token, "Content-Type": "application/json"},
            params=params,
            timeout=30
        )
        data = r.json()
        if data.get('code') != 0:
            return {"error": data.get('message', 'TikTok report error'),
                    "code": data.get('code'),
                    "hint": "If a metric is incompatible with data_level, retry with a smaller metrics list.",
                    "raw": data}
        d = data.get('data', {})
        rows = d.get('list', [])
        # Attach the entity name to every row by resolving ids via the management endpoint.
        if entity and rows:
            id_field, name_field = entity["id"], entity["name"]
            row_ids = []
            for row in rows:
                dims = row.get("dimensions", {}) if isinstance(row, dict) else {}
                if dims.get(id_field) is not None:
                    row_ids.append(dims.get(id_field))
            name_map = tiktok_resolve_entity_names(access_token, advertiser_id, entity, row_ids)
            if name_map:
                for row in rows:
                    dims = row.get("dimensions") if isinstance(row, dict) else None
                    if isinstance(dims, dict) and dims.get(id_field) is not None:
                        dims.setdefault(name_field, name_map.get(str(dims.get(id_field))))
        return {
            "advertiser_id": str(advertiser_id),
            "start_date": start_date,
            "end_date": end_date,
            "dimensions": dimensions,
            "metrics": metrics,
            "data_level": data_level,
            "rows": rows,
            "page_info": d.get('page_info', {})
        }
    except Exception as e:
        return {"error": str(e)}

def run_meta_ads_report(access_token, ad_account_id, start_date, end_date,
                        level="account", time_increment=None, fields=None,
                        name_contains=None):
    """Fetch a Meta (Facebook/Instagram) Ads Insights report for a single ad account.

    Each row carries the entity name + id for its level (campaign_name/campaign_id,
    adset_name/adset_id, ad_name/ad_id) so results are identifiable and filterable.
    When name_contains is given, rows are filtered to entities whose name contains that
    substring (case-insensitive). Because account-level rows have no entity name, a name
    filter auto-upgrades the level to 'campaign' so the filter can actually apply — this is
    what makes requests like "only campaigns containing MO" return the right subset instead
    of an account-level total."""
    # Check the account id first: an empty id is the clearest sign the request was
    # mis-routed here (e.g. a Domain Rating / Ahrefs question) rather than a real Meta
    # Ads ask — surface that instead of the generic "connect Meta Ads" message.
    if not ad_account_id:
        return {"error": "No ad_account_id supplied. This does not look like a Meta Ads request — "
                         "if the user asked about Domain Rating / DR / Ahrefs / backlinks, use "
                         "get_ahrefs_report or dataforseo_backlinks_summary instead. Otherwise pick a "
                         "real account id from 'meta_ad_account_ids'."}
    if not access_token:
        return {"error": "Missing Meta access token. Connect Meta Ads first."}
    if not start_date or not end_date:
        return {"error": "start_date and end_date (YYYY-MM-DD) are required"}
    acct = str(ad_account_id)
    if not acct.startswith("act_"):
        acct = "act_" + acct

    # A name filter is meaningless at account level (no per-entity names) — pull campaigns.
    name_contains = (name_contains or "").strip()
    if name_contains and level == "account":
        level = "campaign"

    # The name/id fields Meta returns for each aggregation level.
    NAME_FIELD = {"campaign": "campaign_name", "adset": "adset_name", "ad": "ad_name"}
    ID_FIELD   = {"campaign": "campaign_id",   "adset": "adset_id",   "ad": "ad_id"}
    name_field = NAME_FIELD.get(level)

    if not fields:
        fields = ["spend", "impressions", "clicks", "ctr", "cpc", "cpm",
                  "reach", "frequency", "actions", "action_values",
                  "purchase_roas", "cost_per_action_type"]
    else:
        fields = list(fields)
    # Always include the entity name + id so rows are identifiable and name-filterable.
    for f in (NAME_FIELD.get(level), ID_FIELD.get(level)):
        if f and f not in fields:
            fields.append(f)

    params = {
        "access_token": access_token,
        "level": level,
        "fields": ",".join(fields),
        "time_range": json.dumps({"since": start_date, "until": end_date}),
        "limit": 500,
    }
    if time_increment:
        params["time_increment"] = time_increment
    try:
        r = requests.get(
            f"https://graph.facebook.com/v23.0/{acct}/insights",
            params=params,
            timeout=30
        )
        data = r.json()
        if isinstance(data, dict) and data.get("error"):
            err = data["error"]
            return {"error": err.get("message", "Meta API error"), "code": err.get("code"), "raw": err}
        rows = data.get("data", [])
        total_count = len(rows)
        out = {
            "ad_account_id": acct,
            "start_date": start_date,
            "end_date": end_date,
            "level": level,
            "rows": rows,
            "paging": data.get("paging", {})
        }
        if name_contains and name_field:
            needle = name_contains.lower()
            rows = [row for row in rows if needle in str(row.get(name_field, "")).lower()]
            out["rows"] = rows
            out["name_filter"] = name_contains
            out["matched_count"] = len(rows)
            out["total_count"] = total_count
            out["matched_names"] = [row.get(name_field) for row in rows]
            if not rows:
                out["note"] = (f"No {level}s matched a name containing '{name_contains}'. "
                               f"{total_count} {level}(s) ran in this account for the period. "
                               f"Report this to the user and ask for the exact campaign name — "
                               f"do NOT fall back to account-level totals as if they were the filtered subset.")
        return out
    except Exception as e:
        return {"error": str(e)}

def _linkedin_resolve_names(ids, resource_path, access_token):
    """Batch-resolve LinkedIn entity IDs to human-readable names. Returns {id_str: name}."""
    if not ids or not resource_path:
        return {}
    headers = {
        "Authorization": f"Bearer {access_token}",
        "LinkedIn-Version": "202510",
        "X-Restli-Protocol-Version": "2.0.0"
    }
    names = {}
    ids = list(ids)
    for i in range(0, len(ids), 50):  # chunk to keep URLs sane
        chunk = ids[i:i + 50]
        url = f"https://api.linkedin.com/rest/{resource_path}?ids=List({','.join(chunk)})"
        try:
            r = requests.get(url, headers=headers, timeout=20)
            if r.status_code != 200:
                continue
            results = (r.json() or {}).get("results", {})
            for k, v in results.items():
                nm = (v or {}).get("name") or (v or {}).get("title")
                if nm:
                    names[str(k)] = nm
        except Exception:
            continue
    return names

def run_linkedin_ads_report(access_token, account_id, start_date, end_date,
                            pivot="ACCOUNT", granularity="ALL", fields=None):
    """Fetch a LinkedIn Ads analytics report for a single sponsored account."""
    if not access_token:
        return {"error": "Missing LinkedIn access token. Connect LinkedIn Ads first."}
    if not account_id:
        return {"error": "Missing account_id"}
    try:
        s = datetime.strptime(start_date, "%Y-%m-%d")
        e = datetime.strptime(end_date, "%Y-%m-%d")
    except Exception:
        return {"error": "start_date and end_date must be YYYY-MM-DD"}
    if not fields:
        fields = ["impressions", "clicks", "costInUsd", "costInLocalCurrency",
                  "externalWebsiteConversions", "oneClickLeads", "landingPageClicks",
                  "likes", "shares", "comments", "follows", "dateRange", "pivotValues"]
    acct = str(account_id).replace("urn:li:sponsoredAccount:", "")
    # Build the URL manually — LinkedIn's Rest.li 2.0.0 protocol requires the
    # parentheses/commas unencoded and the URN colons percent-encoded.
    date_range = (f"(start:(year:{s.year},month:{s.month},day:{s.day}),"
                  f"end:(year:{e.year},month:{e.month},day:{e.day}))")
    accounts = f"List(urn%3Ali%3AsponsoredAccount%3A{acct})"
    url = (f"https://api.linkedin.com/rest/adAnalytics?q=analytics"
           f"&dateRange={date_range}"
           f"&timeGranularity={granularity}"
           f"&accounts={accounts}"
           f"&pivot={pivot}"
           f"&fields={','.join(fields)}")
    headers = {
        "Authorization": f"Bearer {access_token}",
        "LinkedIn-Version": "202510",
        "X-Restli-Protocol-Version": "2.0.0"
    }
    try:
        r = requests.get(url, headers=headers, timeout=30)
        data = r.json()
        if isinstance(data, dict) and (data.get("status") and data.get("status") >= 400 or data.get("serviceErrorCode")):
            return {"error": data.get("message", "LinkedIn API error"), "raw": data}
        rows = data.get("elements", [])
        # Resolve pivot URNs (campaign/account/group) to human-readable names.
        # CREATIVE has no friendly name, so it is left as a URN.
        pivot_resource = {
            "ACCOUNT": "adAccounts",
            "CAMPAIGN": "adCampaigns",
            "CAMPAIGN_GROUP": "adCampaignGroups"
        }.get(pivot)
        if pivot_resource and rows:
            ids = set()
            for row in rows:
                for urn in (row.get("pivotValues") or []):
                    num = str(urn).split(":")[-1]
                    if num.isdigit():
                        ids.add(num)
            name_map = _linkedin_resolve_names(sorted(ids), pivot_resource, access_token)
            if name_map:
                for row in rows:
                    pv = row.get("pivotValues") or []
                    if pv:
                        num = str(pv[0]).split(":")[-1]
                        if num in name_map:
                            row["pivotName"] = name_map[num]
        return {
            "account_id": acct,
            "start_date": start_date,
            "end_date": end_date,
            "pivot": pivot,
            "granularity": granularity,
            "rows": rows,
            "paging": data.get("paging", {})
        }
    except Exception as e:
        return {"error": str(e)}

def linkedin_get_ad_accounts(body):
    access_token = body.get('access_token')
    if not access_token:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing access_token"})}
    try:
        url = "https://api.linkedin.com/rest/adAccounts?q=search&search=(status:(values:List(ACTIVE)))&count=100"
        r = requests.get(
            url,
            headers={
                'Authorization': f'Bearer {access_token}',
                'LinkedIn-Version': '202510',
                'X-Restli-Protocol-Version': '2.0.0'
            },
            timeout=15
        )
        data = r.json()
        elements = data.get('elements', [])
        return {"statusCode": r.status_code, "body": json.dumps({"elements": elements, "_raw": data})}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def get_board_items(body):
    if not MONDAY_API_KEY:
        return {"statusCode": 500, "body": json.dumps({"error": "MONDAY_API_KEY environment variable not configured"})}
    params = body.get('data', body)
    cursor = params.get('cursor')
    limit = params.get('limit', 100)
    
    # Use provided board_id or fall back to environment variable
    board_id = params.get('board_id') or os.environ.get('MONDAY_BOARD_ID')
    
    if not board_id:
        return {"statusCode": 500, "body": json.dumps({"error": "No MONDAY_BOARD_ID found in params or env"})}
    try:
        cursor_param = f', cursor: "{cursor}"' if cursor else ''
        query_str = f"""query {{
    boards(ids: [{board_id}]) {{
        columns {{ id title }}
        items_page(limit: {limit}{cursor_param}) {{
            cursor
            items {{
                id
                name
                column_values {{
                    id
                    text
                }}
            }}
        }}
    }}
}}"""
        print(f"[DEBUG] Monday Query with cursor: {cursor}")
        response = requests.post(
            MONDAY_API_URL,
            headers={"Authorization": MONDAY_API_KEY, "API-Version": "2024-04"},
            json={"query": query_str},
            timeout=30
        )
        print(f"[DEBUG] Monday API Response Status: {response.status_code}")
        if response.status_code != 200:
            return {"statusCode": response.status_code, "body": json.dumps({"error": response.text})}
        data = response.json()
        if 'errors' in data:
            return {"statusCode": 400, "body": json.dumps({"error": data['errors'][0]['message'] if data['errors'] else "Unknown error"})}
        try:
            board_data = data['data']['boards'][0]
            items_page = board_data['items_page']
            items = items_page.get('items', [])
            new_cursor = items_page.get('cursor')
            columns = board_data.get('columns', [])
            
            print(f"[DEBUG] Retrieved {len(items)} items, next_cursor: {new_cursor}")
            return {"statusCode": 200, "body": json.dumps({"items": items, "cursor": new_cursor, "columns": columns})}
        except (KeyError, IndexError, TypeError) as e:
            return {"statusCode": 500, "body": json.dumps({"error": f"Failed to parse Monday.com response: {str(e)}"})}
    except requests.exceptions.Timeout:
        return {"statusCode": 504, "body": json.dumps({"error": "Monday.com API request timed out"})}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

# ── Monday GraphQL helper (updated for crawler support) ──────────────────────
def run_monday_graphql(query, variables=None, api_key=None):
    """Execute a raw GraphQL query against Monday.com and return parsed JSON."""
    key = api_key or MONDAY_API_KEY
    if not key:
        return {"error": "MONDAY_API_KEY not configured and no api_key provided"}
    start_time = time.time()
    try:
        payload = {"query": query}
        if variables:
            payload["variables"] = variables
            
        r = requests.post(
            MONDAY_API_URL,
            headers={"Authorization": key, "API-Version": "2024-04"},
            json=payload,
            timeout=30
        )
        if r.status_code != 200:
            return {"error": f"Monday API HTTP {r.status_code}", "detail": r.text[:500]}
        data = r.json()
        print(f"[MONDAY-GQL] Query completed in {time.time() - start_time:.2f}s")
        if "errors" in data and data["errors"]:
            error_msg = data["errors"][0].get("message", "GraphQL error")
            print(f"[MONDAY-GQL] ERROR: {error_msg}")
            result = {"error": error_msg, "graphql_errors": data["errors"]}
            # Give Claude an actionable recovery hint for the most common self-inflicted errors
            # so it retries correctly instead of looping the same broken query.
            low = error_msg.lower()
            if "cursor" in low:
                result["hint"] = ("The cursor is stale or invalid. Re-run the query WITHOUT a cursor "
                                  "to restart pagination from the first page, then only follow the fresh "
                                  "cursor returned by that response.")
            elif "column_values" in low and ("argument" in low or "'id'" in low):
                result["hint"] = ("`column_values` takes a plural list `ids` argument: "
                                  "column_values(ids: [\"col1\", \"col2\"]). There is no `id:` or `filter:` argument.")
            elif '"ids"' in low or ("cannot query field" in low and "ids" in low and "did you mean" in low):
                result["hint"] = ("`ids` is an ARGUMENT, not a selectable field. To get an object's "
                                  "identifier select singular `id` — e.g. `boards { id name }`, "
                                  "`workspace { id name }`, `items { id name }`. `ids:` only appears as a "
                                  "filter argument like `boards(ids: [123]) { id name }`.")
            elif "doesn't exist on type" in low or "cannot query field" in low or "didn't exist on type" in low:
                result["hint"] = ("That field doesn't exist on the Monday type. Items have NO direct "
                                  "`status` field (and no direct field for any column) — read column "
                                  "values via `column_values(ids: [\"status\"]) { id text value }`, where "
                                  "`text` is the status label. Use `creator { id name }` not `creator_name`, "
                                  "and `items_page { items { ... } }` not a bare `items` field on a board.")
            return result
        return data.get("data", data)
    except requests.exceptions.Timeout:
        return {"error": "Monday.com API timed out"}
    except Exception as e:
        return {"error": str(e)}
# ───────────────────────────────────────────────────────────────────────────

# ── Google Chat MCP helper ──────────────────────────────────────────────────
def run_google_chat_mcp_tool(tool_name, tool_input, access_token):
    """
    Execute a tool call against the Google Chat MCP server.
    Endpoint: https://chatmcp.googleapis.com/mcp/v1
    Protocol: JSON-RPC 2.0
    """
    if not access_token:
        return {"error": "Google Workspace access token missing. Please authenticate first."}
    
    mcp_endpoint = "https://chatmcp.googleapis.com/mcp/v1"
    
    # Map our Claude tool names back to MCP tool names if needed
    # (Though we can just use the same names in the Claude definition)
    
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": tool_input
        }
    }
    
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    
    try:
        print(f"[MCP] Calling {tool_name} with {json.dumps(tool_input)}")
        r = requests.post(mcp_endpoint, headers=headers, json=payload, timeout=30)

        if r.status_code in (401, 403):
            return _gchat_error(r)
        if r.status_code != 200:
            return {"error": f"MCP API HTTP {r.status_code}", "detail": r.text[:500]}
            
        data = r.json()
        if "error" in data:
            print(f"[MCP] JSON-RPC Error: {json.dumps(data['error'])}")
            return {"error": "MCP JSON-RPC Error", "detail": data["error"]}
            
        # The result of a tools/call is usually in data["result"]
        if "result" in data:
            res = data["result"]
            # If the result is already in the MCP content format, return it directly
            if isinstance(res, dict) and "content" in res:
                return res
            
            # If it's a raw object, try to make it more readable for Claude
            try:
                # If it looks like a list of items (common in search results)
                if isinstance(res, list):
                    return {"items": res, "count": len(res)}
                if isinstance(res, dict):
                    # Flatten common response wrappers
                    if "conversations" in res: return res["conversations"]
                    if "messages" in res: return res["messages"]
                    if "items" in res: return res["items"]
            except:
                pass
                
            return res
            
        return data
        
    except requests.exceptions.Timeout:
        return {"error": "Google Chat MCP API timed out"}
    except Exception as e:
        print(f"[MCP] Exception: {str(e)}")
        return {"error": str(e)}
# ───────────────────────────────────────────────────────────────────────────


# ── Google Chat Standard API helper ──────────────────────────────────────────
def _gchat_error(r):
    """Translate a non-200 Google Chat response into an actionable error dict.
    401/403 almost always means the user's Google access token expired or was
    revoked — surface a reconnect instruction instead of a raw HTTP error so the
    model tells the user to re-link Google rather than retrying blindly."""
    if r.status_code in (401, 403):
        return {
            "error": "google_auth_expired",
            "auth_expired": True,
            "message": ("Your Google session has expired or is missing the required Chat "
                        "permission. Ask the user to reconnect Google (Settings → Connections "
                        "→ Google Workspace) and try again."),
            "detail": r.text[:300],
        }
    return {"error": f"Google Chat API HTTP {r.status_code}", "detail": r.text[:500]}


def list_google_chat_spaces_standard(access_token, page_size=100):
    """
    Directly call the Google Chat API (v1) to list spaces.
    Useful as a fallback if MCP tools fail.
    """
    if not access_token:
        return {"error": "google_auth_expired", "auth_expired": True,
                "message": "No Google access token was supplied. Ask the user to connect Google Workspace in Settings."}
    url = "https://chat.googleapis.com/v1/spaces"
    headers = {"Authorization": f"Bearer {access_token}"}
    params = {"pageSize": page_size}

    try:
        r = requests.get(url, headers=headers, params=params, timeout=20)
        if r.status_code != 200:
            return _gchat_error(r)
        return r.json()
    except Exception as e:
        return {"error": str(e)}

def list_google_chat_messages_standard(access_token, space_name, page_size=20, filter_str=None):
    """
    Directly call the Google Chat API (v1) to list messages in a space.
    """
    if not access_token:
        return {"error": "google_auth_expired", "auth_expired": True,
                "message": "No Google access token was supplied. Ask the user to connect Google Workspace in Settings."}
    url = f"https://chat.googleapis.com/v1/{space_name}/messages"
    headers = {"Authorization": f"Bearer {access_token}"}
    params = {"pageSize": page_size}
    if filter_str:
        params["filter"] = filter_str

    try:
        r = requests.get(url, headers=headers, params=params, timeout=20)
        if r.status_code != 200:
            return _gchat_error(r)
        return r.json()
    except Exception as e:
        return {"error": str(e)}

def search_google_chat_messages_standard(access_token, query, order_by="CREATE_TIME_DESC"):
    """
    User-level Google Chat message search.
    Step 1: Try the admin search endpoint.
    Step 2 (Fallback): List all spaces, fuzzy-match by name, then fetch messages from matching space.
    """
    if not access_token:
        return {"error": "google_auth_expired", "auth_expired": True,
                "message": "No Google access token was supplied. Ask the user to connect Google Workspace in Settings."}
    headers = {"Authorization": f"Bearer {access_token}"}

    # Step 1: Try admin search endpoint first
    url = "https://chat.googleapis.com/v1/spaces/-/messages:search"
    params = {"query": query, "orderBy": order_by}

    try:
        print(f"[GCHAT] Searching via Standard API: {query}")
        r = requests.get(url, headers=headers, params=params, timeout=20)
        if r.status_code == 200:
            return r.json()
        # An expired/revoked token won't be fixed by the space-name fallback — bail early
        # with an actionable message rather than firing a second doomed request.
        if r.status_code in (401, 403):
            return _gchat_error(r)
        print(f"[GCHAT] Admin search failed ({r.status_code}), using space-name fallback.")
    except Exception as e:
        print(f"[GCHAT] Admin search exception: {e}")
    
    # Step 2: Fuzzy fallback — list spaces, find the matching one, fetch its messages
    try:
        all_spaces = []
        next_page_token = None
        pages = 0
        while pages < 10:
            params_spaces = {"pageSize": 100}
            if next_page_token:
                params_spaces["pageToken"] = next_page_token
            res = requests.get("https://chat.googleapis.com/v1/spaces", headers=headers, params=params_spaces, timeout=20)
            if res.status_code != 200:
                return _gchat_error(res)
            data = res.json()
            all_spaces.extend(data.get("spaces", []))
            next_page_token = data.get("nextPageToken")
            pages += 1
            if not next_page_token:
                break
        
        # Fuzzy match: strip hyphens, spaces, case-insensitive
        q_clean = query.lower().replace("-", " ").replace("_", " ")
        q_words = [w for w in q_clean.split() if len(w) > 2]  # skip short words
        
        best_space = None
        best_score = 0
        for space in all_spaces:
            name = (space.get("displayName") or space.get("name") or "").lower().replace("-", " ").replace("_", " ")
            score = sum(1 for w in q_words if w in name)
            if score > best_score:
                best_score = score
                best_space = space
        
        if not best_space or best_score == 0:
            # No fuzzy match — the query was probably not an actual space name
            # (e.g. a domain like "fareasthospitality.com" or a topic). Instead
            # of dead-ending, return the real space names (the list_my_spaces
            # data) so Claude can pick the closest one and retry.
            space_names = sorted(
                n for n in (
                    (s.get("displayName") or s.get("name") or "") for s in all_spaces
                ) if n
            )
            return {
                "error": "Space not found",
                "detail": (f"No space matching '{query}' found among {len(all_spaces)} spaces. "
                           f"'{query}' looks like a topic or domain rather than a space name."),
                "spaces_checked": len(all_spaces),
                "available_spaces": space_names[:200],
                "hint": ("The query did not match any space name. Pick the closest match from "
                         "available_spaces and call search_messages_standard again with that exact "
                         "space name, or call list_my_spaces to browse all spaces. Do NOT report "
                         "failure to the user before trying at least one real space name."),
            }
        
        space_id = best_space["name"]  # e.g. "spaces/XXXXXXXX"
        print(f"[GCHAT] Matched space: {best_space.get('displayName')} ({space_id}) with score {best_score}")
        
        msg_params = {"pageSize": 25, "orderBy": "createTime desc"}
        msg_res = requests.get(f"https://chat.googleapis.com/v1/{space_id}/messages", headers=headers, params=msg_params, timeout=20)
        if msg_res.status_code != 200:
            return {"error": f"Messages fetch failed {msg_res.status_code}", "detail": msg_res.text[:400]}
        
        result = msg_res.json()
        result["_matched_space"] = best_space.get("displayName") or space_id
        return result
        
    except Exception as e:
        return {"error": str(e)}

def _calendar_freebusy_single(access_token, email, tmin, tmax, timezone_name):
    """Free/busy fallback for one calendar (no titles). Returns a result dict
    in the same shape get_calendar_schedule emits, or None on hard failure."""
    payload = {"timeMin": tmin, "timeMax": tmax, "timeZone": timezone_name,
               "items": [{"id": email}]}
    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
    try:
        r = requests.post("https://www.googleapis.com/calendar/v3/freeBusy",
                          headers=headers, json=payload, timeout=20)
        if r.status_code != 200:
            return None
        entry = (r.json().get("calendars", {}) or {}).get(email, {}) or {}
        errs = entry.get("errors") or []
        if errs:
            reason = errs[0].get("reason", "unknown")
            return {"email": email, "visible": False, "reason": reason,
                    "note": ("Calendar not shared with you or no such user."
                             if reason in ("notFound", "notACalendarUser")
                             else f"Calendar error: {reason}")}
        busy = entry.get("busy", []) or []
        return {"email": email, "visible": True, "details_visible": False,
                "busy": busy, "free": len(busy) == 0,
                "note": "Only free/busy is shared for this colleague — titles aren't visible."}
    except Exception:
        return None


def get_calendar_schedule(access_token, emails, time_min=None, time_max=None, timezone_name="Asia/Singapore"):
    """Look up colleagues' Google Calendar SCHEDULE — with event details by default.

    Rides on the Workspace OAuth token (calendar.readonly scope). For each email
    it calls events.list to return full event details (title, start/end, location,
    attendee count, all-day flag). When a colleague only shares free/busy (or the
    event is private), titles aren't available — it falls back to freeBusy busy
    blocks so availability still works. Per email returns one of:
      • visible:true, details_visible:true, events:[{title,start,end,…}]
      • visible:true, details_visible:false, busy:[{start,end}]   (free/busy only)
      • visible:false, reason:…                                    (not shared)
    Events the owner marked Private surface with title "(private)".
    """
    if not access_token:
        return {"error": "google_auth_expired", "auth_expired": True,
                "message": "No Google access token was supplied. Ask the user to connect Google Workspace in Settings."}

    # Accept a single string ("a@x.com, b@x.com") or a list.
    if isinstance(emails, str):
        emails = [e.strip() for e in emails.replace(";", ",").split(",")]
    emails = [e for e in (emails or []) if e and "@" in e]
    if not emails:
        return {"error": "no_emails", "message": "No valid colleague email addresses were provided."}
    emails = emails[:25]

    def _coerce(ts, day_end=False):
        """Best-effort RFC3339. Tolerates date-only and offset-less inputs."""
        if not ts:
            return None
        ts = str(ts).strip()
        if "T" not in ts:  # date only → expand to a full-day bound
            ts += "T23:59:59" if day_end else "T00:00:00"
        # If no timezone offset present, assume UTC.
        if not (ts.endswith("Z") or "+" in ts[11:] or ts[11:].count("-") > 0):
            ts += "Z"
        return ts

    now = datetime.now(timezone.utc)
    tmin = _coerce(time_min) or now.isoformat().replace("+00:00", "Z")
    tmax = _coerce(time_max, day_end=True) or (now + timedelta(days=7)).isoformat().replace("+00:00", "Z")
    tz = timezone_name or "Asia/Singapore"
    headers = {"Authorization": f"Bearer {access_token}"}

    auth_failed = False  # a 401 on the FIRST calendar means the whole session lacks calendar scope
    results = []
    for idx, email in enumerate(emails):
        try:
            params = {
                "timeMin": tmin, "timeMax": tmax, "timeZone": tz,
                "singleEvents": "true", "orderBy": "startTime", "maxResults": 50,
            }
            r = requests.get(
                f"https://www.googleapis.com/calendar/v3/calendars/{requests.utils.quote(email)}/events",
                headers=headers, params=params, timeout=20)

            if r.status_code == 401:
                if idx == 0:
                    auth_failed = True
                    break
                # token died mid-loop — fall back, then surface a soft error
                fb = _calendar_freebusy_single(access_token, email, tmin, tmax, tz)
                results.append(fb or {"email": email, "visible": False, "reason": "auth"})
                continue

            if r.status_code in (403, 404):
                # No "see all event details" access — try free/busy instead.
                fb = _calendar_freebusy_single(access_token, email, tmin, tmax, tz)
                results.append(fb or {
                    "email": email, "visible": False, "reason": "not_shared",
                    "note": "Calendar not shared with you or no such user."})
                continue

            if r.status_code != 200:
                results.append({"email": email, "visible": False,
                                "reason": f"http_{r.status_code}", "detail": r.text[:200]})
                continue

            items = r.json().get("items", []) or []
            events = []
            for it in items:
                start = it.get("start", {}) or {}
                end = it.get("end", {}) or {}
                all_day = "date" in start
                events.append({
                    "title": it.get("summary") or "(private)",
                    "start": start.get("dateTime") or start.get("date"),
                    "end": end.get("dateTime") or end.get("date"),
                    "all_day": all_day,
                    "location": it.get("location"),
                    "attendee_count": len(it.get("attendees", []) or []) or None,
                    "status": it.get("status"),
                })
            results.append({
                "email": email, "visible": True, "details_visible": True,
                "event_count": len(events), "free": len(events) == 0, "events": events,
            })
        except Exception as e:
            results.append({"email": email, "visible": False, "reason": "exception", "detail": str(e)})

    if auth_failed:
        return {
            "error": "google_calendar_auth",
            "auth_expired": True,
            "message": ("Calendar access isn't available on the current Google session. "
                        "Ask the user to reconnect Google Workspace (Settings → Connections "
                        "→ Google Workspace) and approve the Calendar permission, then retry."),
        }

    return {
        "window": {"timeMin": tmin, "timeMax": tmax, "timeZone": tz},
        "schedule": results,
        "note": ("Times are RFC3339 in the requested timezone. Each colleague's 'events' lists "
                 "their meetings with titles; all other time in the window is free. Where only "
                 "'busy' blocks are returned, that colleague shares free/busy only (no titles). "
                 "Titles shown '(private)' are events the owner marked private."),
    }

def run_google_ads_report(customer_id, query, token):
    url = f"https://googleads.googleapis.com/v22/customers/{customer_id}/googleAds:searchStream"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "developer-token": "mmWDgUpTcZSkkrj-7nnebg",
        "login-customer-id": "4695999392"
    }
    payload = {"query": query}
    try:
        r = requests.post(url, headers=headers, json=payload, timeout=30)
        if r.status_code != 200:
            print(f"[GADS_ERR] {r.status_code} cid={customer_id} detail={r.text[:600]} | query={query[:200]}")
            return {"error": f"Google Ads API {r.status_code}", "detail": r.text[:500]}
        return r.json()
    except Exception as e:
        return {"error": str(e)}


def _micros_to_units(v):
    """Convert a Google Ads *Micros value (int64, usually delivered as a string) to
    account-currency units. 1,000,000 micros = 1 unit."""
    try:
        return round(int(v) / 1_000_000, 2)
    except (TypeError, ValueError):
        try:
            return round(float(v) / 1_000_000, 2)
        except (TypeError, ValueError):
            return None


def _convert_micros_in_obj(obj):
    """Recursively add a currency-unit sibling for every *Micros / *_micros field so the
    LLM never has to hand-divide micros — the source of the recurring 10x spend errors.
    e.g. costMicros:"3259030000" -> also cost:3259.03; averageCpcMicros -> averageCpc."""
    if isinstance(obj, dict):
        for k in list(obj.keys()):
            v = obj[k]
            if isinstance(v, (dict, list)):
                _convert_micros_in_obj(v)
            elif k.endswith("Micros") or k.endswith("_micros"):
                base = k[:-7] if k.endswith("_micros") else k[:-6]
                base = base.rstrip("_")
                if base and base not in obj:
                    conv = _micros_to_units(v)
                    if conv is not None:
                        obj[base] = conv
    elif isinstance(obj, list):
        for it in obj:
            _convert_micros_in_obj(it)


def normalize_ads_report_for_llm(raw):
    """Post-process a Google Ads searchStream response before handing it to the model.
    (1) Converts every monetary *Micros field to account-currency units (÷1,000,000 applied).
    (2) Adds an authoritative _summary.total_cost so the model never sums micros by hand.
    (3) Surfaces the account currency_code so spend is never mislabelled by country.
    Returns a dict {_note, _summary, results}. On error payloads, returns them untouched."""
    if isinstance(raw, dict) and raw.get("error"):
        return raw
    batches = raw if isinstance(raw, list) else [raw]
    all_results = []
    currency = None
    for batch in batches:
        if not isinstance(batch, dict):
            continue
        for row in (batch.get("results") or []):
            _convert_micros_in_obj(row)
            all_results.append(row)
            if currency is None:
                cust = row.get("customer") or {}
                currency = cust.get("currencyCode") or cust.get("currency_code") or currency

    total_cost = 0.0
    has_cost = False
    for row in all_results:
        m = row.get("metrics") if isinstance(row, dict) else None
        if isinstance(m, dict) and isinstance(m.get("cost"), (int, float)):
            total_cost += m["cost"]
            has_cost = True

    summary = {"row_count": len(all_results)}
    if has_cost:
        summary["total_cost"] = round(total_cost, 2)
    if currency:
        summary["currency_code"] = currency

    return {
        "_note": (
            "Monetary *Micros fields have ALREADY been converted to account-currency units "
            "(÷1,000,000 applied) and added as plain siblings — use the 'cost' field, NOT "
            "'costMicros'. Do NOT divide, multiply, or add zeros. '_summary.total_cost' is the "
            "authoritative account total for this query — use it directly instead of summing "
            "rows yourself. Report every money figure in '_summary.currency_code'; never infer "
            "the currency from the account's name or country."
        ),
        "_summary": summary,
        "results": all_results,
    }


def fetch_ads_account_currency(customer_id, token):
    """Fetch a Google Ads account's currency code via a tiny customer query. Used as a
    fallback so spend is always labelled in the correct currency even when the model's GAQL
    did not SELECT customer.currency_code."""
    if not customer_id or not token:
        return None
    try:
        raw = run_google_ads_report(
            customer_id, "SELECT customer.currency_code FROM customer LIMIT 1", token)
        batches = raw if isinstance(raw, list) else [raw]
        for b in batches:
            if isinstance(b, dict):
                for row in (b.get("results") or []):
                    cust = row.get("customer") or {}
                    cc = cust.get("currencyCode") or cust.get("currency_code")
                    if cc:
                        return cc
    except Exception:
        pass
    return None


def run_google_ads_change_history(customer_id, token, days=30,
                                  agency_email_contains="mediaone.co",
                                  flag_after_days=14, campaign_contains=None,
                                  limit=1000):
    """Pull Google Ads change history (the change_event resource) for an account and
    summarise optimisation recency. Google only retains change_event for the last 30 days
    and requires an explicit date range + LIMIT, so `days` is capped at 30.

    For each campaign it finds the most recent change made by an "agency" user (email
    containing agency_email_contains, default 'mediaone.co') and flags campaigns with no
    such change in the last flag_after_days days — i.e. accounts/campaigns that have not
    been optimised recently. This answers "which campaigns haven't been touched by us lately"."""
    from datetime import datetime, timedelta
    if not customer_id:
        return {"error": "Missing customer_id"}
    if not token:
        return {"error": "Missing Google Ads token. Connect Google Ads first."}
    try:
        days = int(days)
    except (TypeError, ValueError):
        days = 30
    days = max(1, min(days, 30))  # change_event is retained for 30 days only
    try:
        flag_after_days = int(flag_after_days)
    except (TypeError, ValueError):
        flag_after_days = 14
    try:
        lim = min(max(int(limit), 1), 10000)
    except (TypeError, ValueError):
        lim = 1000

    # change_event REQUIRES a bounded date range — a lower bound alone (>=) is rejected as
    # CHANGE_DATE_RANGE_INFINITE. Supply BOTH ends. A small future buffer on the upper end
    # avoids cutting off same-day changes due to UTC vs account-timezone skew; the lower end
    # is held just inside the 30-day retention window to avoid CHANGE_DATE_RANGE_TOO_LONG.
    now = datetime.utcnow()
    since_str = (now - timedelta(days=min(days, 29))).strftime("%Y-%m-%d %H:%M:%S")
    until_str = (now + timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
    query = (
        "SELECT change_event.change_date_time, change_event.user_email, "
        "change_event.change_resource_type, change_event.resource_change_operation, "
        "change_event.changed_fields, change_event.campaign, campaign.name "
        "FROM change_event "
        f"WHERE change_event.change_date_time >= '{since_str}' "
        f"AND change_event.change_date_time <= '{until_str}' "
        "ORDER BY change_event.change_date_time DESC "
        f"LIMIT {lim}"
    )

    raw = run_google_ads_report(customer_id, query, token)
    if isinstance(raw, dict) and raw.get("error"):
        return raw

    # searchStream returns a list of {"results": [...]} batches (or a single dict).
    results = []
    if isinstance(raw, list):
        for batch in raw:
            results.extend((batch or {}).get("results", []))
    elif isinstance(raw, dict):
        results.extend(raw.get("results", []))

    needle = (agency_email_contains or "").lower().strip()
    now = datetime.utcnow()

    def _days_since(dt_str):
        if not dt_str:
            return None
        try:
            base = dt_str.split("+")[0].split(".")[0].strip()
            return round((now - datetime.strptime(base, "%Y-%m-%d %H:%M:%S")).total_seconds() / 86400, 1)
        except Exception:
            return None

    events = []
    campaign_last_agency = {}   # campaign name -> latest agency change datetime
    all_campaigns = set()
    agency_event_count = 0
    last_agency_change = None

    for row in results:
        ce = row.get("changeEvent", {}) or {}
        email = (ce.get("userEmail") or "").strip()
        when = ce.get("changeDateTime") or ""
        camp = (row.get("campaign", {}) or {}).get("name") or ce.get("campaign") or "(account-level)"
        if campaign_contains and campaign_contains.lower() not in str(camp).lower():
            continue
        all_campaigns.add(camp)
        is_agency = bool(needle) and needle in email.lower()
        events.append({
            "when": when,
            "user_email": email,
            "is_agency": is_agency,
            "campaign": camp,
            "resource_type": ce.get("changeResourceType"),
            "operation": ce.get("resourceChangeOperation"),
            "changed_fields": ce.get("changedFields"),
        })
        if is_agency:
            agency_event_count += 1
            if when and (last_agency_change is None or when > last_agency_change):
                last_agency_change = when
            if not campaign_last_agency.get(camp) or when > campaign_last_agency[camp]:
                campaign_last_agency[camp] = when

    campaign_flags = []
    for camp in sorted(all_campaigns):
        last = campaign_last_agency.get(camp)
        dsince = _days_since(last)
        campaign_flags.append({
            "campaign": camp,
            "last_agency_change": last,
            "days_since_agency_change": dsince,
            "unoptimised": (last is None) or (dsince is not None and dsince > flag_after_days),
        })

    days_since_last_agency = _days_since(last_agency_change)
    MAX_EVENTS = 200
    return {
        "customer_id": customer_id,
        "window_days": days,
        "agency_email_contains": agency_email_contains,
        "flag_after_days": flag_after_days,
        "total_events": len(events),
        "agency_events": agency_event_count,
        "last_agency_change": last_agency_change,
        "days_since_last_agency_change": days_since_last_agency,
        "account_unoptimised": (last_agency_change is None) or (days_since_last_agency is not None and days_since_last_agency > flag_after_days),
        "unoptimised_campaigns": [c for c in campaign_flags if c["unoptimised"]],
        "campaign_optimisation": campaign_flags,
        "events": events[:MAX_EVENTS],
        "events_truncated": len(events) > MAX_EVENTS,
        "note": ("change_event is only available for the last 30 days. 'unoptimised' = no change by a "
                 f"user whose email contains '{agency_email_contains}' within {flag_after_days} days. "
                 "Account-level changes are grouped under '(account-level)'."),
    }


# MediaOne's manager (MCC) account id. Also used as the login-customer-id on every
# Google Ads call, so it is a valid ancestor for enumerating the whole hierarchy.
MEDIAONE_MCC_ID = "4695999392"


def list_google_ads_child_accounts(manager_id, token):
    """Enumerate every ENABLED client account under a Google Ads manager (MCC) via the
    customer_client resource. Returns non-manager leaf accounts only (the ones that hold
    campaigns). change_event cannot be queried at the MCC level, so a portfolio-wide audit
    must fan out to these child ids one at a time."""
    if not manager_id:
        return {"error": "Missing manager (MCC) customer id"}
    if not token:
        return {"error": "Missing Google Ads token. Connect Google Ads first."}
    manager_id = str(manager_id).replace("-", "").strip()
    query = (
        "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, "
        "customer_client.status, customer_client.currency_code, customer_client.level "
        "FROM customer_client WHERE customer_client.status = 'ENABLED'"
    )
    raw = run_google_ads_report(manager_id, query, token)
    if isinstance(raw, dict) and raw.get("error"):
        return raw
    batches = raw if isinstance(raw, list) else [raw]
    seen = set()
    children = []
    for batch in batches:
        if not isinstance(batch, dict):
            continue
        for row in (batch.get("results") or []):
            cc = row.get("customerClient") or {}
            cid = str(cc.get("id") or "").strip()
            if not cid or cid == manager_id or cid in seen:
                continue
            # Skip manager (MCC) nodes — only leaf accounts hold campaigns/change history.
            if cc.get("manager") in (True, "true", "TRUE"):
                continue
            seen.add(cid)
            children.append({
                "id": cid,
                "name": cc.get("descriptiveName") or "",
                "currency_code": cc.get("currencyCode") or cc.get("currency_code"),
            })
    return {"manager_id": manager_id, "child_accounts": children, "count": len(children)}


def _account_has_active_matching_campaign(customer_id, token, campaign_contains):
    """Return True if the account has at least one ENABLED campaign whose name contains
    campaign_contains (case-insensitive). Used to avoid flagging accounts that simply have
    no matching campaigns as 'unoptimised'."""
    if not campaign_contains:
        return True
    safe = str(campaign_contains).replace("'", "").replace("\\", "")
    q = ("SELECT campaign.name FROM campaign "
         "WHERE campaign.status = 'ENABLED' "
         f"AND campaign.name LIKE '%{safe}%' LIMIT 1")
    raw = run_google_ads_report(customer_id, q, token)
    if isinstance(raw, dict) and raw.get("error"):
        return None  # unknown — don't hide the account on an API error
    batches = raw if isinstance(raw, list) else [raw]
    for b in batches:
        if isinstance(b, dict) and (b.get("results") or []):
            return True
    return False


def run_google_ads_mcc_change_sweep(token, manager_id=None, days=30,
                                    agency_email_contains="mediaone.co",
                                    flag_after_days=14, campaign_contains=None,
                                    max_accounts=50, offset=0):
    """Comb an ENTIRE Google Ads MCC for accounts NOT optimised recently — i.e. no change
    by an agency user (email containing agency_email_contains) within flag_after_days.
    Enumerates child accounts under the manager, then fans out the per-account change-history
    check concurrently. Bounded by max_accounts (+ offset) per call so a 300+ account portfolio
    is paged rather than timing out; the caller loops with a rising offset until done."""
    from concurrent.futures import ThreadPoolExecutor

    if not token:
        return {"error": "Missing Google Ads token. Connect Google Ads first."}
    manager_id = str(manager_id or MEDIAONE_MCC_ID).replace("-", "").strip()
    try:
        max_accounts = min(max(int(max_accounts), 1), 120)
    except (TypeError, ValueError):
        max_accounts = 50
    try:
        offset = max(int(offset), 0)
    except (TypeError, ValueError):
        offset = 0

    listing = list_google_ads_child_accounts(manager_id, token)
    if isinstance(listing, dict) and listing.get("error"):
        return {"error": f"Could not enumerate MCC {manager_id}: {listing['error']}",
                "hint": "Confirm this is a manager (MCC) id and Google Ads is connected with access to it."}
    children = listing.get("child_accounts", [])
    total = len(children)
    batch = children[offset:offset + max_accounts]

    def _check(acct):
        res = run_google_ads_change_history(
            acct["id"], token, days, agency_email_contains, flag_after_days, campaign_contains)
        return acct, res

    unoptimised, errored, scanned_ok = [], [], 0
    with ThreadPoolExecutor(max_workers=12) as ex:
        for acct, res in ex.map(_check, batch):
            if isinstance(res, dict) and res.get("error"):
                errored.append({"id": acct["id"], "name": acct["name"], "error": res["error"]})
                continue
            scanned_ok += 1
            if res.get("account_unoptimised"):
                unoptimised.append({
                    "id": acct["id"],
                    "name": acct["name"],
                    "currency_code": acct.get("currency_code"),
                    "last_agency_change": res.get("last_agency_change"),
                    "days_since_agency_change": res.get("days_since_last_agency_change"),
                    "agency_events": res.get("agency_events"),
                    "unoptimised_campaigns": [c.get("campaign") for c in res.get("unoptimised_campaigns", [])][:20],
                })

    # When a campaign-name filter is set, drop flagged accounts that have no ENABLED campaign
    # matching it, so "active campaigns containing X" is honoured (verify only the small
    # flagged subset to keep the call cheap).
    if campaign_contains and unoptimised:
        def _verify(acct):
            return acct, _account_has_active_matching_campaign(acct["id"], token, campaign_contains)
        kept = []
        with ThreadPoolExecutor(max_workers=12) as ex:
            for acct, has in ex.map(_verify, unoptimised):
                if has is False:
                    continue  # no matching active campaign → not a relevant flag
                acct["has_active_matching_campaign"] = bool(has)
                kept.append(acct)
        unoptimised = kept

    next_offset = offset + len(batch)
    more = next_offset < total
    return {
        "manager_id": manager_id,
        "total_child_accounts": total,
        "scanned_range": [offset, next_offset],
        "scanned_ok": scanned_ok,
        "window_days": days,
        "flag_after_days": flag_after_days,
        "agency_email_contains": agency_email_contains,
        "campaign_contains": campaign_contains,
        "unoptimised_accounts": unoptimised,
        "unoptimised_count": len(unoptimised),
        "errored_accounts": errored[:20],
        "more_accounts_remaining": more,
        "next_offset": next_offset if more else None,
        "note": ("Swept child accounts under the MCC for change history. 'unoptimised' = no change by a "
                 f"user whose email contains '{agency_email_contains}' in the last {flag_after_days} days "
                 "(within the 30-day change_event retention window). "
                 + ("Call again with offset=next_offset to continue the remaining accounts." if more
                    else "All child accounts in the MCC have been scanned.")),
    }


def run_gsc_performance(site_url, tool_input, token):
    import urllib.parse
    from datetime import datetime, timedelta
    
    encoded_site = urllib.parse.quote_plus(site_url)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    
    # Strip siteUrl and other internal fields from payload
    payload = {k: v for k, v in tool_input.items() if k not in ['siteUrl', 'action']}
    
    # Defaults
    if 'startDate' not in payload:
        payload['startDate'] = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    if 'endDate' not in payload:
        payload['endDate'] = datetime.now().strftime('%Y-%m-%d')
    if 'dimensions' not in payload:
        payload['dimensions'] = ['query']

    # Default + hard-cap rowLimit so a single call can't dump tens of thousands of
    # rows into the conversation. Claude is steered to make small sequential calls
    # (one dimension at a time) rather than one giant query.
    try:
        requested_limit = int(payload.get('rowLimit', 250))
    except (TypeError, ValueError):
        requested_limit = 250
    payload['rowLimit'] = max(1, min(requested_limit, 1000))

    try:
        # Prepare variations of the site URL to handle different GSC property types
        import urllib.parse
        domain = site_url.split("//")[-1].split("/")[0]
        
        variations = [
            site_url,                       # 1. As provided (e.g. https://example.com/)
            site_url.rstrip('/'),           # 2. No trailing slash (e.g. https://example.com)
            f"sc-domain:{domain}",          # 3. Domain property (sc-domain:example.com)
            domain                          # 4. Raw domain (example.com)
        ]
        
        # Remove duplicates while preserving order
        unique_variations = []
        for v in variations:
            if v not in unique_variations: unique_variations.append(v)

        last_error = None
        for v in unique_variations:
            encoded_v = urllib.parse.quote(v, safe='')
            target_url = f"https://www.googleapis.com/webmasters/v3/sites/{encoded_v}/searchAnalytics/query"
            
            print(f"[GSC] Trying variation: {v}")
            r = requests.post(target_url, headers=headers, json=payload, timeout=20)
            
            if r.status_code == 200:
                print(f"[GSC] Success using variation: {v}")
                data = r.json()
                # Compact rows: round long floats (ctr/position) to keep the
                # payload small without losing analytical value.
                for row in data.get('rows', []):
                    if 'ctr' in row:
                        row['ctr'] = round(row['ctr'], 4)
                    if 'position' in row:
                        row['position'] = round(row['position'], 1)
                return data
            
            last_error = r.text
            print(f"[GSC] Variation {v} failed: {r.status_code}")

        # If all variations failed, report the last error
        print(f"[GSC] All variations failed. Last error: {last_error}")
        
        # Try to get user identity to help debug permission issues
        user_info = "Unknown Account"
        try:
            ident_res = requests.get("https://www.googleapis.com/oauth2/v3/userinfo", headers=headers, timeout=5)
            if ident_res.status_code == 200:
                user_info = ident_res.json().get('email', 'Email hidden')
        except: pass
        
        error_detail = f"Account: {user_info}. Property tried: {site_url}. " + (last_error[:400] if last_error else "Unknown Error")
        return {"error": "GSC Permission Denied", "detail": error_detail}

    except Exception as e:
        return {"error": str(e)}

# Common metric/dimension aliases → their exact GA4 Data API names. The model (and
# older callers) often pass intuitive names like "users" or "pageviews", which the
# GA4 API rejects with a 400. Normalise them before the request.
GA4_METRIC_ALIASES = {
    "users": "totalUsers",
    "totalusers": "totalUsers",
    "activeusers": "activeUsers",
    "newusers": "newUsers",
    "pageviews": "screenPageViews",
    "pageview": "screenPageViews",
    "views": "screenPageViews",
    "screenpageviews": "screenPageViews",
    "sessions": "sessions",
    "avgsessionduration": "averageSessionDuration",
    "averagesessionduration": "averageSessionDuration",
    "sessionduration": "averageSessionDuration",
    "bouncerate": "bounceRate",
    "engagementrate": "engagementRate",
    "conversion": "conversions",
    "conversions": "conversions",
    "revenue": "totalRevenue",
    "totalrevenue": "totalRevenue",
    "eventcount": "eventCount",
}

def _normalize_ga4_metric(name):
    if not isinstance(name, str):
        return name
    cleaned = name.strip()
    return GA4_METRIC_ALIASES.get(cleaned.lower(), cleaned)

def run_ga4_report(property_id, tool_input, token):
    url = f"https://analyticsdata.googleapis.com/v1beta/{property_id}:runReport"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # Strip internal fields and GA4-specific keys handled separately
    payload = {k: v for k, v in tool_input.items() if k not in ['propertyId', 'action', 'metrics', 'dimensions', 'startDate', 'endDate']}

    # Build dateRanges from startDate/endDate or default to last 30 days
    if 'dateRanges' not in payload:
        start = tool_input.get('startDate', '30daysAgo')
        end = tool_input.get('endDate', 'today')
        payload['dateRanges'] = [{"startDate": start, "endDate": end}]

    # GA4 API requires metrics/dimensions as array of objects {name: ...}, not plain
    # strings — and the metric names must be exact, so alias-normalise them first.
    raw_metrics = tool_input.get('metrics')
    if raw_metrics:
        payload['metrics'] = [{"name": _normalize_ga4_metric(m)} if isinstance(m, str) else m for m in raw_metrics]
    else:
        payload['metrics'] = [{"name": "sessions"}, {"name": "totalUsers"}]

    raw_dims = tool_input.get('dimensions')
    if raw_dims:
        payload['dimensions'] = [{"name": d} if isinstance(d, str) else d for d in raw_dims]

    try:
        print(f"[GA4] Querying {property_id} with payload: {payload}")
        r = requests.post(url, headers=headers, json=payload, timeout=30)
        # Graceful degradation: GA4 returns 400 naming the offending metric/dimension
        # (e.g. bounceRate unavailable on some properties). Drop the flagged field(s)
        # and retry once rather than failing the whole report.
        if r.status_code == 400 and payload.get('metrics'):
            detail = r.text or ""
            bad = [m['name'] for m in payload['metrics'] if isinstance(m, dict) and m.get('name') and m['name'] in detail]
            if bad:
                kept = [m for m in payload['metrics'] if not (isinstance(m, dict) and m.get('name') in bad)]
                payload['metrics'] = kept or [{"name": "sessions"}, {"name": "totalUsers"}]
                print(f"[GA4] Dropping invalid metric(s) {bad} and retrying with {payload['metrics']}")
                r = requests.post(url, headers=headers, json=payload, timeout=30)
        if r.status_code != 200:
            return {"error": f"GA4 API {r.status_code}", "detail": r.text[:500]}
        return r.json()
    except Exception as e:
        return {"error": str(e)}

# ── Agentic loop: Claude + Monday.com tool use ──────────────────────────────
# Human-readable labels for live progress + the structured tool_calls list
# returned to the browser (rendered as chips in the tool log).
TOOL_LABELS = {
    "monday_graphql":                  "Querying Monday.com",
    "search_messages_standard":        "Searching Google Chat",
    "search_conversations":            "Searching Google Chat",
    "search_messages":                 "Searching Google Chat",
    "list_messages":                   "Reading Google Chat messages",
    "list_messages_standard":          "Reading Google Chat messages",
    "send_message":                    "Posting to Google Chat",
    "list_my_spaces":                  "Listing Google Chat spaces",
    "list_mcp_tools":                  "Listing chat tools",
    "get_gsc_performance":             "Pulling Search Console data",
    "get_ga4_report":                  "Fetching GA4 analytics",
    "get_ads_report":                  "Fetching Google Ads data",
    "get_ads_change_history":          "Pulling Google Ads change history",
    "get_ads_mcc_change_sweep":        "Combing the MCC for unoptimised accounts",
    "save_memory_note":                "Saving to memory",
    "get_seranking_report":            "Fetching SE Ranking positions",
    "get_seranking_backlinks":         "Fetching SE Ranking backlinks",
    "get_meta_ads_report":             "Fetching Meta Ads data",
    "get_linkedin_ads_report":         "Fetching LinkedIn Ads data",
    "get_tiktok_ads_report":           "Fetching TikTok Ads data",
    "dataforseo_serp":                 "Fetching live SERP results",
    "dataforseo_search_volume":        "Fetching search volumes",
    "dataforseo_backlinks_summary":    "Fetching backlink summary",
    "dataforseo_domain_rank_overview": "Analyzing domain rank",
    "dataforseo_ranked_keywords":      "Fetching ranked keywords",
    "workduo_list_projects":           "Listing WorkDuo projects",
    "get_workduo_report":              "Fetching AI visibility data",
    "get_ahrefs_report":               "Fetching Ahrefs data",
    "get_moz_da":                      "Fetching Moz DA/PA",
    "search_knowledge_base":           "Searching knowledge base",
    "check_calendar_availability":     "Checking calendar availability",
    "analyze_image":                   "Reading image with Claude",
}

# ── DeepSeek (OpenAI-compatible) provider adapter ────────────────────────────
# The agentic loop below is written entirely against Anthropic's wire format
# (content blocks, tool_use/tool_result, stop_reason). DeepSeek speaks the
# OpenAI chat-completions format instead. These two pure helpers translate at
# the request-out / response-in seams so the ~500-line tool dispatch and the
# Anthropic-shaped `messages` history stay byte-for-byte unchanged. The Claude
# path never touches this code.

def _flatten_text(content):
    """Anthropic content (string OR list of blocks) → plain text for OpenAI."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                parts.append(b["text"])
            elif isinstance(b, str):
                parts.append(b)
        return "\n".join(parts)
    return str(content) if content is not None else ""


def _stringify_tool_result(content):
    """A tool_result block's content → a single string DeepSeek's tool role accepts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text" and b.get("text") is not None:
                    parts.append(b["text"])
                else:
                    # image or other non-text block — DeepSeek tool role is text-only
                    parts.append(json.dumps(b))
            else:
                parts.append(str(b))
        return "\n".join(parts)
    return json.dumps(content) if content is not None else ""


def _anthropic_to_openai(system, messages, tools):
    """Translate Anthropic system+messages+tools → OpenAI chat-completions shape."""
    openai_messages = []

    sys_text = _flatten_text(system) if system else ""
    if sys_text.strip():
        openai_messages.append({"role": "system", "content": sys_text})

    for m in messages:
        role = m.get("role")
        content = m.get("content")

        # Plain-string content passes straight through.
        if isinstance(content, str):
            openai_messages.append({"role": role, "content": content})
            continue

        if not isinstance(content, list):
            openai_messages.append({"role": role, "content": _flatten_text(content)})
            continue

        if role == "assistant":
            text_parts = []
            tool_calls = []
            for b in content:
                if not isinstance(b, dict):
                    continue
                btype = b.get("type")
                if btype == "text" and b.get("text"):
                    text_parts.append(b["text"])
                elif btype == "tool_use":
                    tool_calls.append({
                        "id": b.get("id", ""),
                        "type": "function",
                        "function": {
                            "name": b.get("name", ""),
                            "arguments": json.dumps(b.get("input", {})),
                        },
                    })
                # thinking / redacted_thinking blocks are dropped (DeepSeek has none)
            msg = {"role": "assistant", "content": "\n".join(text_parts)}
            if tool_calls:
                msg["tool_calls"] = tool_calls
            openai_messages.append(msg)
            continue

        # user role: may carry tool_result blocks and/or text/image blocks.
        tool_result_msgs = []
        text_parts = []
        for b in content:
            if not isinstance(b, dict):
                if isinstance(b, str):
                    text_parts.append(b)
                continue
            if b.get("type") == "tool_result":
                tool_result_msgs.append({
                    "role": "tool",
                    "tool_call_id": b.get("tool_use_id", ""),
                    "content": _stringify_tool_result(b.get("content", "")),
                })
            elif b.get("type") == "text" and b.get("text"):
                text_parts.append(b["text"])
            elif b.get("type") == "image":
                # DeepSeek's API is text-only and would reject image blocks. Don't drop
                # them silently — leave a note so the model can give the user a helpful
                # answer instead of replying blind as if no image was sent.
                text_parts.append(
                    "[An image was attached here, but the current model (DeepSeek) cannot "
                    "view images. Tell the user to switch to Claude — the model pill in the "
                    "input bar — and resend the image for visual analysis.]"
                )
        # tool results must come before any free-text user message in the sequence
        openai_messages.extend(tool_result_msgs)
        if text_parts:
            openai_messages.append({"role": "user", "content": "\n".join(text_parts)})

    openai_tools = [{
        "type": "function",
        "function": {
            "name": t.get("name"),
            "description": t.get("description", ""),
            "parameters": t.get("input_schema", {"type": "object", "properties": {}}),
        },
    } for t in (tools or [])]

    return openai_messages, openai_tools


def _openai_to_anthropic(choice_message, finish_reason):
    """Translate one DeepSeek choice → (stop_reason, content_blocks) the loop expects."""
    content_blocks = []

    text = choice_message.get("content")
    if text:
        content_blocks.append({"type": "text", "text": text})

    tool_calls = choice_message.get("tool_calls") or []
    for tc in tool_calls:
        fn = tc.get("function", {}) or {}
        raw_args = fn.get("arguments", "") or "{}"
        try:
            parsed = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        except (ValueError, TypeError):
            parsed = {}
        content_blocks.append({
            "type": "tool_use",
            "id": tc.get("id", f"call_{int(time.time()*1000)}"),
            "name": fn.get("name", ""),
            "input": parsed if isinstance(parsed, dict) else {},
        })

    stop_reason = "tool_use" if (finish_reason == "tool_calls" or tool_calls) else "end_turn"
    return stop_reason, content_blocks


# DeepSeek (unlike Claude) sometimes ENDS a turn by announcing the next step as
# plain text ("Let me check the other boards now.") instead of firing the tool
# call — leaving the user with a half-finished answer. Detect that so the loop
# can nudge it to actually continue.
_DEEPSEEK_CONTINUE_CUES = (
    "let me check", "let me look", "let me fetch", "let me pull", "let me query",
    "let me gather", "let me retrieve", "let me grab", "let me see the",
    "now let me", "let me now", "next, i", "next i", "i'll check", "i will check",
    "i'll look", "i'll now", "i'll pull", "i'll fetch", "i'll query", "i'll gather",
    "checking the other", "check the other", "let me examine", "moving on to",
    "let me go through", "give me a moment", "one moment", "hold on",
)

def _deepseek_turn_unfinished(text):
    """True if DeepSeek ended a turn empty or while announcing more work to do."""
    t = (text or "").strip().lower()
    if not t:
        return True
    tail = t[-140:]
    return any(cue in tail for cue in _DEEPSEEK_CONTINUE_CUES)


# Injected only for DeepSeek: keep it from stalling mid-task.
_DEEPSEEK_TOOL_DISCIPLINE = (
    "\n\nTOOL DISCIPLINE (critical): You are running inside an agentic loop with real, "
    "live tools. When you need data, call the appropriate tool IMMEDIATELY. NEVER reply "
    "with phrases like 'let me check…', 'now let me look at…', or 'let me check the other "
    "boards now' and then stop — that leaves the user with an unfinished answer. Keep "
    "issuing tool calls across as many steps as you need, and only write your final response "
    "once you already have ALL the information. Do not announce future actions; either "
    "perform them now via a tool call, or finish your complete answer."
)


# ── DeepSeek vision bridge ───────────────────────────────────────────────────
# DeepSeek can't see images, so when the user is on DeepSeek and uploads one, we
# give DeepSeek an `analyze_image` tool that runs Claude's vision under the hood.
# Images are persisted in MongoDB (keyed by a stable client id) so a "second look"
# works across page reloads / reopened conversations — not just within a session.

_CHAT_IMAGES_TTL_DAYS = 30

def _chat_images_coll():
    """The chat_images collection, with a TTL index ensured once. None if Mongo is down."""
    db = get_db()
    if db is None:
        return None
    coll = db['chat_images']
    try:
        coll.create_index("ts", expireAfterSeconds=_CHAT_IMAGES_TTL_DAYS * 24 * 3600)
    except Exception:
        pass  # index may already exist / Mongo hiccup — never block the chat
    return coll


def _store_chat_image(image_id, b64, media_type, name, conversation_id):
    """Persist an uploaded image so analyze_image can retrieve it later. Best-effort."""
    if not image_id or not b64:
        return
    try:
        coll = _chat_images_coll()
        if coll is None:
            return
        coll.update_one(
            {"_id": image_id},
            {"$set": {
                "b64": b64,
                "media_type": media_type or "image/png",
                "name": name or "image",
                "conversation_id": conversation_id or "",
                "ts": datetime.utcnow(),
            }},
            upsert=True,
        )
    except Exception as e:
        print(f"[VISION] store image failed: {e}")


def _load_chat_image(image_id):
    """Return {b64, media_type, name} for a stored image id, or None."""
    try:
        coll = _chat_images_coll()
        if coll is None:
            return None
        return coll.find_one({"_id": image_id})
    except Exception as e:
        print(f"[VISION] load image failed: {e}")
        return None


def _claude_vision(b64, media_type, question):
    """One-shot Claude vision call: image + question → description text (or error string)."""
    anthropic_key = os.environ.get('ANTHROPIC_API_KEY')
    if not anthropic_key:
        return "[vision unavailable: ANTHROPIC_API_KEY not configured]"
    mt = media_type if media_type in ('image/jpeg', 'image/png', 'image/gif', 'image/webp') else 'image/png'
    headers = {
        'x-api-key': anthropic_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
    }
    payload = {
        'model': 'claude-haiku-4-5',
        'max_tokens': 1024,
        'messages': [{
            'role': 'user',
            'content': [
                {'type': 'image', 'source': {'type': 'base64', 'media_type': mt, 'data': b64}},
                {'type': 'text', 'text': question or 'Describe this image in detail.'},
            ],
        }],
    }
    try:
        r = requests.post('https://api.anthropic.com/v1/messages', headers=headers, json=payload, timeout=60)
        if r.status_code != 200:
            # retry once on a usage-limit error with the backup key, mirroring the main loop
            backup = os.environ.get('ANTHROPIC_API_KEY_BACKUP')
            if r.status_code in (429, 529) and backup:
                headers['x-api-key'] = backup
                r = requests.post('https://api.anthropic.com/v1/messages', headers=headers, json=payload, timeout=60)
            if r.status_code != 200:
                print(f"[VISION] Claude error {r.status_code}: {r.text[:300]}")
                return f"[vision error {r.status_code}]"
        blocks = r.json().get('content', [])
        return "\n\n".join(b.get('text', '') for b in blocks if b.get('type') == 'text').strip() or "[no description returned]"
    except requests.exceptions.Timeout:
        return "[vision timed out]"
    except Exception as e:
        print(f"[VISION] exception: {e}")
        return f"[vision failed: {e}]"
# ─────────────────────────────────────────────────────────────────────────────

def claude_chat_with_tools(body):
    """
    Full agentic loop:
      1. Send messages to Claude with a monday_graphql tool defined.
      2. If Claude calls the tool, execute the GraphQL query against Monday.com.
      3. Feed the result back to Claude.
      4. Repeat until Claude returns a final text response.
      5. Return { reply, tool_calls_summary } to the browser.

    Expected body fields:
      system     - system prompt string
      messages   - list of {role, content} conversation history
      max_tokens - int (optional, defaults to 4096)
      model      - Claude model ID (optional)
    """
    # Provider switcher: 'anthropic' (default, unchanged) or 'deepseek'.
    provider = (body.get('provider') or 'anthropic').lower()

    anthropic_key = os.environ.get('ANTHROPIC_API_KEY')
    anthropic_key_backup = os.environ.get('ANTHROPIC_API_KEY_BACKUP')
    deepseek_key = os.environ.get('DEEPSEEK_API_KEY')

    if provider == 'deepseek':
        if not deepseek_key:
            return {"statusCode": 500, "body": json.dumps({"error": "DEEPSEEK_API_KEY environment variable not configured"})}
        model = body.get('model') or os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')
    else:
        if not anthropic_key:
            return {"statusCode": 500, "body": json.dumps({"error": "ANTHROPIC_API_KEY environment variable not configured"})}
        model = body.get('model') or os.environ.get('CLAUDE_MODEL', 'claude-haiku-4-5')

    system     = body.get('system', '')

    # Ground the model in the real current date/time (Singapore). Tools such as
    # check_calendar_availability ask the model to compute date windows from
    # "today"; with no injected date the model guesses and can land a day off.
    # Prepend an authoritative date line — handle both a plain-string system and
    # a list of content blocks (prompt-caching shape) without disturbing existing
    # cache_control breakpoints.
    _now_sgt = datetime.now(SGT)
    _date_line = (
        "Current date & time: " + _now_sgt.strftime('%A, %d %B %Y, %H:%M')
        + " (Asia/Singapore, UTC+8). Treat this as 'today' for ALL date math and "
        "relative dates ('today', 'tomorrow', 'this week', 'next Monday')."
    )
    if isinstance(system, list):
        system = [{"type": "text", "text": _date_line}] + system
    elif system:
        system = _date_line + "\n\n" + system
    else:
        system = _date_line

    messages   = list(body.get('messages', []))   # mutable copy for the loop
    max_tokens = int(body.get('max_tokens', 4096))
    thinking   = body.get('thinking')  # e.g. {"type": "enabled", "budget_tokens": 8000}

    if not messages:
        return {"statusCode": 400, "body": json.dumps({"error": "No messages provided"})}

    # ── DeepSeek vision: ingest any attached images ─────────────────────────
    # DeepSeek is text-only; when on DeepSeek the client sends image metadata (and
    # base64 on first upload) in `deepseek_images`. Persist new ones to Mongo and
    # build the list available this turn, so the analyze_image tool can run Claude
    # vision on them — now and across reloads (id-only on later turns).
    deepseek_images = body.get('deepseek_images') or []
    available_images = []
    if provider == 'deepseek' and isinstance(deepseek_images, list):
        conv_id = body.get('conversation_id') or ''
        for img in deepseek_images[:8]:
            if not isinstance(img, dict):
                continue
            img_id = img.get('id')
            if not img_id:
                continue
            if img.get('b64'):
                _store_chat_image(img_id, img['b64'], img.get('media_type'), img.get('name'), conv_id)
            available_images.append({"id": img_id, "name": img.get('name') or 'image'})

    # ── Live progress reporting ─────────────────────────────────────────────
    # The browser sends a progress_id and polls get_chat_progress while this
    # loop runs, so the typing indicator can show what is actually happening
    # instead of a guessed rotation. Best-effort only: a Mongo hiccup must
    # never break the chat itself.
    progress_id = body.get('progress_id')
    tool_events = []   # structured per-call list: [{"name", "label"}, ...]

    def _report_progress(label):
        if not progress_id:
            return
        try:
            db = get_db()
            if db is None:
                return
            db['chat_progress'].update_one(
                {"_id": progress_id},
                {"$set": {"label": label, "events": tool_events, "updated": time.time()}},
                upsert=True,
            )
        except Exception as e:
            print(f"[PROGRESS] write failed: {e}")

    def _clear_progress():
        if not progress_id:
            return
        try:
            db = get_db()
            if db is not None:
                db['chat_progress'].delete_one({"_id": progress_id})
        except Exception:
            pass

    # Tool definitions
    tools = [{
            "name": "search_messages_standard",
            "description": "PRIMARY TOOL for finding messages. Use this IMMEDIATELY if the user provides a space name or keywords. This tool searches across ALL spaces simultaneously. MANDATORY: Always set 'orderBy': 'CREATE_TIME_DESC'.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The space name or keywords (e.g., '1-company-announcements')."},
                    "orderBy": {"type": "string", "enum": ["CREATE_TIME_DESC", "CREATE_TIME_ASC"], "description": "Set to 'CREATE_TIME_DESC'."}
                },
                "required": ["query"]
            }
        },
        {
            "name": "monday_graphql",
            "description": (
                "Execute a GraphQL query against the Monday.com API (API-Version 2024-04). "
                "Use this to discover boards, fetch items, column values, updates, "
                "people assignments, statuses, and any other workspace data.\n"
                "SCHEMA RULES — verify EVERY query against these before sending (a violation = a hard API error):\n"
                "0. `ids` is ONLY an argument, never a selectable field. An object's identifier is "
                "singular `id` — write `boards { id name }`, `workspace { id name }`, `items { id name }`. "
                "Selecting `ids` (e.g. `boards { ids name }`) is a hard API error.\n"
                "1. Top-level `items` on a board is DEPRECATED. ALWAYS use "
                "`items_page(limit:, cursor:) { cursor items { ... } }` nested inside `boards { ... }`. "
                "Never query `items` at the board level, and never put `items_page` at the root.\n"
                "2. `creator_name` does NOT exist — use `creator { id name }`.\n"
                "3. There is no `board_ids`, top-level `column_id`, or `column_value` argument. "
                "Use singular `board_id`, and `columns: [{ column_id: \"...\", column_values: [\"...\"] }]` "
                "(an array of objects).\n"
                "4. `updates_page` does NOT exist on an item — use `updates(limit:) { id body created_at creator { id name } }`.\n"
                "5. `items_page_by_column_values(...)` returns an items_page shape — unwrap it as `{ cursor items { ... } }`, never as raw items. The top-level entry point is `items_page_by_column_values(...)` — there is NO `items_by_column_values`.\n"
                "6. To paginate, follow the returned `cursor` with `next_items_page(cursor: \"...\", limit:) { cursor items { ... } }`.\n"
                "7. `column_values` takes a PLURAL `ids` argument that is a LIST — `column_values(ids: [\"status\", \"date\"]) { id text value }`. There is NO `id:` (singular) argument and NO `filter:` argument on `column_values`; using either is a hard API error.\n"
                "7b. An item has NO direct `status` field — and no direct field for ANY column (status, date, people, numbers, dropdown, …). Writing `items { status { label } }`, `items { status }`, or any column title as a field on the item is a hard API error ('Field ... doesn't exist on type Item'). A status column's value comes from `column_values(ids: [\"status\"]) { id text value }`: the `text` field is the human-readable label (e.g. \"Done\", \"Stuck\"), and `value` is the raw JSON. To read a status, query `items { id name column_values(ids: [\"status\"]) { id text value } }`.\n"
                "8. CURSORS ARE SINGLE-USE AND OPAQUE. Only ever pass a `cursor` value that came back from the immediately preceding `items_page`/`next_items_page` response in THIS conversation. Never reuse a cursor twice, never guess or hand-write one, and never reuse a cursor from an earlier turn — doing so returns 'Invalid or corrupted cursor'. To start over, omit `cursor` entirely.\n"
                "Correct templates:\n"
                "  • Board items: { boards(ids: [BOARD_ID]) { items_page(limit: 100) { cursor items { id name column_values { id text value } creator { id name } } } } }\n"
                "  • By column value: { boards(ids: [BOARD_ID]) { items_page_by_column_values(board_id: BOARD_ID, columns: [{column_id: \"status\", column_values: [\"Done\"]}]) { cursor items { id name column_values { id text value } } } } }\n"
                "  • Item updates: { items(ids: [ITEM_ID]) { updates(limit: 5) { id body created_at creator { id name } } } }\n"
                "MUTATIONS (this tool can write, not just read — used e.g. to archive a chat summary to a board):\n"
                "  • Board groups: { boards(ids: [BOARD_ID]) { groups { id title } } }\n"
                "  • Items in one group (find an item by name): { boards(ids: [BOARD_ID]) { groups(ids: [\"GROUP_ID\"]) { items_page(limit: 50) { items { id name } } } } }\n"
                "  • Create item: mutation { create_item(board_id: BOARD_ID, group_id: \"GROUP_ID\", item_name: \"AI Chatbot Discussions\") { id } }\n"
                "  • Post update on an item: mutation { create_update(item_id: ITEM_ID, body: \"<b>Heading</b><br>line one<br>line two\") { id } } "
                "(body is a one-line GraphQL string with inner double-quotes escaped; Monday renders it as HTML — use <br>, <b>, <ul>/<li>)."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "A valid Monday.com GraphQL query string. Must follow the SCHEMA RULES in the "
                            "tool description: use items_page (never bare items), creator { id name } (never "
                            "creator_name), board_id + columns:[{column_id,column_values}] (never board_ids), "
                            "and updates(limit:) (never updates_page)."
                        )
                    }
                },
                "required": ["query"]
            }
        },
        {
            "name": "list_my_spaces",
            "description": "List all Google Chat spaces you are a member of using the standard Google Chat API. Use this if 'search_conversations' fails.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pageSize": {"type": "integer", "description": "Max results (default 100)."}
                }
            }
        },
        {
            "name": "list_messages_standard",
            "description": "Lists messages starting from the OLDEST. Do NOT use this if the user wants recent messages; use search_messages_standard instead.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "spaceName": {
                        "type": "string",
                        "description": "The resource name (e.g., 'spaces/XXXXXXXX')."
                    },
                    "pageSize": {"type": "integer", "description": "Max results (default 20)."},
                    "filter": {"type": "string", "description": "A query filter (e.g. 'createTime > \"2026-05-01T00:00:00Z\"')."}
                },
                "required": ["spaceName"]
            }
        },
        {
            "name": "send_message",
            "description": "Send a message to a specific Google Chat space. Requires the space resource name (e.g. 'spaces/XXXXXXXX').",
            "input_schema": {
                "type": "object",
                "properties": {
                    "conversationId": {
                        "type": "string",
                        "description": "The target space resource name (e.g., 'spaces/XXXXXXXX')."
                    },
                    "messageText": {
                        "type": "string",
                        "description": "The message body (Markdown supported)."
                    },
                    "threadId": {"type": "string"}
                },
                "required": ["conversationId", "messageText"]
            }
        },

        {
            "name": "get_gsc_performance",
            "description": (
                "Fetch Google Search Console performance data (clicks, impressions, ctr, position). "
                "IMPORTANT: fetch data in small, focused slices and call this tool sequentially — "
                "do NOT request everything in one query. Use ONE dimension per call (e.g. 'query' for "
                "top keywords, then a separate call with 'page' for top pages, then 'date' for the trend). "
                "Combining multiple dimensions multiplies the row count and overflows the context. "
                "Each call returns at most 'rowLimit' rows (default 250); keep it small and refine the "
                "date range or dimension instead of asking for more rows."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "siteUrl": {"type": "string", "description": "The site URL (e.g., 'sc-domain:example.com')."},
                    "startDate": {"type": "string", "description": "Start date (YYYY-MM-DD)."},
                    "endDate": {"type": "string", "description": "End date (YYYY-MM-DD)."},
                    "dimensions": {"type": "array", "items": {"type": "string", "enum": ["query", "page", "country", "device", "date"]}, "description": "Prefer a SINGLE dimension per call. Run separate sequential calls for each breakdown you need."},
                    "rowLimit": {"type": "integer", "description": "Max rows to return for this slice (default 250, hard max 1000). Keep small; make multiple focused calls rather than one large one."}
                },
                "required": ["siteUrl"]
            }
        },
        {
            "name": "get_ga4_report",
            "description": (
                "Fetch Google Analytics 4 report data (sessions, totalUsers, conversions). "
                "Use EXACT GA4 Data API metric names: 'totalUsers' (not 'users'), "
                "'screenPageViews' (not 'pageviews'), 'averageSessionDuration' (not 'avgSessionDuration'). "
                "Common aliases are auto-corrected and unavailable metrics (e.g. bounceRate on some "
                "properties) are dropped gracefully, but prefer the exact names."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "propertyId": {"type": "string", "description": "The GA4 Property ID (e.g., 'properties/12345')."},
                    "startDate": {"type": "string", "description": "Start date (YYYY-MM-DD)."},
                    "endDate": {"type": "string", "description": "End date (YYYY-MM-DD)."},
                    "metrics": {"type": "array", "items": {"type": "string"}},
                    "dimensions": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["propertyId"]
            }
        },
        {
            "name": "get_ads_report",
            "description": "Fetch performance data from Google Ads using GAQL. Metrics include cost_micros, clicks, impressions, conversions, etc.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "customerId": {"type": "string", "description": "The Google Ads Customer ID."},
                    "query": {"type": "string", "description": "The GAQL query string."}
                },
                "required": ["customerId", "query"]
            }
        },
        {
            "name": "get_ads_change_history",
            "description": (
                "Pull Google Ads CHANGE HISTORY (who changed what, when) for an account and flag "
                "campaigns/accounts that have NOT been optimised recently. Use this whenever the user "
                "asks about change history, recent optimisations, who edited an account, or wants to "
                "find accounts/campaigns not touched lately. By default it flags anything with no change "
                "from an agency user (email containing 'mediaone.co') in the last 14 days. Google only "
                "retains change history for the last 30 days. Returns per-campaign last-agency-change "
                "dates, an unoptimised_campaigns list, and the raw events. Distinct from get_ads_report, "
                "which only returns performance metrics, not the audit trail. For a whole-portfolio / "
                "'comb the entire MCC' audit across ALL accounts, use get_ads_mcc_change_sweep instead — "
                "change_event cannot be queried at the MCC level, so this single-account tool would need "
                "to be called once per account."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "customerId": {"type": "string", "description": "The Google Ads Customer ID."},
                    "days": {"type": "integer", "description": "How many days of change history to pull (1-30; default 30). Google retains at most 30 days."},
                    "agency_email_contains": {"type": "string", "description": "Substring identifying agency users in the change log. Default 'mediaone.co'. A change counts as an 'optimisation' only if made by a user whose email contains this."},
                    "flag_after_days": {"type": "integer", "description": "Flag a campaign/account as unoptimised if it has had no agency change within this many days. Default 14."},
                    "campaign_contains": {"type": "string", "description": "Optional case-insensitive campaign-name filter to scope the audit to specific campaigns."}
                },
                "required": ["customerId"]
            }
        },
        {
            "name": "get_ads_mcc_change_sweep",
            "description": (
                "Comb an ENTIRE Google Ads MCC (manager account) and return which CHILD ACCOUNTS have NOT "
                "been optimised recently — no change by an agency user (email containing 'mediaone.co') "
                "within the flag window. USE THIS whenever the user wants a portfolio-wide audit: 'which "
                "accounts haven't been touched/optimised lately', 'comb through the whole MCC', 'list "
                "accounts with no recent change history', etc. It auto-enumerates every enabled child "
                "account under the manager (you do NOT need to know the account ids), then checks each "
                "one's change history. managerCustomerId defaults to the MediaOne MCC (4695999392) — you "
                "usually do NOT need to pass it. Results are paged: it scans up to max_accounts per call "
                "and returns more_accounts_remaining + next_offset; if more remain, call again with that "
                "offset until more_accounts_remaining is false, accumulating unoptimised_accounts. "
                "Returns unoptimised_accounts [{id, name, currency_code, last_agency_change, "
                "days_since_agency_change}], total_child_accounts, and the scanned range."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "managerCustomerId": {"type": "string", "description": "The MCC/manager Customer ID to sweep. Defaults to the MediaOne MCC 4695999392 if omitted."},
                    "days": {"type": "integer", "description": "Days of change history to inspect per account (1-30; default 30)."},
                    "agency_email_contains": {"type": "string", "description": "Substring identifying agency users. Default 'mediaone.co'."},
                    "flag_after_days": {"type": "integer", "description": "Flag an account with no agency change within this many days. Default 14."},
                    "campaign_contains": {"type": "string", "description": "Optional: only flag accounts that have an ENABLED campaign whose name contains this (e.g. 'MO')."},
                    "max_accounts": {"type": "integer", "description": "How many child accounts to scan in this call (default 50, max 120). Use with offset to page a large MCC."},
                    "offset": {"type": "integer", "description": "Start index into the child-account list for paging. Default 0. Pass next_offset from the previous call to continue."}
                },
                "required": []
            }
        },
        {
            "name": "get_seranking_report",
            "description": "Fetch SE Ranking SEO keyword rankings, groups, and positions for a specific site/campaign.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "siteId": {"type": "string", "description": "The SE Ranking Site ID (Campaign ID)."},
                    "includePositions": {"type": "boolean", "description": "Whether to fetch current ranking positions (pos, change, date)."}
                },
                "required": ["siteId"]
            }
        },
        {
            "name": "get_seranking_backlinks",
            "description": (
                "Fetch the monitored backlinks tracked inside a SE Ranking project/campaign. "
                "Use this when the user asks about backlinks, referring domains, anchor text, or "
                "dofollow/nofollow links for one of their SE Ranking campaigns. Takes the SE Ranking "
                "Site ID (from 'loaded_seranking_campaigns' in context). Returns a summary (total "
                "backlinks, unique referring domains, dofollow/nofollow split) plus a sample of "
                "individual links. Note: this reflects SE Ranking's own Backlink Monitoring list — if "
                "a project has no backlink monitoring configured the list comes back empty, in which "
                "case fall back to dataforseo_backlinks_summary or get_ahrefs_report using the "
                "campaign's domain."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "siteId": {"type": "string", "description": "The SE Ranking Site ID (Campaign ID) from loaded_seranking_campaigns."},
                    "limit": {"type": "integer", "description": "Max individual backlinks to include in the sample (default 50).", "default": 50}
                },
                "required": ["siteId"]
            }
        },
        {
            "name": "get_dataforseo_keyword_suggestions",
            "description": "Discover new keyword ideas, search volume, and CPC using DataForSEO's Google Ads database.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "keywords": {"type": "array", "items": {"type": "string"}, "description": "Seed keywords for research."},
                    "location_name": {"type": "string", "description": "Location name (e.g., 'Singapore', 'United States')."},
                    "language_name": {"type": "string", "description": "Language name (e.g., 'English')."}
                },
                "required": ["keywords"]
            }
        },
        {
            "name": "dataforseo_serp",
            "description": "Get Google organic SERP results for a keyword. Returns the top-ranking pages, their URLs, titles, descriptions, and positions.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "The search keyword to get SERP results for."},
                    "location_name": {"type": "string", "description": "Location name, e.g. 'Singapore', 'United States', 'United Kingdom'."},
                    "language_name": {"type": "string", "description": "Language name, e.g. 'English'."},
                    "depth": {"type": "integer", "description": "Number of results to return (default 10, max 100).", "default": 10}
                },
                "required": ["keyword"]
            }
        },
        {
            "name": "dataforseo_search_volume",
            "description": "Get Google Ads search volume, competition level, and CPC for a list of keywords.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "keywords": {"type": "array", "items": {"type": "string"}, "description": "List of keywords to get search volume for (max 1000)."},
                    "location_name": {"type": "string", "description": "Location name, e.g. 'Singapore', 'United States'."},
                    "language_name": {"type": "string", "description": "Language name, e.g. 'English'."}
                },
                "required": ["keywords"]
            }
        },
        {
            "name": "dataforseo_backlinks_summary",
            "description": "Get a backlink summary for a domain or URL: total backlinks, referring domains, domain rank, and broken pages.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "Domain or URL to get backlinks for, e.g. 'example.com' or 'https://example.com/page'."},
                    "include_subdomains": {"type": "boolean", "description": "Whether to include subdomains (default True).", "default": True}
                },
                "required": ["target"]
            }
        },
        {
            "name": "dataforseo_domain_rank_overview",
            "description": "Get a domain's organic traffic rank overview: estimated traffic, number of keywords ranking, and authority score.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "Domain to analyse, e.g. 'example.com'."},
                    "location_name": {"type": "string", "description": "Location name, e.g. 'Singapore', 'United States'."},
                    "language_name": {"type": "string", "description": "Language name, e.g. 'English'."}
                },
                "required": ["target"]
            }
        },
        {
            "name": "dataforseo_ranked_keywords",
            "description": "Get keywords a domain currently ranks for organically in Google, including positions, search volume, and URLs.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "Domain to get ranked keywords for, e.g. 'example.com'."},
                    "location_name": {"type": "string", "description": "Location name, e.g. 'Singapore', 'United States'."},
                    "language_name": {"type": "string", "description": "Language name, e.g. 'English'."},
                    "limit": {"type": "integer", "description": "Max number of keywords to return (default 100, max 1000).", "default": 100},
                    "filters": {"type": "array", "description": "Optional filters, e.g. [[\"ranked_serp_element.serp_item.rank_group\",\"<\",\"11\"]] for top-10 keywords.", "items": {}}
                },
                "required": ["target"]
            }
        },
        {
            "name": "save_memory_note",
            "description": (
                "Persist a DURABLE insight for future sessions. Use ONLY for knowledge that "
                "CANNOT be re-pulled from a connector: user preferences/instructions, strategic "
                "decisions and their rationale, client relationships/requests/context, reusable "
                "workflows, and stable ID mappings (e.g. which account/site ID belongs to a client). "
                "DO NOT save point-in-time data that a tool can re-fetch on demand — keyword "
                "positions/volumes/CPC, GA4 / Google Ads / Meta / LinkedIn / TikTok metrics, live "
                "SERP results, backlink or Domain-Rating counts, or Monday board item counts/statuses. "
                "If a note is essentially a metric snapshot, do NOT save it; re-pull it when needed."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The specific durable insight to remember (e.g., 'User prefers tables for SEO data'). Must NOT be a re-pullable metric snapshot."},
                    "tag": {"type": "string", "enum": ["Preference", "Project Logic", "Fact", "General"], "description": "Category of the memory."}
                },
                "required": ["text", "tag"]
            }
        },
        {
            "name": "get_ahrefs_report",
            "description": (
                "Fetch live Ahrefs data for any domain. Use this whenever the user asks about "
                "backlinks, Domain Rating (DR), referring domains, organic traffic, organic keywords, "
                "or competitor analysis. Actions: 'overview' returns DR + traffic snapshot; "
                "'keywords' returns top organic keyword rankings; 'backlinks' returns top backlinks "
                "by DR; 'competitors' returns competing domains."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "domain": {"type": "string", "description": "The domain to analyse, e.g. 'example.com'."},
                    "action": {
                        "type": "string",
                        "enum": ["overview", "keywords", "backlinks", "competitors"],
                        "description": "What to fetch. Defaults to 'overview'."
                    }
                },
                "required": ["domain"]
            }
        },
        {
            "name": "get_moz_da",
            "description": (
                "Get Moz Domain Authority (DA) and Page Authority (PA) for a domain or URL. "
                "Use this WHENEVER the user specifically asks for 'Moz DA', 'Domain Authority (DA)', "
                "or 'Page Authority (PA)' — this is the real Moz metric, distinct from Ahrefs DR or "
                "DataForSEO domain rank. Pass a bare domain (e.g. 'example.com') for domain-level DA, "
                "or a full URL for that page's PA. Call once per target; for a list of URLs, call it "
                "for each one."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "Domain or full URL to score, e.g. 'example.com' or 'https://example.com/page'."}
                },
                "required": ["target"]
            }
        },
        {
            "name": "get_tiktok_ads_report",
            "description": (
                "Fetch TikTok Ads performance data — spend, impressions, clicks, CTR, CPC, CPM, "
                "conversions, cost per conversion, conversion rate, reach, and results. Use this "
                "whenever the user asks about TikTok Ads or TikTok paid social performance. The "
                "advertiser_id values are in the synced context under 'tiktok_advertiser_ids'. "
                "Call once per advertiser_id. For a daily time series use dimensions ['stat_time_day']; "
                "for a single aggregated total use ['advertiser_id']. To break spend down by campaign, "
                "set data_level='AUCTION_CAMPAIGN' — each row then includes BOTH campaign_id and "
                "campaign_name (the name is resolved automatically), so you can match campaigns to "
                "monday boards by name. Do NOT claim TikTok only returns campaign ids; names are provided."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "advertiser_id": {"type": "string", "description": "The TikTok advertiser (ad account) ID. Found in synced context under 'tiktok_advertiser_ids'."},
                    "start_date": {"type": "string", "description": "Start date (YYYY-MM-DD)."},
                    "end_date": {"type": "string", "description": "End date (YYYY-MM-DD)."},
                    "dimensions": {"type": "array", "items": {"type": "string"}, "description": "Report dimensions. Use ['stat_time_day'] for a daily breakdown or ['advertiser_id'] for a single aggregated total. Defaults to ['stat_time_day']."},
                    "metrics": {"type": "array", "items": {"type": "string"}, "description": "Optional metric list. Defaults to spend, impressions, clicks, ctr, cpc, cpm, conversion, cost_per_conversion, conversion_rate, reach, result, cost_per_result."},
                    "data_level": {"type": "string", "enum": ["AUCTION_ADVERTISER", "AUCTION_CAMPAIGN", "AUCTION_ADGROUP", "AUCTION_AD"], "description": "Aggregation level. Defaults to AUCTION_ADVERTISER."}
                },
                "required": ["advertiser_id", "start_date", "end_date"]
            }
        },
        {
            "name": "get_meta_ads_report",
            "description": (
                "Fetch Meta (Facebook/Instagram) Ads performance data — spend, impressions, clicks, "
                "CTR, CPC, CPM, reach, frequency, ROAS, actions/results, and cost per action. Use this "
                "whenever the user asks about Meta Ads, Facebook Ads, Instagram Ads, or paid social "
                "performance. The ad_account_id values are in the synced context / CURRENT CONTEXT under "
                "'meta_ad_account_ids'. Call once per ad_account_id. For a daily breakdown set "
                "time_increment to 1. To analyse only specific campaigns (e.g. agency-managed "
                "campaigns whose names contain 'MO'), set level='campaign' and pass name_contains "
                "— rows come back with campaign_name/campaign_id and only the matching campaigns. "
                "Never report account-level totals as if they were a name-filtered subset."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "ad_account_id": {"type": "string", "description": "The Meta ad account ID (e.g. 'act_123456789'; the 'act_' prefix is added automatically if missing). Found in synced context under 'meta_ad_account_ids'."},
                    "start_date": {"type": "string", "description": "Start date (YYYY-MM-DD)."},
                    "end_date": {"type": "string", "description": "End date (YYYY-MM-DD)."},
                    "level": {"type": "string", "enum": ["account", "campaign", "adset", "ad"], "description": "Aggregation level. Defaults to 'account'. Rows at campaign/adset/ad level include the entity name + id. Use 'campaign' whenever the user names or filters by campaign."},
                    "time_increment": {"type": "integer", "description": "Set to 1 for a daily time series. Omit for a single aggregated total."},
                    "fields": {"type": "array", "items": {"type": "string"}, "description": "Optional Insights field list. Defaults to spend, impressions, clicks, ctr, cpc, cpm, reach, frequency, actions, action_values, purchase_roas, cost_per_action_type."},
                    "name_contains": {"type": "string", "description": "Case-insensitive substring to filter campaigns/ad sets/ads by name (e.g. 'MO' for agency-managed campaigns). If level is 'account' it auto-upgrades to 'campaign'. The result reports matched_count, total_count, and matched_names so you can confirm the filter."}
                },
                "required": ["ad_account_id", "start_date", "end_date"]
            }
        },
        {
            "name": "get_linkedin_ads_report",
            "description": (
                "Fetch LinkedIn Ads performance data — impressions, clicks, cost (USD and local), "
                "conversions, leads, landing page clicks, likes, shares, comments, and follows. Use this "
                "whenever the user asks about LinkedIn Ads or B2B paid social performance. The account_id "
                "values are in the synced context / CURRENT CONTEXT under 'linkedin_ad_account_ids'. Call "
                "once per account_id. Set granularity to DAILY for a daily time series."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "account_id": {"type": "string", "description": "The LinkedIn sponsored account ID (numeric, e.g. '512345678'). Found in synced context under 'linkedin_ad_account_ids'."},
                    "start_date": {"type": "string", "description": "Start date (YYYY-MM-DD)."},
                    "end_date": {"type": "string", "description": "End date (YYYY-MM-DD)."},
                    "pivot": {"type": "string", "enum": ["ACCOUNT", "CAMPAIGN", "CAMPAIGN_GROUP", "CREATIVE"], "description": "Reporting pivot. Defaults to ACCOUNT."},
                    "granularity": {"type": "string", "enum": ["ALL", "DAILY", "MONTHLY"], "description": "Time granularity. Defaults to ALL (single aggregated total)."},
                    "fields": {"type": "array", "items": {"type": "string"}, "description": "Optional analytics field list. Defaults to impressions, clicks, costInUsd, costInLocalCurrency, externalWebsiteConversions, oneClickLeads, landingPageClicks, likes, shares, comments, follows, dateRange, pivotValues."}
                },
                "required": ["account_id", "start_date", "end_date"]
            }
        },
        {
            "name": "search_knowledge_base",
            "description": (
                "Search MediaOne's internal support knowledge base — a curated FAQ of question/answer "
                "pairs covering company info, PSG and SFEC grants (eligibility, criteria, application, "
                "required documents), package pricing, SEO services, deliverables and KPIs, SEM / Google "
                "Ads, project timelines, and common client questions. ALWAYS call this FIRST when the user "
                "asks a MediaOne company, grant, pricing, package, service, deliverable, or support "
                "question, before answering from general knowledge. Ground your answer in the returned "
                "matches — do NOT invent grant criteria, prices, eligibility, or policies. If no relevant "
                "match is returned, tell the user you don't have that in the knowledge base rather than "
                "guessing."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The user's question or key topic to look up, in natural language."},
                    "top_k": {"type": "integer", "description": "How many matches to return (1-10). Defaults to 4."}
                },
                "required": ["query"]
            }
        },
        {
            "name": "check_calendar_availability",
            "description": (
                "Look up one or more colleagues' Google Calendar SCHEDULE by email. By DEFAULT it returns "
                "full event DETAILS — meeting titles, start/end times, location, and attendee counts — so "
                "use it both for 'what's on Nathan's calendar today?' / 'show me Tom's meetings tomorrow' "
                "AND for availability questions like 'is Tom free this afternoon?', 'find a 30-min slot "
                "Nathan and I both have on Thursday', or 'who's free at 3pm?' (infer free gaps from the "
                "events). Provide the time window as RFC3339 timestamps; today's date is given in the "
                "system prompt, so compute concrete start/end times from relative phrases ('today', "
                "'tomorrow', 'this week'). Default timezone is Asia/Singapore. Per colleague the result is "
                "one of: details_visible:true with an 'events' list; visible:true + details_visible:false "
                "with 'busy' blocks (that person shares free/busy only — no titles); or visible:false with "
                "a reason (calendar not shared) — relay that rather than guessing. Titles shown '(private)' "
                "are events marked private. When you have details, present the actual meeting titles and "
                "times by default, not just free/busy. If the result says calendar access isn't available, "
                "tell the user to reconnect Google Workspace and approve the Calendar permission."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "emails": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "One or more colleague email addresses to check (e.g. ['tom@mediaone.co'])."
                    },
                    "start_time": {
                        "type": "string",
                        "description": "Window start as RFC3339 (e.g. '2026-06-26T09:00:00+08:00') or a date 'YYYY-MM-DD'. Defaults to now."
                    },
                    "end_time": {
                        "type": "string",
                        "description": "Window end as RFC3339 or date 'YYYY-MM-DD'. Defaults to 7 days after start."
                    },
                    "timezone": {
                        "type": "string",
                        "description": "IANA timezone for the window and results. Defaults to 'Asia/Singapore'."
                    }
                },
                "required": ["emails"]
            }
        },
        {
            "name": "workduo_list_projects",
            "description": (
                "List the WorkDuo AI-visibility projects available to this account. Use this FIRST when "
                "the user asks about AI visibility / AI search presence / LLM visibility / WorkDuo and you "
                "don't already have the entity_id, so you can find the right project's entity_id and "
                "project_id to pass to get_workduo_report. (If projects are already listed in the system "
                "context with their entity ids, you can skip this and call get_workduo_report directly.)"
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "search": {"type": "string", "description": "Optional case-insensitive substring to filter projects by name (e.g. a brand or client name)."}
                }
            }
        },
        {
            "name": "get_workduo_report",
            "description": (
                "Fetch WorkDuo AI-visibility metrics (visibility, share-of-voice, mentions, average position) "
                "for one entity over a date range. ALWAYS use this when the user asks about AI visibility, AI "
                "search presence, LLM visibility, or WorkDuo. You need the entity_id — get it from "
                "workduo_list_projects or from the projects listed in the system context. Dates default to the "
                "trailing 30 days if omitted."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "entity_id":  {"type": "string", "description": "The WorkDuo entity id to report on (from workduo_list_projects)."},
                    "project_id": {"type": "string", "description": "The WorkDuo project id the entity belongs to (recommended; from workduo_list_projects)."},
                    "start_date": {"type": "string", "description": "Start date 'YYYY-MM-DD'. Defaults to 30 days ago."},
                    "end_date":   {"type": "string", "description": "End date 'YYYY-MM-DD'. Defaults to today."}
                },
                "required": ["entity_id"]
            }
        }
    ]

    # DeepSeek-only: expose Claude vision as a tool when the user attached image(s).
    if provider == 'deepseek' and available_images:
        tools.append({
            "name": "analyze_image",
            "description": "View and analyze an image the user attached. You (DeepSeek) cannot see "
                           "images directly — call this to have Claude's vision examine one and return a "
                           "description. Call it again with a more specific question for a closer second look.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "image_id": {"type": "string", "description": "The id of the image to examine (see the attached-images list)."},
                    "question": {"type": "string", "description": "What to look for, e.g. 'Describe this image' or 'What text appears in it?'"},
                },
                "required": ["image_id", "question"],
            },
        })

    anthropic_headers = {
        "x-api-key": anthropic_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    if thinking:
        anthropic_headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"

    tool_call_log = []   # human-readable summary for the UI
    MAX_TOOL_ROUNDS = 8  # safety cap to prevent infinite loops
    auto_continues = 0       # DeepSeek-only: times we've nudged it to finish a stalled turn
    MAX_AUTO_CONTINUES = 3

    # ── Usage accounting ────────────────────────────────────────────────────
    # A single user message can span several model rounds (tool use +
    # auto-continuation). The provider reports per-round token usage; sum it so
    # the admin usage dashboard sees the true cost of the whole turn, not just
    # the last round. Normalises Anthropic (input/output_tokens) and DeepSeek
    # (prompt/completion_tokens) shapes into one running total.
    usage_total = {"input_tokens": 0, "output_tokens": 0,
                   "cache_hit_tokens": 0, "cache_write_tokens": 0}
    def _accumulate_usage(u):
        if not isinstance(u, dict):
            return
        # Cache-aware normalisation so the dashboard can price cached input at the
        # (much cheaper) cache rate instead of the flat miss rate.
        #   cache_hit   = already-cached input read back (Anthropic cache_read /
        #                 DeepSeek prompt_cache_hit) — billed at the cache-read rate.
        #   cache_write = Anthropic cache_creation (DeepSeek has none) — cache-write rate.
        cache_hit   = int(u.get("cache_read_input_tokens")     or u.get("prompt_cache_hit_tokens") or 0)
        cache_write = int(u.get("cache_creation_input_tokens") or 0)
        # Normalise to TOTAL input across providers. DeepSeek `prompt_tokens`
        # already includes cache hits; Anthropic `input_tokens` EXCLUDES cache,
        # so add the cached portions back to get the true total.
        if u.get("prompt_tokens") is not None:
            total_in = int(u.get("prompt_tokens") or 0)
        else:
            total_in = int(u.get("input_tokens") or 0) + cache_hit + cache_write
        usage_total["input_tokens"]       += total_in
        usage_total["output_tokens"]      += (u.get("output_tokens") or u.get("completion_tokens") or 0)
        usage_total["cache_hit_tokens"]   += cache_hit
        usage_total["cache_write_tokens"] += cache_write

    def _log_usage(rounds):
        """Best-effort: persist this turn's token usage to the usage_logs
        collection for the admin usage dashboard. Must never break the chat,
        so every failure is swallowed."""
        if usage_total["input_tokens"] == 0 and usage_total["output_tokens"] == 0:
            return
        try:
            db = get_db()
            if db is None:
                return
            # clientEmail in localStorage is sometimes wrapped in escaped quotes/
            # backslashes; extract the bare address so the dashboard groups cleanly.
            email = clean_email(body.get('client_email') or body.get('clientEmail'))
            # Distinct server-side tools this turn invoked, for the dashboard's
            # per-tool breakdown. Prefer the friendly label; memory-note calls
            # are internal bookkeeping, not a user-facing tool, so exclude them.
            tools_used = sorted({
                (t.get("label") or t.get("name"))
                for t in tool_events
                if t.get("name") and t.get("name") != "save_memory_note"
            })
            db.usage_logs.insert_one({
                "orgId":           "digimetrics",
                "ts":              time.time(),
                "savedAt":         datetime.utcnow(),
                "email":           email,
                "app_source":      body.get('app_source') or 'unknown',
                "provider":        provider,
                "model":           model,
                "input_tokens":      int(usage_total["input_tokens"]),
                "output_tokens":     int(usage_total["output_tokens"]),
                "cache_hit_tokens":  int(usage_total["cache_hit_tokens"]),
                "cache_write_tokens": int(usage_total["cache_write_tokens"]),
                "tools_used":        tools_used,
                "rounds":          rounds,
                "conversation_id": body.get('conversation_id') or '',
            })
        except Exception as e:
            print(f"[USAGE] log failed: {e}")

    try:
        for round_num in range(MAX_TOOL_ROUNDS + 1):

            _report_progress("Thinking" if round_num == 0 else "Analyzing results")

            payload = {
                "model": model,
                "max_tokens": max_tokens,
                "messages": messages
            }
            if system:
                payload["system"] = system
            if tools:
                payload["tools"] = tools
            if thinking:
                payload["thinking"] = thinking

            # ── Data size logging ──────────────────────────────────────────────
            sys_size = len(system) if system else 0
            msg_size = len(json.dumps(messages))
            total_est = sys_size + msg_size
            print(f"[LOG] {provider} Request ({model}) - Round {round_num}")
            print(f"      System Prompt Size: {sys_size} chars")
            print(f"      Messages Size:      {msg_size} chars")
            print(f"      Estimated Total:    {total_est} chars")
            # ───────────────────────────────────────────────────────────────────

            if provider == 'deepseek':
                # ── DeepSeek (OpenAI-compatible) path ──────────────────────────
                ds_messages, ds_tools = _anthropic_to_openai(system, messages, tools)
                # Append the tool-discipline reminder to the system message so DeepSeek
                # doesn't stall mid-task by narrating its next step instead of doing it.
                ds_system_extra = _DEEPSEEK_TOOL_DISCIPLINE
                if available_images:
                    _img_list = "; ".join(f"{im['id']} ({im['name']})" for im in available_images)
                    ds_system_extra += (
                        "\n\nATTACHED IMAGES: The user has attached image(s): " + _img_list + ". "
                        "You cannot see images directly. To answer ANY question about them, call the "
                        "analyze_image tool with the image_id and a specific question — do this immediately, "
                        "and call it again for follow-up detail (a 'second look'). Never tell the user you "
                        "can't see images; use the tool instead."
                    )
                if ds_messages and ds_messages[0].get("role") == "system":
                    ds_messages[0]["content"] = (ds_messages[0].get("content") or "") + ds_system_extra
                else:
                    ds_messages.insert(0, {"role": "system", "content": ds_system_extra.strip()})
                ds_payload = {
                    "model": model,
                    "max_tokens": max_tokens,
                    "messages": ds_messages,
                }
                if ds_tools:
                    ds_payload["tools"] = ds_tools
                    ds_payload["tool_choice"] = "auto"

                r = requests.post(
                    "https://api.deepseek.com/chat/completions",
                    headers={
                        "Authorization": f"Bearer {deepseek_key}",
                        "content-type": "application/json",
                    },
                    json=ds_payload,
                    timeout=120,
                )

                if r.status_code != 200:
                    err_body = r.text[:1000]
                    print(f"[TOOLS] DeepSeek error {r.status_code}: {err_body}")
                    return {"statusCode": r.status_code, "body": json.dumps({"error": f"DeepSeek API error {r.status_code}", "detail": err_body})}

                response_data = r.json()
                choice = (response_data.get("choices") or [{}])[0]
                ds_finish = choice.get("finish_reason")
                ds_msg = choice.get("message", {}) or {}
                stop_reason, content_blocks = _openai_to_anthropic(ds_msg, ds_finish)

                # Diagnostics: surface exactly what DeepSeek returned each round so
                # "the conversation just ends" cases are traceable in CloudWatch.
                _ds_text_len = len(ds_msg.get("content") or "")
                _ds_tc = len(ds_msg.get("tool_calls") or [])
                print(f"[DEEPSEEK] Round {round_num}: finish_reason={ds_finish} "
                      f"text_len={_ds_text_len} tool_calls={_ds_tc} usage={json.dumps(response_data.get('usage', {}))}")
                if ds_finish == "length":
                    # Output hit max_tokens — the reply is truncated mid-thought, which
                    # reads to the user as the conversation cutting off. Force a clean end
                    # and append a notice rather than feeding a half-finished turn back.
                    print(f"[DEEPSEEK] WARNING: response truncated at max_tokens={max_tokens} (round {round_num})")
                    stop_reason = "end_turn"
                    if not any(b.get("type") == "text" for b in content_blocks):
                        content_blocks.append({"type": "text", "text": ""})
                if stop_reason == "end_turn" and not any(
                    (b.get("type") == "text" and b.get("text", "").strip()) for b in content_blocks
                ):
                    # DeepSeek ended the turn with no usable text (e.g. content filter or a
                    # bare tool call it declined to summarise) — log the raw shape for triage.
                    print(f"[DEEPSEEK] EMPTY final reply. raw_choice={json.dumps(choice)[:1200]}")
            else:
                # ── Anthropic path (unchanged) ─────────────────────────────────
                r = requests.post(
                    "https://api.anthropic.com/v1/messages",
                    headers=anthropic_headers,
                    json=payload,
                    timeout=60,
                )

                if r.status_code != 200:
                    err_body = r.text[:1000]
                    print(f"[TOOLS] Anthropic error {r.status_code}: {err_body}")
                    # On usage-limit errors, retry once with the backup key if available
                    if r.status_code in (429, 529) and anthropic_key_backup and anthropic_headers["x-api-key"] != anthropic_key_backup:
                        print("[TOOLS] Primary key hit usage limit — retrying with backup key")
                        anthropic_headers["x-api-key"] = anthropic_key_backup
                        continue
                    return {"statusCode": r.status_code, "body": json.dumps({"error": f"Anthropic API error {r.status_code}", "detail": err_body})}

                response_data = r.json()
                stop_reason   = response_data.get("stop_reason")
                content_blocks = response_data.get("content", [])

            # ── Tool result logging ────────────────────────────────────────────
            usage = response_data.get("usage", {})
            _accumulate_usage(usage)
            print(f"      Response usage: {json.dumps(usage)}")
            # ───────────────────────────────────────────────────────────────────

            # ── Final answer: no more tool calls ──────────────────────────
            if stop_reason == "end_turn":
                final_text = "\n\n".join(
                    block["text"] for block in content_blocks
                    if block.get("type") == "text" and block.get("text", "").strip()
                )
                thinking_text = "\n\n".join(
                    block["thinking"] for block in content_blocks
                    if block.get("type") == "thinking" and block.get("thinking", "").strip()
                ) or None
                # DeepSeek sometimes ends a turn while announcing the next step instead
                # of doing it ("Let me check the other boards now.") — which strands the
                # user with a half-finished answer. Nudge it to actually continue.
                if (provider == 'deepseek'
                        and auto_continues < MAX_AUTO_CONTINUES
                        and _deepseek_turn_unfinished(final_text)):
                    print(f"[DEEPSEEK] Stalled turn (auto-continue {auto_continues + 1}/{MAX_AUTO_CONTINUES}); "
                          f"tail={final_text[-100:]!r}")
                    messages.append({
                        "role": "assistant",
                        "content": content_blocks if content_blocks else [{"type": "text", "text": final_text or "(continuing)"}],
                    })
                    messages.append({
                        "role": "user",
                        "content": "Continue and finish the remaining steps now. Call any tools you need, "
                                   "then give the complete final answer — do not stop to announce what you are about to do.",
                    })
                    auto_continues += 1
                    _report_progress("Continuing")
                    continue

                # Never hand the client a blank reply — that renders as a dead empty
                # bubble and reads as "the conversation just ended". Give a graceful nudge.
                if not final_text.strip():
                    final_text = ("I didn't manage to produce a response that time. "
                                  "Could you rephrase or try again?")
                # Exclude internal MEM_SAVE directives from the user-facing tool log
                display_log = [t for t in tool_call_log if not t.startswith("MEM_SAVE:")]
                summary = "\n".join(display_log) if display_log else None
                # If DeepSeek still ended announcing more work (past the in-invocation
                # auto-continue budget), flag it so the client continues in a new message.
                still_unfinished = (provider == 'deepseek' and _deepseek_turn_unfinished(final_text))
                _log_usage(round_num)
                _clear_progress()
                return {
                    "statusCode": 200,
                    "body": json.dumps({
                        "reply": final_text,
                        "thinking": thinking_text,
                        "tool_calls_summary": summary,
                        "tool_calls": [t for t in tool_events if t.get("name") != "save_memory_note"],
                        "rounds": round_num,
                        "incomplete": still_unfinished,
                        "memory_updates": [t for t in tool_call_log if t.startswith("MEM_SAVE:")],
                        "debug_stats": {
                            "system_chars": sys_size,
                            "messages_chars": msg_size,
                            "total_est_chars": total_est,
                            "usage": usage
                        }
                    })
                }

            # ── Tool use: execute each tool call and feed results back ────
            if stop_reason == "tool_use":
                # Add assistant's full response (including tool_use blocks) to history
                messages.append({"role": "assistant", "content": content_blocks})

                # Build the tool_result message with one result per tool_use block
                tool_results = []
                for block in content_blocks:
                    if block.get("type") != "tool_use":
                        continue

                    tool_id    = block.get("id", f"call_{int(time.time())}")
                    tool_name  = block["name"]
                    tool_input = block.get("input", {})

                    # Record the call + beacon real progress before executing,
                    # so the browser shows what is running right now.
                    _tool_label = TOOL_LABELS.get(tool_name, tool_name.replace('_', ' ').title())
                    tool_events.append({"name": tool_name, "label": _tool_label})
                    _report_progress(_tool_label)

                    if tool_name == "monday_graphql":
                        gql_query = tool_input.get("query", "")
                        print(f"[TOOLS] Executing monday_graphql: {gql_query[:120]}...")
                        tool_call_log.append(f"▸ {gql_query[:100].strip()}{'…' if len(gql_query) > 100 else ''}")

                        result_data = run_monday_graphql(gql_query, api_key=body.get('monday_api_key'))
                        result_str  = json.dumps(result_data)

                        # Truncate very large payloads to prevent blowing token budget
                        if len(result_str) > 40000:
                            print(f"[TOOLS] Result truncated ({len(result_str)} chars)")
                            result_str = result_str[:40000] + "\n... [result truncated, refine query if needed]"

                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                    elif tool_name in ["search_conversations", "list_messages", "search_messages", "send_message"]:
                        # Extract Google Access Token from body
                        google_token = body.get('google_access_token') or (body.get('google_tokens', {}).get('workspace'))
                        
                        print(f"[TOOLS] Executing Google Chat MCP: {tool_name}")
                        tool_call_log.append(f"▸ Google Chat: {tool_name}")
                        
                        result_data = run_google_chat_mcp_tool(tool_name, tool_input, google_token)
                        result_str  = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                    elif tool_name == "list_my_spaces":
                        google_token = body.get('google_access_token') or (body.get('google_tokens', {}).get('workspace'))
                        print(f"[TOOLS] Listing Google Chat Spaces via Standard API")
                        
                        page_size = tool_input.get('pageSize', 100)
                        result_data = list_google_chat_spaces_standard(google_token, page_size)
                        result_str = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                    elif tool_name == "list_messages_standard":
                        google_token = body.get('google_access_token') or (body.get('google_tokens', {}).get('workspace'))
                        space_name = tool_input.get('spaceName')
                        page_size = tool_input.get('pageSize', 20)
                        filter_str = tool_input.get('filter')
                        
                        print(f"[TOOLS] Listing Google Chat Messages via Standard API for {space_name}")
                        result_data = list_google_chat_messages_standard(google_token, space_name, page_size, filter_str)
                        result_str = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                    elif tool_name == "search_messages_standard":
                        google_token = body.get('google_access_token') or (body.get('google_tokens', {}).get('workspace'))
                        query = tool_input.get('query')
                        order_by = tool_input.get('orderBy', 'CREATE_TIME_DESC')
                        
                        print(f"[TOOLS] Searching Google Chat Messages via Standard API for {query}")
                        result_data = search_google_chat_messages_standard(google_token, query, order_by)
                        result_str = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                    
                    elif tool_name == "get_ads_report":
                        customerId = tool_input.get("customerId")
                        query = tool_input.get("query")
                        ads_token = body.get('google_tokens', {}).get('ads')
                        
                        print(f"[TOOLS] Fetching Google Ads Report for {customerId}")
                        raw_ads = run_google_ads_report(customerId, query, ads_token)
                        # Convert micros->currency + attach an authoritative pre-summed total,
                        # so the model never hand-divides micros (root cause of 10x spend errors).
                        result_data = normalize_ads_report_for_llm(raw_ads)
                        # Guarantee the currency is known even if the GAQL omitted customer.currency_code,
                        # so an SGD account is never mislabelled (e.g. as MYR) from its country.
                        if (isinstance(result_data, dict)
                                and not result_data.get("_summary", {}).get("currency_code")
                                and customerId and ads_token):
                            cc = fetch_ads_account_currency(customerId, ads_token)
                            if cc:
                                result_data.setdefault("_summary", {})["currency_code"] = cc
                        result_str = json.dumps(result_data)

                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })

                    elif tool_name == "get_ads_change_history":
                        customerId = tool_input.get("customerId")
                        ads_token = body.get('google_tokens', {}).get('ads')
                        print(f"[TOOLS] Fetching Google Ads change history for {customerId}")
                        result_data = run_google_ads_change_history(
                            customerId,
                            ads_token,
                            tool_input.get("days", 30),
                            tool_input.get("agency_email_contains", "mediaone.co"),
                            tool_input.get("flag_after_days", 14),
                            tool_input.get("campaign_contains")
                        )
                        result_str = json.dumps(result_data)
                        if len(result_str) > 40000:
                            result_str = result_str[:40000] + "\n... [result truncated, narrow days or campaign_contains]"
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                        tool_call_log.append(f"Pulled Google Ads change history for {customerId}")

                    elif tool_name == "get_ads_mcc_change_sweep":
                        ads_token = body.get('google_tokens', {}).get('ads')
                        mgr = tool_input.get("managerCustomerId")
                        print(f"[TOOLS] MCC change sweep (manager={mgr or 'default MediaOne MCC'})")
                        result_data = run_google_ads_mcc_change_sweep(
                            ads_token,
                            manager_id=mgr,
                            days=tool_input.get("days", 30),
                            agency_email_contains=tool_input.get("agency_email_contains", "mediaone.co"),
                            flag_after_days=tool_input.get("flag_after_days", 14),
                            campaign_contains=tool_input.get("campaign_contains"),
                            max_accounts=tool_input.get("max_accounts", 50),
                            offset=tool_input.get("offset", 0),
                        )
                        result_str = json.dumps(result_data)
                        if len(result_str) > 40000:
                            result_str = result_str[:40000] + "\n... [result truncated — lower max_accounts]"
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                        tool_call_log.append("Swept MCC for unoptimised Google Ads accounts")

                    elif tool_name == "get_gsc_performance":
                        siteUrl = tool_input.get("siteUrl")
                        gsc_token = body.get('google_tokens', {}).get('gsc')
                        
                        print(f"[TOOLS] Fetching GSC Performance for {siteUrl}")
                        result_data = run_gsc_performance(siteUrl, tool_input, gsc_token)
                        result_str = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })

                    elif tool_name == "get_ga4_report":
                        propertyId = tool_input.get("propertyId")
                        ga4_token = body.get('google_tokens', {}).get('ga4')
                        
                        print(f"[TOOLS] Fetching GA4 Report for {propertyId}")
                        result_data = run_ga4_report(propertyId, tool_input, ga4_token)
                        result_str = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                    elif tool_name == "list_mcp_tools":
                        google_token = body.get('google_access_token') or (body.get('google_tokens', {}).get('workspace'))
                        print(f"[TOOLS] Listing Google Chat MCP Tools with Schemas")
                        
                        payload = {"jsonrpc": "2.0", "id": "list-tools-debug", "method": "tools/list", "params": {}}
                        headers = {"Authorization": f"Bearer {google_token}", "Content-Type": "application/json"}
                        r = requests.post("https://chatmcp.googleapis.com/mcp/v1", headers=headers, json=payload, timeout=30)
                        
                        # Return the full raw response so Claude can see the schemas
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     r.text
                        })
                    elif tool_name == "get_seranking_report":
                        site_id = str(tool_input.get("siteId", ""))
                        include_pos = tool_input.get("includePositions", True)
                        
                        # Validation: Prevent using Monday IDs (usually 10 digits) as SE Ranking Site IDs
                        if len(site_id) >= 10:
                            error_msg = f"Error: Site ID '{site_id}' looks like a Monday.com Item ID. SE Ranking Site IDs are usually 7-8 digits. Please check the context for 'target_site_id' or 'seranking_site_id' associated with the campaign."
                            tool_results.append({
                                "type": "tool_result",
                                "tool_use_id": tool_id,
                                "content": json.dumps({"error": error_msg}),
                                "is_error": True
                            })
                            continue
                        
                        ser_headers = {"Authorization": f"Token {SERANKING_TOKEN}", "Content-Type": "application/json"}
                        
                        # Fetch Keywords
                        kw_res = requests.get(f'https://api4.seranking.com/sites/{site_id}/keywords', headers=ser_headers, timeout=175)
                        keywords = kw_res.json() if kw_res.status_code == 200 else []
                        
                        # Fetch Groups
                        group_res = requests.get(f'https://api4.seranking.com/keyword-groups/{site_id}', headers=ser_headers, timeout=175)
                        groups = group_res.json() if group_res.status_code == 200 else []
                        group_map = {str(g.get('id')): g.get('name', 'Unknown') for g in groups if isinstance(g, dict) and 'id' in g} if isinstance(groups, list) else {}
                        
                        result_data = {"site_id": site_id, "keywords": []}
                        
                        if include_pos:
                            today = datetime.today().strftime('%Y-%m-%d')
                            pos_res = requests.get(f'https://api4.seranking.com/sites/{site_id}/positions?date_from={today}&date_to={today}', headers=ser_headers, timeout=175)
                            pos_data = pos_res.json() if pos_res.status_code == 200 else []
                            
                            pos_map = {}
                            if isinstance(pos_data, list) and len(pos_data) > 0 and 'keywords' in pos_data[0]:
                                for p in pos_data[0]['keywords']:
                                    if isinstance(p, dict) and p.get('id') and p.get('positions'):
                                        latest = p['positions'][-1]
                                        pos_map[str(p.get('id'))] = {"pos": latest.get('pos'), "change": latest.get('change')}
                            
                            if isinstance(keywords, list):
                                for kw in keywords:
                                    k_id = str(kw.get('id', ''))
                                    p_info = pos_map.get(k_id, {})
                                    result_data["keywords"].append({
                                        "name": kw.get('name'),
                                        "group": group_map.get(str(kw.get('group_id')), "No Group"),
                                        "position": p_info.get("pos", "Not Ranked"),
                                        "change": p_info.get("change", "-")
                                    })
                        else:
                            if isinstance(keywords, list):
                                for kw in keywords:
                                    result_data["keywords"].append({
                                        "name": kw.get('name'),
                                        "group": group_map.get(str(kw.get('group_id')), "No Group")
                                    })
                        
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "content": json.dumps(result_data)
                        })
                        tool_call_log.append(f"Fetched SE Ranking rankings for Site {site_id}")

                    elif tool_name == "get_seranking_backlinks":
                        site_id = str(tool_input.get("siteId", ""))
                        limit = tool_input.get("limit", 50)

                        # Same guard as get_seranking_report: a 10+ digit id is almost
                        # certainly a Monday item id, not a SE Ranking site id.
                        if len(site_id) >= 10:
                            tool_results.append({
                                "type": "tool_result",
                                "tool_use_id": tool_id,
                                "content": json.dumps({"error": f"Error: Site ID '{site_id}' looks like a Monday.com Item ID, not a SE Ranking Site ID. Use the site_id from 'loaded_seranking_campaigns'."}),
                                "is_error": True
                            })
                            continue

                        ser_headers = {"Authorization": f"Token {SERANKING_TOKEN}", "Content-Type": "application/json"}
                        try:
                            bl_res = requests.get(f'https://api4.seranking.com/backlinks/{site_id}', headers=ser_headers, timeout=25)
                            links = bl_res.json() if bl_res.status_code == 200 else []
                            if not isinstance(links, list):
                                links = []

                            def _host(u):
                                try:
                                    return (u or "").split("//")[-1].split("/")[0].lower().lstrip("www.")
                                except Exception:
                                    return ""
                            def _truthy(v):
                                return str(v).lower() in ("1", "true", "yes")

                            ref_domains = set()
                            dofollow = nofollow = 0
                            for b in links:
                                if not isinstance(b, dict):
                                    continue
                                ref_domains.add(_host(b.get("url_from") or b.get("source_url") or b.get("from")))
                                # SE Ranking exposes nofollow as a flag; absence implies dofollow.
                                if _truthy(b.get("nofollow")):
                                    nofollow += 1
                                else:
                                    dofollow += 1
                            ref_domains.discard("")

                            sample = []
                            for b in links[:limit]:
                                if not isinstance(b, dict):
                                    continue
                                sample.append({
                                    "from": b.get("url_from") or b.get("source_url") or b.get("from"),
                                    "to": b.get("url_to") or b.get("target_url") or b.get("to"),
                                    "anchor": b.get("anchor"),
                                    "nofollow": _truthy(b.get("nofollow")),
                                    "first_seen": b.get("first_seen") or b.get("date_added"),
                                    "last_visited": b.get("last_visited") or b.get("last_check"),
                                })

                            result_data = {
                                "site_id": site_id,
                                "source": "seranking_backlink_monitoring",
                                "summary": {
                                    "total_backlinks": len(links),
                                    "referring_domains": len(ref_domains),
                                    "dofollow": dofollow,
                                    "nofollow": nofollow,
                                },
                                "sample_backlinks": sample,
                            }
                            if len(links) == 0:
                                result_data["note"] = ("This SE Ranking campaign has no backlinks in its Backlink Monitoring list "
                                                       "(the feature may not be configured for this project). For live backlink data, "
                                                       "use dataforseo_backlinks_summary or get_ahrefs_report with the campaign's domain.")

                            tool_results.append({
                                "type": "tool_result",
                                "tool_use_id": tool_id,
                                "content": json.dumps(result_data)
                            })
                            tool_call_log.append(f"Fetched SE Ranking backlinks for Site {site_id} ({len(links)} links)")
                        except Exception as e:
                            tool_results.append({
                                "type": "tool_result",
                                "tool_use_id": tool_id,
                                "content": json.dumps({"error": str(e)}),
                                "is_error": True
                            })

                    elif tool_name == "get_dataforseo_keyword_suggestions":
                        seeds = tool_input.get("keywords", [])
                        loc = tool_input.get("location_name", "Singapore")
                        lang = tool_input.get("language_name", "English")
                        
                        df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                        payload = [{
                            "keywords": seeds,
                            "location_name": loc,
                            "language_name": lang,
                            "sort_by": "relevance"
                        }]
                        
                        try:
                            res = requests.post("https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live", 
                                              headers=df_headers, json=payload, timeout=30)
                            tool_results.append({
                                "type":        "tool_result",
                                "tool_use_id": tool_id,
                                "content":     res.text
                            })
                            tool_call_log.append(f"Discovered keywords via DataForSEO for: {', '.join(seeds)}")
                        except Exception as e:
                            tool_results.append({
                                "type":        "tool_result",
                                "tool_use_id": tool_id,
                                "content":     json.dumps({"error": str(e)}),
                                "is_error":    True
                            })

                    elif tool_name == "dataforseo_serp":
                        keyword = tool_input.get("keyword", "")
                        loc = tool_input.get("location_name", "Singapore")
                        lang = tool_input.get("language_name", "English")
                        depth = tool_input.get("depth", 10)
                        df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                        try:
                            res = requests.post(
                                "https://api.dataforseo.com/v3/serp/google/organic/live/regular",
                                headers=df_headers,
                                json=[{"keyword": keyword, "location_name": loc, "language_name": lang, "depth": depth, "se_type": "regular"}],
                                timeout=30
                            )
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": res.text})
                            tool_call_log.append(f"Fetched SERP results for: {keyword} ({loc})")
                        except Exception as e:
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"error": str(e)}), "is_error": True})

                    elif tool_name == "dataforseo_search_volume":
                        keywords = tool_input.get("keywords", [])
                        loc = tool_input.get("location_name", "Singapore")
                        lang = tool_input.get("language_name", "English")
                        df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                        try:
                            res = requests.post(
                                "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live",
                                headers=df_headers,
                                json=[{"keywords": keywords, "location_name": loc, "language_name": lang}],
                                timeout=30
                            )
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": res.text})
                            tool_call_log.append(f"Got search volume for {len(keywords)} keywords ({loc})")
                        except Exception as e:
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"error": str(e)}), "is_error": True})

                    elif tool_name == "dataforseo_backlinks_summary":
                        target = tool_input.get("target", "")
                        include_subdomains = tool_input.get("include_subdomains", True)
                        df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                        try:
                            res = requests.post(
                                "https://api.dataforseo.com/v3/backlinks/summary/live",
                                headers=df_headers,
                                json=[{"target": target, "include_subdomains": include_subdomains}],
                                timeout=30
                            )
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": res.text})
                            tool_call_log.append(f"Fetched backlinks summary for: {target}")
                        except Exception as e:
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"error": str(e)}), "is_error": True})

                    elif tool_name == "dataforseo_domain_rank_overview":
                        target = tool_input.get("target", "")
                        loc = tool_input.get("location_name", "Singapore")
                        lang = tool_input.get("language_name", "English")
                        df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                        try:
                            res = requests.post(
                                "https://api.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live",
                                headers=df_headers,
                                json=[{"target": target, "location_name": loc, "language_name": lang}],
                                timeout=30
                            )
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": res.text})
                            tool_call_log.append(f"Fetched domain rank overview for: {target}")
                        except Exception as e:
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"error": str(e)}), "is_error": True})

                    elif tool_name == "dataforseo_ranked_keywords":
                        target = tool_input.get("target", "")
                        loc = tool_input.get("location_name", "Singapore")
                        lang = tool_input.get("language_name", "English")
                        limit = tool_input.get("limit", 100)
                        filters = tool_input.get("filters")
                        df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                        payload_item = {"target": target, "location_name": loc, "language_name": lang, "limit": limit}
                        if filters:
                            payload_item["filters"] = filters
                        try:
                            res = requests.post(
                                "https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live",
                                headers=df_headers,
                                json=[payload_item],
                                timeout=30
                            )
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": res.text})
                            tool_call_log.append(f"Fetched ranked keywords for: {target} ({loc})")
                        except Exception as e:
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"error": str(e)}), "is_error": True})

                    elif tool_name == "save_memory_note":
                        text = tool_input.get("text", "")
                        tag = tool_input.get("tag", "General")
                        print(f"[TOOLS] Saving Memory Note: [{tag}] {text}")
                        # We use a special prefix in the log to signal the frontend
                        tool_call_log.append(f"MEM_SAVE: {json.dumps({'tag': tag, 'text': text})}")
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     "Success: Note saved to persistent memory modal."
                        })

                    elif tool_name == "get_tiktok_ads_report":
                        tiktok_token = body.get('tiktok_access_token')
                        advertiser_id = tool_input.get("advertiser_id")
                        print(f"[TOOLS] Fetching TikTok Ads Report for {advertiser_id}")
                        result_data = run_tiktok_report(
                            tiktok_token,
                            advertiser_id,
                            tool_input.get("start_date"),
                            tool_input.get("end_date"),
                            tool_input.get("dimensions"),
                            tool_input.get("metrics"),
                            tool_input.get("data_level", "AUCTION_ADVERTISER")
                        )
                        result_str = json.dumps(result_data)
                        if len(result_str) > 40000:
                            result_str = result_str[:40000] + "\n... [result truncated, narrow the date range or metrics]"
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                        tool_call_log.append(f"Fetched TikTok Ads report for advertiser {advertiser_id}")

                    elif tool_name == "get_meta_ads_report":
                        meta_token = body.get('meta_access_token')
                        ad_account_id = tool_input.get("ad_account_id")
                        print(f"[TOOLS] Fetching Meta Ads Report for {ad_account_id}")
                        result_data = run_meta_ads_report(
                            meta_token,
                            ad_account_id,
                            tool_input.get("start_date"),
                            tool_input.get("end_date"),
                            tool_input.get("level", "account"),
                            tool_input.get("time_increment"),
                            tool_input.get("fields"),
                            tool_input.get("name_contains")
                        )
                        result_str = json.dumps(result_data)
                        if len(result_str) > 40000:
                            result_str = result_str[:40000] + "\n... [result truncated, narrow the date range or fields]"
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                        tool_call_log.append(f"Fetched Meta Ads report for account {ad_account_id}")

                    elif tool_name == "get_linkedin_ads_report":
                        linkedin_token = body.get('linkedin_access_token')
                        account_id = tool_input.get("account_id")
                        print(f"[TOOLS] Fetching LinkedIn Ads Report for {account_id}")
                        result_data = run_linkedin_ads_report(
                            linkedin_token,
                            account_id,
                            tool_input.get("start_date"),
                            tool_input.get("end_date"),
                            tool_input.get("pivot", "ACCOUNT"),
                            tool_input.get("granularity", "ALL"),
                            tool_input.get("fields")
                        )
                        result_str = json.dumps(result_data)
                        if len(result_str) > 40000:
                            result_str = result_str[:40000] + "\n... [result truncated, narrow the date range or fields]"
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                        tool_call_log.append(f"Fetched LinkedIn Ads report for account {account_id}")

                    elif tool_name == "get_ahrefs_report":
                        domain = ahrefs_bare_domain(tool_input.get("domain", ""))
                        action = tool_input.get("action", "overview")
                        print(f"[TOOLS] Fetching Ahrefs {action} for {domain}")
                        ahrefs_key = AHREFS_API_KEY
                        if not ahrefs_key:
                            result_data = {"error": "AHREFS_API_KEY is not configured on the server"}
                        elif not domain:
                            result_data = {"error": "No valid domain supplied. Pass a bare domain like 'example.com'."}
                        else:
                            ahrefs_headers = {
                                "Authorization": f"Bearer {ahrefs_key}",
                                "Accept": "application/json"
                            }
                            # Ahrefs v3 requires a 'date' on the snapshot endpoints; it returns the
                            # latest data on or before this date. Use today (UTC).
                            ahrefs_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                            base = "https://api.ahrefs.com/v3/site-explorer"

                            def _ah_get(path, params):
                                """GET an Ahrefs v3 endpoint; return (ok, json_or_error_dict)."""
                                try:
                                    r = requests.get(f"{base}/{path}", headers=ahrefs_headers,
                                                     params=params, timeout=30)
                                    if r.status_code == 200:
                                        return True, r.json()
                                    # 404 "Not found" => domain not in Ahrefs index (or no data).
                                    if r.status_code == 404:
                                        return False, {
                                            "not_in_ahrefs": True,
                                            "message": (f"'{domain}' was not found in the Ahrefs index "
                                                        f"(it may be too new or too small to be crawled). "
                                                        f"Try get_dataforseo_* tools for this domain instead."),
                                        }
                                    return False, {"error": f"Ahrefs HTTP {r.status_code}: {r.text[:300]}"}
                                except Exception as ah_e:
                                    return False, {"error": str(ah_e)}

                            try:
                                if action == "overview":
                                    # No single 'overview' endpoint exists in v3 — compose one from
                                    # domain-rating + metrics + backlinks-stats.
                                    ok_dr, dr = _ah_get("domain-rating",
                                                        {"target": domain, "date": ahrefs_date})
                                    if not ok_dr and dr.get("not_in_ahrefs"):
                                        result_data = dr
                                    else:
                                        ok_m, met = _ah_get("metrics",
                                                            {"target": domain, "mode": "domain", "date": ahrefs_date})
                                        ok_b, bls = _ah_get("backlinks-stats",
                                                            {"target": domain, "mode": "domain", "date": ahrefs_date})
                                        result_data = {
                                            "domain": domain,
                                            "domain_rating": (dr.get("domain_rating") if ok_dr else dr),
                                            "metrics": (met.get("metrics") if ok_m else met),
                                            "backlinks_stats": (bls.get("metrics") if ok_b else bls),
                                        }
                                elif action == "keywords":
                                    ok, data = _ah_get("organic-keywords", {
                                        "target": domain, "mode": "domain", "date": ahrefs_date,
                                        "select": "keyword,best_position,volume,sum_traffic,keyword_difficulty",
                                        "order_by": "volume:desc", "limit": 50,
                                    })
                                    result_data = data
                                elif action == "backlinks":
                                    ok, data = _ah_get("all-backlinks", {
                                        "target": domain, "mode": "domain",
                                        "select": "url_from,url_to,domain_rating_source,anchor,first_seen",
                                        "order_by": "domain_rating_source:desc", "limit": 50,
                                    })
                                    result_data = data
                                elif action == "competitors":
                                    ok, data = _ah_get("organic-competitors", {
                                        "target": domain, "mode": "domain", "date": ahrefs_date,
                                        "select": "competitor_domain,domain_rating,keywords_common,keywords_competitor,traffic",
                                        "order_by": "keywords_common:desc", "limit": 20,
                                    })
                                    result_data = data
                                else:
                                    result_data = {"error": f"Unknown action: {action}"}
                            except Exception as ah_e:
                                result_data = {"error": str(ah_e)}
                        result_str = json.dumps(result_data)
                        if len(result_str) > 40000:
                            result_str = result_str[:40000] + "\n... [result truncated]"
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                        tool_call_log.append(f"Fetched Ahrefs {action} for {domain}")

                    elif tool_name == "get_moz_da":
                        target = (tool_input.get("target") or tool_input.get("domain") or "").strip()
                        print(f"[TOOLS] Fetching Moz DA/PA for {target}")
                        try:
                            r_moz = requests.post(
                                MOZ_API_URL,
                                headers={"Accept": "application/json", "Content-Type": "application/json"},
                                json={"domain": target},
                                timeout=30
                            )
                            if r_moz.status_code == 200:
                                moz = r_moz.json()
                                result_data = {
                                    "target": target,
                                    "domain_authority": moz.get("domain_authority"),
                                    "page_authority": moz.get("page_authority"),
                                    "spam_score": moz.get("spam_score"),
                                    "linking_root_domains": moz.get("root_domains_to_root_domain"),
                                    "source": "Moz"
                                }
                            else:
                                result_data = {"error": f"Moz API HTTP {r_moz.status_code}: {r_moz.text[:300]}"}
                        except Exception as moz_e:
                            result_data = {"error": str(moz_e)}
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     json.dumps(result_data)
                        })
                        tool_call_log.append(f"Fetched Moz DA/PA for {target}")

                    elif tool_name == "search_knowledge_base":
                        kb_query = tool_input.get("query", "")
                        kb_top_k = tool_input.get("top_k", 4)
                        print(f"[TOOLS] KB search: {kb_query}")
                        result_data = search_knowledge_base_db(kb_query, kb_top_k, body)
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     json.dumps(result_data)
                        })
                        tool_call_log.append(f"Searched knowledge base for: {kb_query}")

                    elif tool_name == "check_calendar_availability":
                        # Calendar free/busy rides on the Workspace token (calendar.readonly scope).
                        cal_token = (body.get('google_tokens', {}).get('calendar')
                                     or body.get('google_tokens', {}).get('workspace')
                                     or body.get('google_access_token'))
                        cal_emails = tool_input.get("emails") or []
                        cal_start = tool_input.get("start_time")
                        cal_end = tool_input.get("end_time")
                        cal_tz = tool_input.get("timezone", "Asia/Singapore")
                        print(f"[TOOLS] Calendar schedule for {cal_emails}")
                        result_data = get_calendar_schedule(cal_token, cal_emails, cal_start, cal_end, cal_tz)
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     json.dumps(result_data)
                        })
                        _who = ", ".join(cal_emails) if isinstance(cal_emails, list) else str(cal_emails)
                        tool_call_log.append(f"Checked calendar availability for {_who}")

                    elif tool_name == "analyze_image":
                        # DeepSeek vision bridge: run Claude's vision on a stored image.
                        img_id    = tool_input.get("image_id", "")
                        question  = tool_input.get("question", "Describe this image in detail.")
                        print(f"[VISION] analyze_image id={img_id} q={question[:80]!r}")
                        img_doc = _load_chat_image(img_id)
                        if not img_doc or not img_doc.get("b64"):
                            vision_text = ("That image is no longer available (it may have expired or was from a "
                                           "previous session). Ask the user to re-upload it so I can take a look.")
                        else:
                            vision_text = _claude_vision(img_doc["b64"], img_doc.get("media_type"), question)
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     json.dumps({"image_id": img_id, "analysis": vision_text}),
                        })
                        tool_call_log.append(f"Analyzed image with Claude: {question[:80]}")

                    elif tool_name == "workduo_list_projects":
                        search = tool_input.get("search", "")
                        print(f"[TOOLS] Listing WorkDuo projects (search={search!r})")
                        result_data = _workduo_list_projects_compact(search)
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     json.dumps(result_data),
                        })
                        tool_call_log.append(f"Listed WorkDuo projects ({result_data.get('count', 0)})")

                    elif tool_name == "get_workduo_report":
                        entity_id  = tool_input.get("entity_id", "")
                        project_id = tool_input.get("project_id", "")
                        start_date = tool_input.get("start_date", "")
                        end_date   = tool_input.get("end_date", "")
                        print(f"[TOOLS] WorkDuo report entity={entity_id} {start_date}..{end_date}")
                        result_data = _workduo_get_report(entity_id, project_id, start_date, end_date)
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     json.dumps(result_data),
                        })
                        tool_call_log.append(f"Pulled WorkDuo AI-visibility report for {entity_id}")

                    else:
                        # Unknown tool (usually a hallucinated name, e.g.
                        # "workduo_list_projects"). Return the list of REAL tool
                        # names so Claude can re-issue the call against a valid
                        # one instead of repeating the bad name or giving up.
                        valid_names = [t.get("name") for t in tools if t.get("name")]
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     json.dumps({
                                "error": f"Unknown tool: {tool_name}",
                                "valid_tools": valid_names,
                                "hint": ("That tool does not exist. Choose the closest tool from "
                                         "valid_tools and call it instead — do not invent tool names."),
                            }),
                            "is_error":    True
                        })

                # ── Central safety cap ────────────────────────────────────
                # Every tool result is capped here so a single large payload
                # (e.g. full GSC/GA4/SE Ranking coverage) can't blow the next
                # round's request past the 200k-token context ceiling. Only
                # monday_graphql truncated itself before; this covers ALL tools.
                TOOL_RESULT_CHAR_LIMIT = 40000   # ~10k tokens per result
                for _tr in tool_results:
                    _c = _tr.get("content")
                    if isinstance(_c, str) and len(_c) > TOOL_RESULT_CHAR_LIMIT:
                        print(f"[TOOLS] Capping {block.get('name','result')} result ({len(_c)} chars)")
                        _tr["content"] = _c[:TOOL_RESULT_CHAR_LIMIT] + "\n... [result truncated to fit token budget — narrow the date range, fields, or row count]"

                # Report any failed tool calls to Google Chat (covers ALL tools;
                # the model often recovers so these never reach the frontend).
                try:
                    _report_tool_failures(content_blocks, tool_results, messages, body)
                except Exception as _tre:
                    print(f"[tool-report] skipped: {_tre}")

                messages.append({"role": "user", "content": tool_results})
                continue   # next round

            # ── Unexpected stop reason ────────────────────────────────────
            print(f"[TOOLS] Unexpected stop_reason: {stop_reason}")
            # Try to extract any text Claude produced anyway
            fallback_text = "\n\n".join(
                block.get("text", "") for block in content_blocks
                if block.get("type") == "text"
            ).strip()
            _log_usage(round_num)
            _clear_progress()
            return {
                "statusCode": 200,
                "body": json.dumps({
                    "reply": fallback_text or f"Stopped unexpectedly ({stop_reason}).",
                    "tool_calls_summary": "\n".join(t for t in tool_call_log if not t.startswith("MEM_SAVE:")) or None,
                    "tool_calls": [t for t in tool_events if t.get("name") != "save_memory_note"]
                })
            }

        # Exceeded MAX_TOOL_ROUNDS — return whatever Claude last said
        fallback = "\n\n".join(
            b.get("text", "") for b in content_blocks if b.get("type") == "text"
        ).strip()
        _log_usage(round_num)
        _clear_progress()
        return {
            "statusCode": 200,
            "body": json.dumps({
                "reply": fallback or "I reached the maximum number of data lookups. Please refine your question.",
                "tool_calls_summary": "\n".join(t for t in tool_call_log if not t.startswith("MEM_SAVE:")) or None,
                "tool_calls": [t for t in tool_events if t.get("name") != "save_memory_note"],
                # Ran out of tool rounds with work still pending — let the client auto-continue
                # in a fresh invocation (separate bot message) instead of dead-ending here.
                "incomplete": True
            })
        }

    except requests.exceptions.Timeout:
        _clear_progress()
        return {"statusCode": 504, "body": json.dumps({"error": "Request timed out during agentic loop"})}
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[TOOLS] Exception: {e}\n{tb}")
        _clear_progress()
        return {"statusCode": 500, "body": json.dumps({"error": str(e), "traceback": tb})}
# ───────────────────────────────────────────────────────────────────────────

# ── Prompt-building helpers (server-side prompts) ────────────────────────────

def _call_claude_simple(system_text, user_text, model=None, max_tokens=4096, provider='deepseek'):
    """Call DeepSeek (default) or Anthropic with a single user turn; return a Lambda result dict."""
    provider = (provider or 'deepseek').lower()

    if provider == 'deepseek':
        deepseek_key = os.environ.get('DEEPSEEK_API_KEY')
        if not deepseek_key:
            return {'statusCode': 500, 'body': json.dumps({'error': 'DEEPSEEK_API_KEY not configured'})}
        try:
            r = requests.post(
                'https://api.deepseek.com/chat/completions',
                headers={
                    'Authorization': f'Bearer {deepseek_key}',
                    'content-type':  'application/json',
                },
                json={
                    'model':      model or 'deepseek-chat',
                    'max_tokens': max_tokens,
                    'messages':   [
                        {'role': 'system', 'content': system_text},
                        {'role': 'user',   'content': user_text},
                    ],
                },
                timeout=60,
            )
            if r.status_code != 200:
                return {'statusCode': r.status_code,
                        'body': json.dumps({'error': f'DeepSeek API error {r.status_code}',
                                            'detail': r.text[:500]})}
            choice = (r.json().get('choices') or [{}])[0]
            text = choice.get('message', {}).get('content', '')
            return {'statusCode': 200, 'body': json.dumps({'result': text, 'reply': text})}
        except requests.exceptions.Timeout:
            return {'statusCode': 504, 'body': json.dumps({'error': 'DeepSeek API request timed out'})}
        except Exception as e:
            return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}

    anthropic_key = os.environ.get('ANTHROPIC_API_KEY')
    if not anthropic_key:
        return {'statusCode': 500, 'body': json.dumps({'error': 'ANTHROPIC_API_KEY not configured'})}
    try:
        r = requests.post(
            'https://api.anthropic.com/v1/messages',
            headers={
                'x-api-key':          anthropic_key,
                'anthropic-version':  '2023-06-01',
                'content-type':       'application/json',
            },
            json={
                'model':      model or 'claude-haiku-4-5',
                'max_tokens': max_tokens,
                'system':     system_text,
                'messages':   [{'role': 'user', 'content': user_text}]
            },
            timeout=60,
        )
        if r.status_code != 200:
            return {'statusCode': r.status_code,
                    'body': json.dumps({'error': f'Anthropic API error {r.status_code}',
                                        'detail': r.text[:500]})}
        text = r.json().get('content', [{}])[0].get('text', '')
        return {'statusCode': 200, 'body': json.dumps({'result': text, 'reply': text})}
    except requests.exceptions.Timeout:
        return {'statusCode': 504, 'body': json.dumps({'error': 'Anthropic API request timed out'})}
    except Exception as e:
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}


WORKDUO_API_BASE = "https://api.workduo.ai"

def _workduo_auth():
    pk = os.environ.get('WORKDUO_PUBLIC_KEY', '')
    sk = os.environ.get('WORKDUO_SECRET_KEY', '')
    return "Basic " + base64.b64encode(f"{pk}:{sk}".encode()).decode()


def _get_workduo_projects():
    auth = _workduo_auth()
    all_projects = []
    page = 1
    while True:
        r = requests.get(
            f"{WORKDUO_API_BASE}/core/v1/projects",
            params={"page": page, "pageSize": 100},
            headers={"Authorization": auth},
            timeout=20
        )
        if r.status_code != 200:
            return {"statusCode": r.status_code, "body": json.dumps({"error": r.text[:500]})}
        data = r.json()
        batch = data.get("data", [])
        all_projects.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return {"statusCode": 200, "body": json.dumps({"projects": all_projects})}


def _workduo_default_dates():
    """(start, end) for the trailing 30 days as 'YYYY-MM-DD'."""
    end = datetime.now(timezone.utc).date()
    return (end - timedelta(days=30)).isoformat(), end.isoformat()


def _workduo_list_projects_compact(search=""):
    """Compact project list for chatbot tool use: project_id, name, entity_id.
    Returns a plain dict (not a Lambda envelope) suitable as a tool result."""
    res = _get_workduo_projects()
    if res.get("statusCode") != 200:
        try:
            return {"error": json.loads(res.get("body", "{}")).get("error", "WorkDuo error")}
        except Exception:
            return {"error": "Failed to list WorkDuo projects"}
    projects = json.loads(res["body"]).get("projects", [])
    s = (search or "").strip().lower()
    out = []
    for p in projects:
        name = p.get("name", "")
        if s and s not in name.lower():
            continue
        out.append({
            "project_id": p.get("id"),
            "name":       name,
            "entity_id":  (p.get("entity") or {}).get("id", ""),
        })
    return {"count": len(out), "projects": out}


def _workduo_get_report(entity_id, project_id="", start_date="", end_date=""):
    """Fetch WorkDuo AI-visibility metrics for one entity over a date range.
    Returns a plain dict (not a Lambda envelope) suitable as a tool result."""
    if not entity_id:
        return {"error": "entity_id is required — call workduo_list_projects first to find it."}
    if not start_date or not end_date:
        s, e = _workduo_default_dates()
        start_date = start_date or s
        end_date   = end_date or e
    try:
        r = requests.get(
            f"{WORKDUO_API_BASE}/data/v1/metrics/entities/{entity_id}",
            params={"projectId": project_id, "dateRange": "custom",
                    "startDate": start_date, "endDate": end_date},
            headers={"Authorization": _workduo_auth()},
            timeout=20,
        )
        if r.status_code != 200:
            return {"error": f"WorkDuo API {r.status_code}", "detail": r.text[:300]}
        rows = [
            {"date":       row["date"][:10],
             "visibility": row.get("visibility", 0),
             "sov":        row.get("sov", 0),
             "mentions":   row.get("mentions", 0),
             "position":   row.get("position", 0)}
            for row in r.json().get("data", [])
        ]
        return {"entity_id": entity_id, "project_id": project_id,
                "start_date": start_date, "end_date": end_date,
                "row_count": len(rows), "rows": rows}
    except Exception as ex:
        return {"error": str(ex)}


def _geo_fetch_workduo_direct(entities, start_date, end_date):
    auth = _workduo_auth()
    results = []
    for e in entities:
        entity_id  = e.get("entityId", "")
        project_id = e.get("projectId", "")
        name       = e.get("name", "")
        if not entity_id:
            continue
        try:
            r = requests.get(
                f"{WORKDUO_API_BASE}/data/v1/metrics/entities/{entity_id}",
                params={"projectId": project_id, "dateRange": "custom",
                        "startDate": start_date, "endDate": end_date},
                headers={"Authorization": auth},
                timeout=20
            )
            if r.status_code == 200:
                rows = [
                    {"date": row["date"][:10],
                     "visibility": row.get("visibility", 0),
                     "sov":        row.get("sov", 0),
                     "mentions":   row.get("mentions", 0),
                     "position":   row.get("position", 0)}
                    for row in r.json().get("data", [])
                ]
                results.append({"entity_id": entity_id, "name": name, "rows": rows, "note": None})
            else:
                results.append({"entity_id": entity_id, "name": name, "rows": [],
                                 "note": f"API {r.status_code}"})
        except Exception as ex:
            results.append({"entity_id": entity_id, "name": name, "rows": [], "note": str(ex)})
    return {"statusCode": 200, "body": json.dumps({"reply": json.dumps(results)})}


def _build_geo_fetch_body(entities, start_date, end_date,
                          is_comparison=False, cmp_from=None, cmp_to=None):
    """Construct the claude_chat_with_tools body for a WorkDuo GEO visibility fetch."""
    entity_list = [
        f"- {e.get('name')} (entity_id: {e.get('entityId')}, project_id: {e.get('projectId')})"
        for e in entities if e.get('entityId')
    ]
    if is_comparison:
        system_text = (
            f'You are fetching HISTORICAL comparison data from WorkDuo. '
            f'For each entity, call get_visibility with metric="all", '
            f'start_date="{cmp_from}", end_date="{cmp_to}". '
            f'This is a prior-period request — the dates MUST be {cmp_from} to {cmp_to}. '
            'Return ONLY a raw JSON array: '
            '[{"entity_id":"...","name":"...","rows":[{"date":"YYYY-MM-DD","visibility":0.0,'
            '"sov":0.0,"mentions":0,"position":0.0}],"note":null}]'
        )
        user_text = (
            f'Fetch prior-period visibility from {cmp_from} to {cmp_to} '
            f'using start_date="{cmp_from}" and end_date="{cmp_to}" in the tool call. '
            'Return ONLY the JSON array:\n' + '\n'.join(entity_list)
        )
    else:
        system_text = (
            f'You are a data fetcher. For each WorkDuo entity call get_visibility with metric="all", '
            f'start_date="{start_date}", end_date="{end_date}". '
            'Return ONLY a raw JSON array — no markdown, no code fences, no explanation:\n'
            '[{"entity_id":"...","name":"...","rows":[{"date":"YYYY-MM-DD","visibility":0.0,'
            '"sov":0.0,"mentions":0,"position":0.0}],"note":null}]\n'
            'If a project has no data set rows to [] and put the note in "note".'
        )
        user_text = (
            f'Fetch WorkDuo visibility from {start_date} to {end_date} (metric="all") for each entity. '
            'Return ONLY the JSON array:\n' + '\n'.join(entity_list)
        )
    return {
        'model':      'claude-haiku-4-5',
        'max_tokens': 8192,
        'system':     [{'type': 'text', 'text': system_text}],
        'messages':   [{'role': 'user', 'content': [{'type': 'text', 'text': user_text}]}]
    }


def _audit_recommendations(body):
    site_url    = body.get('siteUrl', 'the website')
    issues      = body.get('issues', [])
    total_pages = int(body.get('totalPages', 0) or 0)
    issue_list  = '\n'.join(
        f"- {i.get('label', '')}: {i.get('affected', 0)} of {total_pages} pages affected"
        for i in issues
    )
    system = (
        'You are a senior technical SEO specialist producing an audit that an untrained '
        'or lightly-trained salesperson can present to a prospect, while also flagging which '
        'items a junior team member can fix versus which must be escalated to a senior specialist.'
    )
    user = (
        f'A site audit of "{site_url}" ({total_pages} pages crawled) found the following issues:\n\n'
        f'{issue_list}\n\n'
        'Generate 5-7 prioritised, actionable recommendations to fix these issues, ordered so the '
        'list reads as a sensible sequence of work (do the highest-impact, foundational items first). '
        'Return ONLY a JSON array with no markdown, where each item has:\n'
        '- priority: "high", "medium", or "low"\n'
        '- category: the single best-fit gap area, one of exactly: '
        '"technical", "content", "authority", "metadata", "ux", "schema", "internal_linking"\n'
        '- title: short title (max 8 words)\n'
        '- issue: one sentence describing the problem\n'
        '- root_cause: one sentence on the likely underlying cause (not just the symptom)\n'
        '- recommendation: 1-2 sentences of specific actionable advice\n'
        '- impact: one sentence on the SEO/UX benefit of fixing this\n'
        '- effort: rough resource estimate, one of "S" (a few hours), "M" (1-2 days), "L" (multi-day / specialist)\n'
        '- handling: "internal" if a CSM or junior can action it, or "escalate" if it needs a senior SEO specialist\n'
        '- handling_reason: short reason for the handling choice (max 14 words)\n'
        '- talking_point: one plain-English sentence a salesperson can say to the client about this (no jargon)\n\n'
        'Across the set, make sure metadata, internal linking and authority/backlink gaps are surfaced '
        'as their own items whenever the issues imply them — do not fold everything into "technical". '
        'JSON array only, no other text.'
    )
    return _call_claude_simple(system, user, max_tokens=3500, provider=body.get('provider'))


def _competitor_insights(body):
    target_domain = body.get('targetDomain', '')
    location      = body.get('location', '')
    summary       = body.get('summary', '')
    keywords      = body.get('keywords', '')
    domain_part   = f' for target domain "{target_domain}"' if target_domain else ''
    loc_part      = f' in {location}'                        if location      else ''
    system = 'You are a senior SEO strategist providing strategic competitive analysis insights.'
    user = (
        f'A competitor analysis was run{domain_part}{loc_part}.\n\n'
        f'Competitors found and their keyword rankings:\n{summary}\n\n'
        f'Keywords analysed: {keywords or "see above"}\n\n'
        'Generate 5-7 strategic insights and recommendations. '
        'Return ONLY a JSON array where each item has:\n'
        '- type: "insight" or "recommendation"\n'
        '- title: short title (max 8 words)\n'
        '- detail: 2-3 sentences of specific, actionable strategic advice\n'
        '- priority: "high", "medium", or "low" (recommendations only — set "—" for insights)\n'
        '- icon: one of "crosshairs", "chess", "chart-line", "lightbulb", "exclamation-triangle", "trophy", "key"\n\n'
        'JSON array only, no other text.'
    )
    return _call_claude_simple(system, user, max_tokens=2800, provider=body.get('provider'))


def _strategy_auto_populate(body):
    text   = (body.get('text') or '')[:100000]
    system = 'You are an expert SEO strategist extracting structured business context from raw text.'
    user   = (
        'Analyze the following text and extract key business signals for an SEO strategy.\n'
        'Return ONLY a valid JSON object with the following fields:\n'
        '- client_profile: A concise description of the business.\n'
        '- objectives: An array of objectives from these exact options: '
        '["lead_generation", "brand_authority", "local_visibility", "ecommerce_revenue", '
        '"service_enquiries", "niche_dominance"]. Pick at most 3.\n'
        '- target_audience: Brief description of the target customer.\n'
        '- market_context: Key competitors or market landscape info.\n'
        '- seed_keywords: 3-5 primary keywords found in the text.\n\n'
        f'TEXT:\n{text}'
    )
    return _call_claude_simple(system, user, max_tokens=2000, provider=body.get('provider'))


def _strategy_generate(body):
    inputs        = body.get('inputs', {})
    discovery     = body.get('discoveryData', [])
    objectives_str = ', '.join(inputs.get('objectives', [])) or 'General Growth'
    system = 'You are the Digimetrics Strategy Engine, a senior SEO strategist.'
    user = (
        'Analyse the client context below and devise 3 to 5 distinct keyword-led SEO strategies '
        'that are genuinely tailored to this specific business, market, and set of objectives. '
        'Do NOT use generic template strategy names — invent strategy angles that make sense for this client.\n\n'
        f'CLIENT PROFILE: {inputs.get("clientProfile", "")}\n'
        f'BUSINESS OBJECTIVES: {objectives_str}\n'
        f'TARGET AUDIENCE: {inputs.get("targetAudience", "General")}\n'
        f'MARKET CONTEXT: {inputs.get("marketContext", "Standard Industry")}\n'
        f'KEYWORD INFLUENCERS (constraints, preferences, brand rules, terms to include/avoid): '
        f'{inputs.get("keywordInfluencers", "None specified")}\n'
        f'SEMANTIC DATA SIGNALS: {json.dumps(discovery[:10])}\n\n'
        'TASK: Based on the above context, determine how many strategies (3-5) are warranted and '
        'what angles are most valuable for this client. Each strategy should target a meaningfully '
        'different audience segment, intent type, or growth lever — avoid overlap. '
        'Name each strategy to reflect the specific opportunity, not a generic category.\n\n'
        'OUTPUT FORMAT (MANDATORY JSON):\n'
        'Return ONLY a JSON object with a "strategies" array. Each strategy MUST have:\n'
        '- "name": Descriptive, client-specific strategy name '
        '(e.g. "Relocation-Season Demand Capture" not "Long-Tail")\n'
        '- "focus": 1-sentence strategic core specific to this client\n'
        '- "target_keywords": Array of 10-15 primary keyword themes relevant to this strategy\n'
        '- "content_approach": Brief content strategy tailored to this angle\n'
        '- "expected_impact": "High", "Medium", or "Very High"\n'
        '- "time_to_rank": Est. months (number)\n'
        '- "recommended": boolean (true for exactly one)\n'
        '- "keyword_data": { "primary_theme": "Core theme", "semantic_clusters": '
        '[ { "topic": "Topic 1", "keywords": ["kw1","kw2","kw3","kw4","kw5"], "intent": "Informational" } ], '
        '"longtail_opportunities": "2-3 sentences explaining the long-tail opportunity" }\n\n'
        'Return compact valid JSON only. No prose.'
    )
    return _call_claude_simple(system, user, max_tokens=4000, provider=body.get('provider'))


def _strategy_recommendations(body):
    strategy  = body.get('strategy', {})
    audit_ctx = body.get('auditContext', {})
    has_audit = bool(audit_ctx)
    audit_block = (
        f'\nAUDIT DATA (real metrics from the client\'s website):\n{json.dumps(audit_ctx)}\n'
        if has_audit else ''
    )
    kw_list = ', '.join((strategy.get('target_keywords') or [])[:8])
    system  = 'You are a senior SEO strategist reviewing a client website.'
    user    = (
        'Based on the chosen SEO strategy and audit data below, generate a detailed action plan.\n\n'
        'CHOSEN STRATEGY:\n'
        f'- Name: {strategy.get("name", "")}\n'
        f'- Focus: {strategy.get("focus", "")}\n'
        f'- Content Approach: {strategy.get("content_approach", "")}\n'
        f'- Primary Keywords: {kw_list}\n'
        f'{audit_block}'
        'OUTPUT (MANDATORY JSON):\n'
        'Return ONLY a JSON object with exactly two keys:\n\n'
        '1. "strengths": array of 4-8 items representing what the site is already doing well. Each item:\n'
        '   { "title": "Short win title", "detail": "1-sentence explanation", '
        '"category": "Content|Technical SEO|Performance|Domain & Trust" }\n'
        f'   {"Base these on PASSING checks and good scores in the audit data." if has_audit else "Generate plausible general strengths."}\n\n'
        '2. "recommendations": array of 5-8 prioritized actions. Each item:\n'
        '   { "task": "Action title", "description": "Specific actionable step", '
        '"priority": "High|Medium|Low", "effort": "Quick|Medium|Strategic", '
        '"impact": "High|Medium|Low", "rationale": "Why this matters for the strategy", '
        '"category": "Content|Technical SEO|Performance|Domain & Trust" }\n'
        f'   {"Base Technical SEO, Performance, and Domain & Trust items on FAILING or WARN checks in the audit. Do NOT flag items that are already passing." if has_audit else "Include at least 1 item per category."}\n\n'
        'Compact valid JSON only. No prose.'
    )
    return _call_claude_simple(system, user, max_tokens=3500, provider=body.get('provider'))


# ── Claude Haiku chat handler (simple, no tools) ────────────────────────────
def claude_chat(body):
    """
    Proxy a chat request to Anthropic's Messages API.

    Expected body fields:
      model      - e.g. "claude-haiku-4-5"  (optional, defaults to env CLAUDE_MODEL)
      system     - system prompt string
      messages   - list of {role, content} dicts
      max_tokens - int (optional, defaults to 4096)
    """
    anthropic_key = os.environ.get('ANTHROPIC_API_KEY')
    if not anthropic_key:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": "ANTHROPIC_API_KEY environment variable not configured"})
        }

    model      = body.get('model') or os.environ.get('CLAUDE_MODEL', 'claude-3-5-sonnet-20241022')
    system     = body.get('system', '')
    messages   = body.get('messages', [])
    max_tokens = int(body.get('max_tokens', 4096))

    if not messages:
        return {"statusCode": 400, "body": json.dumps({"error": "No messages provided"})}

    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages
    }
    if system:
        payload["system"] = system

    print(f"[CLAUDE] model={model} messages={len(messages)} max_tokens={max_tokens}")

    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": anthropic_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        if r.status_code != 200:
            err_body = r.text[:1000]
            print(f"[CHAT] Anthropic error {r.status_code}: {err_body}")
            return {"statusCode": r.status_code, "body": json.dumps({"error": f"Anthropic API error {r.status_code}", "detail": err_body})}
        return {"statusCode": r.status_code, "body": r.text}
    except requests.exceptions.Timeout:
        return {"statusCode": 504, "body": json.dumps({"error": "Anthropic API request timed out"})}
    except Exception as e:
        print(f"[CLAUDE] Exception: {str(e)}")
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
# ───────────────────────────────────────────────────────────────────────────

# ── SEO Team Performance Dashboard: server-side snapshot (for the daily cron) ──
# Mirrors computeSeoKpiModel() in index.html. Keep the two in sync — the frontend
# is the source of truth for the live view; this exists so the EventBridge cron
# can persist a daily snapshot even when nobody has the cockpit open.
SEO_KPI_BOARD_ID = '2845615047'
SEO_KPI_ACTIVE_STATUSES = ['lived (pm)', 'renewed no pause', 'guarantee (seo)', 'renewed (new timeline)']

def _seo_kpi_num(v):
    try:
        return float(str(v if v is not None else '').replace(',', ''))
    except (TypeError, ValueError):
        return 0.0

def _seo_kpi_compute(items):
    today = datetime.utcnow()
    rows = []
    for item in items or []:
        cv = {c.get('id'): c for c in (item.get('column_values') or [])}
        def txt(cid):
            return ((cv.get(cid, {}) or {}).get('text') or '').strip()
        pt_tokens = [t for t in re.split(r'[\s,]+', txt('tags').lower()) if t]
        if 'seo' not in pt_tokens:
            continue
        name = item.get('name') or ''
        seo_status_l = txt('color1').lower()
        camp_type_l = txt('status').lower()
        contracted = _seo_kpi_num(txt('numbers8'))
        f9 = ((cv.get('formula9', {}) or {}).get('display_value') or (cv.get('formula9', {}) or {}).get('text') or '').strip()
        low = f9.lower()
        if 'kpi hit' in low or f9.startswith('✅'):
            kpi = 'HIT'
        elif 'not hit' in low or f9.startswith('❌'):
            kpi = 'NOT HIT'
        elif f9 and ('excluded' in low or 'input kpi' in low):
            kpi = 'NA'
        else:
            is_cluster = 'cluster' in camp_type_l
            is_special = 'special' in camp_type_l
            is_excluded = 'excluded' in camp_type_l or 'internal kpi' in camp_type_l or camp_type_l in ('na', '')
            if is_excluded:
                kpi = 'NA'
            elif is_special:
                kpi = 'HIT' if _seo_kpi_num(txt('numbers40')) == 999 else 'NOT HIT'
            elif is_cluster:
                k = _seo_kpi_num(txt('numeric_mksrz985'))
                kpi = ('HIT' if _seo_kpi_num(txt('numbers_18')) >= k else 'NOT HIT') if k > 0 else 'NA'
            else:
                k = _seo_kpi_num(txt('numbers3'))
                kpi = ('HIT' if _seo_kpi_num(txt('numbers98')) >= k else 'NOT HIT') if k > 0 else 'NA'
        over2 = False
        parts = txt('timeline5').split(' - ')
        if len(parts) >= 2:
            try:
                s = datetime.strptime(parts[0].strip(), '%Y-%m-%d')
                if today >= s:
                    over2 = (today - s).days >= 61
            except ValueError:
                pass
        is_active = any(st in seo_status_l for st in SEO_KPI_ACTIVE_STATUSES)
        is_psg = bool(re.search(r'\(\s*psg', name, re.I)) or 'psg' in pt_tokens
        rows.append({'over2': over2, 'isActive': is_active, 'isPsg': is_psg,
                     'kpiStatus': kpi, 'contracted': contracted})
    active = [r for r in rows if r['isActive']]
    scores = {
        'totalActive': len(active),
        'over2': sum(1 for r in active if r['over2']),
        'psg': sum(1 for r in active if r['isPsg']),
        'contractedKws': sum(r['contracted'] for r in active),
    }
    def rate(sub):
        h = sum(1 for r in sub if r['kpiStatus'] == 'HIT')
        m = sum(1 for r in sub if r['kpiStatus'] == 'NOT HIT')
        return {'hit': h, 'miss': m, 'total': h + m, 'pct': int(round(h * 100.0 / (h + m))) if (h + m) else None}
    scored = [r for r in active if r['kpiStatus'] in ('HIT', 'NOT HIT')]
    donuts = {'all': rate(scored),
              'regular': rate([r for r in scored if not r['isPsg']]),
              'psg': rate([r for r in scored if r['isPsg']])}
    return scores, donuts

def _seo_kpi_pull_board():
    items = []
    cursor = None
    for _ in range(15):
        cur = ',cursor:"%s"' % cursor if cursor else ''
        q = ('{ boards(ids:[' + SEO_KPI_BOARD_ID + ']){ items_page(limit:200' + cur + '){ cursor items{ id name '
             'column_values(ids:["tags","status","color1","numbers3","numbers98","timeline5","people6",'
             '"dup__of_people","numeric_mksrz985","numbers_18","numbers_1","numbers_19","numbers40","numbers8","total_kws","formula9"])'
             '{ id text ... on FormulaValue { display_value } } } } } }')
        res = run_monday_graphql(q)
        data = res.get('data', res) if isinstance(res, dict) else {}
        boards = (data or {}).get('boards') or []
        page = boards[0].get('items_page') if boards else None
        if not page:
            break
        items.extend(page.get('items') or [])
        cursor = page.get('cursor')
        if not cursor:
            break
    return items

def _seo_kpi_compute_rows(items):
    """Full per-campaign rows for the "Raw Data" tab — mirrors the frontend
    computeSeoKpiModel() field-for-field so a stored daily snapshot renders
    identically to a live pull. Numeric board fields are kept as text so blanks
    stay blank and real zeros stay 0 (matching the source sheet)."""
    today = datetime.utcnow()
    pulled_date = "%d/%d/%d" % (today.month, today.day, today.year)
    rows = []
    for item in items or []:
        cv = {c.get('id'): c for c in (item.get('column_values') or [])}
        def txt(cid, _cv=cv):
            return ((_cv.get(cid, {}) or {}).get('text') or '').strip()
        pt_tokens = [t for t in re.split(r'[\s,]+', txt('tags').lower()) if t]
        if 'seo' not in pt_tokens:
            continue
        name = item.get('name') or ''
        seo_status = txt('color1'); seo_status_l = seo_status.lower()
        camp_type = txt('status'); camp_type_l = camp_type.lower()
        consultant = txt('people6')
        timeline = txt('timeline5')
        contracted = _seo_kpi_num(txt('numbers8'))
        guaranteed = _seo_kpi_num(txt('total_kws'))
        f9 = ((cv.get('formula9', {}) or {}).get('display_value') or (cv.get('formula9', {}) or {}).get('text') or '').strip()
        low = f9.lower()
        if 'kpi hit' in low or f9.startswith('✅'):
            kpi = 'HIT'
        elif 'not hit' in low or f9.startswith('❌'):
            kpi = 'NOT HIT'
        elif f9 and ('excluded' in low or 'input kpi' in low):
            kpi = 'NA'
        else:
            is_cluster = 'cluster' in camp_type_l
            is_special = 'special' in camp_type_l
            is_excluded = 'excluded' in camp_type_l or 'internal kpi' in camp_type_l or camp_type_l in ('na', '')
            if is_excluded:
                kpi = 'NA'
            elif is_special:
                kpi = 'HIT' if _seo_kpi_num(txt('numbers40')) == 999 else 'NOT HIT'
            elif is_cluster:
                k = _seo_kpi_num(txt('numeric_mksrz985'))
                kpi = ('HIT' if _seo_kpi_num(txt('numbers_18')) >= k else 'NOT HIT') if k > 0 else 'NA'
            else:
                k = _seo_kpi_num(txt('numbers3'))
                kpi = ('HIT' if _seo_kpi_num(txt('numbers98')) >= k else 'NOT HIT') if k > 0 else 'NA'
        over2 = False; start_str = ''; end_str = ''
        parts = timeline.split(' - ')
        if len(parts) >= 2:
            try:
                s = datetime.strptime(parts[0].strip(), '%Y-%m-%d')
                datetime.strptime(parts[1].strip(), '%Y-%m-%d')
                start_str = parts[0].strip(); end_str = parts[1].strip()
                if today >= s:
                    over2 = (today - s).days >= 61
            except ValueError:
                pass
        is_active = any(st in seo_status_l for st in SEO_KPI_ACTIVE_STATUSES)
        is_psg = bool(re.search(r'\(\s*psg', name, re.I)) or 'psg' in pt_tokens
        rows.append({
            'id': item.get('id'), 'name': name, 'consultant': consultant,
            'seoStatus': seo_status, 'campType': camp_type, 'timeline': timeline,
            'startStr': start_str, 'endStr': end_str, 'over2': over2,
            'isActive': is_active, 'isPsg': is_psg, 'kpiStatus': kpi,
            'contracted': contracted, 'guaranteed': guaranteed,
            'projectType': txt('tags'), 'asstSeo': txt('dup__of_people'),
            'guaranteedStr': txt('total_kws'), 'kpiKws': txt('numbers3'), 'p1Kws': txt('numbers98'),
            'clusterTotal': txt('numbers_1'), 'clusterKpiPct': txt('numbers_19'),
            'clusterKpi': txt('numeric_mksrz985'), 'clustersHit': txt('numbers_18'),
            'manualCheck': txt('numbers40'), 'contractedStr': txt('numbers8'),
            'pulledDate': pulled_date,
        })
    return rows
# ───────────────────────────────────────────────────────────────────────────

def lambda_handler(event, context):
    # Standard CORS headers
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version",
    }

    # Handle Preflight
    if isinstance(event, dict) and event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers}

    try:
        # Parse body
        if isinstance(event, dict):
            if 'body' in event and isinstance(event['body'], str):
                try:
                    body = json.loads(event['body'])
                except:
                    body = {}
            else:
                body = event
        else:
            try:
                body = json.loads(event)
            except:
                body = {}

        action = body.get('action')
        result = None

        if action == 'report_error':
            result = forward_error_report(body, event)
        elif action == 'openai_proxy':
            result = openai_proxy(body)
        elif action == 'openai_upload':
            result = openai_upload(body)
        elif action == 'download_file':
            result = download_file(body)
        elif action == 'google_token_exchange':
            result = google_token_exchange(body)
        elif action == 'google_refresh_token':
            result = google_refresh_token(body)
        elif action == 'ads_offline_authorize':
            result = ads_offline_authorize(body)
        elif action == 'ads_config_get':
            result = ads_config_get(body)
        elif action == 'ads_config_save':
            result = ads_config_save(body)
        elif action == 'ads_auth_status':
            result = ads_auth_status(body)
        elif action == 'ads_auth_revoke':
            result = ads_auth_revoke(body)
        elif action == 'ads_test_webhook':
            result = ads_test_webhook(body)
        elif action == 'ads_budget_sweep':
            result = ads_budget_sweep(body, event)
        elif action == 'linkedin_get_ad_accounts':
            result = linkedin_get_ad_accounts(body)
        elif action == 'tiktok_auth':
            result = tiktok_auth(body)
        elif action == 'tiktok_get_advertisers':
            result = tiktok_get_advertisers(body)
        elif action == 'get_board_items':
            result = get_board_items(body)
        elif action == 'claude_chat':
            result = claude_chat(body)
        elif action == 'claude_chat_with_tools':
            result = claude_chat_with_tools(body)
        elif action == 'get_chat_progress':
            # Lightweight poll: what is the agentic loop doing right now?
            pid = body.get('progress_id')
            doc = None
            try:
                db = get_db()
                if db is not None and pid:
                    doc = db['chat_progress'].find_one({"_id": pid})
            except Exception as e:
                print(f"[PROGRESS] read failed: {e}")
            doc = doc or {}
            result = {"statusCode": 200, "body": json.dumps({
                "label": doc.get("label"),
                "events": doc.get("events", [])
            })}
        elif action == 'sync_knowledge_base':
            result = sync_knowledge_base(body)
        elif action == 'kb_ensure_index':
            result = kb_ensure_index(body)
        elif action == 'search_knowledge_base':
            result = {"statusCode": 200, "body": json.dumps(
                search_knowledge_base_db(body.get('query', ''), body.get('top_k', 4), body))}
        elif action == 'keyword_discovery':
            # Direct access to DataForSEO for the Strategy Engine
            seeds = body.get('keywords', [])
            if isinstance(seeds, str): seeds = [seeds]
            loc = body.get('location', 'Singapore')
            lang = body.get('language', 'English')
            
            df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
            payload = [{
                "keywords": seeds,
                "location_name": loc,
                "language_name": lang,
                "sort_by": "relevance"
            }]
            
            try:
                res = requests.post("https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live", 
                                  headers=df_headers, json=payload, timeout=30)
                result = {"statusCode": res.status_code, "body": res.text}
            except Exception as e:
                result = {"statusCode": 500, "body": json.dumps({"error": str(e)})}
        elif action == 'fetch_boards':
            db = get_db()
            if db is None: 
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                user_id = body.get('data', {}).get('userId', 'default_workspace')
                user_data = db.boards.find_one({"userId": user_id})
                result = {"statusCode": 200, "body": json.dumps({"boards": user_data.get('boards', []) if user_data else []}, cls=JSONEncoder)}
        elif action == 'save_boards':
            db = get_db()
            if db is None: 
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                data = body.get('data', {})
                user_id = data.get('userId')
                if not user_id: 
                    result = {"statusCode": 400, "body": json.dumps({"error": "Missing userId"})}
                else:
                    update_doc = {
                        "userId": user_id,
                        "boards": data.get('boards', []),
                        "folders": data.get('folders', []),
                        "lastUpdated": datetime.utcnow()
                    }
                    db.boards.update_one({"userId": user_id}, {"$set": update_doc}, upsert=True)
                    result = {"statusCode": 200, "body": json.dumps({"success": True}, cls=JSONEncoder)}
        elif action == 'fetch_teams_config':
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                doc = db.teams_config.find_one({"orgId": "digimetrics"})
                result = {"statusCode": 200, "body": json.dumps({"teams": doc.get('teams', []) if doc else []}, cls=JSONEncoder)}
        elif action == 'save_teams_config':
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                teams = body.get('teams', [])
                db.teams_config.update_one(
                    {"orgId": "digimetrics"},
                    {"$set": {"teams": teams, "lastUpdated": datetime.utcnow()}},
                    upsert=True
                )
                result = {"statusCode": 200, "body": json.dumps({"success": True}, cls=JSONEncoder)}
        elif action == 'save_tool_log':
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                log = body.get('log', {})
                if log:
                    log['orgId'] = 'digimetrics'
                    log['savedAt'] = datetime.utcnow()
                    db.tool_logs.insert_one(log)
                result = {"statusCode": 200, "body": json.dumps({"success": True}, cls=JSONEncoder)}
        elif action == 'fetch_tool_logs':
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                limit = min(int(body.get('limit', 500)), 1000)
                since = body.get('since')   # ts > since  (incremental updates)
                before = body.get('before') # ts < before (backward cursor pagination)
                query = {"orgId": "digimetrics"}
                if since:
                    query["ts"] = {"$gt": since}
                elif before:
                    query["ts"] = {"$lt": before}
                logs = list(db.tool_logs.find(query, {"_id": 0, "savedAt": 0, "orgId": 0}).sort("ts", -1).limit(limit))
                result = {"statusCode": 200, "body": json.dumps({"logs": logs, "has_more": len(logs) == limit}, cls=JSONEncoder)}
        elif action == 'clear_tool_logs':
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                deleted = db.tool_logs.delete_many({"orgId": "digimetrics"})
                result = {"statusCode": 200, "body": json.dumps({"success": True, "deleted": deleted.deleted_count}, cls=JSONEncoder)}
        elif action == 'fetch_usage_stats':
            # Aggregated chatbot token usage for the admin usage dashboard.
            # Cost is computed client-side from an editable price table, so this
            # only returns raw token counts bucketed by model / user / app / day.
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                try:
                    days = int(body.get('days', 30))
                except (TypeError, ValueError):
                    days = 30
                query = {"orgId": "digimetrics"}
                if days > 0:
                    query["ts"] = {"$gte": time.time() - days * 86400}
                cursor = (db.usage_logs
                          .find(query, {"_id": 0, "savedAt": 0, "orgId": 0})
                          .sort("ts", -1)
                          .limit(20000))
                rows = list(cursor)

                def _blank():
                    return {"messages": 0, "input_tokens": 0, "output_tokens": 0,
                            "cache_hit_tokens": 0, "cache_write_tokens": 0}
                totals = _blank()
                by_model, by_user, by_app, by_day, by_tool = {}, {}, {}, {}, {}
                for r in rows:
                    it = int(r.get("input_tokens") or 0)
                    ot = int(r.get("output_tokens") or 0)
                    ch = int(r.get("cache_hit_tokens") or 0)
                    cw = int(r.get("cache_write_tokens") or 0)
                    # Normalise possibly-escaped emails on read so old rows group
                    # under the same clean key as new ones; also fix `recent`.
                    r["email"] = clean_email(r.get("email"))
                    for bucket, key in (
                        (totals,   None),
                        (by_model, r.get("model") or "unknown"),
                        (by_user,  r["email"]),
                        (by_app,   r.get("app_source") or "unknown"),
                        (by_day,   datetime.utcfromtimestamp(r.get("ts") or 0).strftime("%Y-%m-%d")),
                    ):
                        tgt = bucket if key is None else bucket.setdefault(key, _blank())
                        tgt["messages"]           += 1
                        tgt["input_tokens"]       += it
                        tgt["output_tokens"]      += ot
                        tgt["cache_hit_tokens"]   += ch
                        tgt["cache_write_tokens"] += cw

                    # By-tool is one-to-many: a single turn can invoke several
                    # tools, so it counts toward each (token sums may therefore
                    # exceed the totals — the UI notes this). Turns that used no
                    # tool bucket under a plain-chat label. Old rows written before
                    # `tools_used` existed also fall there.
                    tools_used = r.get("tools_used") or ["(plain chat — no tool)"]
                    for tname in tools_used:
                        tgt = by_tool.setdefault(tname, _blank())
                        tgt["messages"]           += 1
                        tgt["input_tokens"]       += it
                        tgt["output_tokens"]      += ot
                        tgt["cache_hit_tokens"]   += ch
                        tgt["cache_write_tokens"] += cw

                result = {"statusCode": 200, "body": json.dumps({
                    "days":      days,
                    "totals":    totals,
                    "by_model":  by_model,
                    "by_user":   by_user,
                    "by_app":    by_app,
                    "by_tool":   by_tool,
                    "by_day":    by_day,
                    "recent":    rows[:60],
                }, cls=JSONEncoder)}
        elif action == 'clear_usage_logs':
            # Admin: purge usage logs. Optional app_source filter lets you drop
            # just one source (e.g. test traffic) instead of the whole org.
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                q = {"orgId": "digimetrics"}
                if body.get('app_source'):
                    q["app_source"] = body.get('app_source')
                deleted = db.usage_logs.delete_many(q)
                result = {"statusCode": 200, "body": json.dumps({"success": True, "deleted": deleted.deleted_count}, cls=JSONEncoder)}
        elif action == 'seo_kpi_save':
            # Persist today's SEO Team Performance Dashboard snapshot (idempotent per UTC day).
            # Called best-effort by the cockpit card on every load so daily history accrues.
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                snap = body.get('snapshot', {}) or {}
                day = datetime.utcnow().strftime('%Y-%m-%d')
                doc = {
                    "orgId": "digimetrics", "day": day,
                    "scores":  snap.get('scores', {}),
                    "overall": snap.get('overall', {}),
                    "regular": snap.get('regular', {}),
                    "psg":     snap.get('psg', {}),
                    "updatedAt": datetime.utcnow(),
                }
                db.seo_kpi_daily.update_one(
                    {"orgId": "digimetrics", "day": day},
                    {"$set": doc}, upsert=True)
                result = {"statusCode": 200, "body": json.dumps({"success": True, "day": day}, cls=JSONEncoder)}
        elif action == 'seo_kpi_cron':
            # Daily EventBridge trigger: compute today's snapshot server-side (no
            # frontend involved) so history accrues even if nobody opens the cockpit.
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                items = _seo_kpi_pull_board()
                scores, donuts = _seo_kpi_compute(items)
                day = datetime.utcnow().strftime('%Y-%m-%d')
                db.seo_kpi_daily.update_one(
                    {"orgId": "digimetrics", "day": day},
                    {"$set": {"orgId": "digimetrics", "day": day, "scores": scores,
                              "overall": donuts['all'], "regular": donuts['regular'], "psg": donuts['psg'],
                              "source": "cron", "updatedAt": datetime.utcnow()}},
                    upsert=True)
                # Full per-campaign raw snapshot — one doc per UTC day, kept forever,
                # so the "Raw Data" tab can travel back to any historical day.
                raw_rows = _seo_kpi_compute_rows(items)
                db.seo_kpi_daily_raw.update_one(
                    {"orgId": "digimetrics", "day": day},
                    {"$set": {"orgId": "digimetrics", "day": day, "rows": raw_rows,
                              "count": len(raw_rows), "source": "cron", "updatedAt": datetime.utcnow()}},
                    upsert=True)
                result = {"statusCode": 200, "body": json.dumps(
                    {"success": True, "day": day, "items": len(items), "rawCount": len(raw_rows),
                     "scores": scores, "donuts": donuts}, cls=JSONEncoder)}
        elif action == 'seo_kpi_history':
            # Monthly hit-rate trend: seeded historical months (from the SEO Performance
            # Sheet "Summary" tab) plus the current month derived from the latest daily snapshot.
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                monthly = list(db.seo_kpi_monthly.find({"orgId": "digimetrics"}, {"_id": 0}).sort("period", 1))
                series = [{"period": m.get("period"), "overall": m.get("overall"),
                           "regular": m.get("regular"), "psg": m.get("psg"),
                           "contractedKws": m.get("contractedKws")} for m in monthly]
                latest = db.seo_kpi_daily.find_one({"orgId": "digimetrics"}, {"_id": 0}, sort=[("day", -1)])
                if latest:
                    cur = (latest.get("day") or "")[:7]  # YYYY-MM
                    pt = {"period": cur,
                          "overall": (latest.get("overall") or {}).get("pct"),
                          "regular": (latest.get("regular") or {}).get("pct"),
                          "psg":     (latest.get("psg") or {}).get("pct"),
                          "contractedKws": (latest.get("scores") or {}).get("contractedKws")}
                    series = [s for s in series if s.get("period") != cur] + [pt]
                result = {"statusCode": 200, "body": json.dumps({"series": series}, cls=JSONEncoder)}
        elif action == 'seo_kpi_seed_history':
            # One-time (idempotent) seed of monthly history into seo_kpi_monthly.
            # Accepts a `months` array, else falls back to the 2025 Jan-Jul series
            # captured from the sheet's "Summary" tab. Upserts by period so re-runs
            # and later corrections are safe.
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                months = body.get('months')
                if not months:
                    _p  = ["2025-01","2025-02","2025-03","2025-04","2025-05","2025-06","2025-07"]
                    _ov = [58.11,52.38,47.56,38.33,42.62,49.15,43.94]
                    _rg = [78.79,81.08,68.75,35.42,42.55,45.65,40.82]
                    _pg = [41.46,29.79,34.00,50.00,42.86,61.54,52.94]
                    _kw = [3515,3432,3093,1724,1628,1573,1559]
                    months = [{"period": _p[i], "overall": _ov[i], "regular": _rg[i],
                               "psg": _pg[i], "contractedKws": _kw[i]} for i in range(len(_p))]
                n = 0
                for m in months:
                    if not m.get('period'):
                        continue
                    db.seo_kpi_monthly.update_one(
                        {"orgId": "digimetrics", "period": m['period']},
                        {"$set": {"orgId": "digimetrics", "period": m['period'],
                                  "overall": m.get('overall'), "regular": m.get('regular'),
                                  "psg": m.get('psg'), "contractedKws": m.get('contractedKws'),
                                  "source": m.get('source', 'sheet-summary'),
                                  "updatedAt": datetime.utcnow()}},
                        upsert=True)
                    n += 1
                result = {"statusCode": 200, "body": json.dumps({"success": True, "seeded": n}, cls=JSONEncoder)}
        elif action == 'seo_kpi_raw_dates':
            # List the days for which a full raw snapshot exists (newest first).
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                days = db.seo_kpi_daily_raw.distinct("day", {"orgId": "digimetrics"})
                days = sorted([d for d in days if d], reverse=True)
                result = {"statusCode": 200, "body": json.dumps({"days": days}, cls=JSONEncoder)}
        elif action == 'seo_kpi_raw_get':
            # Return one day's full raw rows (or the latest snapshot if day omitted).
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                day = body.get('day')
                if day and day != 'latest':
                    doc = db.seo_kpi_daily_raw.find_one({"orgId": "digimetrics", "day": day}, {"_id": 0})
                else:
                    doc = db.seo_kpi_daily_raw.find_one({"orgId": "digimetrics"}, {"_id": 0}, sort=[("day", -1)])
                if not doc:
                    result = {"statusCode": 200, "body": json.dumps({"day": day, "rows": [], "count": 0}, cls=JSONEncoder)}
                else:
                    result = {"statusCode": 200, "body": json.dumps(
                        {"day": doc.get("day"), "rows": doc.get("rows", []),
                         "count": doc.get("count", len(doc.get("rows", [])))}, cls=JSONEncoder)}
        elif action == 'seo_kpi_raw_import':
            # Bulk backfill of historical raw snapshots (e.g. from the SEO Performance
            # Sheet). Accepts {snapshots:[{day, rows}], source}. Idempotent per day.
            # Never clobbers a server-pulled 'cron' snapshot unless force=True.
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                snaps = body.get('snapshots') or []
                src = body.get('source', 'sheet')
                force = bool(body.get('force'))
                imported = 0; skipped = 0
                for s in snaps:
                    day = s.get('day'); rows = s.get('rows')
                    if not day or rows is None:
                        skipped += 1; continue
                    if not force:
                        existing = db.seo_kpi_daily_raw.find_one({"orgId": "digimetrics", "day": day}, {"source": 1})
                        if existing and existing.get('source') == 'cron':
                            skipped += 1; continue
                    db.seo_kpi_daily_raw.update_one(
                        {"orgId": "digimetrics", "day": day},
                        {"$set": {"orgId": "digimetrics", "day": day, "rows": rows,
                                  "count": len(rows), "source": src, "updatedAt": datetime.utcnow()}},
                        upsert=True)
                    imported += 1
                result = {"statusCode": 200, "body": json.dumps({"success": True, "imported": imported, "skipped": skipped}, cls=JSONEncoder)}
        elif action == 'get_monday_data':
            params = body.get('data', body)
            query = params.get('query') or body.get('query')
            variables = params.get('variables') or body.get('variables')
            api_key = params.get('api_key') or body.get('api_key')
            result_data = run_monday_graphql(query, variables=variables, api_key=api_key)
            result = {"statusCode": 200, "body": json.dumps(result_data)}
        elif action == 'get_insights':
            db = get_db()
            if db is None: 
                result = {"statusCode": 500, "body": json.dumps({"error": "DB Connection Failed"})}
            else:
                email = body.get('email')
                if not email: 
                    result = {"statusCode": 400, "body": json.dumps({"error": "Email missing"})}
                else:
                    doc = db.insights.find_one({"email": email.lower()})
                    result = {"statusCode": 200, "body": json.dumps({"insights": doc.get('insights', []) if doc else []}, cls=JSONEncoder)}
        elif action == 'get_forensic_audits':
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "DB Connection Failed"})}
            else:
                email = body.get('email')
                if not email:
                    result = {"statusCode": 400, "body": json.dumps({"error": "Email missing"})}
                else:
                    doc = db.forensic_audits.find_one({"email": email.lower()})
                    result = {"statusCode": 200, "body": json.dumps({"audits": doc.get('audits', []) if doc else []}, cls=JSONEncoder)}
        elif action == 'save_forensic_audits':
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "DB Connection Failed"})}
            else:
                email = body.get('email')
                audits = body.get('audits', [])
                if not email:
                    result = {"statusCode": 400, "body": json.dumps({"error": "Email missing"})}
                else:
                    db.forensic_audits.update_one(
                        {"email": email.lower()},
                        {"$set": {"audits": audits, "updated_at": datetime.now()}},
                        upsert=True
                    )
                    result = {"statusCode": 200, "body": json.dumps({"status": "success"})}
        elif action == 'save_insights':
            db = get_db()
            if db is None: 
                result = {"statusCode": 500, "body": json.dumps({"error": "DB Connection Failed"})}
            else:
                email = body.get('email')
                insights = body.get('insights', [])
                if not email: 
                    result = {"statusCode": 400, "body": json.dumps({"error": "Email missing"})}
                else:
                    db.insights.update_one(
                        {"email": email.lower()},
                        {"$set": {"insights": insights, "updated_at": datetime.now()}},
                        upsert=True
                    )
                    result = {"statusCode": 200, "body": json.dumps({"status": "success"})}
        elif action == 'get_keyword_metrics_batch':
            keywords = body.get('keywords', [])
            location = body.get('location', 'Singapore')
            language = body.get('language', 'English')
            
            print(f"[DEBUG] get_keyword_metrics_batch: {len(keywords)} keywords for {location}/{language}")
            
            if not keywords:
                result = {"statusCode": 400, "body": json.dumps({"error": "No keywords provided"})}
            elif not DATAFORSEO_API_KEY:
                print("[ERROR] DATAFORSEO_API_KEY is missing from environment")
                result = {"statusCode": 500, "body": json.dumps({"error": "DataForSEO API Key not configured on server"})}
            else:
                df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                # DataForSEO search_volume endpoint
                # Note: keywords must be a list, and it supports max 700 per task
                payload = [{
                    "keywords": keywords[:700], 
                    "location_name": location,
                    "language_name": language
                }]
                
                try:
                    res = requests.post("https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live", 
                                      headers=df_headers, json=payload, timeout=30)
                    print(f"[DEBUG] DataForSEO Status: {res.status_code}")
                    
                    if res.status_code == 200:
                        data = res.json()
                        formatted_results = []
                        if 'tasks' in data and data['tasks']:
                            for task in data['tasks']:
                                if 'result' in task and task['result']:
                                    for item in task['result']:
                                        formatted_results.append({
                                            "keyword": item.get('keyword'),
                                            "metrics": {
                                                "volume": item.get('search_volume'),
                                                "difficulty": item.get('competition_index'),
                                                "cpc": item.get('cpc')
                                            }
                                        })
                        print(f"[DEBUG] Returning {len(formatted_results)} results")
                        result = {"statusCode": 200, "body": json.dumps({"results": formatted_results})}
                    else:
                        print(f"[ERROR] DataForSEO Error: {res.text}")
                        result = {"statusCode": res.status_code, "body": res.text}
                except Exception as e:
                    print(f"[ERROR] Lambda Exception: {str(e)}")
                    result = {"statusCode": 500, "body": json.dumps({"error": str(e)})}
        elif action == 'get_seranking_sites':
            ser_headers = {"Authorization": f"Token {SERANKING_TOKEN}", "Content-Type": "application/json"}
            try:
                r = requests.get('https://api4.seranking.com/sites', headers=ser_headers, timeout=10)
                if r.status_code == 200:
                    sites = [{"id": s.get('id'), "title": s.get('title', 'Untitled'), "url": s.get('name', '')} for s in r.json()]
                    result = {"statusCode": 200, "body": json.dumps({"sites": sites})}
                else:
                    result = {"statusCode": r.status_code, "body": r.text}
            except Exception as e:
                result = {"statusCode": 500, "body": json.dumps({"error": str(e)})}
        # ── Server-side prompt actions ────────────────────────────────────
        elif action == 'get_workduo_projects':
            result = _get_workduo_projects()
        elif action == 'geo_fetch_visibility':
            result = _geo_fetch_workduo_direct(
                entities   = body.get('entities', []),
                start_date = body.get('startDate', ''),
                end_date   = body.get('endDate', '')
            )
        elif action == 'geo_fetch_comparison':
            result = _geo_fetch_workduo_direct(
                entities   = body.get('entities', []),
                start_date = body.get('cmpFrom', ''),
                end_date   = body.get('cmpTo', '')
            )
        elif action == 'audit_recommendations':
            result = _audit_recommendations(body)
        elif action == 'competitor_insights':
            result = _competitor_insights(body)
        elif action == 'strategy_auto_populate':
            result = _strategy_auto_populate(body)
        elif action == 'strategy_generate':
            result = _strategy_generate(body)
        elif action == 'strategy_recommendations':
            result = _strategy_recommendations(body)
        else:
            result = {"statusCode": 400, "body": json.dumps({"error": f"Invalid Action: {action}"})}

        # Final check on result
        if not result:
            result = {"statusCode": 500, "body": json.dumps({"error": "No result produced"})}
        
        if 'headers' not in result:
            result['headers'] = headers
        else:
            # Merge CORS headers into existing headers if any
            result['headers'].update(headers)

        return result

    except Exception as e:
        tb = traceback.format_exc()
        print(f"[CRITICAL ERROR] {str(e)}\n{tb}")
        return {
            "statusCode": 500,
            "headers": headers,
            "body": json.dumps({"error": "Internal Server Error", "detail": str(e), "traceback": tb})
        }
