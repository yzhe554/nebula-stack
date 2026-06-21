#!/usr/bin/env bash
set -euo pipefail

PAYMENTS_API_NAME="dev-venture-core-public-payments"
PAYMENT_API_NAME="dev-venture-core-internal-payment-api-ingress"
ENDPOINT_URL="http://localhost:4566"

api_id() {
  local api_name="$1"
  AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
    aws --endpoint-url="$ENDPOINT_URL" apigatewayv2 get-apis \
    --query "Items[?Name=='$api_name'].ApiId | [0]" \
    --output text 2>/dev/null || true
}

deploy_payment_api_stack() {
  pnpm app:payment-api:package
  pnpm platform:deploy -- --env dev --venture venture --target floci --services customer-records,payment-api,payment-api-ingress
}

deploy_payments_gateway() {
  pnpm platform:deploy -- --env dev --venture venture --target floci --services payments
}

deploy_payments_app() {
  pnpm platform:deploy -- --env dev --venture venture --target floci --services payments-app
}

deploy_payments_stack() {
  pnpm platform:deploy -- --env dev --venture venture --target floci --services payments-app,payments
}

payments_api_id="$(api_id "$PAYMENTS_API_NAME")"
payment_api_id="$(api_id "$PAYMENT_API_NAME")"

if [[ -z "$payment_api_id" || "$payment_api_id" == "None" ]]; then
  echo "Payment API Gateway not found. Bootstrapping payment API stack first..."
  deploy_payment_api_stack
  payment_api_id="$(api_id "$PAYMENT_API_NAME")"
fi

if [[ -z "$payment_api_id" || "$payment_api_id" == "None" ]]; then
  echo "Payment API Gateway not found after bootstrap: $PAYMENT_API_NAME" >&2
  exit 1
fi

if [[ -z "$payments_api_id" || "$payments_api_id" == "None" ]]; then
  echo "Payments API Gateway not found. Bootstrapping payments ECS app and API Gateway first..."
  echo "Building temporary payments image without API Gateway asset prefix..."
  pnpm payments:build
  pnpm payments:docker:build
  deploy_payments_app
  deploy_payments_gateway
  payments_api_id="$(api_id "$PAYMENTS_API_NAME")"
fi

if [[ -z "$payments_api_id" || "$payments_api_id" == "None" ]]; then
  echo "Payments API Gateway not found after bootstrap: $PAYMENTS_API_NAME" >&2
  exit 1
fi

echo "Building payments image for Floci API Gateway path: /execute-api/$payments_api_id/\$default"
NEXT_PUBLIC_GATEWAY_PATH="/execute-api/$payments_api_id/\$default" \
NEXT_PUBLIC_PAYMENT_API_BASE_URL="$ENDPOINT_URL/execute-api/$payment_api_id/\$default" \
  pnpm payments:build
pnpm payments:docker:build
deploy_payments_stack

AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
AWS_SESSION_TOKEN= \
AWS_DEFAULT_REGION=us-east-1 \
NO_PROXY=localhost,127.0.0.1,.floci.localhost,.elb.localhost \
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
aws --endpoint-url="$ENDPOINT_URL" ecs update-service \
  --cluster dev-venture-core-public-payments-app \
  --service dev-venture-core-public-payments-app \
  --force-new-deployment \
  >/dev/null

pnpm floci:url
