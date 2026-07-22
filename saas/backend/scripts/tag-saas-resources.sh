#!/usr/bin/env bash
# Tag every SaaS-owned AWS resource with `product=saas` so Admin → Finances can
# scope its Cost Explorer query to the SaaS product.
#
# WHY: the ~160 internal tool Lambdas behind index.html / chatbot.html live in the
# SAME account and the SAME region as the SaaS stack, so neither the REGION nor the
# SERVICE dimension can separate them. Resource-level cost data isn't enabled, so a
# cost-allocation tag is the only lever that splits the bill by product.
#
# WHAT IT TAGS
#   • every taggable resource in the `digimetrics-saas` CloudFormation stack
#     (found via its auto-applied aws:cloudformation:stack-name tag)
#   • the Amplify app that serves the SaaS front end — NOT part of the stack, so it
#     would otherwise be missed even though it is unambiguously SaaS cost
#
# IDEMPOTENT: re-running just re-applies the same tag.
#
# AFTER RUNNING: activate the tag once, in Billing → Cost allocation tags (or with
# `aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=product,Status=Active`).
# AWS starts recording the tag against cost data from the activation date and NEVER
# backfills, so windows that start before then have no tagged cost — the Finances
# panel detects that and falls back to the whole-account figure with a warning.
#
# Deploys re-apply stack tags from the change-set's `--tags`, so keep
# `--tags Key=product,Value=saas` on the create-change-set call (see DEPLOY.md).
set -euo pipefail

STACK=${STACK:-digimetrics-saas}
REGION=${REGION:-ap-southeast-1}
AMPLIFY_APP=${AMPLIFY_APP:-d1q0hza133u0y9}
TAG_KEY=${TAG_KEY:-product}
TAG_VALUE=${TAG_VALUE:-saas}

echo "Finding taggable resources in stack $STACK ($REGION)…"
# Plain word-splitting rather than `mapfile` — macOS ships bash 3.2, which lacks it.
# ARNs never contain whitespace, so splitting on it is safe.
ARNS=($(
  aws resourcegroupstaggingapi get-resources \
    --region "$REGION" \
    --tag-filters "Key=aws:cloudformation:stack-name,Values=$STACK" \
    --query 'ResourceTagMappingList[].ResourceARN' --output text
))
echo "  ${#ARNS[@]} resources"

# tag-resources caps at 20 ARNs per call.
for ((i = 0; i < ${#ARNS[@]}; i += 20)); do
  aws resourcegroupstaggingapi tag-resources \
    --region "$REGION" \
    --resource-arn-list "${ARNS[@]:i:20}" \
    --tags "$TAG_KEY=$TAG_VALUE" \
    --query 'FailedResourcesMap' --output json
done

# The generic tagging API rejects the HTTP API *stage* ARN ("Invalid ARN specified")
# — it only understands the API itself. The stage has to go through apigatewayv2.
API_ID=${API_ID:-h07tay1xvi}
echo "Tagging API Gateway stage \$default on $API_ID…"
aws apigatewayv2 tag-resource --region "$REGION" \
  --resource-arn "arn:aws:apigateway:$REGION::/apis/$API_ID/stages/\$default" \
  --tags "$TAG_KEY=$TAG_VALUE"

echo "Tagging Amplify app $AMPLIFY_APP (SaaS front end, outside the stack)…"
aws amplify tag-resource --region "$REGION" \
  --resource-arn "arn:aws:amplify:$REGION:$(aws sts get-caller-identity --query Account --output text):apps/$AMPLIFY_APP" \
  --tags "$TAG_KEY=$TAG_VALUE"

echo "Done. Verify:"
echo "  aws resourcegroupstaggingapi get-resources --region $REGION --tag-filters Key=$TAG_KEY,Values=$TAG_VALUE --query 'length(ResourceTagMappingList)'"
