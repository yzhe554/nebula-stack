# Verify TS CLI Replaces Floci Shell Scripts (Plan 5)

Records the live Floci verification that the TypeScript CLI under
`packages/platform/src/cli/` replaces the hand-maintained Floci shell scripts.
Every resource name is derived from the service manifest, so adding a service —
or a new resource type on a service — needs no shell edits.

## What replaced what

| Deleted shell script                           | Replaced by                                              |
| ---------------------------------------------- | -------------------------------------------------------- |
| `scripts/floci-deploy-docs.sh`                 | `floci:deploy:service -- docs-app` (`src/cli/deploy.ts`) |
| `scripts/floci-deploy-payments.sh`             | `floci:deploy:service -- payments-app`                   |
| `scripts/floci-url.sh`                         | `floci:url` (`src/cli/url.ts`)                           |
| `scripts/docs-dev-floci.sh`                    | `floci:dev -- docs-app` (`src/cli/dev.ts`)               |
| `packages/platform/scripts/floci-reset-all.sh` | `floci:reset:all` (`src/cli/reset.ts`)                   |

Kept (DDB helpers + env): `floci-ddb-reset.sh`, `floci-ddb-get-item.sh`,
`floci-ddb-list-tables.sh`, `floci-invoke-payment-api.sh`, `floci-env.sh`.
`reset.ts` spawns the kept `floci-ddb-reset.sh`.

## The bug class this eliminates

On 2026-06-22 `floci:redeploy:all` broke because the shell `floci-reset-all.sh`
didn't know about resources Spec C added (the Lambda security group + the ECS
task role + the VPC-access policy attachment). Each new resource type meant
hand-editing the script, and it was easy to miss one.

`src/cli/reset.ts` derives teardown targets from the manifest via the pure
`planResetTargets(manifest)`: lambda SG (`<phys>-sg`), ECS task role
(`<phys>-task-role` + inline `<phys>-lambda-invoke`), VPC-access detach, etc. all
fall out of reading service configs. The `network` module is deliberately
excluded (it persists across redeploys).

## Live run (2026-06-22)

```bash
curl -i http://localhost:4566            # Floci up

pnpm floci:reset:all                     # TS reset
# → Deleting API Gateways / ECS / Lambda+SG / ECS task roles / DDB / state dirs
# → "Reset complete."  (handles the Spec-C resources the old shell missed)

pnpm floci:deploy:payments               # TS deploy
# → deploys prerequisites (network, payment-api lambda, customer-records),
#   bootstraps payments-app/ALB if needed, builds with NEXT_PUBLIC_GATEWAY_PATH,
#   deploys payments-app + payments gateway, forces new ECS deployment,
#   prints manifest-derived URLs.

pnpm floci:url                           # TS url
# → # payments-app  Via API Gateway: http://localhost:4566/execute-api/<id>/$default/payments
#   # Payment API   Invoked privately via the AWS SDK (no public API Gateway).
```

### Acceptance: payment flow works through the CLI-deployed stack

```bash
PAY_ID=$(aws --endpoint-url=http://localhost:4566 apigatewayv2 get-apis \
  --query "Items[?Name=='dev-venture-core-public-payments'].ApiId | [0]" --output text)
CID="p5-verify-$(date +%s)"
curl -s -X POST "http://localhost:4566/execute-api/$PAY_ID/\$default/payments/api/payments" \
  -H 'content-type: application/json' -d "{\"customerId\":\"$CID\",\"message\":\"p5 cli\"}"
# → {"customerId":"p5-verify-...","stored":true}  (HTTP 200)

aws --endpoint-url=http://localhost:4566 dynamodb get-item \
  --table-name dev-venture-core-managed-customer-records \
  --key "{\"customerId\":{\"S\":\"$CID\"}}" --query 'Item.customerId.S'
# → "p5-verify-..."  (persisted)
```

Result: payments page **200**, payment submit **200 `{stored:true}`**, item
**persisted** — the full browser → same-origin route → SDK Invoke → in-VPC
Lambda → DynamoDB path, deployed and reset entirely by the TS CLI.

## Architecture notes

- **AWS SDK v3** (user-confirmed over the `aws` CLI): `@aws-sdk/client-{apigatewayv2,ecs,elastic-load-balancing-v2,iam,cloudwatch-logs,ec2,lambda}`.
- **Pure / imperative split** keeps logic testable: `planResetTargets`,
  `buildServiceUrls`, `gatewayPathFor`/`dockerBuildArgsFor`/`prerequisiteServices`
  are pure and unit-tested; AWS/docker/terraform orchestration is verified by this
  live run.
- **Build count:** `deploy.ts` does one real `next build` on a warm redeploy
  (gateway exists) and skips the bootstrap build when the `<image>:local` already
  exists (`docker image inspect`); a fully cold deploy with no local image does a
  placeholder build + the real build.
- **Floci endpoint:** the CLI runs host-side → `http://localhost:4566`.

## Status

All four orchestration shell scripts (+ the reset script) replaced by manifest-
driven TS commands and verified live. Platform unit suite: 135 tests green; lint

- typecheck clean.
