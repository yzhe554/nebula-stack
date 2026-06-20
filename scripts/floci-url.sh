#!/usr/bin/env bash
set -euo pipefail

DOCS_API_NAME="dev-venture-core-public-docs"
PAYMENT_API_NAME="dev-venture-core-internal-payment-api-ingress"
ENDPOINT_URL="http://localhost:4566"
DOCS_STATE_DIR="infra/services/dev/venture/core/public/__generated__/floci/docs"
PAYMENT_API_STATE_DIR="infra/services/dev/venture/core/internal/__generated__/floci/payment-api-ingress"

docs_api_id="$(AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
  aws --endpoint-url="$ENDPOINT_URL" apigatewayv2 get-apis \
  --query "Items[?Name=='$DOCS_API_NAME'].ApiId | [0]" \
  --output text 2>/dev/null || true)"

payment_api_id="$(AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
  aws --endpoint-url="$ENDPOINT_URL" apigatewayv2 get-apis \
  --query "Items[?Name=='$PAYMENT_API_NAME'].ApiId | [0]" \
  --output text 2>/dev/null || true)"

if [[ -z "$docs_api_id" || "$docs_api_id" == "None" ]]; then
  if [[ -d "$DOCS_STATE_DIR" ]]; then
    docs_api_id="$(jq -r '.resources[] | select(.type == "aws_apigatewayv2_api" and .name == "docs") | .instances[0].attributes.id // empty' "$DOCS_STATE_DIR/terraform.tfstate" 2>/dev/null || true)"
  fi
fi

if [[ -z "$payment_api_id" || "$payment_api_id" == "None" ]]; then
  if [[ -d "$PAYMENT_API_STATE_DIR" ]]; then
    payment_api_id="$(jq -r '.resources[] | select(.type == "aws_apigatewayv2_api" and .name == "payment_api_ingress") | .instances[0].attributes.id // empty' "$PAYMENT_API_STATE_DIR/terraform.tfstate" 2>/dev/null || true)"
  fi
fi

if [[ -z "$docs_api_id" || "$docs_api_id" == "None" ]]; then
  echo "API Gateway not found: $DOCS_API_NAME" >&2
  echo "Run: pnpm floci:deploy:all" >&2
  exit 1
fi

if [[ -z "$payment_api_id" || "$payment_api_id" == "None" ]]; then
  echo "API Gateway not found: $PAYMENT_API_NAME" >&2
  echo "Run: pnpm floci:deploy:all" >&2
  exit 1
fi

docs_gateway_path="/execute-api/$docs_api_id/\$default"
payment_gateway_path="/execute-api/$payment_api_id/\$default"

cat <<URLS
Docs via Floci:
$ENDPOINT_URL$docs_gateway_path/docs

Payment API via Floci:
$ENDPOINT_URL$payment_gateway_path/api/payments

Docs direct:
http://localhost:3001/docs

For static assets through Floci, start docs with:
pnpm docs:dev:floci
URLS
