# Service Registry (Single Source of Truth for Names) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single function `buildServiceManifest(services)` that computes every physical/derived name for a service (physical name, ECS cluster/ALB/target-group-prefix/container-port, and which gateway fronts it) exactly once, so that `generate.ts` — and later the deploy/url/reset CLI (Plan 5) — consume names from one place instead of re-deriving them in shell scripts and scattered helpers.

**Architecture:** A new `src/registry.ts` exposes `buildServiceManifest(services: LoadedService[]): ServiceManifestEntry[]`. Each entry wraps a `LoadedService` plus its computed names, reusing the existing `src/terraform/naming.ts` helpers (the same functions the Terraform emitters use, so manifest names are guaranteed to match generated infrastructure). ECS-specific names are populated only for ECS services. The gateway-fronting link is derived by scanning API Gateway service route targets. `generate.ts` is refactored to source `serviceNames` and `serviceContainerPorts` from the manifest, deleting its duplicated local helpers.

**Tech Stack:** TypeScript (ESM, `tsx`), Zod 4, Vitest, pnpm workspaces.

**This is Plan 2 of the 5-plan sequence** (plugins ✅ → **registry (names)** → app-derivation/Dockerfile → ECS env → TS CLI). It is behavior-preserving: generated Terraform output must remain byte-identical.

---

## Ground Rules

- **Run from `packages/platform/`** unless a path says otherwise. Test command: `pnpm test` (alias for `vitest run`); single file: `pnpm vitest run tests/platform/<file>.test.ts`.
- **Green at every commit.** `pnpm test` and `pnpm typecheck` must pass before each commit. From repo root, `pnpm lint` (oxlint `--type-aware --type-check --deny-warnings`) must be clean. **Note this repo's oxlint forbids `no-unsafe-type-assertion`** — avoid `as T` casts; use type guards or precise typing. Prefer `oxlint-disable-next-line` with a justification only at a genuine type-erasure boundary.
- **Do not commit** — the user commits. Each "Commit" step is a checkpoint: stage the listed files with `git add` and report the diff to the user. Never run `git commit`.
- **Behavior-preserving.** The final gate (Task 7) regenerates Terraform and asserts no `main.tf.json` changed. If any does, a change altered output — stop and investigate.
- Follow the established plugin/registry patterns already in `src/services/` and `src/terraform/`.

## Background: what already exists (verified current state)

- `src/terraform/naming.ts` exports: `physicalName(metadata, suffix?)`, `terraformName(value)`, `truncateName(value, max)`, `ecsLoadBalancerName(metadata)`, `targetGroupNamePrefix(resourceName)`.
- `src/services/index.ts` exports `serviceTypeRegistry` (a `ServiceTypeRegistry` of the four plugins).
- `src/service-discovery.ts` exports `discoverServices(options): Promise<LoadedService[]>`.
- `src/generated-paths.ts` exports `generatedDirectoryForService(metadata, target)`.
- `src/types.ts` exports `LoadedService`, `ServiceMetadata`, `ServiceType`, `ApiGatewayConfig`, etc. `LoadedService` is a discriminated union on `metadata.serviceType`.
- `generate.ts` currently defines its OWN local `physicalName`, `serviceNamesFor`, `serviceContainerPortsFor`, and `isEcsService`. These duplicate naming logic and are what this plan removes.

### Names the manifest must compute (and what they must equal)

Verified against `src/services/ecs/terraform.ts` and the existing shell scripts so the manifest is a faithful single source of truth:

