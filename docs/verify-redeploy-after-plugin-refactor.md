# Verify Redeploy After Service-Type Plugin Refactor

This records a full `floci:redeploy:all` run after decomposing `terraform.ts`
into composable service-type plugins (see
`docs/superpowers/plans/2026-06-21-composable-service-type-modules.md`).

The goal is to confirm the refactor is behavior-preserving against a live Floci
stack, not just in unit tests. Two layers of evidence:

1. **Static:** generated `main.tf.json` is byte-identical to pre-refactor output.
2. **Runtime:** a clean reset + redeploy brings up all three flows and they return `200`.

Verified flows:

```text
Docs:        API Gateway -> ALB -> ECS -> docs container (3001)
Payments:    API Gateway -> ALB -> ECS -> payments container (3002)
Payment API: API Gateway -> Lambda -> DynamoDB
```

## 0. Preconditions

```bash
curl -i http://localhost:4566   # Floci reachable (200)
docker info                     # Docker running
```

## 1. Static check — generated Terraform unchanged

```bash
pnpm platform:generate -- --env dev --venture venture --target floci
pnpm platform:generate -- --env dev --venture venture --target aws
git status --short infra/services | grep main.tf.json || echo "BYTE-IDENTICAL"
```

Expected: `BYTE-IDENTICAL` (no `main.tf.json` modified). Confirmed.

## 2. Full reset + redeploy

```bash
pnpm floci:redeploy:all
```

This runs `floci:reset:all` (tears down all local Floci resources) then
`floci:deploy:all` (rebuilds docs + payments images, applies Terraform for every
service, restarts the ECS services, prints URLs). Completed with exit code 0.

API Gateway IDs from this run (yours will differ — IDs are assigned per deploy):

```text
docs        5a5cc3917d
payments    b8aec7307d
payment-api 88b5db793a
```

## 3. ECS services

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_SESSION_TOKEN= \
AWS_DEFAULT_REGION=us-east-1 \
NO_PROXY=localhost,127.0.0.1,.floci.localhost,.elb.localhost \
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
aws --endpoint-url=http://localhost:4566 ecs describe-services \
  --cluster dev-venture-core-public-docs-app \
  --services dev-venture-core-public-docs-app \
  --query 'services[0].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount}' \
  --output json
```

Repeat with `dev-venture-core-public-payments-app` for payments.

Result:

```json
// docs
{ "status": "ACTIVE", "desired": 1, "running": 1, "pending": 0 }
// payments
{ "status": "ACTIVE", "desired": 1, "running": 1, "pending": 0 }
```

## 4. API Gateway responses

```bash
NP() { NO_PROXY=localhost,127.0.0.1,.floci.localhost,.elb.localhost \
  env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy "$@"; }

NP curl -s -o /dev/null -w "%{http_code}\n" --max-time 25 \
  "http://localhost:4566/execute-api/5a5cc3917d/\$default/docs"
NP curl -s -o /dev/null -w "%{http_code}\n" --max-time 25 \
  "http://localhost:4566/execute-api/b8aec7307d/\$default/payments"
NP curl -s -o /dev/null -w "%{http_code}\n" --max-time 25 \
  -X POST "http://localhost:4566/execute-api/88b5db793a/\$default/api/payments" \
  -H 'content-type: application/json' \
  -d '{"customerId":"customer-local-1","message":"verify refactor"}'
```

Result: `200`, `200`, `200`.

## 5. Lambda -> DynamoDB write

The payment-api POST should persist a record. Confirm it landed:

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_SESSION_TOKEN= \
AWS_DEFAULT_REGION=us-east-1 \
NO_PROXY=localhost,127.0.0.1,.floci.localhost,.elb.localhost \
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
aws --endpoint-url=http://localhost:4566 dynamodb get-item \
  --table-name dev-venture-core-managed-customer-records \
  --key '{"customerId":{"S":"customer-local-1"}}' \
  --query 'Item.customerId' --output json
```

Result: `{ "S": "customer-local-1" }` — the Lambda wrote to DynamoDB.

## 6. ALB target health

```bash
TG=$(jq -r '.resources[] | select(.type=="aws_lb_target_group") | .instances[0].attributes.arn' \
  infra/services/dev/venture/core/public/__generated__/floci/docs-app/terraform.tfstate)
# (repeat with payments-app)
aws ... elbv2 describe-target-health --target-group-arn "$TG" \
  --query 'TargetHealthDescriptions[].{port:Target.Port,state:TargetHealth.State}' --output json
```

Result:

```json
// docs-app
[ { "port": 3001, "state": "initial" } ]
// payments-app
[ { "port": 3002, "state": "healthy" } ]
```

`initial` is transient (same note as `verify-floci-docs-ecs-flow.md` step 4): the
pass condition is the API Gateway URL returning `200`, which it does.

## Conclusion

After the plugin refactor, a clean reset + redeploy brings up docs, payments, and
the payment-api end-to-end, all returning `200`, with a confirmed Lambda->DynamoDB
write. Combined with the byte-identical generated Terraform, the refactor is
behavior-preserving against the live Floci stack.
