# In-VPC Lambda + Direct SDK Invoke — Design (Spec C)

**Date:** 2026-06-22
**Status:** Drafted (not yet implemented). Depends on Spec A (Real VPC) and Spec B (VPC endpoints).

## Context

Final of three specs for the banking-grade private-invocation requirement. Specs A and B build the foundation (real VPC with private internal zone; VPC endpoints for private AWS access). Spec C changes how the payment-api Lambda is deployed and invoked.

The user's requirements, verbatim, that drive this spec:

1. **Lambda is always deployed in the VPC.**
2. **An app in the same VPC connects to the Lambda directly using the AWS SDK** (not via HTTP/API Gateway).
3. **If the Lambda needs external (outbound internet) access, we create a NAT; if it needs to be reached by the public, we put API Gateway in front of it.**

For the demo specifically: payment-api goes VPC-internal, payments calls it via SDK, the `payment-api-ingress` API Gateway is removed. API Gateway support stays in the platform but becomes opt-in for public/third-party exposure.

This also resolves a prior pain point: the payments app's `NEXT_PUBLIC_PAYMENT_API_BASE_URL` → runtime-env → `force-dynamic` workaround disappears, because the browser now calls the payments app's own same-origin `/api/payments`, and the payments **server** invokes the Lambda via SDK (no cross-service URL reaches the browser).

## Problem (current state, verified)

- payment-api Lambda is **regional** — `lambda/terraform.ts` emits no `vpc_config`. It's not in the VPC.
- It's fronted by `payment-api-ingress.apigateway.yaml` (a Lambda-target API Gateway) purely so the in-VPC payments app can reach it over HTTP.
- The payments **browser** calls that gateway cross-origin via `fetch(${PAYMENT_API_BASE_URL}/api/payments)`.
- The Lambda uses Hono's `hono/aws-lambda` adapter (`handle()`), which expects an **API Gateway event** shape as input.

This is the wrong topology for a bank: the internal payment API is exposed through a public-style gateway, and the browser holds its URL.

## Goals

1. **Lambda always in VPC, zone-configurable (default `internal`).** Every lambda gets `vpc_config` placing its ENIs in the configured zone's subnets (default `internal`) + a lambda security group. The zone is a field in the lambda YAML, defaulting to `internal`.
2. **ECS → Lambda direct SDK invoke.** A new `ecs.permissions.lambda` declaration grants the ECS task role `lambda:InvokeFunction` on the target and injects the target's physical function name as an env var. The payments server uses the AWS SDK `InvokeCommand` (routed through the Lambda interface endpoint from Spec B).
3. **payment-api accepts direct invoke.** The handler accepts a raw JSON payload (direct `Invoke`) in addition to / instead of the API Gateway event shape.
4. **payments app: same-origin server route.** Browser → payments' own `/api/payments` (a Next.js route handler / server action) → server-side SDK `Invoke`. Removes `NEXT_PUBLIC_PAYMENT_API_BASE_URL`, the runtime env, and `force-dynamic`.
5. **Remove `payment-api-ingress`** from the demo infra.
6. **Conditional NAT:** a lambda that declares it needs outbound internet gets a NAT gateway (in a public subnet) + an internal route to it. Default: no NAT.
7. **Conditional public API Gateway:** API Gateway in front of a Lambda remains supported, used only when a function must be public/third-party. The platform keeps the apigateway→lambda capability; it's just not used for payment-api anymore.

## Non-Goals

- Cognito auth / token forwarding (tracked separately in the cognito-auth plan).
- Multi-region, cross-VPC invoke.
- Changing DynamoDB access (Lambda still writes DynamoDB via the gateway endpoint from Spec B).

## Guiding principles (from brainstorming)