| Field | How computed | Example (docs-app) | Matches |
|---|---|---|---|
| `physicalName` | `physicalName(metadata)` | `dev-venture-core-public-docs-app` | ECS cluster/service `name`, task family |
| `ecs.clusterName` | same as `physicalName` | `dev-venture-core-public-docs-app` | `aws_ecs_cluster.name` |
| `ecs.albName` | `ecsLoadBalancerName(metadata)` (= `truncateName(physicalName, 32)`) | `dev-venture-core-public-docs-app` (≤32) / `dev-venture-core-public-payments` (truncated from payments-app) | `aws_lb.name`; shell `DOCS_ALB_NAME`/`PAYMENTS_ALB_NAME` |
| `ecs.targetGroupPrefix` | `targetGroupNamePrefix(terraformName(serviceName))` | `docsa-` / `payme-` | floci `aws_lb_target_group.name_prefix`; shell `*_TARGET_GROUP_PREFIX` |
| `ecs.containerPort` | `config.service.containerPort` | `3001` | route integration port |
| `frontedByGateway` | scan apigateway services' route targets for `{type: ecs|lambda, service: <thisName>}` | docs-app ← `docs` | shell hardcoded API names |

> NOTE on `albName`: `ecsLoadBalancerName` truncates to 32 chars. `payments-app`'s physical name `dev-venture-core-public-payments-app` is 36 chars → truncated to `dev-venture-core-public-payments` (32), which matches the shell script's `PAYMENTS_ALB_NAME="dev-venture-core-public-payments"`. Do not "fix" this — it is the intended current behavior.

> NOTE on `targetGroupPrefix`: the floci ECS path calls `targetGroupNamePrefix(resourceName)` where `resourceName = terraformName(serviceName)` (e.g. `docs_app` → strips `_`, slices 5 → `docsa-`). Compute it from `terraformName(metadata.serviceName)`, NOT from the raw service name.

---

## File Structure (end state)

```
packages/platform/src/
  registry.ts                         # NEW: ServiceManifestEntry, buildServiceManifest
  generate.ts                         # MODIFIED: consume manifest; delete local helpers
packages/platform/tests/platform/
  registry.test.ts                    # NEW: unit tests for buildServiceManifest
```

`naming.ts`, the plugins, and `service-discovery.ts` are unchanged. `generate.ts` is the only existing file modified.

---

### Task 1: Define `ServiceManifestEntry` and the physical-name core of `buildServiceManifest`

**Files:**
- Create: `packages/platform/src/registry.ts`
- Create: `packages/platform/tests/platform/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/platform/tests/platform/registry.test.ts
import { describe, expect, test } from "vitest";
import { buildServiceManifest } from "../../src/registry";
import type { LoadedService } from "../../src/types";

const dynamoService: LoadedService = {
  metadata: {
    env: "dev", venture: "venture", vpc: "core", securityZone: "managed",
    serviceName: "customer-records", serviceType: "dynamodb",
    sourcePath: "infra/services/dev/venture/core/managed/customer-records.dynamodb.yaml",
  },
  config: { billingMode: "PAY_PER_REQUEST", hashKey: { name: "id", type: "S" }, pointInTimeRecovery: false },
};

describe("buildServiceManifest", () => {
  test("computes the physical name for a service", () => {
    const [entry] = buildServiceManifest([dynamoService]);
    expect(entry.physicalName).toBe("dev-venture-core-managed-customer-records");
    expect(entry.metadata.serviceName).toBe("customer-records");
  });

  test("leaves ecs and frontedByGateway unset for non-ecs services", () => {
    const [entry] = buildServiceManifest([dynamoService]);
    expect(entry.ecs).toBeUndefined();
    expect(entry.frontedByGateway).toBeUndefined();
  });

  test("preserves input order", () => {
    const manifest = buildServiceManifest([dynamoService]);
    expect(manifest).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it, confirm it FAILS**

Run: `pnpm vitest run tests/platform/registry.test.ts`
Expected: FAIL — cannot find module `../../src/registry`.

- [ ] **Step 3: Implement the entry type and core builder**

```ts
// packages/platform/src/registry.ts
import { physicalName } from "./terraform/naming";
import type { LoadedService } from "./types";

export type EcsNames = {
  clusterName: string;
  albName: string;
  targetGroupPrefix: string;
  containerPort: number;
};

