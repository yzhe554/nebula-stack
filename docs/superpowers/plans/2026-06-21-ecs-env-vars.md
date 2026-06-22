# ECS Env Vars in YAML Implementation Plan

> **STATUS: OBSOLETE / NOT IMPLEMENTED (2026-06-22).**
> This plan's sole motivating consumer was injecting `PAYMENT_API_BASE_URL` into
> the payments app via an ECS `env` block with `ref: gatewayBaseUrl`. **Spec C
> eliminated that need**: the payments app now reaches the payment-api Lambda via
> AWS SDK `InvokeCommand` (using `PAYMENT_API_FUNCTION_NAME`, injected by
> `ecs.permissions.lambda`), not an HTTP gateway URL. The ECS emitter already
> emits a container `environment` array (added for `permissions.lambda` in Spec
> C), so the generic `env`/`ref` machinery here has no current user. Building it
> now would be speculative (YAGNI). Revisit only if a real need for arbitrary
> static/ref ECS env vars emerges. See `docs/superpowers/specs/2026-06-22-in-vpc-lambda-direct-invoke-design.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an ECS service declare runtime environment variables in its YAML — both static literals and references to another service's deployed gateway base URL — validated by the zod schema and emitted into the ECS task definition's container `environment`, with `ref` values resolved at deploy time from the service manifest.

**Architecture:** Extend `ecsSchema` with an optional `env` map: each value is either `{ static: string }` or `{ ref: { gatewayBaseUrl: string } }`. The ECS Terraform emitter gains an `environment` array in all three container-definition variants (ec2/fargate/floci), populated from a resolved env map passed through `TerraformContext`. A new resolver turns `ref` entries into concrete URLs using the manifest's `frontedByGateway`/gateway data plus the deploy target's endpoint. When no `env` is declared, NO `environment` key is emitted, preserving byte-identical output for existing services.

**Tech Stack:** TypeScript (ESM, `tsx`), Zod 4, Vitest.

**This is Plan 4 of the 5-plan sequence** (plugins ✅ → registry ✅-drafted → app/Dockerfile ✅-drafted → **ECS env** → TS CLI). Depends on Plan 2 (`src/registry.ts`). The actual deploy-time resolution wiring is consumed by Plan 5's CLI; this plan delivers the schema, the emitter support, and the pure resolver with unit tests.

---

## Ground Rules

- Run from `packages/platform/`. Test: `pnpm test`; repo-root `pnpm lint` + `pnpm typecheck` clean.
- **oxlint forbids `no-unsafe-type-assertion`** — use guards/discriminated unions, not `as T`.
- **Do not commit** — stage + report; user commits.
- **Behavior preservation is critical and subtle:** services that declare no `env` must produce byte-identical `main.tf.json`. The schema field is OPTIONAL and the emitter must omit the `environment` key entirely when there are no vars. Task 6 is the gate.
- **Pre-req:** Plan 2 (`src/registry.ts`) must exist. Plan 3 is independent of this plan and need not be applied first, but if both are applied the manifest already has the `app` field — harmless here.
- After regenerating committed JSON schemas, the `schemas/ecs.schema.json` file WILL change (new optional `env` property). That is expected and correct for this plan — unlike the Terraform `main.tf.json` which must NOT change. Keep these two straight.

## Background: verified current state

- `packages/platform/schemas/ecs.schema.ts` exports `ecsSchema` (a strict zod object: `cluster`, `service`, `task`, `image`, `healthCheck`, with a fargate cpu/memory superRefine). `.strict()` means adding `env` to a YAML without schema support would currently fail validation — so the schema must be extended first.
- `src/services/ecs/terraform.ts` builds `container_definitions: JSON.stringify([{ name, image, essential, portMappings, logConfiguration }])` in THREE places (ec2 ~line 110, fargate ~line 327, floci ~line 470 — grep `container_definitions` for exact current lines). ECS task definitions accept a container `environment: [{ name, value }]` array.
- `TerraformContext` (`src/terraform/context.ts`) currently has: `target?`, `moduleDirectory?`, `serviceNames?`, `serviceContainerPorts?`, `domainCertificateArns?`.
- JSON schema regeneration: `pnpm schema:sync <dir>` writes all `*.schema.json`. The ecs plugin's `jsonSchemaMetadata` drives `ecs.schema.json`.
- Gateway base URL shape (from `floci-url.sh` / shell scripts): for Floci a gateway base URL is `http://localhost:4566/execute-api/<api-id>/$default`. The `<api-id>` is only known at deploy time (post-apply), so `ref` resolution is a deploy-time concern — this plan provides the resolver function and emitter; Plan 5's CLI calls it with discovered IDs.

