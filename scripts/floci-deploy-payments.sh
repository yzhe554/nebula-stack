#!/usr/bin/env bash
set -euo pipefail

PAYMENTS_API_NAME="dev-venture-core-public-payments"
PAYMENT_API_FUNCTION_NAME="dev-venture-core-internal-payment-api"
ENDPOINT_URL="http://localhost:4566"

api_id() {
  local api_name="$1"
  AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
    aws --endpoint-url="$ENDPOINT_URL" apigatewayv2 get-apis \
    --query "Items[?Name=='$api_name'].ApiId | [0]" \
    --output text 2>/dev/null || true
}

lambda_exists() {
  AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
    aws --endpoint-url="$ENDPOINT_URL" lambda get-function \
    --function-name "$PAYMENT_API_FUNCTION_NAME" >/dev/null 2>&1
}

# payment-api is now invoked directly via the AWS SDK from the payments ECS
# task (no API Gateway in front). It runs in the VPC, so the network module
# must be deployed first.
deploy_payment_api_stack() {
  pnpm app:payment-api:package
  pnpm platform:deploy -- --env dev --venture venture --target floci --services network,customer-records,payment-api
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

if ! lambda_exists; then
  echo "Payment API Lambda not found. Bootstrapping payment API stack first..."
  deploy_payment_api_stack
fi

if ! lambda_exists; then
  echo "Payment API Lambda not found after bootstrap: $PAYMENT_API_FUNCTION_NAME" >&2
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
# The payments server calls the payment-api Lambda via the AWS SDK using
# PAYMENT_API_FUNCTION_NAME (injected as an ECS task env by permissions.lambda),
# so no payment-api URL is baked into the image any more.
NEXT_PUBLIC_GATEWAY_PATH="/execute-api/$payments_api_id/\$default" \
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
