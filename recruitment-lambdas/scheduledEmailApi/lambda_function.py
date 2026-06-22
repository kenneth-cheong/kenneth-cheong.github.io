"""
recruitmentScheduledEmail — API handler for scheduling "send on behalf" emails.

The recruitment front-end (recruitment.html) POSTs JSON here to schedule, list,
or cancel a delayed interview-invitation email. Rows live in DynamoDB and are
later delivered by the recruitmentEmailDispatcher Lambda (EventBridge cron).

Actions (JSON body):
  {"action":"schedule","senderEmail","to","subject","body","sendAt"(ISO8601),"candidateId"?}
  {"action":"list","senderEmail"?}
  {"action":"cancel","id"}
"""
import json
import os
import uuid
import base64
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

TABLE_NAME = os.environ.get("TABLE_NAME", "recruitmentScheduledEmails")
table = boto3.resource("dynamodb").Table(TABLE_NAME)

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Content-Type": "application/json",
}


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _resp(code, body):
    return {"statusCode": code, "headers": CORS, "body": json.dumps(body, default=str)}


def handler(event, context):
    # Works behind both HTTP API (v2) and REST API (v1) shapes.
    method = (
        (event.get("requestContext", {}).get("http", {}) or {}).get("method")
        or event.get("httpMethod")
    )
    if method == "OPTIONS":
        return _resp(200, {"ok": True})

    try:
        raw = event.get("body") or "{}"
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode()
        data = json.loads(raw)
    except Exception:
        return _resp(400, {"success": False, "message": "Invalid JSON body"})

    action = data.get("action")

    if action == "schedule":
        for field in ("senderEmail", "to", "subject", "body", "sendAt"):
            if not data.get(field):
                return _resp(400, {"success": False, "message": f"Missing field: {field}"})
        item = {
            "id": str(uuid.uuid4()),
            "senderEmail": data["senderEmail"],
            "to": data["to"],
            "subject": data["subject"],
            "body": data["body"],
            "sendAt": data["sendAt"],          # ISO8601 UTC; dispatcher compares lexically
            "status": "pending",
            "candidateId": str(data.get("candidateId", "")),
            "createdAt": _now_iso(),
        }
        table.put_item(Item=item)
        return _resp(200, {"success": True, "id": item["id"]})

    if action == "list":
        sender = data.get("senderEmail")
        res = table.query(
            IndexName="status-sendAt-index",
            KeyConditionExpression=Key("status").eq("pending"),
        )
        items = [i for i in res.get("Items", []) if (not sender or i.get("senderEmail") == sender)]
        items.sort(key=lambda i: i.get("sendAt", ""))
        return _resp(200, {"success": True, "items": items})

    if action == "cancel":
        eid = data.get("id")
        if not eid:
            return _resp(400, {"success": False, "message": "Missing id"})
        table.delete_item(Key={"id": eid})
        return _resp(200, {"success": True})

    return _resp(400, {"success": False, "message": f"Unknown action: {action}"})