- **Always in VPC, zone configurable** (the user's explicit choice over "no opt-out" and "opt-out allowed").
- **`permissions.lambda` mirrors the existing `permissions.dynamodb` pattern** (IAM policy on the task role + function-name env var).
- Direct SDK invoke over the **Lambda interface endpoint** (Spec B), not HTTP.
- Reuse Spec A's `vpcDataSources` (by-tag subnet/VPC lookup) for the Lambda's `vpc_config`.
- **Floci caveat:** Lambda VPC config / interface-endpoint invoke may behave differently on Floci (as flow logs, source-SG rules, and likely endpoints do). Target-conditional where needed; AWS-target generated Terraform is the correctness source. The live acceptance test remains: payments can submit a payment and it persists to DynamoDB.

---

## Architecture

### 1. Lambda always in VPC (zone-configurable)

Extend `lambdaSchema` with an optional `zone` field (default `"internal"`). The lambda emitter:
- Adds `vpc_config` to `aws_lambda_function`:
  ```
  vpc_config {
    subnet_ids         = <subnets of the lambda's zone, via vpcDataSources>
    security_group_ids = [${aws_security_group.<lambda>.id}]
  }
  ```
- Creates a dedicated lambda security group in the VPC (egress to the endpoint SG / DynamoDB; ingress not needed for invoke — Invoke is control-plane, not data-plane to the ENI).
- Uses Spec A's `vpcDataSources(metadata)` but keyed by the lambda's configured `zone` rather than its file-path `securityZone` (lambdas live under `internal/` already, so default aligns; the `zone` field allows override without moving the file).
- Adds the AWS-managed `AWSLambdaVPCAccessExecutionRole` policy attachment (Lambda in VPC needs ENI-management permissions) alongside the existing basic-execution attachment.

CAVEAT — Lambda-in-VPC + DynamoDB: once in the internal zone (no internet route), the Lambda reaches DynamoDB only via the **gateway endpoint** (Spec B) and CloudWatch Logs via the **logs interface endpoint** (Spec B). This is why Spec B precedes C. Verify the Lambda's outbound SG egress permits 443 to the endpoint SG and the DynamoDB prefix list.

### 2. `ecs.permissions.lambda` (IAM + env), mirroring `permissions.dynamodb`

Extend `ecsSchema` with:
```yaml
permissions:
  lambda:
    - service: payment-api
      actions: [lambda:InvokeFunction]
```
The ECS emitter (mirroring the lambda→dynamodb policy pattern in `lambda/terraform.ts`):
- Emits an `aws_iam_role_policy` on the ECS **task role** allowing the declared actions on the target Lambda's ARN (resolved via the manifest's physical name — `serviceNames` map / registry).
- Injects an env var with the target function's physical name, e.g. `PAYMENT_API_FUNCTION_NAME=dev-venture-core-internal-payment-api`, so the app's SDK call knows what to invoke. (Naming convention: `<SERVICE>_FUNCTION_NAME` upper-snake, or a generic `LAMBDA_<service>` — decide at implementation; keep it derivable.)
- NOTE: ECS tasks currently may only have an execution role; invoking Lambda needs a **task role** (distinct from execution role). If the ECS emitter doesn't already create a task role, add one. Verify against current `ecs/terraform.ts`.

This also makes `ecs.permissions.lambda` the Spec B derivation trigger for the **lambda interface endpoint**.

### 3. payment-api accepts direct invoke

`apps/payment-api/index.ts` uses `hono/aws-lambda`'s `handle()` (API Gateway event shape). Direct `InvokeCommand` sends a **raw JSON payload**. Options:
- **Preferred:** add a thin handler branch that detects a raw payload (no `requestContext`/`httpMethod` keys of an APIGW event) and routes it straight into the app logic (call the same DynamoDB write path with the parsed body), bypassing the Hono HTTP adapter. Keep the Hono app for any remaining HTTP/public path.
- Keep `createApp`'s core logic (the DynamoDB write) reusable so both the HTTP adapter and the direct-invoke branch call it.

The contract for direct invoke: input `{ customerId, message }`, output `{ customerId, stored: true }` (JSON), matching today's HTTP response body.

### 4. payments app: same-origin server route

- Add a Next.js **route handler** at `apps/payments/app/api/payments/route.ts` (server-side POST) that:
  - reads the target function name from `process.env.PAYMENT_API_FUNCTION_NAME` (runtime ECS env, injected by `permissions.lambda`),
  - calls AWS SDK `LambdaClient.send(new InvokeCommand({ FunctionName, Payload }))`,
  - returns the Lambda's JSON response.
- The client `payments-form.tsx` calls `fetch("/api/payments", …)` — **same-origin, relative** — instead of an absolute cross-service URL.
- This removes `NEXT_PUBLIC_PAYMENT_API_BASE_URL`, the runtime `PAYMENT_API_BASE_URL` prop plumbing from Spec/Plan 3, AND `export const dynamic = "force-dynamic"` (the page no longer depends on a runtime env var for client rendering — the server route reads the function name at request time, which is fine for a route handler).
  - NOTE: reconcile with Plan 3 (app-derivation/Dockerfile), which converted payments to a server-prop reading `PAYMENT_API_BASE_URL`. Spec C supersedes that: the value the server needs is now `PAYMENT_API_FUNCTION_NAME`, consumed in the route handler, not passed to the client. Update/remove the Plan 3 page/prop wiring accordingly.

### 5. Remove `payment-api-ingress` from the demo

