#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/floci-env.sh"

if [[ "${1:-}" == "--" ]]; then
  shift
fi

CUSTOMER_ID="${1:-customer-demo-1}"
MESSAGE="${2:-approved-from-demo}"
RESPONSE_FILE="/tmp/payment-api-response.json"
PAYLOAD_FILE="/tmp/payment-api-payload.json"
INVOKE_RESULT_FILE="/tmp/payment-api-invoke-result.json"

jq -n \
  --arg customerId "$CUSTOMER_ID" \
  --arg message "$MESSAGE" \
  '{
    version: "2.0",
    routeKey: "POST /api/payments",
    rawPath: "/api/payments",
    rawQueryString: "",
    headers: {
      "content-type": "application/json",
      host: "localhost"
    },
    requestContext: {
      domainName: "localhost",
      http: {
        method: "POST",
        path: "/api/payments",
        sourceIp: "127.0.0.1"
      }
    },
    body: ({ customerId: $customerId, message: $message } | tojson),
    isBase64Encoded: false
  }' > "$PAYLOAD_FILE"

aws --endpoint-url=http://localhost:4566 lambda invoke \
  --cli-binary-format raw-in-base64-out \
  --function-name dev-venture-core-internal-payment-api \
  --payload "file://$PAYLOAD_FILE" \
  "$RESPONSE_FILE" > "$INVOKE_RESULT_FILE"

cat "$RESPONSE_FILE"
echo

if jq -e '.FunctionError? // empty' "$INVOKE_RESULT_FILE" >/dev/null; then
  echo "Lambda invoke reported FunctionError:" >&2
  cat "$INVOKE_RESULT_FILE" >&2
  exit 1
fi

status_code="$(jq -r '.statusCode // empty' "$RESPONSE_FILE")"

if [[ "$status_code" != "200" ]]; then
  echo "Lambda returned non-200 statusCode: ${status_code:-missing}" >&2
  exit 1
fi