export type GatewayFronting = {
  serviceName: string;
  physicalName: string;
};

export type ServiceManifestEntry = {
  service: LoadedService;
  metadata: LoadedService["metadata"];
  physicalName: string;
  ecs?: EcsNames;
  frontedByGateway?: GatewayFronting;
};

export function buildServiceManifest(services: LoadedService[]): ServiceManifestEntry[] {
  return services.map((service) => ({
    service,
    metadata: service.metadata,
    physicalName: physicalName(service.metadata),
  }));
}
```

- [ ] **Step 4: Run test, confirm PASS (3 tests)**

Run: `pnpm vitest run tests/platform/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck + lint**

Run: `pnpm test && pnpm typecheck` then from repo root `pnpm lint`.
Expected: all existing tests + 3 new pass; typecheck and lint clean.

- [ ] **Step 6: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/registry.ts packages/platform/tests/platform/registry.test.ts
```
Report the diff to the user.

---

### Task 2: Populate `ecs` names for ECS services

**Files:**
- Modify: `packages/platform/src/registry.ts`
- Modify: `packages/platform/tests/platform/registry.test.ts`

- [ ] **Step 1: Add a failing test for ECS names**

Append inside the `describe` block:

```ts
const ecsService: LoadedService = {
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

test("computes ecs names including the 32-char truncated ALB name", () => {
  const [entry] = buildServiceManifest([ecsService]);
  expect(entry.ecs).toEqual({
    clusterName: "dev-venture-core-public-payments-app",
    albName: "dev-venture-core-public-payments", // truncated from 36 to 32 chars
    targetGroupPrefix: "payme-",
    containerPort: 3002,
  });
});

test("computes docs-app target group prefix as docsa-", () => {
  const docsApp: LoadedService = {
    metadata: {
      env: "dev", venture: "venture", vpc: "core", securityZone: "public",
      serviceName: "docs-app", serviceType: "ecs",
      sourcePath: "infra/services/dev/venture/core/public/docs-app.ecs.yaml",
    },
    config: {
      cluster: { capacity: "fargate" },
      service: { desiredCount: 1, containerPort: 3001 },
      task: { cpu: 256, memoryMb: 512 },
      image: { repository: "nebula-docs", tag: "local" },
      healthCheck: { path: "/docs" },
    },
  };
  const [entry] = buildServiceManifest([docsApp]);
  expect(entry.ecs?.targetGroupPrefix).toBe("docsa-");
  expect(entry.ecs?.albName).toBe("dev-venture-core-public-docs-app");
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `pnpm vitest run tests/platform/registry.test.ts`
Expected: FAIL — `entry.ecs` is `undefined`.

- [ ] **Step 3: Implement ECS name population**

Update `registry.ts`:

```ts
import {
  ecsLoadBalancerName,
  physicalName,
  targetGroupNamePrefix,
  terraformName,
} from "./terraform/naming";
import type { LoadedService } from "./types";

type EcsService = Extract<LoadedService, { metadata: { serviceType: "ecs" } }>;

function isEcsService(service: LoadedService): service is EcsService {
  return service.metadata.serviceType === "ecs";
}

function ecsNamesFor(service: EcsService): EcsNames {
  return {
    clusterName: physicalName(service.metadata),
    albName: ecsLoadBalancerName(service.metadata),
    targetGroupPrefix: targetGroupNamePrefix(terraformName(service.metadata.serviceName)),
    containerPort: service.config.service.containerPort,
  };
}

export function buildServiceManifest(services: LoadedService[]): ServiceManifestEntry[] {
  return services.map((service) => ({
    service,
    metadata: service.metadata,
    physicalName: physicalName(service.metadata),
    ...(isEcsService(service) ? { ecs: ecsNamesFor(service) } : {}),
  }));
}
```

- [ ] **Step 4: Run test, confirm PASS**

Run: `pnpm vitest run tests/platform/registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Full suite + typecheck + lint**

Run: `pnpm test && pnpm typecheck`, then repo-root `pnpm lint`.
Expected: clean.

- [ ] **Step 6: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/registry.ts packages/platform/tests/platform/registry.test.ts
```
Report the diff.

---

### Task 3: Derive `frontedByGateway` from API Gateway route targets

**Files:**
- Modify: `packages/platform/src/registry.ts`
- Modify: `packages/platform/tests/platform/registry.test.ts`

API Gateway services route to ECS/Lambda services via route targets. For each ECS/Lambda service, find the gateway whose routes target it. Route targets appear in two shapes (verified in `apigateway.schema` and the YAMLs): a route's top-level `target` and an optional per-deploy-target `targets: { floci?, aws? }`. A target is `{ type: "ecs" | "lambda" | "http_proxy", service?, uri? }`; only `ecs`/`lambda` targets carry a `service`.

- [ ] **Step 1: Add a failing test**

Append inside the `describe` block:

```ts
const docsGateway: LoadedService = {
  metadata: {
    env: "dev", venture: "venture", vpc: "core", securityZone: "public",
    serviceName: "docs", serviceType: "apigateway",
    sourcePath: "infra/services/dev/venture/core/public/docs.apigateway.yaml",
  },
  config: {
    description: "Docs app ingress.",
    routes: [
      {
        path: "/docs", method: "ANY",
        target: { type: "http_proxy", uri: "http://host.docker.internal:3001/docs" },
        targets: { floci: { type: "ecs", service: "docs-app" }, aws: { type: "ecs", service: "docs-app" } },
      },
    ],
  },
};

const docsAppForGateway: LoadedService = {
  metadata: {
    env: "dev", venture: "venture", vpc: "core", securityZone: "public",
    serviceName: "docs-app", serviceType: "ecs",
    sourcePath: "infra/services/dev/venture/core/public/docs-app.ecs.yaml",
  },
  config: {
    cluster: { capacity: "fargate" },
    service: { desiredCount: 1, containerPort: 3001 },
    task: { cpu: 256, memoryMb: 512 },
    image: { repository: "nebula-docs", tag: "local" },
    healthCheck: { path: "/docs" },
  },
};

test("links an ecs service to the gateway that fronts it (via targets map)", () => {
  const manifest = buildServiceManifest([docsAppForGateway, docsGateway]);
  const docsApp = manifest.find((e) => e.metadata.serviceName === "docs-app");
  expect(docsApp?.frontedByGateway).toEqual({
    serviceName: "docs",
    physicalName: "dev-venture-core-public-docs",
  });
});

test("links via a route's top-level target too", () => {
  const paymentsGateway: LoadedService = {
    metadata: {
      env: "dev", venture: "venture", vpc: "core", securityZone: "public",
      serviceName: "payments", serviceType: "apigateway",
      sourcePath: "infra/services/dev/venture/core/public/payments.apigateway.yaml",
    },
    config: {
      description: "Payments app public ingress.",
      routes: [{ path: "/payments", method: "ANY", target: { type: "ecs", service: "payments-app" } }],
    },
  };
  const paymentsApp: LoadedService = {
    metadata: {
      env: "dev", venture: "venture", vpc: "core", securityZone: "public",
      serviceName: "payments-app", serviceType: "ecs",
      sourcePath: "infra/services/dev/venture/core/public/payments-app.ecs.yaml",
    },
    config: {
      cluster: { capacity: "fargate" }, service: { desiredCount: 1, containerPort: 3002 },
      task: { cpu: 256, memoryMb: 512 }, image: { repository: "nebula-payments", tag: "local" },
      healthCheck: { path: "/payments" },
    },
  };
  const manifest = buildServiceManifest([paymentsApp, paymentsGateway]);
  expect(manifest.find((e) => e.metadata.serviceName === "payments-app")?.frontedByGateway?.serviceName)
    .toBe("payments");
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `pnpm vitest run tests/platform/registry.test.ts`
Expected: FAIL — `frontedByGateway` undefined.

- [ ] **Step 3: Implement gateway-fronting derivation**

Add to `registry.ts`. Build a map from targeted-service-name → gateway entry, then assign. Type the apigateway service via the discriminant and iterate its routes.

```ts
type ApiGatewayService = Extract<LoadedService, { metadata: { serviceType: "apigateway" } }>;

function isApiGatewayService(service: LoadedService): service is ApiGatewayService {
  return service.metadata.serviceType === "apigateway";
}

function targetedServiceNames(gateway: ApiGatewayService): string[] {
  return gateway.config.routes.flatMap((route) => {
    const targets = [route.target, ...Object.values(route.targets ?? {})];
    return targets.flatMap((target) =>
      (target.type === "ecs" || target.type === "lambda") && target.service ? [target.service] : [],
    );
  });
}

function gatewayFrontingByService(services: LoadedService[]): Map<string, GatewayFronting> {
  const map = new Map<string, GatewayFronting>();
  for (const service of services) {
    if (!isApiGatewayService(service)) {
      continue;
    }
    const fronting: GatewayFronting = {
      serviceName: service.metadata.serviceName,
      physicalName: physicalName(service.metadata),
    };
    for (const targeted of targetedServiceNames(service)) {
      if (!map.has(targeted)) {
        map.set(targeted, fronting);
      }
    }
  }
  return map;
}
```

Update `buildServiceManifest` to use it:

```ts
export function buildServiceManifest(services: LoadedService[]): ServiceManifestEntry[] {
  const fronting = gatewayFrontingByService(services);
  return services.map((service) => ({
    service,
    metadata: service.metadata,
    physicalName: physicalName(service.metadata),
    ...(isEcsService(service) ? { ecs: ecsNamesFor(service) } : {}),
    ...(fronting.has(service.metadata.serviceName)
      ? { frontedByGateway: fronting.get(service.metadata.serviceName) }
      : {}),
  }));
}
```

If `route.target` / `target.service` typing requires narrowing that oxlint flags, prefer adding a small typed helper over a cast. Report if you hit a typing wall.

- [ ] **Step 4: Run test, confirm PASS**

Run: `pnpm vitest run tests/platform/registry.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Full suite + typecheck + lint**

Run: `pnpm test && pnpm typecheck`, then repo-root `pnpm lint`.
Expected: clean.

- [ ] **Step 6: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/registry.ts packages/platform/tests/platform/registry.test.ts
```
Report the diff.

---

### Task 4: Add manifest helpers for `serviceNames` and `serviceContainerPorts`

`generate.ts` passes two maps into the Terraform context: `serviceNames` (service-name → physical-name, for dynamodb/lambda/ecs) and `serviceContainerPorts` (ecs service-name → port). Provide these as manifest-derived helpers so `generate.ts` stops computing them locally.

**Files:**
- Modify: `packages/platform/src/registry.ts`
- Modify: `packages/platform/tests/platform/registry.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
import { serviceNamesFromManifest, serviceContainerPortsFromManifest } from "../../src/registry";

test("serviceNamesFromManifest maps dynamodb/lambda/ecs names to physical names", () => {
  const manifest = buildServiceManifest([dynamoService, ecsService]);
  expect(serviceNamesFromManifest(manifest)).toEqual({
    "customer-records": "dev-venture-core-managed-customer-records",
    "payments-app": "dev-venture-core-public-payments-app",
  });
});

test("serviceContainerPortsFromManifest maps only ecs services to ports", () => {
  const manifest = buildServiceManifest([dynamoService, ecsService]);
  expect(serviceContainerPortsFromManifest(manifest)).toEqual({
    "payments-app": 3002,
  });
});
```

> Verify the exact set of types included in `serviceNames` against the CURRENT `generate.ts` `serviceNamesFor` (it filters to `dynamodb | lambda | ecs` and excludes `apigateway`). Mirror that filter exactly so output is identical. Read `generate.ts` before implementing.

- [ ] **Step 2: Run, confirm FAIL**

Run: `pnpm vitest run tests/platform/registry.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the helpers**

```ts
export function serviceNamesFromManifest(
  manifest: ServiceManifestEntry[],
): Record<string, string> {
  return Object.fromEntries(
    manifest
      .filter((entry) => {
        const t = entry.metadata.serviceType;
        return t === "dynamodb" || t === "lambda" || t === "ecs";
      })
      .map((entry) => [entry.metadata.serviceName, entry.physicalName]),
  );
}

export function serviceContainerPortsFromManifest(
  manifest: ServiceManifestEntry[],
): Record<string, number> {
  return Object.fromEntries(
    manifest
      .filter((entry): entry is ServiceManifestEntry & { ecs: EcsNames } => entry.ecs !== undefined)
      .map((entry) => [entry.metadata.serviceName, entry.ecs.containerPort]),
  );
}
```

- [ ] **Step 4: Run test, confirm PASS (9 tests total)**

Run: `pnpm vitest run tests/platform/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck + lint**

Run: `pnpm test && pnpm typecheck`, then repo-root `pnpm lint`.
Expected: clean.

- [ ] **Step 6: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/registry.ts packages/platform/tests/platform/registry.test.ts
```
Report the diff.

---

### Task 5: Refactor `generate.ts` to consume the manifest

**Files:**
- Modify: `packages/platform/src/generate.ts`
- Test: existing tests + the byte-identical gate in Task 7

`generate.ts` currently builds `serviceNames` via local `serviceNamesFor`, `serviceContainerPorts` via local `serviceContainerPortsFor`, has a local `physicalName`, and a local `isEcsService`. Replace these with manifest calls.

- [ ] **Step 1: Read the current `generate.ts` fully**

Run: `cat src/generate.ts` (or open it). Note the exact call sites where `serviceNames` and `serviceContainerPorts` are computed and passed into `terraformForService(...)`.

- [ ] **Step 2: Rewire to the manifest**

At the top, add `import { buildServiceManifest, serviceNamesFromManifest, serviceContainerPortsFromManifest } from "./registry";`.

Replace the computation block. The current code (verified) computes from `scopedServices`:
```ts
const serviceNames = serviceNamesFor(scopedServices);
const serviceContainerPorts = serviceContainerPortsFor(scopedServices);
```
Replace with:
```ts
const manifest = buildServiceManifest(scopedServices);
const serviceNames = serviceNamesFromManifest(manifest);
const serviceContainerPorts = serviceContainerPortsFromManifest(manifest);
```

Delete the now-unused local functions `serviceNamesFor`, `serviceContainerPortsFor`, `isEcsService`, and the local `physicalName` (confirm `physicalName` is not referenced elsewhere in `generate.ts` first — grep). Leave `discoverServices`, arg parsing, and the write loop untouched.

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck`, then repo-root `pnpm lint`.
Expected: clean. Fix any orphaned imports your deletion created (e.g. if `physicalName`'s removal orphans an import).

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 5: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/generate.ts
```
Report the diff.

---

### Task 6: Wire the manifest into `discoverServices` consumers cleanly (optional consolidation)

**Files:**
- Modify: `packages/platform/src/registry.ts` (add a convenience loader)
- Modify: `packages/platform/tests/platform/registry.test.ts`

Provide a convenience that discovers and builds in one call, for Plan 5's CLI to reuse. This keeps the manifest the single entry point.

- [ ] **Step 1: Add a failing test**

```ts
import { loadServiceManifest } from "../../src/registry";

test("loadServiceManifest discovers services then builds the manifest", async () => {
  const manifest = await loadServiceManifest({ env: "dev", venture: "venture" });
  const names = manifest.map((e) => e.metadata.serviceName).sort();
  expect(names).toContain("docs-app");
  expect(names).toContain("customer-records");
  // docs-app is fronted by the docs gateway
  expect(manifest.find((e) => e.metadata.serviceName === "docs-app")?.frontedByGateway?.serviceName)
    .toBe("docs");
});
```

> This test reads the real `infra/services` tree, matching how `service-discovery.test.ts` exercises `discoverServices`. Confirm `discoverServices`'s option shape by reading its signature (it takes `{ env, venture?, services?, servicesRoot? }`).

- [ ] **Step 2: Run, confirm FAIL**

Run: `pnpm vitest run tests/platform/registry.test.ts`
Expected: FAIL — `loadServiceManifest` not exported.

- [ ] **Step 3: Implement**

```ts
import { discoverServices, type DiscoverOptions } from "./service-discovery";

export async function loadServiceManifest(
  options: DiscoverOptions,
): Promise<ServiceManifestEntry[]> {
  return buildServiceManifest(await discoverServices(options));
}
```

(Confirm `DiscoverOptions` is exported from `service-discovery.ts`; it is. If not, export it.)

- [ ] **Step 4: Run test, confirm PASS**

Run: `pnpm vitest run tests/platform/registry.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Full suite + typecheck + lint**

Run: `pnpm test && pnpm typecheck`, then repo-root `pnpm lint`.
Expected: clean.

- [ ] **Step 6: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/registry.ts packages/platform/tests/platform/registry.test.ts
```
Report the diff.

---

### Task 7: Final verification — byte-identical generated output

**Files:** none (verification only)

- [ ] **Step 1: Regenerate Terraform for both targets**

Run from repo root:
```bash
pnpm platform:generate -- --env dev --venture venture --target floci
pnpm platform:generate -- --env dev --venture venture --target aws
```
Expected: completes without error.

- [ ] **Step 2: Assert no generated file changed**

Run:
```bash
git status --short infra/services | grep main.tf.json || echo "BYTE-IDENTICAL"
```
Expected: `BYTE-IDENTICAL`. If any `main.tf.json` shows as modified, the `generate.ts` refactor changed the `serviceNames`/`serviceContainerPorts` maps — diff the file and fix `registry.ts` until output matches. This is the acceptance gate proving the manifest produces names identical to the prior local helpers.

- [ ] **Step 3: Full green check**

Run from repo root: `pnpm lint && pnpm --filter @repo/platform test && pnpm --filter @repo/platform typecheck`
Expected: lint clean, all tests pass, typecheck clean.

- [ ] **Step 4: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/
```
Report the final diff and a summary to the user.

---

## Self-Review Notes

- **Spec coverage:** Implements the names half of spec §2 (service registry as single source of truth for physical/ECS/gateway-fronting names) and rewires `generate.ts` to consume it. The `app` field (app dir/package/dockerfile/devPort derivation) is **Plan 3** — deliberately excluded here. The CLI that consumes `frontedByGateway`/`ecs` names to replace shell scripts is **Plan 5**.
- **Why these names:** Each computed field is cross-checked (in the Background table) against both the ECS Terraform emitter and the hardcoded shell-script values, so the manifest is provably the single source the scripts will later read.
- **Behavior preservation:** `generate.ts` is the only behavior-bearing change; Task 7 asserts byte-identical generated Terraform. `serviceNamesFromManifest` mirrors the current `serviceNamesFor` type filter exactly (dynamodb/lambda/ecs).
- **No placeholders.** Every step has concrete code or exact commands.
- **oxlint:** Plan avoids `as` casts (repo forbids `no-unsafe-type-assertion`); uses type guards and a typed predicate in `serviceContainerPortsFromManifest`.
- **Type consistency:** `ServiceManifestEntry`, `EcsNames`, `GatewayFronting`, `buildServiceManifest`, `serviceNamesFromManifest`, `serviceContainerPortsFromManifest`, `loadServiceManifest` names are used identically across tasks.
```
