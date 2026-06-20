#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/floci-env.sh"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

TABLE_NAME="dev-venture-core-restricted-customer-records"
ENDPOINT_URL="http://localhost:4566"

if ! aws --endpoint-url="$ENDPOINT_URL" dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1; then
  echo "Local Floci DynamoDB table does not exist: $TABLE_NAME"
  rm -rf "$REPO_ROOT/__generated__/floci/dev/venture/customer-records"
  exit 0
fi

echo "Disabling deletion protection for local Floci table: $TABLE_NAME"
aws --endpoint-url="$ENDPOINT_URL" dynamodb update-table \
  --table-name "$TABLE_NAME" \
  --no-deletion-protection-enabled >/dev/null

for attempt in {1..20}; do
  deletion_protection_enabled="$(aws --endpoint-url="$ENDPOINT_URL" dynamodb describe-table \
    --table-name "$TABLE_NAME" \
    --query 'Table.DeletionProtectionEnabled' \
    --output text)"

  if [[ "$deletion_protection_enabled" == "False" || "$deletion_protection_enabled" == "false" || "$deletion_protection_enabled" == "None" ]]; then
    break
  fi

  echo "Waiting for deletion protection to be disabled... attempt $attempt"
  sleep 1

done

echo "Deleting local Floci table: $TABLE_NAME"
aws --endpoint-url="$ENDPOINT_URL" dynamodb delete-table \
  --table-name "$TABLE_NAME" >/dev/null

for attempt in {1..20}; do
  if ! aws --endpoint-url="$ENDPOINT_URL" dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1; then
    echo "Deleted local Floci DynamoDB table: $TABLE_NAME"
    rm -rf "$REPO_ROOT/__generated__/floci/dev/venture/customer-records"
    exit 0
  fi

  echo "Waiting for table deletion... attempt $attempt"
  sleep 1

done

echo "Timed out waiting for table deletion: $TABLE_NAME" >&2
exit 1
