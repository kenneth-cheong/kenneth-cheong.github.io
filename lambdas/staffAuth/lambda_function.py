"""
staffAuth — username/password login for index.html (app.digimetrics.ai), plus a
staff-managed admin API for creating / editing / removing those accounts.

Two audiences:
  * Staff/clients log in with a username + password (verified here, hashed at
    rest in DynamoDB). A successful login returns the account's display name and
    the list of app sections it is allowed to see.
  * Admins (a fixed allowlist of mediaone.co Google accounts) manage those
    accounts. Admin calls are gated by a short-lived HMAC session token that is
    only minted after a Google ID token is verified against the allowlist.

A third audience was added later: any authenticated platform user (admin OR staff
account OR a verified @mediaone.co Google identity) can read the WhatsApp support
bot's conversation logs. Those live in a different table and are READ-ONLY here.
They are gated because they are client PII — phone numbers and message
transcripts. See _require_platform_user().

Actions (POST JSON, field "action"):
  login          {username, password}                       -> {success, user}
  admin_session  {credential}                               -> {token, exp, email, name}
  admin_list     {token}                                    -> {accounts:[...]}
  admin_create   {token, username, password, name, sections, active}
  admin_update   {token, username, name?, sections?, active?}
  admin_reset    {token, username, password}
  admin_delete   {token, username}
  wa_list_conversations {token|credential, limit?, cursor?}  -> {conversations:[...], cursor}
  wa_get_conversation   {token|credential, wa_id}           -> {wa_id, turns:[...]}

Env vars:
  TABLE_NAME          DynamoDB table (PK: username)
  WA_CONVO_TABLE      WhatsApp bot conversations, read-only (default wa_conversations)
  ADMIN_EMAILS        comma-separated allowlist of admin emails
  GOOGLE_CLIENT_ID    OAuth client id the ID token must be issued for
  ADMIN_TOKEN_SECRET  HMAC secret for minting admin session tokens
"""

import base64
import hashlib
import hmac
import json
import os
import re
import time
import urllib.parse
import urllib.request
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError


def _json_default(o):
    # DynamoDB returns numbers as Decimal, which json can't serialise natively.
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    raise TypeError(f"Not JSON serializable: {type(o)}")

TABLE_NAME = os.environ.get("TABLE_NAME", "dm-staff-accounts")
ADMIN_EMAILS = {
    e.strip().lower()
    for e in os.environ.get("ADMIN_EMAILS", "").split(",")
    if e.strip()
}
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
ADMIN_TOKEN_SECRET = os.environ.get("ADMIN_TOKEN_SECRET", "")
ADMIN_TOKEN_TTL = 12 * 60 * 60  # 12h
STAFF_TOKEN_TTL = 30 * 24 * 60 * 60  # 30d — staff session, used for usage metering

# Sections a staff account can be granted. Keep in sync with the frontend nav.
VALID_SECTIONS = {"seo", "smm", "content", "geo", "sem", "others", "cockpit"}
# Max number of tool ids we'll store on an account (guards against abuse).
MAX_TOOLS = 200

_ddb = boto3.resource("dynamodb")
_table = _ddb.Table(TABLE_NAME)

# WhatsApp support-bot conversations. READ-ONLY from this Lambda — the exec role is
# granted only Scan + GetItem on this one table.
WA_CONVO_TABLE = os.environ.get("WA_CONVO_TABLE", "wa_conversations")
_wa_table = _ddb.Table(WA_CONVO_TABLE)

# Must stay identical to ESCALATION_REPLY in lambdas/whatsappBot/lambda_function.py.
# It is how we detect an escalated conversation without a schema change: the bot sends
# this exact constant (never model-generated text) when it hands off to a human. Change
# the bot's wording without changing this and the "escalated" flag silently goes false
# for every conversation.
WA_ESCALATION_REPLY = (
    "That's one for a human colleague — I've passed this to the MediaOne team "
    "and someone will follow up with you here."
)

