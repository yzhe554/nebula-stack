#!/usr/bin/env bash
set -euo pipefail

API_NAME="dev-venture-core-public-docs"
ENDPOINT_URL="http://localhost:4566"

api_id() {
  AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
    aws --endpoint-url="$ENDPOINT_URL" apigatewayv2 get-apis \
    --query "Items[?Name=='$API_NAME'].ApiId | [0]" \
    --output text 2>/dev/null || true
}

deploy_docs_stack() {
  pnpm platform:deploy -- --env dev --venture venture --target floci --services docs-app,docs
}

deploy_docs_gateway() {
  pnpm platform:deploy -- --env dev --venture venture --target floci --services docs
}

deploy_docs_app() {
  pnpm platform:deploy -- --env dev --venture venture --target floci --services docs-app
}

current_api_id="$(api_id)"

if [[ -z "$current_api_id" || "$current_api_id" == "None" ]]; then
  echo "Docs API Gateway not found. Bootstrapping docs ECS app and API Gateway first..."
  echo "Building temporary docs image without API Gateway asset prefix..."
  pnpm docs:build
  pnpm docs:docker:build
  deploy_docs_app
  deploy_docs_gateway
  current_api_id="$(api_id)"
fi

if [[ -z "$current_api_id" || "$current_api_id" == "None" ]]; then
  echo "Docs API Gateway not found after bootstrap: $API_NAME" >&2
  exit 1
fi

echo "Building docs image for Floci API Gateway path: /execute-api/$current_api_id/\$default"
NEXT_PUBLIC_GATEWAY_PATH="/execute-api/$current_api_id/\$default" pnpm docs:build
pnpm docs:docker:build
deploy_docs_stack

AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
AWS_SESSION_TOKEN= \
AWS_DEFAULT_REGION=us-east-1 \
NO_PROXY=localhost,127.0.0.1,.floci.localhost,.elb.localhost \
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
aws --endpoint-url="$ENDPOINT_URL" ecs update-service \
  --cluster dev-venture-core-public-docs-app \
  --service dev-venture-core-public-docs-app \
  --force-new-deployment \
  >/dev/null

pnpm floci:url
