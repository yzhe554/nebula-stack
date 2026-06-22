# Floci Local Deploy — Troubleshooting & Behavior Notes

Notes on how the Floci (local LocalStack-style) deploy behaves and how to resolve
the issues most likely to bite during local development. None of this affects the
real `aws` target — every workaround below is gated on `target === "floci"`.

## Stable API Gateway URLs across redeploys

**Behavior:** `pnpm floci:reset:all` does **not** delete the API Gateways (nor the
`network` module). Only ECS services/clusters/ALBs, the Lambda + its IAM/SG/log
group, ECS task roles, and DynamoDB are torn down. The gateway and its Terraform
state are preserved.

**Why:** Floci assigns a **random `execute-api` id** every time a gateway is
created. The Next.js apps bake that id into their static `assetPrefix` at build
time (`/execute-api/<id>/$default/...`). If a redeploy minted a new id, an
already-built container would request its assets under the _old_ id → 404s →
Next router retries → broken page. Preserving the gateway means `terraform apply`
re-uses the existing id, so:

```
pnpm floci:reset:all       # gateways kept, id unchanged
pnpm floci:deploy:all      # gateway shows "No changes"; same URL as before
```

The gateway URLs therefore stay stable across `redeploy:all`. (Implemented in
`packages/platform/src/cli/reset.ts` — `planResetTargets` skips `apigateway`
entries; see the comment there.)

**AWS:** N/A — `floci:reset:all` is a local-only dev command and never runs
against AWS. On AWS the gateway uses a stable custom domain anyway.

## 431 "Request Header Fields Too Large" in the browser

**Symptom:** the gateway URL works via `curl` (200) but the **browser** returns 431.

**Cause:** Floci rejects requests whose headers exceed ~8KB. A dev browser often
accumulates a large `Cookie` jar for `localhost` (from everything else ever hosted
on `localhost:<port>`), pushing the request over the limit. This is **not** a
deploy/proxy/gateway-id problem — a direct `curl` with a big `Cookie` header also
431s; a small-header request returns 200.

**Fix (client-side):**

- Quickest: open the URL in an **incognito/private window** (no cookies) to
  confirm, then in your normal profile clear cookies for `localhost` /
  `localhost:4566` (DevTools → Application → Cookies).
- Or use a dedicated browser profile for Floci so the cookie jar stays small.

## Corporate proxy (`alpaca` on 127.0.0.1:3128)

If a local proxy is configured, make sure `localhost` bypasses it (the CLI already
sets `NO_PROXY` for its own SDK/spawn calls via `scrubbedEnv`, but the **browser**
uses the system/proxy settings). Add `localhost, 127.0.0.1, *.floci.localhost` to
the proxy's bypass list / macOS System Settings → Network → Proxies. (Note: the
431 above is a header-size limit in Floci, independent of the proxy.)

## Transient Floci IAM read-back ("empty result") during deploy

**Symptom:** `terraform apply` occasionally fails reading a freshly-created
`aws_iam_role_policy_attachment` (e.g. `AWSLambdaVPCAccessExecutionRole`) with
"empty result", even though it was created.

**Handling:** `src/deploy.ts` retries `terraform plan + apply` up to 3 times **on
the floci target only** when it sees this transient signature. The `aws` target
uses `maxAttempts = 1` (fail fast — no retry).

## Floci-only emitter workarounds (all gated; AWS output unaffected)

These are emitted differently for `floci` vs `aws`; the AWS-target generated
Terraform is the full, correct configuration.

| Resource                                                                 | Floci                                          | AWS                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------- |
| VPC Flow Logs                                                            | omitted (Floci `CreateFlowLogs` unsupported)   | emitted                                     |
| VPC endpoints (gateway + interface)                                      | omitted (SDK uses `AWS_ENDPOINT_URL` locally)  | emitted                                     |
| Inter-zone security-group rules                                          | omitted (Floci can't create source-SG rules)   | emitted (full segmentation)                 |
| ECS task env (`AWS_ENDPOINT_URL=host.docker.internal:4566` + test creds) | injected so the in-container SDK reaches Floci | not injected (task role + public endpoints) |
| Lambda `AWS_ENDPOINT_URL`                                                | injected                                       | not injected                                |
| ECS launch type (Floci variant)                                          | EC2                                            | Fargate                                     |
| Deploy `terraform apply` retries                                         | up to 3 on transient errors                    | 1 (fail fast)                               |

## Image tags

ECS task definitions are tagged with a **deterministic content hash** of the app's
build inputs (source tree + Dockerfile + gateway-path build arg), not the static
`:local`. Identical source ⇒ identical tag ⇒ no ECS task-def churn on a no-op
redeploy; a real change ⇒ new tag ⇒ ECS redeploys. This replaced an unconditional
`forceNewEcsDeployment`. See `docs/superpowers/specs/2026-06-22-content-hashed-image-tags-design.md`.
