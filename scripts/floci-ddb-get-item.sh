#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/floci-env.sh"

if [[ "${1:-}" == "--" ]]; then
  shift
fi

TABLE_NAME="dev-venture-core-restricted-customer-records"
CUSTOMER_ID="${1:-customer-demo-1}"
ENDPOINT_URL="http://localhost:4566"

if ! aws --endpoint-url="$ENDPOINT_URL" dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1; then
  echo "DynamoDB table not found in Floci: $TABLE_NAME" >&2
  echo "Deploy it first:" >&2
  echo "  pnpm platform:deploy -- --env dev --venture venture --target floci --services customer-records" >&2
  echo "Or deploy both services:" >&2
  echo "  pnpm floci:deploy:all" >&2
  echo "Current Floci tables:" >&2
  aws --endpoint-url="$ENDPOINT_URL" dynamodb list-tables >&2 || true
  exit 1
fi

aws --endpoint-url="$ENDPOINT_URL" dynamodb get-item \
  --table-name "$TABLE_NAME" \
  --key "{\"customerId\":{\"S\":\"${CUSTOMER_ID}\"}}"
