# socialMediaAudit — deploy

Async Social Media Audit backend. Region: `ap-southeast-1`, account `167633412846`.

## DEPLOYED (2026-06-15) — live resources
- **Lambda:** `socialMediaAudit` (python3.13, timeout 180, mem 256), role `socialMediaAudit-role` (AWSLambdaBasicExecutionRole + inline `sma-dynamodb`). Env: `APIFY_TOKEN`, `CLAUDE_API_KEY`.
- **DynamoDB:** `sma_jobs` (PK jobId, TTL on `ttl`), `sma_snapshots` (PK brand_platform, SK ts).
- **Endpoint:** REST API `vceg7jm8w0`, stage `socialMediaAudit`, root resource POST+OPTIONS → AWS_PROXY →
  `https://vceg7jm8w0.execute-api.ap-southeast-1.amazonaws.com/socialMediaAudit`
- **NOTE:** Lambda Function URLs are blocked at the account level (returned `Forbidden` even with a correct
  resource policy + AuthType NONE) — that's why this uses a REST API, matching the rest of the project.
- Verified end-to-end with `{handles:{instagram:"nike"}}` → real 292M-follower scorecard.

Re-deploy code: `update-function-code --function-name socialMediaAudit --zip-file fileb://socialMediaAudit.zip --region ap-southeast-1`

---
The generic steps below are kept for reference / rebuilding from scratch.

## 0. Prereqs
- An **Apify** account + API token (apify.com → Settings → Integrations → Personal API tokens).
- On Apify, make sure you've "tried"/subscribed to the actors referenced in `ACTORS`
  (lambda_function.py top). Swap any slug there for one you prefer.

## 1. DynamoDB tables
```bash
aws dynamodb create-table --region ap-southeast-1 \
  --table-name sma_jobs \
  --attribute-definitions AttributeName=jobId,AttributeType=S \
  --key-schema AttributeName=jobId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
aws dynamodb update-time-to-live --region ap-southeast-1 \
  --table-name sma_jobs --time-to-live-specification "Enabled=true,AttributeName=ttl"

aws dynamodb create-table --region ap-southeast-1 \
  --table-name sma_snapshots \
  --attribute-definitions AttributeName=brand_platform,AttributeType=S AttributeName=ts,AttributeType=N \
  --key-schema AttributeName=brand_platform,KeyType=HASH AttributeName=ts,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

## 2. Package + create the function
`requests` isn't in the Lambda runtime — bundle it.
```bash
cd lambdas/socialMediaAudit
pip install requests -t package
cp lambda_function.py package/
(cd package && zip -r ../socialMediaAudit.zip .)

aws lambda create-function --region ap-southeast-1 \
  --function-name socialMediaAudit \
  --runtime python3.12 --handler lambda_function.lambda_handler \
  --timeout 60 --memory-size 256 \
  --role arn:aws:iam::167633412846:role/<your-lambda-exec-role> \
  --zip-file fileb://socialMediaAudit.zip
```
Re-deploy after edits: `aws lambda update-function-code --function-name socialMediaAudit --zip-file fileb://socialMediaAudit.zip --region ap-southeast-1`

## 3. Env vars
```bash
aws lambda update-function-configuration --region ap-southeast-1 \
  --function-name socialMediaAudit \
  --environment "Variables={APIFY_TOKEN=apify_api_xxx,ANTHROPIC_API_KEY=sk-ant-xxx}"
```

## 4. IAM
The exec role needs `dynamodb:PutItem/GetItem/Query` on `sma_jobs` + `sma_snapshots`
(plus the usual CloudWatch Logs perms).

## 5. HTTP API route
Add a `POST /socialMediaAudit` route on an HTTP API (reuse an existing one, e.g.
`8domnt5y2f`), integrate to this function, enable CORS, then
`aws lambda add-permission` for `apigateway.amazonaws.com` to invoke it.
Set the resulting URL as `SMA_ENDPOINT` in index.html.

## Contract
- `POST {action:"start", brand_name, domain, handles:{instagram,tiktok,facebook,linkedin,youtube},
   platforms:[...], competitors:[{platform,handle,name}]}` → `{jobId, platforms}`
- `POST {action:"poll", jobId}` → `{status:"running", progress}` or `{status:"done", scorecard}`

The frontend polls every ~6s until `done`.