---

## File Structure (end state)

```
packages/platform/
  schemas/ecs.schema.ts                  # MODIFIED: optional env map
  schemas/ecs.schema.json                # REGENERATED
  src/types.ts                            # MODIFIED: EcsConfig gains env?
  src/terraform/context.ts               # MODIFIED: resolvedEcsEnv? on context
  src/services/ecs/terraform.ts          # MODIFIED: emit environment in 3 variants
  src/services/ecs/env.ts                # NEW: pure resolver (ref -> value)
  tests/platform/ecs-env.test.ts         # NEW
  tests/platform/terraform.test.ts       # MODIFIED: env emission assertions
  tests/platform/json-schemas.test.ts    # (verify still green after regen)
```

---

### Task 1: Extend the ECS schema with an optional `env` map

**Files:**
- Modify: `packages/platform/schemas/ecs.schema.ts`
- Modify: `packages/platform/src/types.ts`
- Test: `packages/platform/tests/platform/service-discovery.test.ts` or a focused schema test

- [ ] **Step 1: Add a failing schema test**

Create `packages/platform/tests/platform/ecs-env.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { ecsSchema } from "../../schemas/ecs.schema";

const baseConfig = {
  cluster: { capacity: "fargate" as const },
  service: { desiredCount: 1, containerPort: 3002 },
  task: { cpu: 256, memoryMb: 512 },
  image: { repository: "nebula-payments", tag: "local" },
  healthCheck: { path: "/payments" },
};

describe("ecsSchema env", () => {
  test("accepts a static env var", () => {
    const parsed = ecsSchema.parse({ ...baseConfig, env: { FOO: { static: "bar" } } });
    expect(parsed.env).toEqual({ FOO: { static: "bar" } });
  });

  test("accepts a gatewayBaseUrl ref", () => {
    const parsed = ecsSchema.parse({
      ...baseConfig,
      env: { PAYMENT_API_BASE_URL: { ref: { gatewayBaseUrl: "payment-api-ingress" } } },
    });
    expect(parsed.env?.PAYMENT_API_BASE_URL).toEqual({ ref: { gatewayBaseUrl: "payment-api-ingress" } });
  });

  test("rejects an env value that is neither static nor ref", () => {
    expect(() => ecsSchema.parse({ ...baseConfig, env: { BAD: { nonsense: 1 } } })).toThrow();
  });

  test("omitting env is valid", () => {
    expect(ecsSchema.parse(baseConfig).env).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `pnpm vitest run tests/platform/ecs-env.test.ts`
Expected: FAIL (the `nonsense` case currently throws due to `.strict()` at top level only if env isn't a known key — actually `env` is unknown so ALL cases throw today; that's the failing state we fix).

- [ ] **Step 3: Add the `env` field to `ecsSchema`**

In `ecs.schema.ts`, define the value union and add an optional `env` to the top-level object (before `.strict()`):

```ts
const ecsEnvValueSchema = z.union([
  z.object({ static: z.string() }).strict(),
  z.object({ ref: z.object({ gatewayBaseUrl: z.string().min(1) }).strict() }).strict(),
]);

// inside the top-level z.object({ ... }) add:
    env: z.record(z.string(), ecsEnvValueSchema).optional()
      .describe("Runtime environment variables for the ECS container. Values are a static string or a ref to another service's deployed gateway base URL."),
```

Keep `.strict()` on the top-level object (now `env` is a known key so it's allowed).

- [ ] **Step 4: Mirror the type in `src/types.ts`**

Find `EcsConfig` in `src/types.ts` and add:
```ts
export type EcsEnvValue = { static: string } | { ref: { gatewayBaseUrl: string } };
// in EcsConfig:
  env?: Record<string, EcsEnvValue>;
