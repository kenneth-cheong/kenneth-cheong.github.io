"""
recruitmentEmailDispatcher — EventBridge-cron worker that delivers due emails by
sending them from each recruiter's OWN Gmail mailbox via the Gmail API.

Runs on a schedule (rate(5 minutes)). For each pending row whose sendAt has
passed, it looks up the recruiter's stored refresh token (recruitmentGmailTokens,
populated by recruitmentGmailAuth), mints a short-lived access token, and calls
the Gmail API to send the message. Because the send goes through the recruiter's
own account, it appears in their Gmail "Sent" folder and is a genuine first-party
send. Each row is marked 'sent' or 'failed' so it is never double-sent.

No external dependencies — uses urllib + stdlib email only.
"""
import os
import json
import base64
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone
from email.mime.text import MIMEText

import boto3
from boto3.dynamodb.conditions import Key

TABLE_NAME = os.environ.get("TABLE_NAME", "recruitmentScheduledEmails")
TOKENS_TABLE = os.environ.get("TOKENS_TABLE", "recruitmentGmailTokens")
CLIENT_ID = os.environ["GMAIL_CLIENT_ID"]
CLIENT_SECRET = os.environ["GMAIL_CLIENT_SECRET"]

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)
tokens = dynamodb.Table(TOKENS_TABLE)


def _access_token(refresh_token):
    data = urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())["access_token"]


def _gmail_send(access_token, sender, to, subject, body):
    msg = MIMEText(body, _charset="utf-8")
    msg["to"] = to
    msg["from"] = sender
    msg["subject"] = subject
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    payload = json.dumps({"raw": raw}).encode()
    req = urllib.request.Request(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        data=payload,
        method="POST",
        headers={"Authorization": "Bearer " + access_token, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def handler(event, context):
    now = datetime.now(timezone.utc).isoformat()
    res = table.query(
        IndexName="status-sendAt-index",
        KeyConditionExpression=Key("status").eq("pending") & Key("sendAt").lte(now),
    )
    items = res.get("Items", [])
    sent, failed = 0, 0
    access_cache = {}  # senderEmail -> access_token (one refresh per run per sender)

    for it in items:
        sender = (it.get("senderEmail") or "").strip().lower()
        try:
            if sender not in access_cache:
                tok = tokens.get_item(Key={"senderEmail": sender}).get("Item")
                if not tok or not tok.get("refreshToken"):
                    raise RuntimeError(f"{sender} has not authorized Gmail sending")
                access_cache[sender] = _access_token(tok["refreshToken"])
            _gmail_send(access_cache[sender], it["senderEmail"], it["to"], it["subject"], it["body"])
            table.update_item(
                Key={"id": it["id"]},
                UpdateExpression="SET #s = :s, sentAt = :t",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":s": "sent", ":t": now},
            )
            sent += 1
        except urllib.error.HTTPError as e:
            _mark_failed(it["id"], e.read().decode()[:500])
            failed += 1
        except Exception as e:  # noqa: BLE001
            _mark_failed(it["id"], str(e)[:500])
            failed += 1

    print(f"dispatcher checked={len(items)} sent={sent} failed={failed}")
    return {"checked": len(items), "sent": sent, "failed": failed}


def _mark_failed(row_id, message):
    table.update_item(
        Key={"id": row_id},
        UpdateExpression="SET #s = :s, lastError = :e",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "failed", ":e": message},
    )
