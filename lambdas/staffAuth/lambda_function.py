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
  wa_get_prompt         {token|credential}                  -> {prompts:{...}, fixed_contract, composed}
  wa_save_prompt        {token|credential, key, text}       -> {updated_at, updated_by}
  wa_send_message       {token|credential, wa_id, text}     -> {success}
  wa_set_paused         {token|credential, wa_id, paused}   -> {paused}

The last four are newer and differ in kind from the read-only pair above: they
change what a public bot says to clients, and they send real WhatsApp messages.
Neither is done in this Lambda. Both are a synchronous invoke of whatsappBot, so
WA_ACCESS_TOKEN lives in one place and this function's role stays read-only on
wa_conversations. This file authenticates the person; that one does the writing.

Env vars:
  TABLE_NAME          DynamoDB table (PK: username)
  WA_CONVO_TABLE      WhatsApp bot conversations, read-only (default wa_conversations)
  BOT_PROMPT_TABLE    staff-editable prompt blocks (default dm-bot-prompts)
  WA_BOT_FUNCTION     the bot Lambda to invoke (default whatsappBot)
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
# Admin session length.
#
# Was 12h, which meant signing in with Google twice a day — and because a Google
# id_token only lives ~1h, an expired admin token had NO renewal path at all: the
# only way back was a fresh interactive sign-in. That is what made the tools read
# "Please sign in again" so constantly.
#
# 30d is defensible here specifically because expiry is NOT the revocation
# mechanism: verify_admin_token re-checks ADMIN_EMAILS on every single call, so
# dropping someone from that env var cuts them off instantly no matter how long
# their token had left. A shorter TTL never bought us revocation — it only bought
# us re-authentication, which is not the same thing.
#
# ADMIN_SESSION_MAX still bounds it: admin_refresh keeps the ORIGINAL iat, so a
# session cannot roll forever. Ninety days after first signing in, you sign in
# again for real.
ADMIN_TOKEN_TTL = int(os.environ.get("ADMIN_TOKEN_TTL_SEC", 30 * 24 * 60 * 60))
ADMIN_SESSION_MAX = int(os.environ.get("ADMIN_SESSION_MAX_SEC", 90 * 24 * 60 * 60))
STAFF_TOKEN_TTL = 30 * 24 * 60 * 60  # 30d — staff session, used for usage metering

# Sections a staff account can be granted. Keep in sync with the frontend nav.
VALID_SECTIONS = {"seo", "smm", "content", "geo", "sem", "others", "cockpit"}
# Max number of tool ids we'll store on an account (guards against abuse).
MAX_TOOLS = 200

_ddb = boto3.resource("dynamodb")
_table = _ddb.Table(TABLE_NAME)

# WhatsApp support-bot conversations. READ-ONLY from this Lambda — the exec role is
# granted only Scan + GetItem on this one table.
#
# It stays read-only even now that staff can reply and pause the bot from
# index.html: those go out as a synchronous invoke of the whatsappBot Lambda, which
# is the only function holding WA_ACCESS_TOKEN and the only one that writes turns.
# Keeping the send token out of this internet-facing, CORS-* API is worth the extra
# hop. Don't "simplify" it by giving this role UpdateItem and a Graph token.
WA_CONVO_TABLE = os.environ.get("WA_CONVO_TABLE", "wa_conversations")
_wa_table = _ddb.Table(WA_CONVO_TABLE)

# The whatsappBot Lambda. Invoked for anything that sends a message, writes a turn,
# or needs the prompt DEFAULTS (which that file owns — see do_wa_get_prompt).
WA_BOT_FUNCTION = os.environ.get("WA_BOT_FUNCTION", "whatsappBot")
_lambda = boto3.client("lambda")

# The staff-editable half of the WhatsApp bot's system prompt. This Lambda may
# read and write these blocks but deliberately does NOT know their default text —
# whatsappBot does, and hands it over via the wa_prompt_info invoke. Storing a
# second copy here is exactly the WA_ESCALATION_REPLY drift trap, but 2KB wide.
BOT_PROMPT_TABLE = os.environ.get("BOT_PROMPT_TABLE", "dm-bot-prompts")
_prompt_table = _ddb.Table(BOT_PROMPT_TABLE)