USERNAME_RE = re.compile(r"^[a-zA-Z0-9._@-]{3,64}$")


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64u_dec(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def hash_pw(password: str) -> str:
    salt = os.urandom(16)
    iterations = 200_000
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2${iterations}${_b64u(salt)}${_b64u(dk)}"


def verify_pw(password: str, stored: str) -> bool:
    try:
        scheme, iters, salt_b64, hash_b64 = stored.split("$")
        if scheme != "pbkdf2":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), _b64u_dec(salt_b64), int(iters)
        )
        return hmac.compare_digest(dk, _b64u_dec(hash_b64))
    except Exception:
        return False


def make_admin_token(email: str) -> dict:
    exp = int(time.time()) + ADMIN_TOKEN_TTL
    payload = f"{email.lower()}|{exp}"
    sig = hmac.new(
        ADMIN_TOKEN_SECRET.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()
    return {"token": f"{_b64u(payload.encode())}.{sig}", "exp": exp}


def verify_admin_token(token: str):
    """Return the admin email if the token is valid & unexpired, else None."""
    try:
        payload_b64, sig = token.split(".")
        payload = _b64u_dec(payload_b64).decode()
        expected = hmac.new(
            ADMIN_TOKEN_SECRET.encode(), payload.encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(expected, sig):
            return None
        email, exp = payload.rsplit("|", 1)
        if int(exp) < int(time.time()):
            return None
        if email.lower() not in ADMIN_EMAILS:
            return None
        return email.lower()
    except Exception:
        return None


def make_staff_token(username: str) -> dict:
    """Session token issued to a staff account at login; binds usage metering
    calls to that account. Prefixed 's:' to keep it distinct from admin tokens."""
    exp = int(time.time()) + STAFF_TOKEN_TTL
    payload = f"s:{username}|{exp}"
    sig = hmac.new(ADMIN_TOKEN_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return {"token": f"{_b64u(payload.encode())}.{sig}", "exp": exp}


def verify_staff_token(token: str):
    """Return the staff username if the token is valid & unexpired, else None."""
    try:
        payload_b64, sig = token.split(".")
        payload = _b64u_dec(payload_b64).decode()
        expected = hmac.new(ADMIN_TOKEN_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig):
            return None
        if not payload.startswith("s:"):
            return None
        body, exp = payload.rsplit("|", 1)
        if int(exp) < int(time.time()):
            return None
        return body[2:]  # strip "s:"
    except Exception:
        return None


def current_month() -> str:
    return time.strftime("%Y-%m", time.gmtime())


def usage_attr(month: str = None) -> str:
    return "u_" + (month or current_month())


def clean_tools(raw) -> list:
    if not isinstance(raw, list):
        return []
    out = []
    for t in raw:
        if isinstance(t, str) and 0 < len(t) <= 64 and t not in out:
            out.append(t)
        if len(out) >= MAX_TOOLS:
            break
    return out


def verify_google_credential(credential: str):
    """Verify a Google ID token via tokeninfo. Return (email, name) or None."""
    try:
        url = "https://oauth2.googleapis.com/tokeninfo?" + urllib.parse.urlencode(
            {"id_token": credential}
        )
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
    except Exception:
        return None

    if GOOGLE_CLIENT_ID and data.get("aud") != GOOGLE_CLIENT_ID:
        return None
    if str(data.get("email_verified", "")).lower() not in ("true", "1"):
        return None
    try:
        if int(data.get("exp", 0)) < int(time.time()):
            return None
    except Exception:
        return None
    email = (data.get("email") or "").lower()
    if not email:
        return None
    return email, data.get("name") or email


def clean_sections(raw) -> list:
    if not isinstance(raw, list):
        return []
    return [s for s in dict.fromkeys(raw) if s in VALID_SECTIONS]


def public_account(item: dict) -> dict:
    """Strip the password hash before returning an account to an admin."""
    month = current_month()
    return {
        "username": item.get("username"),
        "name": item.get("name", ""),
        "sections": item.get("sections", []),
        "tools": item.get("tools", []),
        "quota": int(item.get("quota") or 0),
        "usageThisMonth": int(item.get(usage_attr(month)) or 0),
        "month": month,
        "active": bool(item.get("active", True)),
        "createdBy": item.get("createdBy", ""),
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
    }


def _resp(status: int, body: dict) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "content-type",
            "Access-Control-Allow-Methods": "POST,OPTIONS",
        },
        "body": json.dumps(body, default=_json_default),
    }


# --------------------------------------------------------------------------- #
# actions
# --------------------------------------------------------------------------- #
def do_login(body: dict) -> dict:
    username = (body.get("username") or "").strip().lower()
    password = body.get("password") or ""
    if not username or not password:
        return _resp(400, {"success": False, "message": "Missing credentials."})
    try:
        item = _table.get_item(Key={"username": username}).get("Item")
    except ClientError:
        return _resp(500, {"success": False, "message": "Server error."})

    # Constant-ish behaviour: don't leak whether the username exists.
    if not item or not verify_pw(password, item.get("pw", "")):
        return _resp(401, {"success": False, "message": "Invalid username or password."})
    if not item.get("active", True):
        return _resp(403, {"success": False, "message": "This account is disabled."})

    month = current_month()
    quota = int(item.get("quota") or 0)
    used = int(item.get(usage_attr(month)) or 0)
    tok = make_staff_token(item["username"])
    return _resp(
        200,
        {
            "success": True,
            "user": {
                "username": item["username"],
                "name": item.get("name", item["username"]),
                "sections": item.get("sections", []),
                "tools": item.get("tools", []),
                "quota": quota,
            },
            "token": tok["token"],
            "tokenExp": tok["exp"],
            "usage": {
                "month": month,
                "used": used,
                "limit": quota,
                "remaining": (max(0, quota - used) if quota > 0 else -1),
            },
        },
    )


def do_usage_status(body: dict) -> dict:
    username = verify_staff_token(body.get("token") or "")
    if not username:
        return _resp(401, {"success": False, "message": "Session expired."})
    try:
        item = _table.get_item(Key={"username": username}).get("Item")
    except ClientError:
        return _resp(500, {"success": False, "message": "Server error."})
    if not item:
        return _resp(404, {"success": False, "message": "No such account."})
    month = current_month()
    quota = int(item.get("quota") or 0)
    used = int(item.get(usage_attr(month)) or 0)
    return _resp(200, {
        "success": True,
        "active": bool(item.get("active", True)),
        "month": month, "used": used, "limit": quota,
        "remaining": (max(0, quota - used) if quota > 0 else -1),
    })


def do_record_usage(body: dict) -> dict:
    """Count one tool run against the account's monthly quota. Returns
    allowed=False (without incrementing) when the account is already at its
    limit, so the frontend can block the run."""
    username = verify_staff_token(body.get("token") or "")
    if not username:
        return _resp(401, {"success": False, "message": "Session expired."})
    try:
        item = _table.get_item(Key={"username": username}).get("Item")
    except ClientError:
        return _resp(500, {"success": False, "message": "Server error."})
    if not item:
        return _resp(404, {"success": False, "message": "No such account."})
    if not item.get("active", True):
        return _resp(403, {"success": False, "allowed": False, "message": "Account disabled."})

    month = current_month()
    attr = usage_attr(month)
    quota = int(item.get("quota") or 0)
    used_now = int(item.get(attr) or 0)

    # Already at the monthly limit — refuse without incrementing so the caller
    # can block the run. (if_not_exists is only valid in update expressions, not
    # condition expressions, so the cap is enforced here in Python.)
    if quota > 0 and used_now >= quota:
        return _resp(200, {"success": True, "allowed": False, "month": month,
                           "used": used_now, "limit": quota, "remaining": 0,
                           "message": "Monthly usage limit reached."})

    try:
        r = _table.update_item(
            Key={"username": username},
            UpdateExpression="SET #a = if_not_exists(#a, :z) + :one",
            ExpressionAttributeNames={"#a": attr},
            ExpressionAttributeValues={":z": 0, ":one": 1},
            ReturnValues="UPDATED_NEW",
        )
        used = int(r["Attributes"][attr])
    except ClientError:
        return _resp(500, {"success": False, "message": "Server error."})

    return _resp(200, {"success": True, "allowed": True, "month": month, "used": used,
                       "limit": quota, "remaining": (max(0, quota - used) if quota > 0 else -1)})


def do_admin_session(body: dict) -> dict:
    credential = body.get("credential") or ""
    if not credential:
        return _resp(400, {"success": False, "message": "Missing credential."})
    verified = verify_google_credential(credential)
    if not verified:
        return _resp(401, {"success": False, "message": "Could not verify Google identity."})
    email, name = verified
    if email not in ADMIN_EMAILS:
        return _resp(403, {"success": False, "message": "Not an authorised admin."})
    tok = make_admin_token(email)
    return _resp(200, {"success": True, "email": email, "name": name, **tok})


def _require_admin(body: dict):
    return verify_admin_token(body.get("token") or "")


def do_admin_list(body: dict) -> dict:
    if not _require_admin(body):
        return _resp(401, {"success": False, "message": "Admin session expired."})
    try:
        items = _table.scan().get("Items", [])
    except ClientError:
        return _resp(500, {"success": False, "message": "Server error."})
    accounts = sorted(
        (public_account(i) for i in items), key=lambda a: (a["username"] or "")
    )
    return _resp(200, {"success": True, "accounts": accounts})


def do_admin_create(body: dict) -> dict:
    admin = _require_admin(body)
    if not admin:
        return _resp(401, {"success": False, "message": "Admin session expired."})
    username = (body.get("username") or "").strip().lower()
    password = body.get("password") or ""
    name = (body.get("name") or "").strip()
    sections = clean_sections(body.get("sections"))
    tools = clean_tools(body.get("tools"))
    try:
        quota = max(0, int(body.get("quota") or 0))
    except (TypeError, ValueError):
        quota = 0
    active = bool(body.get("active", True))

    if not USERNAME_RE.match(username):
        return _resp(400, {"success": False, "message": "Username must be 3-64 chars (letters, numbers, . _ - @)."})
    if len(password) < 6:
        return _resp(400, {"success": False, "message": "Password must be at least 6 characters."})

    try:
        exists = _table.get_item(Key={"username": username}).get("Item")
    except ClientError:
        return _resp(500, {"success": False, "message": "Server error."})
    if exists:
        return _resp(409, {"success": False, "message": "That username already exists."})

    now = int(time.time())
    item = {
        "username": username,
        "pw": hash_pw(password),
        "name": name or username,
        "sections": sections,
        "tools": tools,
        "quota": quota,
        "active": active,
        "createdBy": admin,
        "createdAt": now,
        "updatedAt": now,
    }
    try:
        _table.put_item(Item=item, ConditionExpression="attribute_not_exists(username)")
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(409, {"success": False, "message": "That username already exists."})
        return _resp(500, {"success": False, "message": "Server error."})
    return _resp(200, {"success": True, "account": public_account(item)})


def do_admin_update(body: dict) -> dict:
    admin = _require_admin(body)
    if not admin:
        return _resp(401, {"success": False, "message": "Admin session expired."})
    username = (body.get("username") or "").strip().lower()
    if not username:
        return _resp(400, {"success": False, "message": "Missing username."})

    updates = {"updatedAt": int(time.time())}
    if "name" in body:
        updates["name"] = (body.get("name") or "").strip() or username
    if "sections" in body:
        updates["sections"] = clean_sections(body.get("sections"))
    if "tools" in body:
        updates["tools"] = clean_tools(body.get("tools"))
    if "quota" in body:
        try:
            updates["quota"] = max(0, int(body.get("quota") or 0))
        except (TypeError, ValueError):
            updates["quota"] = 0
    if "active" in body:
        updates["active"] = bool(body.get("active"))

    expr_parts, names, values = [], {}, {}
    for i, (k, v) in enumerate(updates.items()):
        expr_parts.append(f"#k{i} = :v{i}")
        names[f"#k{i}"] = k
        values[f":v{i}"] = v
    try:
        _table.update_item(
            Key={"username": username},
            UpdateExpression="SET " + ", ".join(expr_parts),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression="attribute_exists(username)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(404, {"success": False, "message": "No such account."})
        return _resp(500, {"success": False, "message": "Server error."})
    try:
        item = _table.get_item(Key={"username": username}).get("Item")
    except ClientError:
        item = None
    return _resp(200, {"success": True, "account": public_account(item) if item else None})


def do_admin_reset(body: dict) -> dict:
    admin = _require_admin(body)
    if not admin:
        return _resp(401, {"success": False, "message": "Admin session expired."})
    username = (body.get("username") or "").strip().lower()
    password = body.get("password") or ""
    if not username:
        return _resp(400, {"success": False, "message": "Missing username."})
    if len(password) < 6:
        return _resp(400, {"success": False, "message": "Password must be at least 6 characters."})
    try:
        _table.update_item(
            Key={"username": username},
            UpdateExpression="SET pw = :p, updatedAt = :u",
            ExpressionAttributeValues={":p": hash_pw(password), ":u": int(time.time())},
            ConditionExpression="attribute_exists(username)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(404, {"success": False, "message": "No such account."})
        return _resp(500, {"success": False, "message": "Server error."})
    return _resp(200, {"success": True})


def do_admin_delete(body: dict) -> dict:
    admin = _require_admin(body)
    if not admin:
        return _resp(401, {"success": False, "message": "Admin session expired."})
    username = (body.get("username") or "").strip().lower()
    if not username:
        return _resp(400, {"success": False, "message": "Missing username."})
    try:
        _table.delete_item(Key={"username": username})
    except ClientError:
        return _resp(500, {"success": False, "message": "Server error."})
    return _resp(200, {"success": True})


# --------------------------------------------------------------------------- #
# WhatsApp support-log viewer (read-only)
#
# These serve client PII, so they are gated. The `monday` Lambda that backs every
# other tool in index.html has NO authentication at all — routing this data through
# it would publish phone numbers and transcripts to anyone who reads the JS bundle.
# That is why these live here instead: this file already has the only real identity
# verification in the repo, and we reuse it rather than inventing a second one.
# --------------------------------------------------------------------------- #
def _require_platform_user(body):
    """Any authenticated platform user. Returns an identity string, else None.

    Three ways in, because the app has three kinds of session:
      * admin token   — verify_admin_token re-checks ADMIN_EMAILS on every call
      * staff token   — issued by do_login to a username/password account
      * Google id_token — for @mediaone.co people who sign in with Google but are
        not admins, and so have no minted token of their own. The email comes from
        Google's tokeninfo, never from the request body.
    """
    tok = (body.get("token") or "").strip()
    if tok:
        email = verify_admin_token(tok)
        if email:
            return email
        user = verify_staff_token(tok)
        if user:
            return f"staff:{user}"
    cred = (body.get("credential") or "").strip()
    if cred:
        got = verify_google_credential(cred)
        if got and got[0].endswith("@mediaone.co"):
            return got[0]
    return None


def _wa_mask(wa_id) -> str:
    """Last 4 digits only. Audit lines go to CloudWatch, whose retention on this
    account is indefinite — an audit trail doesn't need the whole phone number."""
    s = str(wa_id or "")
    return "***" + s[-4:] if len(s) >= 4 else "***"


def _wa_audit(identity, action, wa_id=None):
    print(f"[WA_ADMIN] {identity} {action} {_wa_mask(wa_id) if wa_id else '-'}")


def _wa_summary(item: dict) -> dict:
    """List-view row. Deliberately does NOT include the transcript — the list is a
    directory, and full message bodies only leave the table via wa_get_conversation
    (which is audited per conversation)."""
    turns = item.get("turns") or []
    last = turns[-1] if turns else {}
    return {
        "wa_id": item.get("wa_id"),
        "turns": len(turns),
        "last_ts": int(item.get("last_user_ts") or last.get("ts") or 0),
        "preview": (last.get("text") or "")[:120],
        "escalated": any(
            t.get("role") == "assistant"
            and (t.get("text") or "").strip() == WA_ESCALATION_REPLY
            for t in turns
        ),
    }


def do_wa_list_conversations(body):
    who = _require_platform_user(body)
    if not who:
        return _resp(401, {"success": False, "message": "Not authorised."})
    _wa_audit(who, "list")
    try:
        limit = max(1, min(int(body.get("limit") or 100), 500))
    except (TypeError, ValueError):
        limit = 100
    kwargs = {"Limit": limit}
    cursor = (body.get("cursor") or "").strip()
    if cursor:
        kwargs["ExclusiveStartKey"] = {"wa_id": cursor}
    try:
        res = _wa_table.scan(**kwargs)
    except ClientError as e:
        print("wa scan failed:", repr(e))
        return _resp(500, {"success": False, "message": "Could not read conversations."})
    rows = [_wa_summary(i) for i in res.get("Items", [])]
    rows.sort(key=lambda r: r["last_ts"], reverse=True)
    return _resp(200, {
        "success": True,
        "conversations": rows,
        "cursor": (res.get("LastEvaluatedKey") or {}).get("wa_id"),
    })


def do_wa_get_conversation(body):
    who = _require_platform_user(body)
    if not who:
        return _resp(401, {"success": False, "message": "Not authorised."})
    wa_id = (body.get("wa_id") or "").strip()
    if not wa_id:
        return _resp(400, {"success": False, "message": "wa_id required."})
    _wa_audit(who, "view", wa_id)
    try:
        item = (_wa_table.get_item(Key={"wa_id": wa_id}) or {}).get("Item")
    except ClientError as e:
        print("wa get failed:", repr(e))
        return _resp(500, {"success": False, "message": "Could not read conversation."})
    if not item:
        return _resp(404, {"success": False, "message": "Not found."})
    return _resp(200, {
        "success": True,
        "wa_id": item.get("wa_id"),
        "last_ts": int(item.get("last_user_ts") or 0),
        "expires_at": int(item.get("ttl") or 0),   # 30-day TTL; this is not an archive
        "turns": [
            {
                "role": t.get("role"),
                "text": t.get("text") or "",
                "ts": int(t.get("ts") or 0),
            }
            for t in (item.get("turns") or [])
        ],
    })


ACTIONS = {
    "login": do_login,
    "usage_status": do_usage_status,
    "record_usage": do_record_usage,
    "admin_session": do_admin_session,
    "admin_list": do_admin_list,
    "admin_create": do_admin_create,
    "admin_update": do_admin_update,
    "admin_reset": do_admin_reset,
    "admin_delete": do_admin_delete,
    "wa_list_conversations": do_wa_list_conversations,
    "wa_get_conversation": do_wa_get_conversation,
}


def lambda_handler(event, context):
    # CORS preflight (in case it reaches the Lambda).
    method = (
        event.get("requestContext", {}).get("http", {}).get("method")
        or event.get("httpMethod")
    )
    if method == "OPTIONS":
        return _resp(200, {"ok": True})

    # Body may arrive as a JSON string (API Gateway proxy) or a dict (direct invoke).
    raw = event.get("body", event)
    if isinstance(raw, str):
        if event.get("isBase64Encoded"):
            try:
                raw = base64.b64decode(raw).decode()
            except Exception:
                pass
        try:
            body = json.loads(raw or "{}")
        except Exception:
            return _resp(400, {"success": False, "message": "Invalid JSON."})
    elif isinstance(raw, dict):
        body = raw
    else:
        return _resp(400, {"success": False, "message": "Invalid request."})

    action = body.get("action")
    handler = ACTIONS.get(action)
    if not handler:
        return _resp(400, {"success": False, "message": "Unknown action."})
    try:
        return handler(body)
    except Exception as e:
        print("staffAuth error:", repr(e))
        return _resp(500, {"success": False, "message": "Server error."})