```
(Confirm `EcsConfig` is the type used by `LoadedService`'s ecs member; it is.)

- [ ] **Step 5: Run, confirm PASS (4 tests)**

Run: `pnpm vitest run tests/platform/ecs-env.test.ts`
Expected: PASS.

- [ ] **Step 6: Regenerate + verify the JSON schema changed as expected**

```bash
pnpm schema:sync schemas
git status --short schemas/
```
Expected: `schemas/ecs.schema.json` modified (now includes `env`), others unchanged. Then run `pnpm test` — `json-schemas.test.ts` should still pass (it compares the in-memory schema to the regenerated file; both now include env). If that test pins the committed file, regenerating updates it consistently. Confirm green.

- [ ] **Step 7: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/schemas/ecs.schema.ts packages/platform/schemas/ecs.schema.json packages/platform/src/types.ts packages/platform/tests/platform/ecs-env.test.ts
```
Report the diff (note ecs.schema.json is intentionally changed).

---

### Task 2: Pure env resolver (`ref` → concrete value)

**Files:**
- Create: `packages/platform/src/services/ecs/env.ts`
- Modify: `packages/platform/tests/platform/ecs-env.test.ts`

The resolver turns the YAML `env` map into a concrete `Record<string,string>`, given a lookup for gateway base URLs (provided at deploy time by the CLI; in tests, a stub).

- [ ] **Step 1: Add failing tests**

```ts
import { resolveEcsEnv } from "../../src/services/ecs/env";

describe("resolveEcsEnv", () => {
  const gatewayBaseUrl = (service: string) =>
    service === "payment-api-ingress"
      ? "http://localhost:4566/execute-api/abc123/$default"
      : undefined;

  test("passes static values through", () => {
    expect(resolveEcsEnv({ FOO: { static: "bar" } }, { gatewayBaseUrl })).toEqual({ FOO: "bar" });
  });

  test("resolves a gatewayBaseUrl ref", () => {
    expect(
      resolveEcsEnv(
        { PAYMENT_API_BASE_URL: { ref: { gatewayBaseUrl: "payment-api-ingress" } } },
        { gatewayBaseUrl },
      ),
    ).toEqual({ PAYMENT_API_BASE_URL: "http://localhost:4566/execute-api/abc123/$default" });
  });

  test("throws when a ref target gateway is unknown", () => {
    expect(() =>
      resolveEcsEnv({ X: { ref: { gatewayBaseUrl: "ghost" } } }, { gatewayBaseUrl }),
    ).toThrow(/unknown gateway/i);
  });

  test("returns empty object for undefined env", () => {
    expect(resolveEcsEnv(undefined, { gatewayBaseUrl })).toEqual({});
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement**

```ts
// packages/platform/src/services/ecs/env.ts
import type { EcsEnvValue } from "../../types";

export type EcsEnvResolution = {
  gatewayBaseUrl(serviceName: string): string | undefined;
};

export function resolveEcsEnv(
  env: Record<string, EcsEnvValue> | undefined,
  resolution: EcsEnvResolution,
): Record<string, string> {
  if (!env) {
    return {};
  }
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if ("static" in value) {
      resolved[key] = value.static;
      continue;
    }
    const url = resolution.gatewayBaseUrl(value.ref.gatewayBaseUrl);
    if (url === undefined) {
      throw new Error(
        `ECS env ${key} references unknown gateway service ${value.ref.gatewayBaseUrl}`,
      );
    }
    resolved[key] = url;
  }
  return resolved;
}
```

- [ ] **Step 4: Run, confirm PASS (8 tests in file)**. Suite + typecheck + lint.

- [ ] **Step 5: Commit (checkpoint)**

```bash
git add packages/platform/src/services/ecs/env.ts packages/platform/tests/platform/ecs-env.test.ts
```
Report the diff.

---

### Task 3: Thread resolved env through `TerraformContext`

**Files:**
- Modify: `packages/platform/src/terraform/context.ts`

- [ ] **Step 1: Add the field**

```ts
export type TerraformContext = {
  target?: DeployTarget;
  moduleDirectory?: string;
  serviceNames?: Record<string, string>;
  serviceContainerPorts?: Record<string, number>;
  domainCertificateArns?: Record<string, string>;
  resolvedEcsEnv?: Record<string, string>;
};
```

`resolvedEcsEnv` is the already-resolved `name→value` map for the service being generated (the generator/CLI resolves per-service before calling `terraformForService`). Keeping it pre-resolved keeps the emitter pure and synchronous.

- [ ] **Step 2: Typecheck + lint + full suite** (no behavior change yet). Commit checkpoint:

```bash
git add packages/platform/src/terraform/context.ts
```
Report the diff.

---

### Task 4: Emit `environment` in all three ECS container-definition variants

**Files:**
- Modify: `packages/platform/src/services/ecs/terraform.ts`
- Modify: `packages/platform/tests/platform/terraform.test.ts`

- [ ] **Step 1: Add a failing emitter test**

In `terraform.test.ts`, add a test that an ECS service generates `environment` when `resolvedEcsEnv` is provided, and OMITS it when empty:

```ts
test("emits container environment from resolvedEcsEnv", () => {
  const service: LoadedService = {
    metadata: {
      env: "dev", venture: "venture", vpc: "core", securityZone: "public",
      serviceName: "payments-app", serviceType: "ecs",
      sourcePath: "infra/services/dev/venture/core/public/payments-app.ecs.yaml",
    },
    config: {
      cluster: { capacity: "fargate" },
      service: { desiredCount: 1, containerPort: 3002 },
      task: { cpu: 256, memoryMb: 512 },
      image: { repository: "nebula-payments", tag: "local" },
      healthCheck: { path: "/payments" },
    },
  };

  const tf = terraformResult(
    terraformForService(service, {
      target: "floci",
      resolvedEcsEnv: { PAYMENT_API_BASE_URL: "http://localhost:4566/execute-api/abc/$default" },
    }),
  );
  const taskDef = resource(tf, "aws_ecs_task_definition", "payments_app");
  const containers = JSON.parse(taskDef.container_definitions as string) as Array<{
    environment?: Array<{ name: string; value: string }>;
  }>;
  expect(containers[0].environment).toEqual([
    { name: "PAYMENT_API_BASE_URL", value: "http://localhost:4566/execute-api/abc/$default" },
  ]);
});