# An allow-list, not a free-form key space: the bot only ever reads these two, so
# any other key would be dead weight that staff could nonetheless fill with text.
EDITABLE_PROMPT_KEYS = ("shared_persona", "whatsapp_scope", "whatsapp_client_scope")
MAX_PROMPT_CHARS = 8000        # mirrors whatsappBot's MAX_PROMPT_CHARS
MAX_PROMPT_HISTORY = 10        # versions kept for one-click revert

# Who a WhatsApp number belongs to. Staff-maintained from index.html.
#
# SCOPE — read this before extending it: the directory exists so a colleague reading
# a transcript knows who they are talking to. It is NOT an authorisation record. The
# bot does not use it to decide what to tell anyone, and `whatsapp_scope` still says
# it has no account data. A phone number proves possession of a SIM, not that the
# holder is entitled to a client's campaign or billing data — numbers get recycled,
# handsets get shared, and people leave the company still holding their phone. If you
# ever wire this into what the bot DISCLOSES, that is a different feature with a
# different risk profile, and the three guardrail layers have to be revisited.
CLIENT_DIR_TABLE = os.environ.get("CLIENT_DIR_TABLE", "dm-client-directory")
_client_table = _ddb.Table(CLIENT_DIR_TABLE)
MAX_CLIENT_FIELD = 120

# The account matrix: which of our systems this number's client lives in.
#
# Each asset stores an id AND the label it had when it was picked. The label is not
# redundant: the Google Ads and Meta pickers can only be populated by a browser that
# holds a live OAuth token / a pasted Meta token, so a colleague without either would
# otherwise open the matrix and see a bare customer id with no idea what it is. The
# id is what's authoritative; the label is what's readable.
#
# campaign_id is the ICIR item (board 2845615047) — the thing that actually IS a
# client. board_id / seranking_id are pre-filled FROM that item's own columns
# (text_mknpdk1p, text_mm3zt0yn) rather than re-asked, because Monday already knows
# them and a second hand-typed copy would just drift.
ASSET_FIELDS = (
    "campaign",     # ICIR item — the client record everything else hangs off
    "board",        # that client's per-client Monday execution board
    "seranking",    # SE Ranking site
    "ads",          # Google Ads customer
    "meta",         # Meta ad account (id already carries the act_ prefix)
    "geo",          # GEO / WorkDuo dashboard campaign
    "smm",          # social monthly report project (note: keyed projectId upstream)
)


def _norm_phone(raw):
    """WhatsApp's `from` is digits with no '+' (e.g. 6593665477). Store that shape,
    so the directory key and the conversation key are the same string.

    Returns None rather than guessing. A wrong-but-plausible normalisation is the
    worst outcome here: it doesn't error, it just labels a conversation with the
    wrong company, and nobody notices.
    """
    s = re.sub(r"[^\d]", "", str(raw or ""))
    if s.startswith("00"):          # 0065… international prefix
        s = s[2:]
    # E.164 is max 15 digits. The floor is 9 to force a country code: a Singapore
    # local "93665477" would store as 8 digits and silently never match the
    # "6593665477" WhatsApp actually sends.
    if not (9 <= len(s) <= 15):
        return None
    return s

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


