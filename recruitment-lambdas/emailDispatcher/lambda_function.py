"""
recruitmentEmailDispatcher — EventBridge-cron worker that delivers due emails.

Runs on a schedule (rate(5 minutes)). Queries the recruitmentScheduledEmails
table for rows whose status is 'pending' and whose sendAt has passed, then sends
each via Amazon SES with the recruiter's address as Reply-To. Each row is marked
'sent' or 'failed' so it is never double-sent.

Sender (Source) must be an SES-verified identity. While the mediaone.co domain is
re-verified, FROM_ADDR defaults to the verified kenneth@mediaone.co mailbox.
"""
import os
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

TABLE_NAME = os.environ.get("TABLE_NAME", "recruitmentScheduledEmails")
FROM_ADDR = os.environ.get("FROM_ADDR", "MediaOne Recruitment <kenneth@mediaone.co>")

table = boto3.resource("dynamodb").Table(TABLE_NAME)
ses = boto3.client("ses", region_name=os.environ.get("SES_REGION", "ap-southeast-1"))


def handler(event, context):
    now = datetime.now(timezone.utc).isoformat()
    res = table.query(
        IndexName="status-sendAt-index",
        KeyConditionExpression=Key("status").eq("pending") & Key("sendAt").lte(now),
    )
    items = res.get("Items", [])
    sent, failed = 0, 0

    for it in items:
        try:
            ses.send_email(
                Source=FROM_ADDR,
                Destination={"ToAddresses": [it["to"]]},
                Message={
                    "Subject": {"Data": it["subject"], "Charset": "UTF-8"},
                    "Body": {"Text": {"Data": it["body"], "Charset": "UTF-8"}},
                },
                ReplyToAddresses=[it["senderEmail"]],
            )
            table.update_item(
                Key={"id": it["id"]},
                UpdateExpression="SET #s = :s, sentAt = :t",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":s": "sent", ":t": now},
            )
            sent += 1
        except Exception as e:  # noqa: BLE001 - record and continue
            table.update_item(
                Key={"id": it["id"]},
                UpdateExpression="SET #s = :s, lastError = :e",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":s": "failed", ":e": str(e)[:500]},
            )
            failed += 1

    print(f"dispatcher checked={len(items)} sent={sent} failed={failed}")
    return {"checked": len(items), "sent": sent, "failed": failed}
