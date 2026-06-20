#!/usr/bin/env bash
set -euo pipefail

API_NAME="dev-venture-core-public-docs"
ENDPOINT_URL="http://localhost:4566"

api_id="$(AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
  aws --endpoint-url="$ENDPOINT_URL" apigatewayv2 get-apis \
  --query "Items[?Name=='$API_NAME'].ApiId | [0]" \
  --output text 2>/dev/null || true)"

if [[ -z "$api_id" || "$api_id" == "None" ]]; then
  state_dir="infra/services/dev/venture/core/public/__generated__/floci/docs"
  if [[ -d "$state_dir" ]]; then
    api_id="$(terraform -chdir="$state_dir" state show aws_apigatewayv2_api.docs 2>/dev/null \
      | awk -F '"' '/^[[:space:]]*id[[:space:]]*=/{ print $2; exit }')"
  fi
fi

if [[ -z "$api_id" || "$api_id" == "None" ]]; then
  echo "API Gateway not found in Floci: $API_NAME" >&2
  echo "Run: pnpm floci:deploy:all" >&2
  exit 1
fi

export NEXT_PUBLIC_GATEWAY_PATH="/execute-api/$api_id/\$default"

echo "Starting docs with gateway path: $NEXT_PUBLIC_GATEWAY_PATH"
echo "Open: $ENDPOINT_URL$NEXT_PUBLIC_GATEWAY_PATH/docs"

if ! lsof -tiTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  rm -f apps/docs/.next/dev/lock
fi

pnpm --filter @repo/docs run dev
