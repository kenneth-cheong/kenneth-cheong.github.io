#!/usr/bin/env node
// One-shot: populate the `emailLower` attribute on every existing user so the
// new emailIndex GSI can find them. Without this, accounts created before the
// email/password feature (e.g. existing Google users) are invisible to lookups,
// which would let a password signup create a DUPLICATE account for the same
// address instead of linking onto the Google one.
//
//   USERS_TABLE=digimetrics-saas-UsersTable-XXXX AWS_REGION=ap-southeast-1 \
//     node scripts/backfill-email-index.mjs
//
// Run once, AFTER the CloudFormation change-set that adds the GSI executes.
// Idempotent: only writes rows whose emailLower is missing or stale.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.USERS_TABLE;
if (!TABLE) { console.error('Set USERS_TABLE (and AWS_REGION).'); process.exit(1); }

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

let scanned = 0, updated = 0, ExclusiveStartKey;
do {
  const res = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey }));
  for (const u of res.Items || []) {
    scanned++;
    if (!u.email) continue;                                   // provision stubs may lack it
    const emailLower = String(u.email).trim().toLowerCase();
    if (u.emailLower === emailLower) continue;                // already correct
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { userId: u.userId },
      UpdateExpression: 'SET emailLower = :e',
      ExpressionAttributeValues: { ':e': emailLower },
    }));
    updated++;
    console.log(`  ${u.userId} -> ${emailLower}`);
  }
  ExclusiveStartKey = res.LastEvaluatedKey;
} while (ExclusiveStartKey);

console.log(`✅ backfill complete — scanned ${scanned}, updated ${updated}`);