- Delete `infra/services/dev/venture/core/internal/payment-api-ingress.apigateway.yaml`.
- Remove references in shell scripts / the Plan 5 CLI (`floci-url`, reset, deploy bootstrap) to the payment-api gateway. (If Plan 5's CLI is already implemented, update its manifest-driven logic; if not, note it for Plan 5.)
- The apigateway→lambda capability stays in the platform (apigateway plugin unchanged) for future public Lambdas.

### 6. Conditional NAT gateway

- Add an optional lambda (or network) declaration that a zone/function needs outbound internet, e.g. `network.yaml` zone flag or a lambda `egress: internet` field.
- When set, the network module (Spec A) emits an `aws_nat_gateway` in a public subnet + an EIP + an internal-zone route `0.0.0.0/0 → nat`. Default: none (internal stays internet-less).
- Demo payment-api does NOT need NAT (DynamoDB via gateway endpoint). So NAT is built but unused in the demo — implement the mechanism + a unit test, keep it off by default.

### 7. Conditional public API Gateway

No new work beyond keeping the apigateway plugin's lambda-target support. Document that a public Lambda gets an `apigateway.yaml` with a `target: { type: lambda, service: <fn> }`; an internal-only Lambda (the demo) gets none. The platform already supports this — Spec C just stops using it for payment-api.

---

## Data flow (demo, after Spec C)

```
Browser → POST /payments app's own /api/payments (same origin, via the app's gateway path)
  → payments Next.js route handler (server, in-VPC ECS task)
     reads PAYMENT_API_FUNCTION_NAME (runtime env from ecs.permissions.lambda)
     AWS SDK InvokeCommand(FunctionName, {customerId,message})
       → Lambda interface VPC endpoint (Spec B, private)
         → payment-api Lambda (in internal zone, Spec C vpc_config)
            → DynamoDB via gateway endpoint (Spec B)
            → returns {customerId, stored:true}
  → route handler returns JSON to browser
```
No public internet, no API Gateway, no cross-service URL in the browser.

## Validation / error handling

- `ecs.permissions.lambda[].service` must reference a real lambda service (mirror the existing dynamodb reference validation in the registry's `validateReferences`).
- Lambda `zone` must be a zone declared in `network.yaml` with subnets.
- If a lambda is in VPC and writes DynamoDB but no dynamodb gateway endpoint is derivable (Spec B) → fail with a clear message (the internet-less Lambda would otherwise silently fail at runtime).

## Testing

- **Unit (lambda emitter):** `vpc_config` present with the configured zone's subnets + lambda SG; `AWSLambdaVPCAccessExecutionRole` attached; `zone` defaults to `internal`, overridable.
- **Unit (ecs emitter):** `permissions.lambda` → task-role IAM policy with `lambda:InvokeFunction` on the resolved ARN + `PAYMENT_API_FUNCTION_NAME` env injected; task role created.
- **Unit (payment-api app):** direct-invoke branch handles a raw `{customerId,message}` payload and writes DynamoDB, returning `{customerId,stored:true}`; the HTTP/Hono path still works.
- **Unit (validation):** unknown lambda reference rejected; lambda zone must have subnets.
- **Removal:** `payment-api-ingress` gone; no dangling references.
- **Live (Floci) acceptance:** payments page submits a payment → it persists to DynamoDB (the SDK-invoke path works end-to-end), WITHOUT the API Gateway in front of the Lambda. docs/payments page URLs still 200. (Floci Lambda-VPC/endpoint fidelity may require target-conditional handling; if Floci can't do private invoke, fall back to `AWS_ENDPOINT_URL`-style direct SDK to localhost as the lambda emitter already does for DynamoDB — verify and document.)

## Sequencing within Spec C

1. Lambda `zone` schema field + `vpc_config` + lambda SG + VPC-access role policy (unit tests).
2. ECS task role + `ecs.permissions.lambda` schema + IAM policy + function-name env (unit tests).
3. payment-api app: direct-invoke branch (unit tests).
4. payments app: `/api/payments` route handler + client fetch to same-origin; remove `NEXT_PUBLIC_PAYMENT_API_BASE_URL` / `force-dynamic` / Plan-3 prop wiring.
5. Remove `payment-api-ingress.apigateway.yaml` + references.
6. Conditional NAT mechanism (unit test; off in demo).
7. Live verify on Floci: payment submit persists to DynamoDB without the gateway; docs/payments 200.

## Interaction with earlier plans

- **Supersedes Plan 3's payments env approach:** Plan 3 made payments read `PAYMENT_API_BASE_URL` as a server prop with `force-dynamic`. Spec C replaces that with a same-origin route handler reading `PAYMENT_API_FUNCTION_NAME`. When implementing, remove the now-obsolete prop/`force-dynamic` wiring rather than layering on top.
- **Plan 5 (TS CLI):** its deploy/url/reset logic references the payment-api gateway. With `payment-api-ingress` removed, Plan 5's manifest-driven CLI naturally drops it (no hardcoded gateway). If Plan 5 ships before Spec C, update its expectations; if after, Spec C's removal is already reflected.
- **Depends on Spec B** for the Lambda interface endpoint (private invoke) and the DynamoDB gateway endpoint (Lambda's DB access from the internet-less internal zone).
