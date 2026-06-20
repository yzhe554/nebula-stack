#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/floci-env.sh"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PAYMENT_API_DIR="$REPO_ROOT/__generated__/floci/dev/venture/payment-api"

if [[ -f "$PAYMENT_API_DIR/main.tf.json" ]]; then
  echo "Destroying local Floci Lambda stack: payment-api"
  (cd "$PAYMENT_API_DIR" && terraform init && terraform destroy -auto-approve) || true
fi

"$(dirname "$0")/floci-ddb-reset.sh"

rm -rf "$REPO_ROOT/__generated__/floci/dev/venture"
echo "Removed local generated Floci Terraform state under __generated__/floci/dev/venture"
