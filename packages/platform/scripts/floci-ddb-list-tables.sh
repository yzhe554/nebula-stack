#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/floci-env.sh"

aws --endpoint-url=http://localhost:4566 dynamodb list-tables
