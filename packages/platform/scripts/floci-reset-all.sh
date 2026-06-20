#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/floci-env.sh"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PAYMENT_API_DIR="$REPO_ROOT/infra/services/dev/venture/core/internal/__generated__/floci/payment-api"
CUSTOMER_RECORDS_DIR="$REPO_ROOT/infra/services/dev/venture/core/restricted/__generated__/floci/customer-records"
ENDPOINT_URL="http://localhost:4566"
FUNCTION_NAME="dev-venture-core-internal-payment-api"
ROLE_NAME="dev-venture-core-internal-payment-api-lambda-role"
INLINE_POLICY_NAME="dev-venture-core-internal-payment-api-dynamodb-access"
BASIC_EXECUTION_POLICY_ARN="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
LOG_GROUP_NAME="/aws/lambda/dev-venture-core-internal-payment-api"

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

rm -rf "$PAYMENT_API_DIR" "$CUSTOMER_RECORDS_DIR"
echo "Removed local generated Floci Terraform state under infra/services/**/__generated__/floci"