test("omits container environment when no resolvedEcsEnv (byte-identical path)", () => {
  const service: LoadedService = { /* same payments-app config, no env */
    metadata: {
      env: "dev", venture: "venture", vpc: "core", securityZone: "public",
      serviceName: "payments-app", serviceType: "ecs",
      sourcePath: "infra/services/dev/venture/core/public/payments-app.ecs.yaml",
    },
    config: {
      cluster: { capacity: "fargate" },
      service: { desiredCount: 1, containerPort: 3002 },
      task: { cpu: 256, memoryMb: 512 },
      image: { repository: "nebula-payments", tag: "local" },
      healthCheck: { path: "/payments" },
    },
  };
  const tf = terraformResult(terraformForService(service, { target: "floci" }));
  const taskDef = resource(tf, "aws_ecs_task_definition", "payments_app");
  const containers = JSON.parse(taskDef.container_definitions as string) as Array<Record<string, unknown>>;
  expect(containers[0].environment).toBeUndefined();
});
```

> The `JSON.parse(...) as ...` cast may trip oxlint in the test. Mirror the parsing style already used in `terraform.test.ts` if it parses container_definitions elsewhere; otherwise a localized parse helper is fine. Match existing test conventions.

- [ ] **Step 2: Run, confirm FAIL** (environment not emitted).

- [ ] **Step 3: Implement in `terraform.ts`**

Add a helper near the top of the ECS emitter module:
```ts
function containerEnvironment(
  context: TerraformContext,
): { environment: Array<{ name: string; value: string }> } | Record<string, never> {
  const env = context.resolvedEcsEnv;
  if (!env || Object.keys(env).length === 0) {
    return {};
  }
  return {
    environment: Object.entries(env).map(([name, value]) => ({ name, value })),
  };
}
```
In EACH of the three `container_definitions: JSON.stringify([{ ... }])` blocks (ec2, fargate, floci), spread the helper into the container object AFTER `portMappings` and before/after `logConfiguration` (placement inside the object is cosmetic for behavior, but to keep byte-identical output when empty, the spread of `{}` adds nothing). Example:
```ts
container_definitions: JSON.stringify([
  {
    name: resourceName,
    image: `${service.config.image.repository}:${service.config.image.tag}`,
    essential: true,
    portMappings: [ /* unchanged */ ],
    ...containerEnvironment(options),
    logConfiguration: { /* unchanged */ },
  },
]),
```

CRITICAL byte-identical requirement: when `resolvedEcsEnv` is absent/empty, `containerEnvironment` returns `{}` and the spread adds NO key, so the serialized JSON is identical to today. Verify object KEY ORDER: placing `...containerEnvironment(options)` between `portMappings` and `logConfiguration` means that when env IS present, `environment` appears between them. Since today there's no `environment` key at all, the only services affected are ones that opt in — existing committed services have no `env`, so their output is unchanged. CONFIRM none of the committed `*.ecs.yaml` files declare `env` yet (they don't, until Plan 5 wiring). 

- [ ] **Step 4: Run the two new tests, confirm PASS**

- [ ] **Step 5: Full suite + typecheck + lint.** Commit checkpoint:

```bash
git add packages/platform/src/services/ecs/terraform.ts packages/platform/tests/platform/terraform.test.ts
```
Report the diff.

---

### Task 5: Wire resolution into `generate.ts` (env present but no refs needed at generate time)

**Files:**
- Modify: `packages/platform/src/generate.ts`
- Test: byte-identical gate

`generate.ts` runs WITHOUT deploy-time gateway IDs (those exist only post-apply). So at generate time: static env values can be resolved, but `ref: gatewayBaseUrl` values cannot. Decision (matches the spec's deploy-time-resolution design): **generate resolves only `static` env; `ref` values are resolved later by Plan 5's deploy command** which regenerates after discovering IDs.

- [ ] **Step 1: Implement static-only resolution at generate time**

In `generate.ts`, for each ECS service, build `resolvedEcsEnv` from static entries only, passing a `gatewayBaseUrl` resolver that returns `undefined` for refs — BUT since an unresolved ref would throw, instead filter to static at generate time:

Add a small helper (or reuse `resolveEcsEnv` with a resolver that throws) — but to avoid throwing on refs during generate, pass only the static subset. Simplest:
```ts
import { resolveEcsEnv } from "./services/ecs/env";
// per ecs service, when building options:
const staticOnly = Object.fromEntries(
  Object.entries(service.config.env ?? {}).filter(([, v]) => "static" in v),
);
const resolvedEcsEnv = resolveEcsEnv(staticOnly, { gatewayBaseUrl: () => undefined });
```
Pass `resolvedEcsEnv` into the `terraformForService(service, { ..., resolvedEcsEnv })` call ONLY for ecs services (or always; non-ecs ignore it).

> Because no committed `*.ecs.yaml` declares `env` yet, `service.config.env` is undefined everywhere and `resolvedEcsEnv` is `{}` — so generated output stays byte-identical. This task just makes the generator ready; Plan 5 adds the deploy-time ref resolution + the actual `env` block in payments-app.ecs.yaml.

- [ ] **Step 2: Byte-identical gate**

```bash
pnpm platform:generate -- --env dev --venture venture --target floci
pnpm platform:generate -- --env dev --venture venture --target aws
git status --short infra/services | grep main.tf.json || echo "BYTE-IDENTICAL"
```
Expected: `BYTE-IDENTICAL` (no env declared anywhere yet).

- [ ] **Step 3: Full suite + typecheck + lint.** Commit checkpoint:

```bash
git add packages/platform/src/generate.ts
```
Report the diff.

---

### Task 6: Final verification

- [ ] **Step 1: Full green check** — repo root: `pnpm lint && pnpm typecheck && pnpm --filter @repo/platform test`. Expected clean/pass.
- [ ] **Step 2: Byte-identical Terraform** (repeat gate from Task 5 Step 2). Expected `BYTE-IDENTICAL`.
- [ ] **Step 3: Confirm `schemas/ecs.schema.json` IS changed** (this plan's intended schema change): `git status --short schemas/` shows ecs.schema.json modified. This is correct.
- [ ] **Step 4: Commit (checkpoint)** — `git add packages/platform/` ; report final diff + summary.

---

## Self-Review Notes

- **Spec coverage:** Implements spec §4 (ECS `env` block: static + `ref: gatewayBaseUrl`, schema-validated, emitted into the task def). Deploy-time `ref` resolution against discovered gateway IDs and the actual `env:` block in `payments-app.ecs.yaml` are wired in Plan 5 (which has the IDs). This plan ships the schema, resolver, emitter, and generator-readiness with full unit coverage.
- **Two kinds of "changed file" kept distinct:** `schemas/ecs.schema.json` MUST change (new optional field); `infra/services/**/main.tf.json` must NOT change (no service opts in yet). Both asserted.
- **Byte-identical safety:** the `environment` key is omitted entirely when env is empty; no committed service declares `env` yet; key order positions `environment` between `portMappings` and `logConfiguration` only when present.
- **Deploy-time vs generate-time:** static resolved at generate; refs deferred to deploy (Plan 5) — explicitly designed, since gateway IDs don't exist until post-apply.
- **oxlint:** flagged the JSON.parse casts in tests to match existing conventions / use guards.
- **No placeholders.** Concrete code + commands throughout.
```
