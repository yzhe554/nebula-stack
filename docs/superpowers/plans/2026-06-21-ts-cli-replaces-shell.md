# TS CLI Replaces Shell Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-maintained Floci shell scripts (`floci-deploy-docs.sh`, `floci-deploy-payments.sh`, `floci-url.sh`, `docs-dev-floci.sh`, `floci-reset-all.sh`) with TypeScript CLI commands that derive every name, app, gateway link, and resource from the service manifest (Plans 2–4), so adding a service requires no shell edits. The CLI uses the AWS SDK (already a dependency) instead of the `aws` CLI.

**Architecture:** A small command layer under `src/cli/` exposes `floci-deploy`, `floci-url`, `floci-reset`, and `floci-dev`, each reading `loadServiceManifest()` and acting generically. `floci-deploy` reproduces the existing bootstrap ordering (deploy gateway → discover its API id → host-build the app with the gateway path → docker build → deploy app/stack → resolve ECS env refs → force new ECS deployment). `floci-url` and `floci-reset` enumerate resources from the manifest. AWS interactions go through `@aws-sdk/client-*` against the Floci endpoint with a scrubbed (no-proxy) environment. `package.json` per-service script entries collapse to generic ones. The five shell scripts are deleted.

**Tech Stack:** TypeScript (ESM, `tsx`), AWS SDK v3, `node:child_process` (docker/terraform/pnpm spawns), Vitest.

**This is Plan 5 of the 5-plan sequence** (plugins ✅ → registry → app/Dockerfile → ECS env → **TS CLI**). Hard dependency on Plans 2, 3, and 4 being applied first (manifest names, `app` field, ECS `env` block + resolver).

---

## Optimization goal: eliminate the redundant Next.js build (investigated)

The current shell scripts build each Next.js app **twice** on a cold deploy (verified): once as a throwaway image to stand up the ECS app/ALB, then again with the real gateway path. A full cold `floci:deploy:all` does ~4 `next build` + 4 `docker build` (2 per app × 2 apps). This CLI must reduce that to **one real build per app**.

