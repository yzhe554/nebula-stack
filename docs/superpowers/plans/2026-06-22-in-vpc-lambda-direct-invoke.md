# In-VPC Lambda + Direct SDK Invoke Implementation Plan (Spec C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every Lambda in the VPC (zone-configurable, default `internal`), let the payments ECS task invoke the payment-api Lambda directly via the AWS SDK (over the Lambda interface endpoint from Spec B), make the payment-api accept a raw direct-invoke payload, switch the payments browser to a same-origin server route (eliminating `force-dynamic`/`NEXT_PUBLIC_PAYMENT_API_BASE_URL`), and remove the `payment-api-ingress` API Gateway from the demo.

**Architecture:** A new `zone` field on the lambda schema drives `vpc_config` (subnets via Spec A's `vpcDataSources` keyed by zone) + a lambda SG + the AWS-managed VPC-access role policy. A new `ecs.permissions.lambda` declaration (mirroring `permissions.dynamodb`) adds an ECS **task role** with `lambda:InvokeFunction` and injects the target function's physical name as an env var. The payment-api Hono app gains a raw-payload branch. The payments app gets an `app/api/payments/route.ts` server handler that SDK-invokes the Lambda; the client posts same-origin.

**Tech Stack:** TypeScript (ESM, `tsx`), Zod 4, Vitest, Terraform JSON, AWS provider, Next.js, `@aws-sdk/client-lambda`, Hono.

**This implements Spec C** (`docs/superpowers/specs/2026-06-22-in-vpc-lambda-direct-invoke-design.md`). Depends on Spec A (VPC) + Spec B (endpoints), both applied.

---

## Ground Rules

- Platform tests/typecheck from `packages/platform/`; app typecheck via `pnpm --filter @repo/<app>`; `pnpm lint` from repo ROOT.
- **oxlint forbids `typescript/no-unsafe-type-assertion`** in source — type guards, not `as T`. Tests reuse the `resource()`/`data()`/`objectProperty()` accessors.
- **Do not `git commit`.** Each "Commit" step = `git add` + report diff. User commits.
- **Target-conditional where Floci can't follow** (mirrors Spec A/B): if Floci can't apply Lambda `vpc_config` or private invoke, the lambda emitter already injects `AWS_ENDPOINT_URL` for floci so the SDK hits `localhost:4566` directly — keep that path working. AWS-target generated Terraform is the correctness source; the live acceptance test is "payments submit persists to DynamoDB."
- **Generated files are gitignored** — verify byte-identical by snapshot-diff of real files, not `git diff`. Unit snapshot tests are the regression guard.

## Decisions baked in (from brainstorming + Spec B)

- **Lambda always in VPC, zone-configurable, default `internal`** (user's explicit choice).
- **`internal` zone reaches AWS APIs via interface endpoints (Spec B), no NAT** (security + performance; cost deprioritized). So the in-VPC Lambda reaches DynamoDB via the gateway endpoint and is invoked via the Lambda interface endpoint — both from Spec B. NAT is a deprioritized escape hatch.
- **`ecs.permissions.lambda` mirrors `permissions.dynamodb`** (IAM + function-name env).
- This **supersedes Plan 3's payments env approach**: remove the `PAYMENT_API_BASE_URL` server-prop + `force-dynamic` wiring; replace with a same-origin route handler reading `PAYMENT_API_FUNCTION_NAME`.

## Background: verified current state

- `schemas/lambda.schema.ts`: `lambdaSchema = z.object({ runtime, handler, package, memoryMb, timeoutSeconds, logRetentionDays, environment, permissions: { dynamodb: [...] } })` — NOT `.strict()`. No `zone` field.
- `src/services/lambda/terraform.ts`: `terraformForLambda(service, options)` emits `aws_iam_role.<name>_lambda_role` + basic-execution attachment + dynamodb policy + log group + `aws_lambda_function.<name>` with `environment.variables` (includes `AWS_ENDPOINT_URL` when `target==="floci"`). NO `vpc_config`. Uses `physicalName`, `terraformName`.
- `src/terraform/vpc-lookup.ts`: `vpcDataSources(metadata)` returns `data.aws_vpc.selected` (by `tag:Name = <env>-<venture>-<vpc>-vpc`) + `data.aws_subnets.selected` (by `vpc-id` + `tag:Zone = metadata.securityZone`). NOTE: it keys subnets off `metadata.securityZone`. For Lambda we need a **zone override** (the lambda's configured `zone`, default internal), which may differ from the file-path `securityZone` — so we need a zone-parameterized variant (see Task 2).
- `src/services/ecs/terraform.ts`: ECS has only a **task execution role** named `<resource>_task_execution_role` (EC2 variant ~line 35, Fargate variant ~line 398). There is NO task role. `permissions` does not exist on ECS today. The Fargate task def references `execution_role_arn` but no `task_role_arn`.
- `schemas/ecs.schema.ts`: `ecsSchema` is `.strict()` with `cluster`/`service`/`task`/`image`/`healthCheck`. No `permissions`. (Plan 4, ECS env, may have added `env` — check at execution; this plan adds `permissions.lambda` independently.)
- `src/registry.ts` / `serviceNamesFromManifest`: maps service name → physical name for dynamodb/lambda/ecs. Use it to resolve the target Lambda's physical name for the IAM ARN + env var.
- `src/services/lambda/index.ts`: `lambdaPlugin` has a `validateReferences` (for dynamodb refs). ECS plugin (`src/services/apigateway/index.ts` pattern) similar.
- `apps/payment-api/index.ts`: `createApp({tableName, dynamoDbClient})` builds a Hono app with `POST /api/payments` that writes DynamoDB and returns `{customerId, stored:true}`. `handler` = `handle(createApp(...))` (API Gateway event adapter). `createRuntimeOptions` reads `TABLE_NAME` + builds a `DynamoDBClient` honoring `AWS_ENDPOINT_URL`.
- `apps/payments/app/`: after Plan 3, `page.tsx` is a server component reading `process.env.PAYMENT_API_BASE_URL` with `export const dynamic = "force-dynamic"`, passing it to `payments-form.tsx` (client) which `fetch`es `${paymentApiBaseUrl}/api/payments`.
- `infra/services/dev/venture/core/internal/payment-api-ingress.apigateway.yaml`: the Lambda-target API Gateway to be removed.

---

## File Structure (end state)

```
packages/platform/
  schemas/lambda.schema.ts             # MODIFIED: optional zone (default "internal")
  schemas/ecs.schema.ts                # MODIFIED: optional permissions.lambda
  src/types.ts                         # MODIFIED: LambdaConfig.zone?, EcsConfig.permissions?.lambda
  src/terraform/vpc-lookup.ts          # MODIFIED: vpcDataSourcesForZone(metadata, zone)
  src/services/lambda/terraform.ts     # MODIFIED: vpc_config + lambda SG + VPC-access policy
  src/services/ecs/terraform.ts        # MODIFIED: task role + permissions.lambda IAM + env (2 variants)
  src/services/network/endpoints.ts    # MODIFIED: derive "lambda" from ecs.permissions.lambda
apps/payment-api/index.ts              # MODIFIED: raw direct-invoke branch
apps/payments/app/api/payments/route.ts # NEW: server route handler, SDK InvokeCommand
apps/payments/app/page.tsx             # MODIFIED: drop force-dynamic + PAYMENT_API_BASE_URL
apps/payments/app/payments-form.tsx    # MODIFIED: fetch same-origin /api/payments
apps/payments/package.json             # MODIFIED: add @aws-sdk/client-lambda
infra/services/dev/venture/core/internal/payment-api-ingress.apigateway.yaml  # DELETED
infra/services/dev/venture/core/public/payments-app.ecs.yaml                  # MODIFIED: permissions.lambda
infra/services/dev/venture/core/internal/payment-api.lambda.yaml              # MODIFIED (optional): zone
```

---

### Task 1: Lambda `zone` schema + type (default `internal`)

**Files:**
- Modify: `packages/platform/schemas/lambda.schema.ts`
- Modify: `packages/platform/src/types.ts`
- Test: `packages/platform/tests/platform/` (add a focused schema test or extend an existing lambda schema test)

- [ ] **Step 1: Write the failing test**

Create `packages/platform/tests/platform/lambda-zone.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { lambdaSchema } from "../../schemas/lambda.schema";

const base = {
  runtime: "nodejs22.x", handler: "index.handler", package: "../x.zip",
  memoryMb: 128, timeoutSeconds: 10, logRetentionDays: 7, environment: {},
  permissions: { dynamodb: [] },
};

describe("lambdaSchema zone", () => {
  test("defaults zone to internal when omitted", () => {
    expect(lambdaSchema.parse(base).zone).toBe("internal");
  });
  test("accepts an explicit zone", () => {
    expect(lambdaSchema.parse({ ...base, zone: "restricted" }).zone).toBe("restricted");
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `cd packages/platform && pnpm vitest run tests/platform/lambda-zone.test.ts`
Expected: FAIL — `zone` undefined.

- [ ] **Step 3: Add `zone` to the schema**

In `lambda.schema.ts`, add to the object (before the closing `})`):
```ts
  zone: z.string().min(1).default("internal"),
```

- [ ] **Step 4: Add to `LambdaConfig` in `src/types.ts`**

Find `LambdaConfig` and add `zone: string;` (it's always present post-parse due to the default). Confirm the field exists where `runtime`/`handler` are.

- [ ] **Step 5: Run, confirm PASS (2 tests)**, then full suite + typecheck + lint. Commit checkpoint:

```bash
git add packages/platform/schemas/lambda.schema.ts packages/platform/src/types.ts packages/platform/tests/platform/lambda-zone.test.ts
```

> NOTE: adding a defaulted `zone` changes parsed lambda config (gains `zone: "internal"`). This does NOT change generated Terraform yet (Task 3 consumes it). But the JSON schema (`lambda.schema.json`) regenerates with the new property — run `pnpm schema:sync schemas` and stage the updated `lambda.schema.json`; the `json-schemas.test.ts` should stay green (it compares in-memory to file). Confirm.

---

### Task 2: Zone-parameterized VPC lookup

**Files:**
- Modify: `packages/platform/src/terraform/vpc-lookup.ts`
- Modify: `packages/platform/tests/platform/vpc-lookup.test.ts`

`vpcDataSources(metadata)` keys subnets off `metadata.securityZone`. Lambda needs to look up its configured `zone` (default internal), which may differ. Add a zone-explicit variant; keep the existing one delegating to it.

- [ ] **Step 1: Add failing test**

```ts
import { vpcDataSourcesForZone } from "../../src/terraform/vpc-lookup";

test("vpcDataSourcesForZone filters subnets by the given zone, not metadata.securityZone", () => {
  const data = vpcDataSourcesForZone(metadata, "internal"); // metadata.securityZone is "public"
  expect(data.aws_subnets).toEqual({
    selected: {
      filter: [
        { name: "vpc-id", values: ["${data.aws_vpc.selected.id}"] },
        { name: "tag:Zone", values: ["internal"] },
      ],
    },
  });
});
```
(Reuse the `metadata` fixture in that file, which has `securityZone: "public"`.)

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement**

```ts
export function vpcDataSourcesForZone(
  metadata: ServiceMetadata,
  zone: string,
): Record<string, unknown> {
  return {
    aws_vpc: {
      selected: { filter: { name: "tag:Name", values: [vpcNameTag(metadata)] } },
    },
    aws_subnets: {
      selected: {
        filter: [
          { name: "vpc-id", values: ["${data.aws_vpc.selected.id}"] },
          { name: "tag:Zone", values: [zone] },
        ],
      },
    },
  };
}
```
Refactor the existing `vpcDataSources(metadata)` to `return vpcDataSourcesForZone(metadata, metadata.securityZone);`. The existing vpc-lookup tests and all ECS snapshot tests must stay green (behavior identical for the existing caller).

- [ ] **Step 4: Run, confirm PASS**, full suite + typecheck + lint. Commit checkpoint:

```bash
git add packages/platform/src/terraform/vpc-lookup.ts packages/platform/tests/platform/vpc-lookup.test.ts
```

---

### Task 3: Lambda `vpc_config` + lambda SG + VPC-access policy

**Files:**
- Modify: `packages/platform/src/services/lambda/terraform.ts`
- Modify: `packages/platform/tests/platform/terraform.test.ts`

- [ ] **Step 1: Add failing tests** (extend the existing Lambda tests in `terraform.test.ts`)

```ts
test("lambda runs in the VPC: vpc_config with the configured zone subnets + lambda SG", () => {
  const service: LoadedService = {
    metadata: {
      env: "dev", venture: "venture", vpc: "core", securityZone: "internal",
      serviceName: "payment-api", serviceType: "lambda",
      sourcePath: "infra/services/dev/venture/core/internal/payment-api.lambda.yaml",
    },
    config: {
      runtime: "nodejs22.x", handler: "index.handler", package: "../x.zip",
      memoryMb: 128, timeoutSeconds: 10, logRetentionDays: 7, environment: {},
      zone: "internal",
      permissions: { dynamodb: [{ service: "customer-records", actions: ["dynamodb:PutItem"] }] },
    },
  };
  const tf = terraformResult(
    terraformForService(service, { target: "aws", serviceNames: { "customer-records": "dev-venture-core-managed-customer-records" } }),
  );
  const fn = resource(tf, "aws_lambda_function", "payment_api");
  expect(objectProperty(fn, "vpc_config")).toEqual({
    subnet_ids: "${data.aws_subnets.selected.ids}",
    security_group_ids: ["${aws_security_group.payment_api.id}"],
  });
  expect(resource(tf, "aws_security_group", "payment_api")["vpc_id"]).toBe("${data.aws_vpc.selected.id}");
  // VPC-access managed policy attached
  const attach = resource(tf, "aws_iam_role_policy_attachment", "payment_api_vpc_access");
  expect(attach["policy_arn"]).toBe("arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole");
  // VPC data sources present
  expect(data(tf, "aws_vpc", "selected")["filter"]).toEqual({ name: "tag:Name", values: ["dev-venture-core-vpc"] });
});
```

> The lambda SG resource key uses `resourceName = terraformName(serviceName)` → `payment_api`. Egress: allow all (443 to endpoints + dynamodb prefix list is simplest as allow-all egress; ingress none needed — Invoke is control-plane). Assert what you implement.

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement in `lambda/terraform.ts`**

- Import `vpcDataSourcesForZone` from `../../terraform/vpc-lookup`.
- Add a lambda SG resource: `aws_security_group.<resourceName> = { name: physicalName(metadata, "sg"), vpc_id: "${data.aws_vpc.selected.id}", egress: [{ from_port:0, to_port:0, protocol:"-1", cidr_blocks:["0.0.0.0/0"] }], tags }`. (Inline egress on aws_security_group requires all attributes; if Terraform complains as it did for routes in Spec A, use a separate `aws_security_group_rule.<name>_egress`. Prefer the separate rule to match Spec A's lesson. Assert accordingly.)
- Add `vpc_config: { subnet_ids: "${data.aws_subnets.selected.ids}", security_group_ids: ["${aws_security_group.<resourceName>.id}"] }` to `aws_lambda_function`.
- Add `aws_iam_role_policy_attachment.<resourceName>_vpc_access = { role: "${aws_iam_role.<roleName>.name}", policy_arn: "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole" }`.
- Pass the VPC data sources to `baseTerraform`'s data arg: merge `vpcDataSourcesForZone(metadata, service.config.zone)` into the data block.
- Add `vpc_config`'s dependency: the Lambda should `depends_on` the VPC-access attachment (ENIs need the policy). Add to the existing `depends_on` array.

> FLOCI caveat: Lambda-in-VPC on Floci may not resolve `data.aws_subnets.selected` if the network module isn't applied, or Floci may not support Lambda VPC config. The lambda already injects `AWS_ENDPOINT_URL` for floci so the SDK hits localhost. Decision: emit `vpc_config` for BOTH targets (it references the network module's subnets, which Spec A deploys on floci too). If Floci can't apply Lambda vpc_config, make `vpc_config` aws-target-only (like flow logs) and document — verify in Task 9. Default: emit for both; fall back to aws-only if the live test fails.

- [ ] **Step 4: Run, confirm PASS**, full suite + typecheck + lint. Commit checkpoint:

```bash
git add packages/platform/src/services/lambda/terraform.ts packages/platform/tests/platform/terraform.test.ts
```

---

### Task 4: ECS task role + `permissions.lambda` (schema + IAM + env)

**Files:**
- Modify: `packages/platform/schemas/ecs.schema.ts`
- Modify: `packages/platform/src/types.ts`
- Modify: `packages/platform/src/services/ecs/terraform.ts`
- Modify: `packages/platform/tests/platform/terraform.test.ts`

- [ ] **Step 1: Add `permissions.lambda` to the ECS schema + type**

In `ecs.schema.ts`, add an optional `permissions` to the top-level object (keep `.strict()`):
```ts
    permissions: z
      .object({
        lambda: z
          .array(z.object({
            service: z.string().min(1),
            actions: z.array(z.enum(["lambda:InvokeFunction"])).min(1),
          }))
          .default([]),
      })
      .strict()
      .optional(),
```
In `src/types.ts` `EcsConfig`, add:
```ts
  permissions?: { lambda: Array<{ service: string; actions: Array<"lambda:InvokeFunction"> }> };
```
Regenerate `ecs.schema.json` (`pnpm schema:sync schemas`); stage it.

- [ ] **Step 2: Add failing emitter test**

```ts
test("ecs permissions.lambda grants InvokeFunction on the target + injects function name env", () => {
  const service: LoadedService = {
    metadata: {
      env: "dev", venture: "venture", vpc: "core", securityZone: "public",
      serviceName: "payments-app", serviceType: "ecs",
      sourcePath: "infra/services/dev/venture/core/public/payments-app.ecs.yaml",
    },
    config: {
      cluster: { capacity: "fargate" }, service: { desiredCount: 1, containerPort: 3002 },
      task: { cpu: 256, memoryMb: 512 }, image: { repository: "nebula-payments", tag: "local" },
      healthCheck: { path: "/payments" },
      permissions: { lambda: [{ service: "payment-api", actions: ["lambda:InvokeFunction"] }] },
    },
  };
  const tf = terraformResult(
    terraformForService(service, { target: "aws", serviceNames: { "payment-api": "dev-venture-core-internal-payment-api" } }),
  );
  // task role exists (distinct from execution role)
  const taskRole = resource(tf, "aws_iam_role", "payments_app_task_role");
  expect(taskRole["name"]).toBe("dev-venture-core-public-payments-app-task-role");
  // invoke policy on the task role
  const policy = resource(tf, "aws_iam_role_policy", "payments_app_lambda_invoke");
  const doc = JSON.parse(policy["policy"] as string);
  expect(doc.Statement[0].Action).toEqual(["lambda:InvokeFunction"]);
  expect(doc.Statement[0].Resource).toBe("arn:aws:lambda:ap-southeast-2:*:function:dev-venture-core-internal-payment-api");
  // task def references the task role + injects the function name env
  const taskDef = resource(tf, "aws_ecs_task_definition", "payments_app");
  expect(taskDef["task_role_arn"]).toBe("${aws_iam_role.payments_app_task_role.arn}");
  const container = JSON.parse(taskDef["container_definitions"] as string)[0];
  expect(container.environment).toContainEqual({ name: "PAYMENT_API_FUNCTION_NAME", value: "dev-venture-core-internal-payment-api" });
});
```

> The env var name: derive as `<SERVICE_UPPER_SNAKE>_FUNCTION_NAME`, i.e. `payment-api` → `PAYMENT_API_FUNCTION_NAME`. Implement a helper `functionNameEnvKey(serviceName)` = `serviceName.toUpperCase().replace(/-/g, "_") + "_FUNCTION_NAME"`. The `JSON.parse(... as string)` casts are in TESTS; reuse the existing pattern in terraform.test.ts (it already JSON.parses policy docs — match that style).

- [ ] **Step 3: Run, confirm FAIL**

- [ ] **Step 4: Implement in `ecs/terraform.ts`**

This touches BOTH the Fargate and EC2 variants (and possibly floci). Focus on the Fargate variant (payments-app uses fargate); apply the same to EC2/floci variants for consistency. Steps:
- Add a **task role** `aws_iam_role.<resource>_task_role` with the ECS-tasks assume-role policy (`Service: "ecs-tasks.amazonaws.com"`). This is separate from the existing `<resource>_task_execution_role`.
- When `config.permissions?.lambda?.length`, add `aws_iam_role_policy.<resource>_lambda_invoke` on the task role: `lambda:InvokeFunction` on each target's ARN. Resolve the target physical name via `serviceNameFor(target.service, options, "...")` (the helper pattern used elsewhere; ECS may need to import/replicate it — the apigateway emitter has `serviceNameFor`). Build ARN `arn:aws:lambda:${regionForTarget(target)}:*:function:${physicalName}`.
- Add `task_role_arn: "${aws_iam_role.<resource>_task_role.arn}"` to `aws_ecs_task_definition` (alongside `execution_role_arn`).
- Inject env into the container definition: for each `permissions.lambda` target, add `{ name: functionNameEnvKey(target.service), value: <physical name> }` to the container's `environment` array. (If Plan 4's ECS `env` work added an `environment` builder, merge into it; otherwise add `environment` to the container object — note this interacts with byte-identical: only services WITH permissions.lambda get `environment`, so existing services stay unchanged.)
- Add a `functionNameEnvKey` helper.

> CAUTION (byte-identical): adding `task_role_arn` and a task role to EVERY ecs service would change docs-app/payments-app output even without permissions. To stay byte-identical for services WITHOUT `permissions.lambda`, gate the task role + task_role_arn + env on `config.permissions?.lambda?.length`. A service with no lambda permissions emits exactly as before. Assert this: a no-permissions ECS service has no `aws_iam_role.*_task_role` and no `task_role_arn`.

- [ ] **Step 5: Add the byte-identical guard test**

```ts
test("ecs without permissions.lambda emits no task role (byte-identical path)", () => {
  // docs-app fixture without permissions
  const tf = terraformResult(terraformForService(docsAppService, { target: "aws" }));
  expect(tf.resource["aws_iam_role"]["docs_app_task_role"]).toBeUndefined();
  const taskDef = resource(tf, "aws_ecs_task_definition", "docs_app");
  expect(taskDef["task_role_arn"]).toBeUndefined();
});
```

- [ ] **Step 6: Run, confirm PASS**, full suite + typecheck + lint. Commit checkpoint:

```bash
git add packages/platform/schemas/ecs.schema.ts packages/platform/schemas/ecs.schema.json packages/platform/src/types.ts packages/platform/src/services/ecs/terraform.ts packages/platform/tests/platform/terraform.test.ts
```

---

### Task 5: Derive `lambda` interface endpoint from `ecs.permissions.lambda`

**Files:**
- Modify: `packages/platform/src/services/network/endpoints.ts`
- Modify: `packages/platform/tests/platform/network-endpoints.test.ts`

Spec B left a comment placeholder. Now wire it.

- [ ] **Step 1: Add failing test**

```ts
test("an ecs service with permissions.lambda requires the lambda interface endpoint", () => {
  const ecsInvokingLambda: LoadedService = {
    metadata: {
      env: "dev", venture: "venture", vpc: "core", securityZone: "public",
      serviceName: "payments-app", serviceType: "ecs",
      sourcePath: "infra/services/dev/venture/core/public/payments-app.ecs.yaml",
    },
    config: {
      cluster: { capacity: "fargate" }, service: { desiredCount: 1, containerPort: 3002 },
      task: { cpu: 256, memoryMb: 512 }, image: { repository: "x", tag: "local" },
      healthCheck: { path: "/payments" },
      permissions: { lambda: [{ service: "payment-api", actions: ["lambda:InvokeFunction"] }] },
    },
  };
  expect(deriveRequiredAwsEndpoints([ecsInvokingLambda])).toEqual(["lambda"]);
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement**

In `deriveRequiredAwsEndpoints`, replace the Spec B comment with:
```ts
    if (service.metadata.serviceType === "ecs" && (service.config.permissions?.lambda?.length ?? 0) > 0) {
      required.add("lambda");
    }
```
Use a type guard `isEcsService` to avoid casts (mirror `isLambdaService`).

- [ ] **Step 4: Run, confirm PASS**, full suite + typecheck + lint. Commit checkpoint:

```bash
git add packages/platform/src/services/network/endpoints.ts packages/platform/tests/platform/network-endpoints.test.ts
```

---

### Task 6: payment-api accepts a raw direct-invoke payload

**Files:**
- Modify: `apps/payment-api/index.ts`
- Modify: `apps/payment-api/tests/` (extend existing tests)

- [ ] **Step 1: Add a failing test** (match the existing test style in `apps/payment-api/tests/`)

```ts
// in apps/payment-api/tests/*.test.ts
import { invokeDirect } from "../index";

test("invokeDirect writes the payload to DynamoDB and returns stored", async () => {
  const sent: unknown[] = [];
  const result = await invokeDirect(
    { customerId: "c1", message: "hi" },
    { tableName: "t", dynamoDbClient: { send: async (c) => { sent.push(c); return {}; } } },
  );
  expect(result).toEqual({ customerId: "c1", stored: true });
  expect(sent).toHaveLength(1);
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement**

Refactor `createApp`'s POST handler logic into a reusable `async function storePayment(body, options): Promise<{customerId, stored}>` that both the Hono route and a new `invokeDirect` call. Add:
```ts
export async function invokeDirect(body: PaymentBody, options: AppOptions) {
  return storePayment(paymentBodyFrom(body), options);
}
```
Add a Lambda handler entry that detects a raw payload (no API Gateway `requestContext`/`version` keys) and routes to `invokeDirect`, else falls through to the Hono `handle()`:
```ts
export function handler(event: unknown, ...rest: unknown[]) {
  if (isRawInvoke(event)) {
    return invokeDirect(event as PaymentBody, createRuntimeOptions());
  }
  runtimeHandler ??= createLambdaHandler(createRuntimeOptions());
  return runtimeHandler(event, ...rest);
}
function isRawInvoke(event: unknown): boolean {
  return typeof event === "object" && event !== null && !("requestContext" in event) && !("version" in event) && !("httpMethod" in event);
}
```
> The `event as PaymentBody` cast: oxlint applies to the platform package's lint config — confirm whether `apps/payment-api` is linted the same way (it may not be under the same `--deny-warnings` ruleset). If it is, narrow without a cast (parse via `paymentBodyFrom(event)` which already takes `unknown`). Prefer `invokeDirect(paymentBodyFrom(event), ...)` and drop the cast. Verify with `pnpm --filter @repo/payment-api typecheck` and repo-root `pnpm lint`.

- [ ] **Step 4: Run, confirm PASS**; `pnpm --filter @repo/payment-api typecheck` + `pnpm --filter @repo/payment-api test`. Commit checkpoint:

```bash
git add apps/payment-api/index.ts apps/payment-api/tests/
```

---

### Task 7: payments same-origin route handler + client fetch; remove force-dynamic

**Files:**
- Create: `apps/payments/app/api/payments/route.ts`
- Modify: `apps/payments/app/page.tsx`, `apps/payments/app/payments-form.tsx`
- Modify: `apps/payments/package.json` (add `@aws-sdk/client-lambda`)

- [ ] **Step 1: Add the SDK dependency**

```bash
pnpm --filter @repo/payments add @aws-sdk/client-lambda
```

- [ ] **Step 2: Create the route handler**

`apps/payments/app/api/payments/route.ts`:
```ts
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

export async function POST(request: Request) {
  const functionName = process.env.PAYMENT_API_FUNCTION_NAME;
  if (!functionName) {
    return Response.json({ error: "PAYMENT_API_FUNCTION_NAME not configured" }, { status: 500 });
  }
  const body = await request.json().catch(() => ({}));
  const client = new LambdaClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    endpoint: process.env.AWS_ENDPOINT_URL,
    credentials: process.env.AWS_ENDPOINT_URL ? { accessKeyId: "test", secretAccessKey: "test" } : undefined,
  });
  const result = await client.send(new InvokeCommand({
    FunctionName: functionName,
    Payload: Buffer.from(JSON.stringify(body)),
  }));
  const text = result.Payload ? Buffer.from(result.Payload).toString("utf8") : "{}";
  return new Response(text, { status: result.FunctionError ? 502 : 200, headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 3: Simplify `page.tsx`** — remove `force-dynamic` and the env-prop:
```tsx
import { PaymentsForm } from "./payments-form";

export default function PaymentsPage() {
  return <PaymentsForm />;
}
```

- [ ] **Step 4: Update `payments-form.tsx`** — drop the `paymentApiBaseUrl` prop and the "configure" warning logic; fetch same-origin:
- Remove the prop and `rawBaseUrl`/`isConfigured`/`defaultPaymentApiBaseUrl`.
- `submitPayment` fetches `"/api/payments"` (relative): `await fetch("/api/payments", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ customerId, message }) })`.
- Remove the `!isConfigured` branch and its warning JSX (the route handler now owns "not configured").

> NOTE: the `assetPrefix`/gateway-path still applies to static assets, so the form's relative `/api/payments` must resolve under the gateway base path. Because the route handler is a server route in the same Next app behind the same API Gateway, the browser's relative fetch resolves to the same gateway path automatically (the page was served from there). Verify in Task 9.

- [ ] **Step 5: Typecheck the app** — `pnpm --filter @repo/payments typecheck`. Commit checkpoint:

```bash
git add apps/payments/app/api/payments/route.ts apps/payments/app/page.tsx apps/payments/app/payments-form.tsx apps/payments/package.json pnpm-lock.yaml
```

---

### Task 8: Remove `payment-api-ingress` + wire the ECS env in the YAML

**Files:**
- Delete: `infra/services/dev/venture/core/internal/payment-api-ingress.apigateway.yaml`
- Modify: `infra/services/dev/venture/core/public/payments-app.ecs.yaml` (add `permissions.lambda`)
- Optional: `infra/services/dev/venture/core/internal/payment-api.lambda.yaml` (set `zone: internal` explicitly; default already internal)

- [ ] **Step 1: Add `permissions.lambda` to `payments-app.ecs.yaml`**

```yaml
permissions:
  lambda:
    - service: payment-api
      actions:
        - lambda:InvokeFunction
```

- [ ] **Step 2: Remove the ingress gateway**

```bash
git rm infra/services/dev/venture/core/internal/payment-api-ingress.apigateway.yaml
```

- [ ] **Step 3: Grep for references to the removed gateway**

```bash
grep -rn "payment-api-ingress" --include="*.sh" --include="*.json" --include="*.ts" packages scripts apps | grep -v __generated__
```
Fix any (shell scripts `floci-url.sh`/`floci-reset-all.sh`/`floci-deploy-payments.sh` reference it; remove those references, or note for Plan 5 if the CLI supersedes them). Do NOT break docs/payments deploy.

- [ ] **Step 4: Validate + generate**

```bash
pnpm platform:validate dev venture
pnpm platform:generate -- --env dev --venture venture --target aws
pnpm platform:generate -- --env dev --venture venture --target floci
```
Expected: validates; payment-api-ingress no longer generated; payments-app now has the task role + invoke policy + `PAYMENT_API_FUNCTION_NAME`; network module's aws endpoints now include `lambda` (interface) because of `permissions.lambda`.

- [ ] **Step 5: Inspect the derived lambda interface endpoint (aws)**

```bash
python3 -c "import json;d=json.load(open('infra/services/dev/venture/core/__generated__/aws/network/main.tf.json'));print(sorted(d['resource'].get('aws_vpc_endpoint',{}).keys()))"
```
Expected: `['dynamodb', 'lambda']`.

- [ ] **Step 6: Commit checkpoint**

```bash
git add infra/services/ packages/ scripts/
git rm infra/services/dev/venture/core/internal/payment-api-ingress.apigateway.yaml
```
Report.

---

### Task 9: Verification + live Floci acceptance

- [ ] **Step 1: Full green** — repo root `pnpm lint && pnpm --filter @repo/platform typecheck && pnpm --filter @repo/platform test && pnpm --filter @repo/payment-api test && pnpm --filter @repo/payments typecheck`.

- [ ] **Step 2: Byte-identical for unaffected services** — snapshot-diff (real files; generated is gitignored) for customer-records, docs, docs-app (NOT payments-app, NOT payment-api, NOT network — those intentionally change). Expected unchanged.

- [ ] **Step 3: Live Floci** — reset + redeploy the demo:
```bash
pnpm floci:reset:all || true
pnpm platform:deploy -- --env dev --venture venture --target floci --services network,customer-records,payment-api
pnpm platform:deploy -- --env dev --venture venture --target floci --services docs-app,docs
# payments: build image + deploy (the CLI/scripts may handle this; otherwise platform:deploy payments-app,payments)
pnpm payments:build && pnpm payments:docker:build
pnpm platform:deploy -- --env dev --venture venture --target floci --services payments-app,payments
```
> If Floci can't apply Lambda `vpc_config`, make it aws-target-only (Task 3 fallback) and redeploy. Document.

- [ ] **Step 4: Acceptance — payment persists via SDK invoke (no gateway)**

- Confirm docs/payments API Gateway URLs still 200 (regression).
- Submit a payment through the payments UI path (or invoke the payments `/api/payments` route directly via the gateway URL): POST to `http://localhost:4566/execute-api/<payments-id>/$default/api/payments` with `{customerId, message}`.
- Verify the item landed in DynamoDB:
```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
NO_PROXY=localhost,127.0.0.1 env -u HTTP_PROXY -u HTTPS_PROXY \
aws --endpoint-url=http://localhost:4566 dynamodb get-item \
  --table-name dev-venture-core-managed-customer-records \
  --key '{"customerId":{"S":"<the id you sent>"}}' --query 'Item.customerId' --output json
```
Expected: the item exists — proving the payments→SDK-invoke→Lambda→DynamoDB path works WITHOUT the `payment-api-ingress` gateway.

- [ ] **Step 5: Write `docs/verify-spec-c-in-vpc-lambda.md`** recording commands + results (mirror existing verify docs). Note any Floci target-conditional fallback used.

- [ ] **Step 6: Final commit checkpoint** — `git add -A` the spec-c changes + verify doc; report summary.

---

## Self-Review Notes

- **Spec coverage:** §Goal 1 (lambda always in VPC, zone-configurable) → Tasks 1-3. §2 (ecs→lambda SDK invoke, IAM+env) → Task 4. §3 (payment-api raw invoke) → Task 6. §4 (payments same-origin route, drop force-dynamic/NEXT_PUBLIC) → Task 7. §5 (remove payment-api-ingress) → Task 8. §6 (conditional NAT) → NOT IMPLEMENTED, see gap. §7 (conditional public apigateway) → no-op (capability retained, just unused) — covered by removal in Task 8 + apigateway plugin untouched. Spec B lambda-endpoint derivation → Task 5.
- **Gap — conditional NAT (spec §6):** deliberately deferred. Per the Spec B zone-model decision, `internal` reaches AWS via interface endpoints (no NAT), so the demo needs no NAT and nothing exercises it. Building an unused NAT mechanism is YAGNI now; add it when a zone genuinely needs general outbound internet. Documented here rather than silently dropped.
- **Supersedes Plan 3:** Task 7 removes Plan 3's `force-dynamic` + `PAYMENT_API_BASE_URL` server-prop wiring. If Plan 3 isn't applied in the working tree at execution time, adapt (the page may still be the original client component) — Task 7's end state is the target regardless.
- **Byte-identical discipline:** lambda gains vpc_config (intended change to payment-api only); ecs task role gated on `permissions.lambda` so other ECS services stay identical (asserted in Task 4 Step 5). Task 9 Step 2 verifies unaffected services.
- **Placeholders:** none. Floci fallbacks (lambda vpc_config aws-only) are bounded with a default + verify step.
- **oxlint:** flagged the `as` spots (payment-api event narrowing; test JSON.parse) with cast-free alternatives.
- **Type consistency:** `vpcDataSourcesForZone`, `functionNameEnvKey`, `invokeDirect`, `storePayment`, `PAYMENT_API_FUNCTION_NAME`, `permissions.lambda` used consistently across tasks.
- **Ordering:** schema/types (1,4) → emitters (2,3,4) → derivation (5) → apps (6,7) → infra wiring/removal (8) → verify (9). Each task independently testable.
```
