#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/floci-env.sh"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PAYMENT_API_DIR="$REPO_ROOT/infra/services/dev/venture/core/internal/__generated__/floci/payment-api"
PAYMENT_API_INGRESS_DIR="$REPO_ROOT/infra/services/dev/venture/core/internal/__generated__/floci/payment-api-ingress"
CUSTOMER_RECORDS_DIR="$REPO_ROOT/infra/services/dev/venture/core/managed/__generated__/floci/customer-records"
DOCS_DIR="$REPO_ROOT/infra/services/dev/venture/core/public/__generated__/floci/docs"
ENDPOINT_URL="http://localhost:4566"
FUNCTION_NAME="dev-venture-core-internal-payment-api"
ROLE_NAME="dev-venture-core-internal-payment-api-lambda-role"
INLINE_POLICY_NAME="dev-venture-core-internal-payment-api-dynamodb-access"
BASIC_EXECUTION_POLICY_ARN="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
LOG_GROUP_NAME="/aws/lambda/dev-venture-core-internal-payment-api"
API_GATEWAY_NAMES=("dev-venture-core-public-docs" "dev-venture-core-internal-payment-api-ingress")

run_or_ignore_not_found() {
  local description="$1"
  shift

  echo "$description"
  if ! output="$($@ 2>&1)"; then
    if [[ "$output" == *"ResourceNotFound"* \
      || "$output" == *"ResourceNotFoundException"* \
      || "$output" == *"NoSuchEntity"* \
      || "$output" == *"NoSuchEntityException"* \
      || "$output" == *"NotFound"* ]]; then
      echo "  Already absent"
      return 0
    fi

    echo "$output" >&2
    return 1
  fi
}

delete_api_gateway() {
  local API_GATEWAY_NAME="$1"
  echo "Deleting local Floci API Gateway: $API_GATEWAY_NAME"
  if ! api_ids="$(aws --endpoint-url="$ENDPOINT_URL" apigatewayv2 get-apis --query "Items[?Name=='$API_GATEWAY_NAME'].ApiId" --output text 2>&1)"; then
    if [[ "$api_ids" == *"NotFound"* ]]; then
      echo "  Already absent"
      return 0
    fi

    echo "$api_ids" >&2
    return 1
  fi

  if [[ -z "$api_ids" || "$api_ids" == "None" ]]; then
    echo "  Already absent"
    return 0
  fi

  for api_id in $api_ids; do
    aws --endpoint-url="$ENDPOINT_URL" apigatewayv2 delete-api --api-id "$api_id"
  done
}

for api_gateway_name in "${API_GATEWAY_NAMES[@]}"; do
  delete_api_gateway "$api_gateway_name"
done

run_or_ignore_not_found \
  "Deleting local Floci Lambda function: $FUNCTION_NAME" \
  aws --endpoint-url="$ENDPOINT_URL" lambda delete-function \
    --function-name "$FUNCTION_NAME"

run_or_ignore_not_found \
  "Deleting local Floci CloudWatch log group: $LOG_GROUP_NAME" \
  aws --endpoint-url="$ENDPOINT_URL" logs delete-log-group \
    --log-group-name "$LOG_GROUP_NAME"

run_or_ignore_not_found \
  "Deleting local Floci Lambda inline IAM policy: $INLINE_POLICY_NAME" \
  aws --endpoint-url="$ENDPOINT_URL" iam delete-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "$INLINE_POLICY_NAME"

run_or_ignore_not_found \
  "Detaching local Floci Lambda basic execution policy" \
  aws --endpoint-url="$ENDPOINT_URL" iam detach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn "$BASIC_EXECUTION_POLICY_ARN"

run_or_ignore_not_found \
  "Deleting local Floci Lambda IAM role: $ROLE_NAME" \
  aws --endpoint-url="$ENDPOINT_URL" iam delete-role \
    --role-name "$ROLE_NAME"

"$(dirname "$0")/floci-ddb-reset.sh"

rm -rf "$PAYMENT_API_DIR" "$PAYMENT_API_INGRESS_DIR" "$CUSTOMER_RECORDS_DIR" "$DOCS_DIR"
echo "Removed local generated Floci Terraform state under infra/services/**/__generated__/floci"