def make_admin_token(email: str, iat: int = None) -> dict:
    """Payload is email|iat|exp. iat is carried through admin_refresh unchanged so
    ADMIN_SESSION_MAX measures from the ORIGINAL Google sign-in — otherwise a
    session could roll forever and the cap would be decorative."""
    now = int(time.time())
    iat = int(iat or now)
    exp = now + ADMIN_TOKEN_TTL
    payload = f"{email.lower()}|{iat}|{exp}"
    sig = hmac.new(
        ADMIN_TOKEN_SECRET.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()
    return {"token": f"{_b64u(payload.encode())}.{sig}", "exp": exp, "iat": iat}


def _parse_admin_token(token: str):
    """(email, iat, exp) if the signature is good, else None. Does NOT check expiry
    or the allow-list — callers decide, because admin_refresh must be able to look
    at a token that has already expired.
    """
    try:
        payload_b64, sig = token.split(".")
        payload = _b64u_dec(payload_b64).decode()
        expected = hmac.new(
            ADMIN_TOKEN_SECRET.encode(), payload.encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(expected, sig):
            return None
        parts = payload.split("|")      # an email cannot contain '|'
        if len(parts) == 3:
            return parts[0], int(parts[1]), int(parts[2])
        if len(parts) == 2:
            # Legacy email|exp token, minted before iat existed. Still in browsers
            # right now, so it must keep working — infer an iat from the old 12h TTL
            # rather than logging everyone out on deploy.
            exp = int(parts[1])
            return parts[0], exp - (12 * 60 * 60), exp
        return None
    except Exception:
        return None


def verify_admin_token(token: str):
    """Return the admin email if the token is valid & unexpired, else None.

    ADMIN_EMAILS is re-checked on EVERY call — this, not expiry, is how an admin is
    revoked. Drop them from the env var and every token they hold dies at once.
    """
    got = _parse_admin_token(token or "")
    if not got:
        return None
    email, _iat, exp = got
    if exp < int(time.time()):
        return None
    if email.lower() not in ADMIN_EMAILS:
        return None
    return email.lower()


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


def tool_usage_attr(month: str = None) -> str:
    # Per-tool breakdown for the month, stored as a map {toolId: count} alongside
    # the u_YYYY-MM running total. Kept in a separate attribute so the total stays
    # a single cheap counter and the breakdown can be dropped without touching it.
    return "tu_" + (month or current_month())


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
    raw_tool_usage = item.get(tool_usage_attr(month)) or {}
    tool_usage = {}
    if isinstance(raw_tool_usage, dict):
        for k, v in raw_tool_usage.items():
            try:
                tool_usage[k] = int(v)
            except (TypeError, ValueError):
                continue
    return {
        "username": item.get("username"),
        "name": item.get("name", ""),
        "sections": item.get("sections", []),
        "tools": item.get("tools", []),
        "quota": int(item.get("quota") or 0),
        "usageThisMonth": int(item.get(usage_attr(month)) or 0),
        "toolUsage": tool_usage,
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

    # Best-effort per-tool breakdown. Kept separate from the quota increment above
    # so a hiccup here can never miscount the quota (which is the number that gates
    # the run). The monthly map tu_YYYY-MM holds {toolId: count}.
    tool = (body.get("tool") or "").strip()[:64]
    if tool:
        _bump_tool_usage(username, month, tool)

    return _resp(200, {"success": True, "allowed": True, "month": month, "used": used,
                       "limit": quota, "remaining": (max(0, quota - used) if quota > 0 else -1)})


def _bump_tool_usage(username: str, month: str, tool: str) -> None:
    """Increment one tool's counter inside the monthly map, best-effort.

    A nested increment fails if the map attribute doesn't exist yet (first tool run
    of the month for this account), so fall back to seeding the map with this tool.
    Any failure is swallowed: the quota total is already counted and correct, and a
    lost breakdown entry is not worth failing the caller's run over.
    """
    tattr = tool_usage_attr(month)
    try:
        _table.update_item(
            Key={"username": username},
            UpdateExpression="SET #m.#t = if_not_exists(#m.#t, :z) + :one",
            ExpressionAttributeNames={"#m": tattr, "#t": tool},
            ExpressionAttributeValues={":z": 0, ":one": 1},
        )
        return
    except ClientError:
        pass
    # Map (or its parent path) not there yet — create it seeded with this tool. The
    # conditional guards a race where a concurrent call created it first.
    try:
        _table.update_item(
            Key={"username": username},
            UpdateExpression="SET #m = :seed",
            ExpressionAttributeNames={"#m": tattr},
            ExpressionAttributeValues={":seed": {tool: 1}},
            ConditionExpression="attribute_not_exists(#m)",
        )
        return
    except ClientError:
        pass
    # Lost the seed race: the map now exists, so the plain nested increment works.
    try:
        _table.update_item(
            Key={"username": username},
            UpdateExpression="SET #m.#t = if_not_exists(#m.#t, :z) + :one",
            ExpressionAttributeNames={"#m": tattr, "#t": tool},
            ExpressionAttributeValues={":z": 0, ":one": 1},
        )
    except ClientError:
        pass


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


def do_admin_refresh(body: dict) -> dict:
    """Swap an admin token for a fresh one, with no Google round-trip.

    This is the piece that was missing. A Google id_token lives ~1h, so once the
    admin token expired there was no way back except an interactive sign-in — which
    is why the tools kept saying "Please sign in again".

    Deliberately accepts an EXPIRED token, within ADMIN_SESSION_MAX of the original
    sign-in. Refusing expired ones would mean anyone who didn't open the app for a
    month had to re-auth anyway, which is the whole problem. What still bounds it:
      * the HMAC must verify — this is not a free pass, it's proof we minted it
      * iat is carried over, so the 90-day cap is measured from the real sign-in
      * ADMIN_EMAILS is re-checked here, so a revoked admin cannot refresh at all
    """
    tok = (body.get("token") or "").strip()
    got = _parse_admin_token(tok)
    if not got:
        return _resp(401, {"success": False, "message": "Not a valid session.", "reauth": True})
    email, iat, _exp = got
    if email.lower() not in ADMIN_EMAILS:
        return _resp(403, {"success": False, "message": "Not an authorised admin.", "reauth": True})
    if int(time.time()) - iat > ADMIN_SESSION_MAX:
        return _resp(401, {"success": False, "reauth": True,
                           "message": "It's been 90 days — please sign in with Google again."})
    fresh = make_admin_token(email, iat=iat)
    print(f"[ADMIN] refreshed session for {email}")
    return _resp(200, {"success": True, "email": email, **fresh})


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
        # The bot has stood down and a human owns this chat. Set by whatsappBot on
        # escalation and on any staff reply; cleared by a human from index.html.
        "bot_paused": bool(item.get("bot_paused")),
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
    # Label each conversation with who it is. Joined here, once, rather than making
    # the page fire a lookup per row.
    directory = _client_map()
    for r in rows:
        c = directory.get(r["wa_id"]) or {}
        r["client_name"] = c.get("name") or ""
        r["client_company"] = c.get("company") or ""
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
    try:
        c = (_client_table.get_item(Key={"wa_id": wa_id}) or {}).get("Item") or {}
    except ClientError as e:
        print("client lookup failed:", repr(e))
        c = {}          # unlabelled beats failing the transcript read
    return _resp(200, {
        "success": True,
        "wa_id": item.get("wa_id"),
        "client_name": c.get("name") or "",
        "client_company": c.get("company") or "",
        "last_ts": int(item.get("last_user_ts") or 0),
        # Deliberately NOT returned any more: conversations are kept (TTL disabled on the
        # table 2026-07-16). Old items still carry a stale `ttl` from when they were
        # written, and surfacing it would tell staff a conversation expires on a date it
        # no longer will.
        "bot_paused": bool(item.get("bot_paused")),
        "paused_by": item.get("paused_by") or "",
        "paused_at": int(item.get("paused_at") or 0),
        "turns": [
            {
                "role": t.get("role"),          # user | assistant (bot) | agent (human)
                "text": t.get("text") or "",
                "ts": int(t.get("ts") or 0),
                "agent": t.get("agent") or "",  # who sent it, when role == 'agent'
            }
            for t in (item.get("turns") or [])
        ],
    })


def _client_map():
    """{wa_id: {name, company}} for every directory entry.

    A full Scan, deliberately: this table is one row per client phone number — tens,
    maybe hundreds. Scanning it once and joining in memory costs less than a GetItem
    per conversation, and the caller already holds the whole conversation list.
    Returns {} on failure — an unlabelled list is a far better outcome than a 500
    on the tool staff use to read escalations.
    """
    out = {}
    try:
        kwargs = {}
        while True:
            res = _client_table.scan(**kwargs)
            for i in res.get("Items", []):
                out[i.get("wa_id")] = {
                    "name": i.get("name") or "",
                    "company": i.get("company") or "",
                }
            key = res.get("LastEvaluatedKey")
            if not key:
                break
            kwargs["ExclusiveStartKey"] = key
    except ClientError as e:
        print("client directory scan failed:", repr(e))
        return {}
    return out


def do_clients_list(body):
    who = _require_platform_user(body)
    if not who:
        return _resp(401, {"success": False, "message": "Not authorised."})
    try:
        rows, kwargs = [], {}
        while True:
            res = _client_table.scan(**kwargs)
            rows.extend(res.get("Items", []))
            key = res.get("LastEvaluatedKey")
            if not key:
                break
            kwargs["ExclusiveStartKey"] = key
    except ClientError as e:
        print("client list failed:", repr(e))
        return _resp(500, {"success": False, "message": "Could not read the client directory."})
    rows.sort(key=lambda r: (r.get("company") or "").lower())
    return _resp(200, {"success": True, "clients": [_client_row(r) for r in rows]})


def _client_row(r: dict) -> dict:
    out = {
        "wa_id": r.get("wa_id"),
        "name": r.get("name") or "",
        "company": r.get("company") or "",
        "notes": r.get("notes") or "",
        # Tier 2 gate. Default off, and OFF IS THE ONLY SAFE DEFAULT: this decides
        # whether the bot may ever discuss this client's account with whoever holds
        # this SIM. Nothing reads it yet — the bot still escalates every
        # account-specific question — but it is stored per number from the start so
        # the switch is a deliberate act per client, never a global flip.
        "account_data_enabled": bool(r.get("account_data_enabled")),
        "verified_by": r.get("verified_by") or "",
        "verified_at": int(r.get("verified_at") or 0),
        "updated_at": int(r.get("updated_at") or 0),
        "updated_by": r.get("updated_by") or "",
    }
    for f in ASSET_FIELDS:
        out[f + "_id"] = r.get(f + "_id") or ""
        out[f + "_name"] = r.get(f + "_name") or ""
    return out


def do_clients_upsert(body):
    who = _require_platform_user(body)
    if not who:
        return _resp(401, {"success": False, "message": "Not authorised."})

    wa_id = _norm_phone(body.get("wa_id"))
    if not wa_id:
        return _resp(400, {"success": False, "message":
                           "That doesn't look like a phone number with a country code. "
                           "Singapore mobiles start 65 — e.g. 6591234567."})
    name = (body.get("name") or "").strip()[:MAX_CLIENT_FIELD]
    company = (body.get("company") or "").strip()[:MAX_CLIENT_FIELD]
    notes = (body.get("notes") or "").strip()[:MAX_CLIENT_FIELD * 4]
    if not name and not company:
        return _resp(400, {"success": False, "message": "Give the number a name or a company."})

    # If the caller renamed the number (edited the key), drop the old row — otherwise
    # the directory keeps a stale entry that still claims that number.
    old = _norm_phone(body.get("old_wa_id"))
    now = int(time.time())

    item = {
        "wa_id": wa_id, "name": name, "company": company, "notes": notes,
        "updated_at": now, "updated_by": who,
    }
    for f in ASSET_FIELDS:
        item[f + "_id"] = (body.get(f + "_id") or "").strip()[:MAX_CLIENT_FIELD]
        item[f + "_name"] = (body.get(f + "_name") or "").strip()[:MAX_CLIENT_FIELD]

    # Turning account access ON is a named act by a named person, and re-stamped on
    # every save so the record shows who most recently vouched for this number —
    # not whoever first created the row months ago.
    enabled = bool(body.get("account_data_enabled"))
    item["account_data_enabled"] = enabled
    if enabled:
        item["verified_by"] = who
        item["verified_at"] = now
    else:
        item["verified_by"] = ""
        item["verified_at"] = 0

    try:
        _client_table.put_item(Item=item)
        if old and old != wa_id:
            _client_table.delete_item(Key={"wa_id": old})
    except ClientError as e:
        print("client upsert failed:", repr(e))
        return _resp(500, {"success": False, "message": "Could not save this client."})

    # Loud, and separately from the rest: this one decides whether a client's account
    # data may leave over WhatsApp.
    _wa_audit(who, "client_save", wa_id)
    if enabled:
        _wa_audit(who, "client_account_access_ON", wa_id)
    return _resp(200, {"success": True, "wa_id": wa_id, "updated_at": now, "updated_by": who})


def do_clients_delete(body):
    who = _require_platform_user(body)
    if not who:
        return _resp(401, {"success": False, "message": "Not authorised."})
    wa_id = _norm_phone(body.get("wa_id"))
    if not wa_id:
        return _resp(400, {"success": False, "message": "wa_id required."})
    try:
        _client_table.delete_item(Key={"wa_id": wa_id})
    except ClientError as e:
        print("client delete failed:", repr(e))
        return _resp(500, {"success": False, "message": "Could not remove this client."})
    _wa_audit(who, "client_delete", wa_id)
    return _resp(200, {"success": True})


def _invoke_bot(payload: dict):
    """Synchronously invoke whatsappBot. Returns its dict, or None if the call
    itself failed.

    Synchronous on purpose: the caller is a person watching a spinner after
    pressing Send. An async invoke would return 202 and they'd never learn that
    Graph rejected the message.
    """
    try:
        res = _lambda.invoke(
            FunctionName=WA_BOT_FUNCTION,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode(),
        )
        # A handler exception surfaces here, not as a boto error.
        if res.get("FunctionError"):
            print("bot invoke returned FunctionError:", res["FunctionError"])
            return None
        return json.loads(res["Payload"].read().decode() or "{}")
    except Exception as e:
        print("bot invoke failed:", repr(e))
        return None


def do_wa_get_prompt(body):
    """Current prompt blocks + their defaults, history and the fixed guardrails.

    The defaults and the non-editable contract come from whatsappBot itself (which
    also seeds the table on first call), so there is exactly one copy of that text
    in the repo. Everything else — who edited, when, and the revert history — is
    this table's job.
    """
    who = _require_platform_user(body)
    if not who:
        return _resp(401, {"success": False, "message": "Not authorised."})

    info = _invoke_bot({"action": "wa_prompt_info"}) or {}
    if not info.get("ok"):
        return _resp(502, {"success": False,
                           "message": "Could not reach the WhatsApp bot to load the prompt."})

    out = {}
    for key in EDITABLE_PROMPT_KEYS:
        try:
            item = (_prompt_table.get_item(Key={"prompt_id": key}) or {}).get("Item") or {}
        except ClientError as e:
            print("prompt read failed:", repr(e))
            return _resp(500, {"success": False, "message": "Could not read the saved prompt."})
        default_text = (info.get("defaults") or {}).get(key, "")
        text = (item.get("text") or "").strip() or default_text
        out[key] = {
            "text": text,
            "default_text": default_text,
            "is_default": text.strip() == default_text.strip(),
            "updated_at": int(item.get("updated_at") or 0),
            "updated_by": item.get("updated_by") or "",
            "history": [
                {
                    "text": h.get("text") or "",
                    "updated_at": int(h.get("updated_at") or 0),
                    "updated_by": h.get("updated_by") or "",
                }
                for h in (item.get("history") or [])[:MAX_PROMPT_HISTORY]
            ],
        }

    _wa_audit(who, "prompt_view")
    return _resp(200, {
        "success": True,
        "prompts": out,
        "fixed_contract": info.get("fixed_contract") or "",
        "composed": info.get("composed") or "",
        "max_chars": MAX_PROMPT_CHARS,
    })


def do_wa_save_prompt(body):
    who = _require_platform_user(body)
    if not who:
        return _resp(401, {"success": False, "message": "Not authorised."})

    key = (body.get("key") or "").strip()
    if key not in EDITABLE_PROMPT_KEYS:
        # Never let an arbitrary key through: the guardrail split only holds
        # because the bot reads these two and composes the rest itself.
        return _resp(400, {"success": False, "message": "Unknown prompt block."})

    text = (body.get("text") or "").strip()
    if not text:
        return _resp(400, {"success": False,
                           "message": "The prompt cannot be empty. Use Restore default instead."})
    if len(text) > MAX_PROMPT_CHARS:
        return _resp(400, {"success": False,
                           "message": f"Too long — {len(text)} characters, limit {MAX_PROMPT_CHARS}."})

    try:
        item = (_prompt_table.get_item(Key={"prompt_id": key}) or {}).get("Item") or {}
    except ClientError as e:
        print("prompt read-before-save failed:", repr(e))
        return _resp(500, {"success": False, "message": "Could not save the prompt."})

    if not item:
        # whatsappBot seeds on wa_prompt_info, which the editor calls on open. No
        # item here means the bot could not write, so default_text would be lost
        # and Restore default would have nothing to restore.
        return _resp(409, {"success": False,
                           "message": "The prompt has not been initialised yet. Reopen the tool and try again."})

    now = int(time.time())
    prev = (item.get("text") or "").strip()
    history = list(item.get("history") or [])
    if prev and prev != text:
        history.insert(0, {"text": prev,
                           "updated_at": int(item.get("updated_at") or 0),
                           "updated_by": item.get("updated_by") or ""})
    history = history[:MAX_PROMPT_HISTORY]

    try:
        # Read-modify-write on history. Two staff saving the same block within the
        # same second can cost one history entry; the live text is still last-write-
        # wins and correct. Not worth a version column for a handful of editors.
        _prompt_table.put_item(Item={
            "prompt_id": key,
            "text": text,
            "default_text": item.get("default_text") or "",
            "updated_at": now,
            "updated_by": who,
            "history": history,
        })
    except ClientError as e:
        print("prompt save failed:", repr(e))
        return _resp(500, {"success": False, "message": "Could not save the prompt."})

    # Loud on purpose: this changes what a public bot says to clients.
    _wa_audit(who, f"prompt_save:{key}:{len(text)}chars")
    return _resp(200, {"success": True, "updated_at": now, "updated_by": who})


def do_wa_send_message(body):
    """Staff reply. The actual send + turn write happen in whatsappBot."""
    who = _require_platform_user(body)
    if not who:
        return _resp(401, {"success": False, "message": "Not authorised."})
    wa_id = (body.get("wa_id") or "").strip()
    text = (body.get("text") or "").strip()
    if not wa_id or not text:
        return _resp(400, {"success": False, "message": "wa_id and text are required."})

    _wa_audit(who, "reply", wa_id)
    res = _invoke_bot({"action": "wa_agent_send", "wa_id": wa_id, "text": text, "agent": who})
    if res is None:
        return _resp(502, {"success": False, "message": "Could not reach the WhatsApp bot."})
    if not res.get("ok"):
        # 409 for the 24h service window so the UI can special-case it; the client
        # has simply gone quiet too long and no retry will fix it.
        status = 409 if res.get("outside_window") else 400
        return _resp(status, {"success": False,
                              "message": res.get("error") or "The message was not sent.",
                              "outside_window": bool(res.get("outside_window"))})
    return _resp(200, {"success": True})


def do_wa_set_paused(body):
    """Hand a conversation to a human, or hand it back to the bot."""
    who = _require_platform_user(body)
    if not who:
        return _resp(401, {"success": False, "message": "Not authorised."})
    wa_id = (body.get("wa_id") or "").strip()
    if not wa_id:
        return _resp(400, {"success": False, "message": "wa_id is required."})
    paused = bool(body.get("paused"))

    _wa_audit(who, f"pause:{paused}", wa_id)
    res = _invoke_bot({"action": "wa_set_paused", "wa_id": wa_id,
                       "paused": paused, "agent": who})
    if res is None:
        return _resp(502, {"success": False, "message": "Could not reach the WhatsApp bot."})
    if not res.get("ok"):
        return _resp(400, {"success": False,
                           "message": res.get("error") or "Could not update this conversation."})
    return _resp(200, {"success": True, "paused": paused})


ACTIONS = {
    "login": do_login,
    "usage_status": do_usage_status,
    "record_usage": do_record_usage,
    "admin_session": do_admin_session,
    "admin_refresh": do_admin_refresh,
    "admin_list": do_admin_list,
    "admin_create": do_admin_create,
    "admin_update": do_admin_update,
    "admin_reset": do_admin_reset,
    "admin_delete": do_admin_delete,
    "wa_list_conversations": do_wa_list_conversations,
    "wa_get_conversation": do_wa_get_conversation,
    "wa_get_prompt": do_wa_get_prompt,
    "wa_save_prompt": do_wa_save_prompt,
    "wa_send_message": do_wa_send_message,
    "wa_set_paused": do_wa_set_paused,
    "clients_list": do_clients_list,
    "clients_upsert": do_clients_upsert,
    "clients_delete": do_clients_delete,
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
