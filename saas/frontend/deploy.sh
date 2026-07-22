#!/usr/bin/env bash
# One-command publish to the live Amplify app (manual-deploy hosting).
#
#   ./deploy.sh           # build + deploy
#   npm run deploy        # same, via package.json
#
# Builds the production bundle (uses .env.production), zips dist/, and pushes it
# to the existing Amplify app — no Git connection / new URL needed.
set -euo pipefail

APP_ID="d1q0hza133u0y9"
BRANCH="main"
REGION="ap-southeast-1"
URL="https://${BRANCH}.${APP_ID}.amplifyapp.com"

cd "$(dirname "$0")"

# ── Ensure a modern Node (Vite needs >=18; system default here is v10) ────────
node_major() { node -v 2>/dev/null | sed -E 's/v([0-9]+).*/\1/'; }
if [ "$(node_major || echo 0)" -lt 18 ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"; nvm use 20 >/dev/null 2>&1 || nvm use 18 >/dev/null 2>&1 || true
fi
if [ "$(node_major || echo 0)" -lt 18 ]; then
  echo "✗ Node >=18 required (found $(node -v 2>/dev/null || echo none)). Install/activate Node 20 and retry." >&2
  exit 1
fi
echo "▸ Node $(node -v)"

# ── Build + verify the real API base is baked in ──────────────────────────────
echo "▸ Building…"
npm run build
grep -rq "api.digimetrics.ai" dist/assets/*.js || { echo "✗ Build looks wrong — no API base in bundle." >&2; exit 1; }

# ── Zip dist contents (index.html at the zip root) ────────────────────────────
echo "▸ Packaging…"
rm -f deploy.zip
( cd dist && zip -rq ../deploy.zip . )

# ── Create deployment → upload → start ────────────────────────────────────────
echo "▸ Creating Amplify deployment…"
read -r JOB UPLOAD < <(aws amplify create-deployment \
  --app-id "$APP_ID" --branch-name "$BRANCH" --region "$REGION" \
  --query '[jobId, zipUploadUrl]' --output text)
echo "  jobId=$JOB"

echo "▸ Uploading bundle…"
curl -fsS -X PUT -H "Content-Type: application/zip" --upload-file deploy.zip "$UPLOAD" >/dev/null

echo "▸ Starting deployment…"
aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB" --region "$REGION" >/dev/null

# ── Poll to completion ────────────────────────────────────────────────────────
echo -n "▸ Waiting"
for _ in $(seq 1 40); do
  ST=$(aws amplify get-job --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB" --region "$REGION" \
    --query 'job.summary.status' --output text 2>/dev/null || echo PENDING)
  case "$ST" in
    SUCCEED) echo; echo "✓ Deployed → $URL"; rm -f deploy.zip; exit 0;;
    FAILED|CANCELLED) echo; echo "✗ Deployment $ST (job $JOB)" >&2; rm -f deploy.zip; exit 1;;
  esac
  echo -n "."; sleep 5
done
echo; echo "✗ Timed out waiting for job $JOB (it may still finish)." >&2
exit 1
