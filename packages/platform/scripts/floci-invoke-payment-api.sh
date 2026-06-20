#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/floci-env.sh"

if [[ "${1:-}" == "--" ]]; then
  shift
fi

CUSTOMER_ID="${1:-customer-demo-1}"
MESSAGE="${2:-approved-from-demo}"
RESPONSE_FILE="/tmp/payment-api-response.json"

aws --endpoint-url=http://localhost:4566 lambda invoke \
  --cli-binary-format raw-in-base64-out \
  --function-name dev-venture-core-internal-payment-api \
  --payload "{\"body\":\"{\\\"customerId\\\":\\\"${CUSTOMER_ID}\\\",\\\"message\\\":\\\"${MESSAGE}\\\"}\"}" \
  "$RESPONSE_FILE"

cat "$RESPONSE_FILE"
echo