Root cause (investigated — do NOT try to make it runtime):
- `next.config.ts` sets `assetPrefix = NEXT_PUBLIC_GATEWAY_PATH + basePath`. With `output: "standalone"`, Next bakes `assetPrefix` into `/_next/static/...` URLs at **build time** — there is no runtime hook. So the gateway-path → assetPrefix coupling is inherently build-time. (Unlike `PAYMENT_API_BASE_URL`, which Plan 3 correctly moved to runtime because it's just data the app reads.)
- Two coupled cycles force the ordering: (a) the app image needs the gateway id for `assetPrefix` → gateway must exist; (b) the gateway's ECS integration reads the ALB via `data.aws_lb.<name>` (by-name lookup) → the ALB (created by the ECS app) must exist first. Hence: ECS app/ALB up → gateway minted → rebuild app with id.
- This is **Floci-only**. On AWS the gateway uses a custom domain (no `/execute-api/<id>/$default` prefix), so `NEXT_PUBLIC_GATEWAY_PATH` is unset, `assetPrefix` is undefined, and a single build already works. Do not change the AWS path.

Required behavior in `floci-deploy` (Task 5): the throwaway build must NOT be a full `next build`. Instead bootstrap the ECS app/ALB with a **cheap placeholder image** (e.g. reuse the last-built image if present, or a minimal image just to create the ALB), THEN deploy the gateway to mint the id, THEN do exactly **one** real `pnpm <app>:build` + `docker build` with the gateway path, then redeploy + force-new-deployment. Net: one real Next build per app on cold deploy, zero on the AWS path. Task 5 Step 3 below is updated to reflect this; if implementing the placeholder bootstrap proves large, the acceptable fallback is to still build once by deploying the gateway FIRST using a pre-existing/cached image for the ALB — document whichever you choose.

---

## Ground Rules

- Run from `packages/platform/`. Test: `pnpm test`; repo-root `pnpm lint` + `pnpm typecheck` clean.
- **oxlint forbids `no-unsafe-type-assertion`** — guards over `as T`.
- **Do not commit** — stage + report; user commits.
- This plan changes runtime tooling, not Terraform generation. The byte-identical Terraform gate must still hold (the CLI calls the same `terraformForService`).
- **Pre-req gate (Task 0):** Plans 2, 3, 4 MUST be applied. Verify `src/registry.ts` exports `loadServiceManifest`/`ServiceManifestEntry` with `app`, `ecs`, `frontedByGateway`; `src/services/ecs/env.ts` exports `resolveEcsEnv`; `TerraformContext` has `resolvedEcsEnv`; `apps/Dockerfile` exists; `apps/payments/app/page.tsx` reads `PAYMENT_API_BASE_URL`. If any is missing, STOP and report which plan is outstanding.
- **AWS SDK availability:** `@aws-sdk/client-dynamodb` is already a dependency. This plan adds `@aws-sdk/client-apigatewayv2`, `@aws-sdk/client-ecs`, `@aws-sdk/client-elastic-load-balancing-v2`, `@aws-sdk/client-iam`, `@aws-sdk/client-cloudwatch-logs`, `@aws-sdk/client-lambda` to `@repo/platform`. Confirm with the user before adding deps if they prefer to keep using the `aws` CLI via spawn — see Task 1 decision point.

## Background: what the shell scripts do (verified — must be reproduced)

- **`floci-deploy-docs.sh` / `floci-deploy-payments.sh`:** (1) look up the public gateway's API id by name via `apigatewayv2 get-apis`; (2) if missing, bootstrap: build app + docker image, deploy `<app>` (ECS) then `<gateway>`; (3) host-build the app with `NEXT_PUBLIC_GATEWAY_PATH=/execute-api/<id>/$default` (payments also set `NEXT_PUBLIC_PAYMENT_API_BASE_URL` — now replaced by the runtime `PAYMENT_API_BASE_URL` ECS env from Plan 3/4); (4) docker build; (5) `platform:deploy` the stack; (6) `ecs update-service --force-new-deployment`; (7) print URLs.
- **`floci-url.sh`:** for docs/payments/payment-api, resolve API ids (via get-apis, fallback to tfstate), ALB DNS (from tfstate), print a set of URLs; missing services show "Not deployed".
- **`floci-reset-all.sh`:** delete (idempotently, ignoring not-found) all API gateways, ECS services+clusters (docs + payments), ALBs+listeners+target groups (docs + payments), the payment-api Lambda + role + inline policy + basic-exec attach + log group, run `floci-ddb-reset.sh`, and `rm -rf` the generated floci state dirs.
- **`docs-dev-floci.sh`:** resolve the docs gateway id, export `NEXT_PUBLIC_GATEWAY_PATH`, run `pnpm --filter @repo/docs dev`.
- **`floci-env.sh`** (sourced by kept scripts): sets `AWS_ACCESS_KEY_ID=test` etc. and unsets proxies. The CLI must replicate this scrubbed env for SDK + spawned processes.
- **KEPT (not replaced by this plan):** `floci-ddb-get-item.sh`, `floci-ddb-list-tables.sh`, `floci-ddb-reset.sh`, `floci-invoke-payment-api.sh`, `floci-env.sh`. `floci-reset-all.sh`'s teardown calls `floci-ddb-reset.sh` — the TS reset must invoke the same DDB reset (spawn it, or port it; spawning keeps scope tight).

## Naming the CLI derives from the manifest (no hardcoding)

- Gateway API name to look up = `entry.physicalName` for apigateway services (e.g. `dev-venture-core-public-docs`).
- For an app service, its fronting gateway = `entry.frontedByGateway` (Plan 2).
- ECS cluster/service name = `entry.ecs.clusterName` (= physicalName); ALB name = `entry.ecs.albName`; target-group prefix = `entry.ecs.targetGroupPrefix`.
- App build command/dir/dockerfile/port = `entry.app` (Plan 3).
- Generated state dir = `generatedDirectoryForService(metadata, "floci")`.
- Lambda function name, role, log group = `entry.physicalName` + suffixes already encoded in the lambda emitter (`physicalName(metadata)`, `${physicalName}-lambda-role`, `/aws/lambda/${physicalName}`). Confirm exact suffixes by reading `src/services/lambda/terraform.ts` before implementing reset.

---

## File Structure (end state)

```
packages/platform/src/cli/
  floci-env.ts        # scrubbed env + Floci endpoint constant + AWS SDK client factory
  aws.ts              # thin SDK wrappers: getApiIdByName, forceNewDeployment, delete* helpers
  deploy.ts           # floci-deploy command (bootstrap + build + deploy + restart)
  url.ts              # floci-url command
  reset.ts            # floci-reset command
  dev.ts              # floci-dev command
packages/platform/tests/platform/cli-*.test.ts   # unit tests for pure logic (URL building, resolution, planning)
package.json (root)   # MODIFIED: generic script entries; remove per-service shell entries
packages/platform/package.json  # MODIFIED: new deps; new bin/script entries
scripts/floci-deploy-docs.sh        # DELETED
scripts/floci-deploy-payments.sh    # DELETED
scripts/floci-url.sh                # DELETED
scripts/docs-dev-floci.sh           # DELETED
packages/platform/scripts/floci-reset-all.sh  # DELETED
```

> SCOPE NOTE: This is the largest plan. It is structured so each command is independently testable. Pure logic (URL construction, env resolution, reset target enumeration) is unit-tested; the imperative AWS/docker/terraform orchestration is verified by the live `floci:redeploy:all` end-to-end run (Task 9), mirroring `docs/verify-redeploy-after-plugin-refactor.md`.

---

### Task 0: Pre-req verification + dependency decision

- [ ] **Step 1: Verify Plans 2–4 are applied**

Run:
```bash
cd packages/platform
grep -q "loadServiceManifest" src/registry.ts && echo "P2 ok"
grep -q "app?" src/registry.ts || grep -q "AppMetadata" src/registry.ts && echo "P3 ok"
test -f src/services/ecs/env.ts && echo "P4 resolver ok"
grep -q "resolvedEcsEnv" src/terraform/context.ts && echo "P4 context ok"
test -f ../../apps/Dockerfile && echo "P3 dockerfile ok"
```
Expected: all "ok". If any missing, STOP — report which plan to apply first.

- [ ] **Step 2: Decide AWS interaction mechanism (ask the user)**

The spec says use the AWS SDK. But the kept scripts and reset involve many services. Present to the user: **(A)** add the AWS SDK client packages listed above (cleaner, typed, matches spec), or **(B)** spawn the `aws` CLI from TS with the scrubbed env (no new deps, closer to current behavior, but stringly-typed). Recommend A per the spec. Wait for the answer; implement accordingly. The rest of this plan assumes **A**; if B is chosen, replace SDK calls with `spawnSync("aws", [...])` wrappers in `aws.ts` keeping the same function signatures so other tasks are unaffected.

- [ ] **Step 3: (If A) add dependencies**

Add to `packages/platform/package.json` dependencies and install:
```bash
pnpm --filter @repo/platform add @aws-sdk/client-apigatewayv2 @aws-sdk/client-ecs @aws-sdk/client-elastic-load-balancing-v2 @aws-sdk/client-iam @aws-sdk/client-cloudwatch-logs @aws-sdk/client-lambda
```
Confirm `pnpm install` succeeds. Commit checkpoint (stage package.json + lockfile; report).

---

### Task 1: `floci-env.ts` — scrubbed environment + client factory

**Files:**
- Create: `packages/platform/src/cli/floci-env.ts`
- Create: `packages/platform/tests/platform/cli-env.test.ts`

Replicates `floci-env.sh`: a function returning the scrubbed env (test creds, region, proxies unset) for spawned processes, plus the Floci endpoint URL constant and a helper to build SDK clients pointed at Floci.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from "vitest";
import { scrubbedEnv, FLOCI_ENDPOINT } from "../../src/cli/floci-env";

describe("floci scrubbed env", () => {
  test("sets test creds and region", () => {
    const env = scrubbedEnv({ HTTP_PROXY: "http://corp", PATH: "/usr/bin" });
    expect(env.AWS_ACCESS_KEY_ID).toBe("test");
    expect(env.AWS_DEFAULT_REGION).toBe("us-east-1");
    expect(env.PATH).toBe("/usr/bin");
  });
  test("removes proxy vars", () => {
    const env = scrubbedEnv({ HTTP_PROXY: "x", HTTPS_PROXY: "y", http_proxy: "z" });
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
  });
  test("endpoint is the floci localstack url", () => {
    expect(FLOCI_ENDPOINT).toBe("http://localhost:4566");
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement**

```ts
// packages/platform/src/cli/floci-env.ts
export const FLOCI_ENDPOINT = "http://localhost:4566";

const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];

export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of PROXY_KEYS) {
    delete env[key];
  }
  env.AWS_ACCESS_KEY_ID = "test";
  env.AWS_SECRET_ACCESS_KEY = "test";
  env.AWS_DEFAULT_REGION = "us-east-1";
  env.AWS_REGION = "us-east-1";
  env.AWS_EC2_METADATA_DISABLED = "true";
  env.NO_PROXY = "localhost,127.0.0.1,localhost.floci.io,.floci.localhost,.elb.localhost,0.0.0.0";
  env.no_proxy = env.NO_PROXY;
  delete env.AWS_SESSION_TOKEN;
  return env;
}

export function flociClientConfig() {
  return {
    endpoint: FLOCI_ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  };
}
```

- [ ] **Step 4: Run, confirm PASS. Suite + typecheck + lint. Commit checkpoint.**

```bash
git add packages/platform/src/cli/floci-env.ts packages/platform/tests/platform/cli-env.test.ts
```

---

### Task 2: `url.ts` — pure URL building + `floci-url` command

**Files:**
- Create: `packages/platform/src/cli/url.ts`
- Create: `packages/platform/tests/platform/cli-url.test.ts`

Separate the PURE URL-construction (given resolved gateway ids + ALB DNS) from the imperative discovery, so the formatting logic is unit-tested.

- [ ] **Step 1: Failing test for pure URL builder**

```ts
import { describe, expect, test } from "vitest";
import { buildServiceUrls } from "../../src/cli/url";

test("builds gateway + alb urls for a fronted ecs app", () => {
  const lines = buildServiceUrls([
    {
      serviceName: "docs-app",
      basePath: "/docs",
      gatewayId: "abc123",
      albDns: "dev-venture-core-public-docs-app-xyz.elb.localhost",
      containerHost: "dev-venture-core-public-docs-app.floci.localhost",
      containerPort: 3001,
    },
  ]);
  expect(lines.join("\n")).toContain("http://localhost:4566/execute-api/abc123/$default/docs");
  expect(lines.join("\n")).toContain("http://dev-venture-core-public-docs-app-xyz.elb.localhost/docs");
});

test("shows Not deployed when gatewayId missing", () => {
  const lines = buildServiceUrls([
    { serviceName: "docs-app", basePath: "/docs", gatewayId: undefined, albDns: undefined, containerHost: "h", containerPort: 3001 },
  ]);
  expect(lines.join("\n")).toMatch(/not deployed/i);
});
```

- [ ] **Step 2: FAIL → implement `buildServiceUrls` (pure)** returning string lines from a typed input array. Base path comes from the fronting gateway's first route path (derive from manifest in the command layer, pass in here). Keep formatting close to `floci-url.sh` output but driven by the manifest list rather than hardcoded blocks.

- [ ] **Step 3: Implement the imperative `runFlociUrl()`** that: loads the manifest, for each apigateway entry resolves its API id (SDK `GetApisCommand`, match `Name === entry.physicalName`, fallback to reading `<stateDir>/terraform.tfstate`), for each fronted ecs entry resolves ALB DNS from its tfstate, derives base paths from gateway routes, then prints `buildServiceUrls(...)`. Add a CLI entry (`if (isCliEntry) runFlociUrl()`), mirroring how `validate.ts`/`generate.ts` detect CLI entry.

- [ ] **Step 4: Run pure tests PASS; suite + typecheck + lint. Commit checkpoint.**

```bash
git add packages/platform/src/cli/url.ts packages/platform/tests/platform/cli-url.test.ts
```

---

### Task 3: `aws.ts` — typed SDK wrappers

**Files:**
- Create: `packages/platform/src/cli/aws.ts`

Thin, individually-testable-by-integration wrappers used by deploy/reset/url. No unit tests (they're IO); they're exercised in Task 9's live run. Keep each function tiny and single-purpose.

- [ ] **Step 1: Implement wrappers** using `flociClientConfig()`:
  - `getApiIdByName(name): Promise<string | undefined>` (ApiGatewayV2 `GetApisCommand`, find by `Name`)
  - `deleteApiByName(name): Promise<void>` (idempotent — ignore not-found)
  - `forceNewEcsDeployment(cluster, service): Promise<void>` (ECS `UpdateServiceCommand` with `forceNewDeployment: true`)
  - `deleteEcsService(cluster, service)`, `deleteEcsCluster(cluster)` (idempotent)
  - `deleteAlbByName(name)` + listeners + `deleteTargetGroupsByPrefix(prefix)` (ELBv2)
  - `deleteLambda(name)`, `deleteLogGroup(name)`, `deleteRole(name)` + detach/inline-policy (IAM/Lambda/Logs)
  Each wraps the SDK call in try/catch that swallows `NotFound`/`ResourceNotFoundException`/`NoSuchEntity` (mirroring `run_or_ignore_not_found`). Centralize the "ignore not found" predicate.

- [ ] **Step 2: typecheck + lint. Commit checkpoint** (`git add packages/platform/src/cli/aws.ts`). No behavior to test yet.

---

### Task 4: `reset.ts` — `floci-reset` command

**Files:**
- Create: `packages/platform/src/cli/reset.ts`
- Create: `packages/platform/tests/platform/cli-reset.test.ts`

- [ ] **Step 1: Unit-test the PURE reset-plan builder**

Extract a pure `planResetTargets(manifest): ResetPlan` that enumerates, from the manifest, exactly which resources to delete (api gateway names, ecs cluster/service names, alb names + target-group prefixes, lambda name + role + log group, generated state dirs). Test it against a fixture manifest asserting it lists docs + payments ECS, all gateways, the payment-api lambda resources — matching the hardcoded lists in `floci-reset-all.sh`.

```ts
import { planResetTargets } from "../../src/cli/reset";
// build a manifest fixture (or call loadServiceManifest in an integration-style test)
test("plans teardown of every ecs, gateway, and lambda resource", () => {
  const plan = planResetTargets(/* fixture manifest */);
  expect(plan.apiGatewayNames).toContain("dev-venture-core-public-docs");
  expect(plan.ecsClusters).toContain("dev-venture-core-public-payments-app");
  expect(plan.lambda?.functionName).toBe("dev-venture-core-internal-payment-api");
});
```
Confirm the lambda role/policy/log-group names by reading `src/services/lambda/terraform.ts` and encode the SAME suffixes in `planResetTargets`.

- [ ] **Step 2: FAIL → implement `planResetTargets` (pure)** from the manifest.

- [ ] **Step 3: Implement imperative `runFlociReset()`** that: checks Floci reachable (SDK `sts get-caller-identity` equivalent or a cheap call), executes the plan via `aws.ts` wrappers (idempotent), spawns `packages/platform/scripts/floci-ddb-reset.sh` (kept) with scrubbed env, then `rm -rf` the generated floci state dirs (`generatedDirectoryForService(metadata,"floci")` per service). Print progress lines like the script.

- [ ] **Step 4: Pure tests PASS; suite + typecheck + lint. Commit checkpoint.**

```bash
git add packages/platform/src/cli/reset.ts packages/platform/tests/platform/cli-reset.test.ts
```

---

### Task 5: `deploy.ts` — `floci-deploy` command (bootstrap + build + deploy + restart)

**Files:**
- Create: `packages/platform/src/cli/deploy.ts`
- Create: `packages/platform/tests/platform/cli-deploy.test.ts`

This is the core. Generalize the docs/payments deploy scripts into one manifest-driven flow for an app service (and its fronting gateway).

- [ ] **Step 1: Unit-test the PURE deploy-plan/ordering logic**

Extract pure helpers and test them:
  - `gatewayPathFor(apiId): string` → `/execute-api/${apiId}/$default`
  - `buildArgsFor(entry, gatewayPath): { APP_NAME, PORT, NEXT_PUBLIC_GATEWAY_PATH }` from `entry.app`/`entry.ecs`
  - `deployOrderFor(appService, manifest)` → the ordered list of service names to `platform:deploy` (gateway first when bootstrapping, then app+gateway). Mirror the script: bootstrap path deploys `<app>` then `<gateway>`; steady-state deploys `<app>,<gateway>`.

```ts
import { gatewayPathFor, buildArgsFor } from "../../src/cli/deploy";
test("gateway path format", () => {
  expect(gatewayPathFor("abc")).toBe("/execute-api/abc/$default");
});
test("docker build args derived from manifest entry", () => {
  const args = buildArgsFor(
    { app: { base: "docs" }, ecs: { containerPort: 3001 } } as any, // use a real typed fixture
    "/execute-api/abc/$default",
  );
  expect(args).toMatchObject({ APP_NAME: "docs", PORT: 3001, NEXT_PUBLIC_GATEWAY_PATH: "/execute-api/abc/$default" });
});
```
> Replace the `as any` with a properly typed minimal fixture — oxlint forbids unsafe assertions. Construct a real `ServiceManifestEntry` fixture.

- [ ] **Step 2: FAIL → implement the pure helpers.**

- [ ] **Step 3: Implement imperative `runFlociDeploy(serviceName)`**:
  1. Load manifest; find the app `entry` and its `frontedByGateway`.
  2. Resolve gateway API id via `getApiIdByName(gateway.physicalName)`. If missing, BOOTSTRAP **without a throwaway full Next build** (see the Optimization goal above): stand up the ECS app/ALB using a placeholder image so the ALB exists — reuse an already-present `<image>:local` if one exists (skip building), else build a minimal placeholder; then `platform:deploy` the app then the gateway; re-resolve the id. The expensive real `next build` happens exactly ONCE, in step 4, after the id is known. Do NOT call `pnpm <app>:build` in this bootstrap branch.
  3. Resolve ECS env refs: build a `gatewayBaseUrl(serviceName)` resolver from discovered API ids (`${FLOCI_ENDPOINT}/execute-api/<id>/$default`), call `resolveEcsEnv(entry.service.config.env, ...)` (Plan 4) — this is how `PAYMENT_API_BASE_URL` reaches the payments task now.
  4. The SINGLE real build: host-build the app with `NEXT_PUBLIC_GATEWAY_PATH` set (`pnpm <app>:build`), then `docker build` (shared Dockerfile with `buildArgsFor`). This is the only `next build` in the whole flow.
  5. `platform:deploy` the app+gateway. (The deploy regenerates Terraform; ensure the resolved ECS env is passed — see Step 4 note.)
  6. `forceNewEcsDeployment(entry.ecs.clusterName, entry.ecs.clusterName)`.
  7. Print URLs (call `runFlociUrl()` or its core).

  > Build-count assertion for Task 9's live run: a cold `floci:deploy:all` must perform at most ONE `next build` per app (down from two). Verify by counting build invocations in the CLI's logged output. On AWS (no gateway path) the bootstrap branch is skipped entirely.

- [ ] **Step 4: Resolve the ECS-env-at-deploy wiring**

`platform:deploy` (`src/deploy.ts`) shells to `platform:generate`. For `ref` env to land in the task def, generation during deploy must receive the resolved env. Simplest approach that fits the existing structure: have `floci-deploy` set the resolved values as process env and extend `generate.ts` (Plan 4 made it static-only) to also pick up deploy-injected ref values — OR have `floci-deploy` call generation directly with `resolvedEcsEnv` in the `TerraformContext` rather than going through the shell `platform:deploy`. Choose the direct path: `floci-deploy` imports `terraformForService` + `buildServiceManifest`, generates with `resolvedEcsEnv` per ecs service, writes the files, then runs `terraform init/plan/apply` per service (reuse the logic in `src/deploy.ts`). Refactor `src/deploy.ts`'s apply loop into an importable function if needed. Document the chosen approach in the report.

> This is the one genuinely tricky integration. If it proves too large, split: land deploy WITHOUT ref-env first (static env only), file a follow-up task for ref-env injection. Report if you split.

- [ ] **Step 5: Pure tests PASS; suite + typecheck + lint. Commit checkpoint.**

```bash
git add packages/platform/src/cli/deploy.ts packages/platform/tests/platform/cli-deploy.test.ts
```

---

### Task 6: `dev.ts` — `floci-dev` command

**Files:**
- Create: `packages/platform/src/cli/dev.ts`

- [ ] **Step 1: Implement `runFlociDev(serviceName)`**: load manifest, find app entry + fronting gateway, resolve gateway id, spawn `pnpm --filter <packageName> dev` with `NEXT_PUBLIC_GATEWAY_PATH` set and scrubbed env. Mirror `docs-dev-floci.sh` (including the `lsof`/lock cleanup only if trivial; otherwise omit — it's a dev convenience). Generalizes beyond docs to any app.

- [ ] **Step 2: typecheck + lint. Commit checkpoint** (`git add packages/platform/src/cli/dev.ts`).

---

### Task 7: Wire CLI entries in package.json; delete shell scripts

**Files:**
- Modify: `packages/platform/package.json` (script entries calling the CLI)
- Modify: root `package.json` (generic entries)
- Delete: the five shell scripts

- [ ] **Step 1: Add platform script entries** in `packages/platform/package.json`:
```json
"floci:deploy:service": "tsx --no-cache src/cli/deploy.ts",
"floci:url": "tsx --no-cache src/cli/url.ts",
"floci:reset:all": "tsx --no-cache src/cli/reset.ts",
"floci:dev": "tsx --no-cache src/cli/dev.ts"
```
(Replace the existing `floci:reset:all` shell entry.)

- [ ] **Step 2: Update root package.json** — replace per-service entries:
  - `floci:url` → `pnpm --filter @repo/platform run floci:url`
  - `floci:deploy:docs` → `pnpm --filter @repo/platform run floci:deploy:service -- docs-app`
  - `floci:deploy:payments` → `pnpm --filter @repo/platform run floci:deploy:service -- payments-app`
  - `docs:dev:floci` → `pnpm --filter @repo/platform run floci:dev -- docs-app`
  - `floci:deploy:all` stays as `pnpm floci:deploy:payments && pnpm floci:deploy:docs`
  - `floci:reset:all` already delegates to the platform script (now TS).
  Keep `docs:build`, `payments:build`, `*:docker:build` for now (the CLI calls docker directly, but these are still handy; the spec's "collapse per-service entries" is satisfied by removing the deploy/url/dev shell indirection). Remove entries that pointed at deleted scripts.

- [ ] **Step 3: Delete the five shell scripts**
```bash
git rm scripts/floci-deploy-docs.sh scripts/floci-deploy-payments.sh scripts/floci-url.sh scripts/docs-dev-floci.sh packages/platform/scripts/floci-reset-all.sh
```

- [ ] **Step 4: Grep for dangling references** to the deleted scripts:
```bash
grep -rn "floci-deploy-docs\|floci-deploy-payments\|floci-url.sh\|docs-dev-floci\|floci-reset-all" --include="*.json" --include="*.sh" --include="*.md" . | grep -v docs/superpowers
```
Fix any (e.g. `floci-reset-all.sh` is referenced inside other kept scripts? It isn't — verify). The `floci-ddb-reset.sh` spawn from `reset.ts` must point at the kept script path.

- [ ] **Step 5: typecheck + lint. Commit checkpoint.**

```bash
git add package.json packages/platform/package.json && git rm --cached scripts/floci-deploy-docs.sh scripts/floci-deploy-payments.sh scripts/floci-url.sh scripts/docs-dev-floci.sh packages/platform/scripts/floci-reset-all.sh
```
Report the diff.

---

### Task 8: Add the `env` block to `payments-app.ecs.yaml`

**Files:**
- Modify: `infra/services/dev/venture/core/public/payments-app.ecs.yaml`

Now that the runtime var (Plan 3) + schema/resolver (Plan 4) + deploy resolution (Task 5) exist, declare the cross-service env so the payments container gets the payment-api gateway URL at runtime.

- [ ] **Step 1: Add to `payments-app.ecs.yaml`**

```yaml
env:
  PAYMENT_API_BASE_URL:
    ref:
      gatewayBaseUrl: payment-api-ingress
```
(Confirm `payment-api-ingress` is the apigateway service name fronting the payment-api lambda — verified in the YAMLs.)

- [ ] **Step 2: Validate** — `pnpm platform:validate dev venture` passes (schema accepts env from Plan 4).

- [ ] **Step 3: Byte-identical check is now EXPECTED TO CHANGE for payments-app only**

```bash
pnpm platform:generate -- --env dev --venture venture --target floci
git status --short infra/services | grep main.tf.json
```
Expected: ONLY `payments-app/main.tf.json` (floci, and aws if generated) shows modified — now containing an `environment` entry. All other services unchanged. This is the intended first real use of the env feature. Inspect the diff to confirm it's just the `environment` addition (the `ref` resolves at deploy; at generate time without an id it'll be static-only/empty — so actually generate-time output may still omit it; confirm behavior matches Plan 4 Task 5's static-only generate decision, meaning the env only materializes during `floci:deploy`). Document what you observe.

- [ ] **Step 4: Commit checkpoint** (`git add infra/services/.../payments-app.ecs.yaml` and any regenerated tf). Report.

---

### Task 9: Live end-to-end verification

- [ ] **Step 1: Preconditions** — Floci up (`curl -i http://localhost:4566`), Docker running.

- [ ] **Step 2: Full reset + redeploy via the NEW CLI**
```bash
pnpm floci:reset:all
pnpm floci:deploy:all
```
Expected: completes; URLs printed.

- [ ] **Step 3: Verify all three flows return 200** (docs, payments, payment-api) and the payments app receives `PAYMENT_API_BASE_URL` (the page shows configured state / a payment POST through the UI path succeeds). Use the same checks as `docs/verify-redeploy-after-plugin-refactor.md` (ECS describe-services, API gateway curl, DynamoDB get-item).

- [ ] **Step 4: Verify `pnpm floci:url` and `pnpm floci:dev -- docs-app`** behave like the old scripts.

- [ ] **Step 5: Write `docs/verify-cli-replaces-shell.md`** in the same format as the existing verify doc, recording the commands and results.

- [ ] **Step 6: Full green check** — repo root `pnpm lint && pnpm typecheck && pnpm --filter @repo/platform test`.

- [ ] **Step 7: Commit checkpoint** — `git add -A` the CLI, package.json, deleted scripts, verify doc; report final summary.

---

## Self-Review Notes

- **Spec coverage:** Implements spec §5 (TS CLI replacing all five orchestration shell scripts, AWS SDK, manifest-driven, package.json collapsed) and closes the loop on §3/§4 by adding the payments `env` block (Task 8) so the runtime `PAYMENT_API_BASE_URL` is actually supplied.
- **Dependency on Plans 2–4:** Task 0 gates it.
- **Risk management:** pure logic (env scrub, URL building, reset planning, deploy build-args/ordering) is unit-tested; imperative AWS/docker/terraform orchestration is validated by the live run (Task 9). The genuinely hard integration (ref-env at deploy time) is isolated in Task 5 Step 4 with an explicit fallback-split instruction if it's too large.
- **Kept scripts:** the DDB helpers + `floci-invoke-payment-api.sh` + `floci-env.sh` stay; `reset.ts` spawns the kept `floci-ddb-reset.sh`.
- **Byte-identical nuance:** Terraform output stays identical until Task 8 deliberately opts payments-app into `env`; that one change is inspected.
- **Open decision:** Task 0 Step 2 asks the user to confirm AWS SDK deps vs spawning `aws` CLI — the one thing needing a human call before building.
- **No placeholders** except clearly-marked typed-fixture spots where the implementer must construct a real `ServiceManifestEntry` (oxlint forbids the `as any` shown for illustration).
```
