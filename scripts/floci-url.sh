#!/usr/bin/env bash
set -euo pipefail

DOCS_API_NAME="dev-venture-core-public-docs"
PAYMENTS_API_NAME="dev-venture-core-public-payments"
PAYMENT_API_NAME="dev-venture-core-internal-payment-api-ingress"
ENDPOINT_URL="http://localhost:4566"
DOCS_STATE_DIR="infra/services/dev/venture/core/public/__generated__/floci/docs"
DOCS_APP_STATE_DIR="infra/services/dev/venture/core/public/__generated__/floci/docs-app"
PAYMENTS_STATE_DIR="infra/services/dev/venture/core/public/__generated__/floci/payments"
PAYMENTS_APP_STATE_DIR="infra/services/dev/venture/core/public/__generated__/floci/payments-app"
PAYMENT_API_STATE_DIR="infra/services/dev/venture/core/internal/__generated__/floci/payment-api-ingress"

docs_api_id="$(AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
  aws --endpoint-url="$ENDPOINT_URL" apigatewayv2 get-apis \
  --query "Items[?Name=='$DOCS_API_NAME'].ApiId | [0]" \
  --output text 2>/dev/null || true)"

payment_api_id="$(AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
  aws --endpoint-url="$ENDPOINT_URL" apigatewayv2 get-apis \
  --query "Items[?Name=='$PAYMENT_API_NAME'].ApiId | [0]" \
  --output text 2>/dev/null || true)"

payments_api_id="$(AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
  aws --endpoint-url="$ENDPOINT_URL" apigatewayv2 get-apis \
  --query "Items[?Name=='$PAYMENTS_API_NAME'].ApiId | [0]" \
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

if [[ -z "$payments_api_id" || "$payments_api_id" == "None" ]]; then
  if [[ -d "$PAYMENTS_STATE_DIR" ]]; then
    payments_api_id="$(jq -r '.resources[] | select(.type == "aws_apigatewayv2_api" and .name == "payments") | .instances[0].attributes.id // empty' "$PAYMENTS_STATE_DIR/terraform.tfstate" 2>/dev/null || true)"
  fi
fi

docs_alb_dns=""
if [[ -f "$DOCS_APP_STATE_DIR/terraform.tfstate" ]]; then
  docs_alb_dns="$(jq -r '.resources[] | select(.type == "aws_lb" and .name == "docs_app") | .instances[0].attributes.dns_name // empty' "$DOCS_APP_STATE_DIR/terraform.tfstate" 2>/dev/null || true)"
fi

payments_alb_dns=""
if [[ -f "$PAYMENTS_APP_STATE_DIR/terraform.tfstate" ]]; then
  payments_alb_dns="$(jq -r '.resources[] | select(.type == "aws_lb" and .name == "payments_app") | .instances[0].attributes.dns_name // empty' "$PAYMENTS_APP_STATE_DIR/terraform.tfstate" 2>/dev/null || true)"
fi

echo "Floci URLs"
echo "=========="
echo

if [[ -n "$docs_api_id" && "$docs_api_id" != "None" ]]; then
  docs_gateway_path="/execute-api/$docs_api_id/\$default"
  cat <<URLS
Docs via API Gateway:
$ENDPOINT_URL$docs_gateway_path/docs

Docs API Gateway base:
$ENDPOINT_URL$docs_gateway_path

URLS
else
  cat <<URLS
Docs via API Gateway:
Not deployed. Run:
pnpm platform:deploy -- --env dev --venture venture --target floci --services docs-app,docs

URLS
fi

if [[ -n "$docs_alb_dns" && "$docs_alb_dns" != "null" ]]; then
  cat <<URLS
Docs via ALB (inside Floci container network; not directly host-accessible):
http://$docs_alb_dns/docs

URLS
fi

cat <<URLS
Docs ECS container direct (inside Floci container network; not directly host-accessible):
http://dev-venture-core-public-docs-app.floci.localhost:3001/docs

Docs local dev direct:
http://localhost:3001/docs

URLS

if [[ -n "$payments_api_id" && "$payments_api_id" != "None" ]]; then
  payments_gateway_path="/execute-api/$payments_api_id/\$default"
  cat <<URLS
Payments app via API Gateway:
$ENDPOINT_URL$payments_gateway_path/payments

Payments API Gateway base:
$ENDPOINT_URL$payments_gateway_path

URLS
else
  cat <<URLS
Payments app via API Gateway:
Not deployed. Run full stack deploy if needed:
pnpm floci:deploy:all

URLS
fi

if [[ -n "$payments_alb_dns" && "$payments_alb_dns" != "null" ]]; then
  cat <<URLS
Payments via ALB (inside Floci container network; not directly host-accessible):
http://$payments_alb_dns/payments

URLS
fi

cat <<URLS
Payments ECS container direct (inside Floci container network; not directly host-accessible):
http://dev-venture-core-public-payments-app.floci.localhost:3002/payments

URLS

if [[ -n "$payment_api_id" && "$payment_api_id" != "None" ]]; then
  payment_gateway_path="/execute-api/$payment_api_id/\$default"
  cat <<URLS
Payment API via API Gateway:
$ENDPOINT_URL$payment_gateway_path/api/payments

URLS
else
  cat <<URLS
Payment API via API Gateway:
Not deployed. Run full stack deploy if needed:
pnpm floci:deploy:all

URLS
fi

cat <<URLS
For local dev proxy mode, start docs with:
pnpm docs:dev:floci

For Floci docs deployment, run:
pnpm floci:deploy:docs

For Floci payments deployment, run:
pnpm floci:deploy:payments
URLS
