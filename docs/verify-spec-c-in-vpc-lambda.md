# Verify Spec C — In-VPC Lambda + Direct SDK Invoke

Records the live Floci verification that the payment-api Lambda runs in the VPC
and is invoked directly via the AWS SDK from the payments app — with **no API
Gateway in front of the Lambda** (the `payment-api-ingress` gateway was removed).

Flow proven:

```text
browser → payments app /api/payments (same-origin, behind payments gateway)
  → payments Next.js server route handler (in-VPC ECS task)
     reads PAYMENT_API_FUNCTION_NAME (ECS task env from permissions.lambda)
     AWS SDK InvokeCommand → in-VPC payment-api Lambda → DynamoDB
```

## 0. Preconditions

```bash
curl -i http://localhost:4566   # Floci reachable
docker info                     # Docker running
```

## 1. Reset + deploy the payment-api stack (network first)

```bash
pnpm floci:reset:all
pnpm app:payment-api:package
pnpm platform:deploy -- --env dev --venture venture --target floci --services network,customer-records,payment-api
```

Expected: `Apply complete!`. The Lambda is created WITH `vpc_config` (subnets +
lambda SG + `AWSLambdaVPCAccessExecutionRole`). Floci applies Lambda-in-VPC
cleanly — no target-conditional fallback needed.

## 2. Deploy the payments stack

```bash
pnpm payments:build && pnpm payments:docker:build
pnpm platform:deploy -- --env dev --venture venture --target floci --services payments-app,payments
```

The `payments-app` task definition includes:

- `task_role_arn` → a task role with `lambda:InvokeFunction` on the payment-api ARN
- container env `PAYMENT_API_FUNCTION_NAME=dev-venture-core-internal-payment-api`
- (Floci only) `AWS_ENDPOINT_URL=http://host.docker.internal:4566`, `AWS_REGION`, test creds

## 3. Acceptance: submit a payment, confirm it persists

```bash
PAY_ID=$(aws --endpoint-url=http://localhost:4566 apigatewayv2 get-apis \
  --query "Items[?Name=='dev-venture-core-public-payments'].ApiId | [0]" --output text)
CID="verify-$(date +%s)"

curl -s -X POST "http://localhost:4566/execute-api/$PAY_ID/\$default/payments/api/payments" \
  -H 'content-type: application/json' \
  -d "{\"customerId\":\"$CID\",\"message\":\"spec-c\"}"
# → {"customerId":"verify-...","stored":true}  (HTTP 200)

aws --endpoint-url=http://localhost:4566 dynamodb get-item \
  --table-name dev-venture-core-managed-customer-records \
  --key "{\"customerId\":{\"S\":\"$CID\"}}" --query 'Item'
# → the item exists, with the message — proving the SDK-invoke path end to end
```

NOTE the path is `/payments/api/payments`: the payments Next app has
`basePath: /payments`, so its `/api/payments` route handler is served under the
payments gateway's `/payments/*` route.

Result (2026-06-22 run): **HTTP 200, `{stored:true}`, item persisted.** ✓

## 4. Regression: docs/payments pages still serve

```bash
pnpm floci:url   # then curl the docs + payments gateway URLs → 200
```

## Two real bugs the live check caught (fixed)

The live run surfaced two issues that unit tests + generated-Terraform inspection
did not — both fixed in the ECS emitter:

1. **ECS task had no AWS credentials/endpoint on Floci.** The route handler's
   `LambdaClient` failed with `CredentialsProviderError`. The lambda emitter
   injects `AWS_ENDPOINT_URL` for Floci, but the ECS emitter did not. Fix: when
   an ECS service has `permissions.lambda` and target is `floci`, inject
   `AWS_ENDPOINT_URL` + `AWS_REGION` + test creds as task env.

2. **ECS containers cannot resolve `localhost.floci.io`.** The lambda's
   `flociEndpointUrl` (`http://localhost.floci.io:4566`) works for the Lambda
   runtime but not inside an ECS container, which got `EAI_AGAIN`. ECS containers
   reach the host-published Floci port via `host.docker.internal` (the same alias
   the API Gateway uses to reach ECS). Fix: a separate `flociEcsEndpointUrl =
http://host.docker.internal:4566` used for ECS task env.

Both are Floci-only concerns; on real AWS the task role provides creds and the
SDK uses the public endpoint.

## Status

Spec C verified end-to-end on Floci: the payment-api Lambda runs in the VPC and
is invoked privately via the SDK from the payments app, with no API Gateway in
front of it. Platform unit suite: 121 tests green; lint + typecheck clean.
