#!/usr/bin/env bash
set -euo pipefail

API_NAME="dev-venture-core-public-docs"
ENDPOINT_URL="http://localhost:4566"
STATE_DIR="infra/services/dev/venture/core/public/__generated__/floci/docs"

api_id="$(AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
  aws --endpoint-url="$ENDPOINT_URL" apigatewayv2 get-apis \
  --query "Items[?Name=='$API_NAME'].ApiId | [0]" \
  --output text 2>/dev/null || true)"

if [[ -z "$api_id" || "$api_id" == "None" ]]; then
  if [[ -d "$STATE_DIR" ]]; then
    api_id="$(terraform -chdir="$STATE_DIR" state show aws_apigatewayv2_api.docs 2>/dev/null \
      | awk -F '"' '/^[[:space:]]*id[[:space:]]*=/{ print $2; exit }')"
  fi
fi

if [[ -z "$api_id" || "$api_id" == "None" ]]; then
  echo "API Gateway not found: $API_NAME" >&2
  echo "Run: pnpm floci:deploy:all" >&2
  exit 1
fi

gateway_path="/execute-api/$api_id/\$default"

cat <<URLS
Docs via Floci:
$ENDPOINT_URL$gateway_path/

Payment API via Floci:
$ENDPOINT_URL$gateway_path/api/payments

Docs direct:
http://localhost:3001/

For static assets through Floci, start docs with:
pnpm docs:dev:floci
URLS
