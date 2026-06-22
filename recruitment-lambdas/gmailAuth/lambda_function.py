"""
recruitmentGmailAuth — OAuth token broker for "send from the recruiter's own Gmail".

The recruitment front-end runs Google's auth-code flow (popup) and POSTs the
one-time code here. We exchange it for a long-lived refresh token and store it
per recruiter in DynamoDB. The recruitmentEmailDispatcher later uses that refresh
token to mint access tokens and send via the Gmail API as that recruiter.

Actions (JSON body):
  {"action":"exchange","senderEmail","code"}   -> store refresh token
  {"action":"status","senderEmail"}            -> {authorized: bool}
  {"action":"revoke","senderEmail"}            -> forget + revoke at Google

No external dependencies — uses urllib + stdlib only.
"""
import json
import os
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone

import boto3

CLIENT_ID = os.environ["GMAIL_CLIENT_ID"]
CLIENT_SECRET = os.environ["GMAIL_CLIENT_SECRET"]
TOKENS_TABLE = os.environ.get("TOKENS_TABLE", "recruitmentGmailTokens")
# 'postmessage' is the redirect_uri Google expects for popup (initCodeClient) flows.
REDIRECT_URI = os.environ.get("REDIRECT_URI", "postmessage")

tokens = boto3.resource("dynamodb").Table(TOKENS_TABLE)

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Content-Type": "application/json",
}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _resp(code, body):
    return {"statusCode": code, "headers": CORS, "body": json.dumps(body, default=str)}


def _post_form(url, params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def handler(event, context):
    method = (
        (event.get("requestContext", {}).get("http", {}) or {}).get("method")
        or event.get("httpMethod")
    )
    if method == "OPTIONS":
        return _resp(200, {"ok": True})

    try:
        data = json.loads(event.get("body") or "{}")
    except Exception:
        return _resp(400, {"authorized": False, "message": "Invalid JSON body"})

    action = data.get("action")
    sender = (data.get("senderEmail") or "").strip().lower()
    if not sender:
        return _resp(400, {"authorized": False, "message": "Missing senderEmail"})

    if action == "exchange":
        code = data.get("code")
        if not code:
            return _resp(400, {"authorized": False, "message": "Missing code"})
        try:
            tok = _post_form(
                "https://oauth2.googleapis.com/token",
                {
                    "code": code,
                    "client_id": CLIENT_ID,
                    "client_secret": CLIENT_SECRET,
                    "redirect_uri": REDIRECT_URI,
                    "grant_type": "authorization_code",
                },
            )
        except urllib.error.HTTPError as e:
            return _resp(200, {"authorized": False, "message": e.read().decode()[:300]})

        refresh = tok.get("refresh_token")
        if not refresh:
            # Google only returns a refresh token on the *first* consent. If the user
            # has authorized before, they must revoke (Disconnect) and re-consent.
            return _resp(200, {
                "authorized": False,
                "message": "No refresh token returned — Disconnect and authorize again to force a fresh consent.",
            })

        tokens.put_item(Item={"senderEmail": sender, "refreshToken": refresh, "updatedAt": _now()})
        return _resp(200, {"authorized": True})

    if action == "status":
        it = tokens.get_item(Key={"senderEmail": sender}).get("Item")
        return _resp(200, {"authorized": bool(it and it.get("refreshToken"))})

    if action == "revoke":
        it = tokens.get_item(Key={"senderEmail": sender}).get("Item")
        if it and it.get("refreshToken"):
            try:
                _post_form("https://oauth2.googleapis.com/revoke", {"token": it["refreshToken"]})
            except Exception:
                pass
        tokens.delete_item(Key={"senderEmail": sender})
        return _resp(200, {"authorized": False})

    return _resp(400, {"authorized": False, "message": f"Unknown action: {action}"})
