# TS CLI Replaces Shell Scripts Implementation Plan (Plan 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **REWRITTEN 2026-06-22** against the post-Spec-A/B/C codebase. The original draft predated the VPC work and assumed the now-obsolete Plan 4 (ECS `env`/`ref`). All references to `payment-api-ingress`, `PAYMENT_API_BASE_URL`, `resolveEcsEnv`, and `resolvedEcsEnv` have been removed. The demo now deploys a `network` module first and the payments app invokes the Lambda via the AWS SDK (no API Gateway in front).

**Goal:** Replace the hand-maintained Floci shell scripts with TypeScript CLI commands that derive every resource name from the service manifest, so adding a service — or a new resource type on an existing service — requires no shell edits. This directly fixes the class of bug seen on 2026-06-22, where `floci-reset-all.sh` didn't know about Spec C's Lambda security group + ECS task role and broke `redeploy:all`.

**Architecture:** A command layer under `src/cli/` exposes `floci-deploy`, `floci-url`, `floci-reset`, and `floci-dev`, each reading `loadServiceManifest()` and acting generically. A pure `planResetTargets(manifest)` enumerates teardown targets (gateways, ECS svc/cluster/ALB/target-groups, Lambda fn/role/policies/log-group/SG, ECS task roles, DDB tables, generated state dirs) **derived from service configs**, so new resource types are covered by reading the manifest, not by editing hardcoded lists. AWS calls go through `@aws-sdk/client-*` against the Floci endpoint with a scrubbed (no-proxy) environment. The four orchestration shell scripts are deleted; DDB helpers stay.

**Tech Stack:** TypeScript (ESM, `tsx`), AWS SDK v3 (user-confirmed), `node:child_process` (docker/terraform/pnpm spawns), Vitest.

---

## Optimization goal: eliminate the redundant Next.js build (carried over, still valid)

Cold `floci:deploy:all` currently builds each Next app **twice** (throwaway image to stand up the ALB, then real build with the gateway path). Root cause (unchanged, investigated): `assetPrefix = NEXT_PUBLIC_GATEWAY_PATH + basePath` is baked at `next build` (standalone output, no runtime hook); the gateway id only exists after the gateway is deployed; and the gateway's ECS integration reads the ALB by name, so the ALB (hence the ECS app) must exist first. Floci-only (AWS uses a custom domain, single build).

`floci-deploy` must do **one** real `next build` per app: bootstrap the ECS app/ALB with a placeholder/cached image (no full build), deploy the gateway to mint the id, then the single real build + redeploy. Fallback if the placeholder bootstrap is large: deploy the gateway first reusing a pre-existing `<image>:local`. AWS path skips the bootstrap entirely.

---

## Ground Rules

- Run platform commands from `packages/platform/`; `pnpm lint` + `pnpm typecheck` from repo ROOT (or `--filter @repo/platform`).
- **oxlint forbids `typescript/no-unsafe-type-assertion`** — type guards, not `as T`. Reuse existing accessor patterns in tests.
- **Do not `git commit`.** Each "Commit" step = `git add` + report; the user commits.
- This plan changes runtime tooling, NOT Terraform generation — the platform unit suite (currently 121 tests) and byte-identical generated output must stay green (the CLI calls the same `terraformForService`/`platform:deploy`).
- Floci endpoint nuance (learned in Spec C): host→Floci is `http://localhost:4566`; container→Floci is `http://host.docker.internal:4566`. The CLI runs on the **host**, so SDK clients use `http://localhost:4566`.

## Pre-req gate (Task 0)

Verify against CURRENT code (post Spec A/B/C):
```bash
cd packages/platform
grep -q "loadServiceManifest" src/registry.ts && echo "manifest ok"
grep -q "AppMetadata" src/registry.ts && echo "app field ok"
grep -q "frontedByGateway" src/registry.ts && echo "gateway link ok"
test -f ../../apps/Dockerfile && echo "shared dockerfile ok"
grep -q "PAYMENT_API_FUNCTION_NAME\|permissions" src/services/ecs/terraform.ts && echo "ecs permissions ok"
```
Expected: all "ok". (Note: there is intentionally NO `src/services/ecs/env.ts` / `resolvedEcsEnv` — Plan 4 was abandoned. Do not look for them.)

## Background: current shell scripts (verified 2026-06-22)

- **`scripts/floci-deploy-docs.sh`** — looks up docs gateway id; bootstraps docs-app+docs if missing; builds docs with `NEXT_PUBLIC_GATEWAY_PATH`; docker build; `platform:deploy docs-app,docs`; force-new-deployment; prints URLs.
- **`scripts/floci-deploy-payments.sh`** (updated in Spec C) — bootstraps **network,customer-records,payment-api** (lambda, in-VPC; no ingress) if the Lambda is absent; builds payments with `NEXT_PUBLIC_GATEWAY_PATH` only (no payment-api URL); docker build; `platform:deploy payments-app,payments`; force-new-deployment; prints URLs. The payments server reaches the Lambda via SDK using `PAYMENT_API_FUNCTION_NAME` (ECS task env from `permissions.lambda`).
- **`scripts/floci-url.sh`** (updated in Spec C) — resolves docs + payments gateway ids + ALB DNS; prints URLs; payment-api shows "invoked privately via SDK" (no gateway).
- **`scripts/docs-dev-floci.sh`** — resolves docs gateway id, exports `NEXT_PUBLIC_GATEWAY_PATH`, runs `pnpm --filter @repo/docs dev`.
- **`packages/platform/scripts/floci-reset-all.sh`** (updated in Spec C) — idempotently deletes: API gateways (docs, payments), ECS svc/cluster (docs-app, payments-app), ALBs+listeners+target-groups (docs + payments prefixes), Lambda fn + basic-exec detach + **vpc-access detach** + inline dynamodb policy + role + log group + **lambda SG** + **payments ECS task role + inline policy**, runs `floci-ddb-reset.sh`, `rm -rf` generated floci state dirs (NOT the network module dir). **This is the script whose hand-maintenance the CLI eliminates.**
- **KEPT (not replaced):** `floci-ddb-get-item.sh`, `floci-ddb-list-tables.sh`, `floci-ddb-reset.sh`, `floci-invoke-payment-api.sh`, `floci-env.sh`. `reset.ts` spawns the kept `floci-ddb-reset.sh`.
- **The `network` module is never torn down by reset** — it persists across redeploys (idempotent re-apply). The CLI must preserve this (reset does NOT delete the VPC/subnets/SGs/endpoints; it does not remove the network generated-state dir).

## Resource-name derivation (from manifest + emitter suffixes — no hardcoding)

For each manifest entry, derive teardown/deploy names. Suffixes are fixed by the emitters (confirm by reading `src/services/lambda/terraform.ts` and `src/services/ecs/terraform.ts`):

- **apigateway** entry → gateway API name = `entry.physicalName`.
- **ecs** entry → cluster name = service name = `entry.ecs.clusterName` (= physicalName); ALB name = `entry.ecs.albName`; target-group prefix = `entry.ecs.targetGroupPrefix`. If `entry.service.config.permissions?.lambda?.length` → also a task role `${physicalName}-task-role` + inline policy `${physicalName}-lambda-invoke`.
- **lambda** entry → function = `entry.physicalName`; role = `${physicalName}-lambda-role`; log group = `/aws/lambda/${physicalName}`; security group = `${physicalName}-sg`; managed attachments = basic-exec + `AWSLambdaVPCAccessExecutionRole`; inline dynamodb policy `${physicalName}-dynamodb-access` (only if `permissions.dynamodb.length`).
- **app-backed** entry (`entry.app`) → build command `pnpm --filter ${app.packageName} build`, docker build via shared `apps/Dockerfile` with `APP_NAME=${app.base}` / `PORT=${app.devPort}`, image `<image.repository>:<tag>` from the ecs config.
- generated state dir = `generatedDirectoryForService(metadata, "floci")`.

> Deriving these in a pure `planResetTargets`/`planDeploy` from the manifest is the whole point: when a future service type adds a resource, you teach the planner once (keyed off config), and every command benefits. No more "reset forgot the new SG."

---

## File Structure (end state)

```
packages/platform/src/cli/
  floci-env.ts     # scrubbedEnv() + FLOCI_ENDPOINT + flociClientConfig()
  aws.ts           # typed SDK wrappers (getApiIdByName, forceNewEcsDeployment, delete* — idempotent)
  reset.ts         # planResetTargets(manifest) [pure] + runFlociReset() [imperative]
  url.ts           # buildServiceUrls(...) [pure] + runFlociUrl() [imperative]
  deploy.ts        # gatewayPathFor/buildArgsFor [pure] + runFlociDeploy(serviceName) [imperative]
  dev.ts           # runFlociDev(serviceName)
packages/platform/tests/platform/
  cli-env.test.ts  cli-reset.test.ts  cli-url.test.ts  cli-deploy.test.ts
packages/platform/package.json  # new deps + script entries (floci:url/reset:all/deploy:service/dev)
package.json (root)             # generic entries; remove the 4 deploy/url/dev shell entries
scripts/floci-deploy-docs.sh        DELETED
scripts/floci-deploy-payments.sh    DELETED
scripts/floci-url.sh                DELETED
scripts/docs-dev-floci.sh           DELETED
packages/platform/scripts/floci-reset-all.sh  DELETED
```

---

### Task 0: Pre-req gate + dependencies

- [ ] **Step 1:** Run the pre-req gate commands above; confirm all "ok".
- [ ] **Step 2: Add AWS SDK deps** (user confirmed SDK over `aws` CLI):
```bash
pnpm --filter @repo/platform add @aws-sdk/client-apigatewayv2 @aws-sdk/client-ecs @aws-sdk/client-elastic-load-balancing-v2 @aws-sdk/client-iam @aws-sdk/client-cloudwatch-logs @aws-sdk/client-ec2 @aws-sdk/client-lambda
```
(`@aws-sdk/client-ec2` is needed for the Lambda security-group teardown by name. `@aws-sdk/client-dynamodb` already present.)
- [ ] **Step 3:** Commit checkpoint — stage `packages/platform/package.json` + `pnpm-lock.yaml`; report.

---

### Task 1: `floci-env.ts` — scrubbed env + client factory

**Files:** Create `src/cli/floci-env.ts`, `tests/platform/cli-env.test.ts`

- [ ] **Step 1: Failing test**
```ts
import { describe, expect, test } from "vitest";
import { scrubbedEnv, FLOCI_ENDPOINT } from "../../src/cli/floci-env";

describe("floci scrubbed env", () => {
  test("sets test creds + region, keeps PATH", () => {
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
  test("host-side endpoint", () => {
    expect(FLOCI_ENDPOINT).toBe("http://localhost:4566");
  });
});
```
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement**
```ts
// src/cli/floci-env.ts
export const FLOCI_ENDPOINT = "http://localhost:4566";
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];

export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of PROXY_KEYS) delete env[key];
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
  return { endpoint: FLOCI_ENDPOINT, region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } };
}
```
- [ ] **Step 4: PASS; suite + typecheck + lint; commit checkpoint** (`git add src/cli/floci-env.ts tests/platform/cli-env.test.ts`).

---

### Task 2: `aws.ts` — typed idempotent SDK wrappers

**Files:** Create `src/cli/aws.ts`

- [ ] **Step 1: Implement** thin wrappers using `flociClientConfig()`. Each swallows not-found errors (`NotFound`/`ResourceNotFoundException`/`NoSuchEntity`/`InvalidGroup.NotFound`) via one shared `isNotFound(err)` predicate. Functions:
  - `getApiIdByName(name): Promise<string | undefined>` (ApiGatewayV2 `GetApisCommand`)
  - `deleteApiByName(name)` (find id → `DeleteApiCommand`)
  - `forceNewEcsDeployment(cluster, service)` (`UpdateServiceCommand { forceNewDeployment: true }`)
  - `deleteEcsService(cluster, service)` (`UpdateService desiredCount 0` then `DeleteServiceCommand { force: true }`), `deleteEcsCluster(cluster)`
  - `deleteAlbByName(name)` (describe → delete listeners → delete LB), `deleteTargetGroupsByPrefix(prefix)`
  - `deleteLambda(name)`, `deleteLogGroup(name)`
  - `detachRolePolicy(role, policyArn)`, `deleteRolePolicy(role, inlineName)`, `deleteRole(role)`
  - `deleteSecurityGroupByName(name)` (EC2 describe by `group-name` → `DeleteSecurityGroupCommand`)
  - `describeEcsService(cluster, service)` (for url/verify)
  No unit tests (pure IO); exercised in Task 7's live run.
- [ ] **Step 2: typecheck + lint; commit checkpoint** (`git add src/cli/aws.ts`).

---

### Task 3: `reset.ts` — manifest-derived teardown

**Files:** Create `src/cli/reset.ts`, `tests/platform/cli-reset.test.ts`

- [ ] **Step 1: Failing test for the PURE planner** (build a fixture manifest via `buildServiceManifest` over fixture `LoadedService[]`, OR call `loadServiceManifest` against the real tree):
```ts
import { planResetTargets } from "../../src/cli/reset";
import { buildServiceManifest } from "../../src/registry";
// fixtures: payment-api (lambda, permissions.dynamodb), customer-records (dynamodb),
// docs/payments (apigateway), docs-app/payments-app (ecs; payments-app has permissions.lambda)

test("derives every teardown target from the manifest", () => {
  const plan = planResetTargets(buildServiceManifest(fixtures));
  expect(plan.apiGatewayNames).toEqual(
    expect.arrayContaining(["dev-venture-core-public-docs", "dev-venture-core-public-payments"]),
  );
  expect(plan.ecs).toEqual(expect.arrayContaining([
    expect.objectContaining({ cluster: "dev-venture-core-public-payments-app", targetGroupPrefix: "payme-" }),
  ]);
  // lambda resources derived with the emitter suffixes
  expect(plan.lambdas).toContainEqual(expect.objectContaining({
    functionName: "dev-venture-core-internal-payment-api",
    roleName: "dev-venture-core-internal-payment-api-lambda-role",
    logGroup: "/aws/lambda/dev-venture-core-internal-payment-api",
    securityGroupName: "dev-venture-core-internal-payment-api-sg",
    inlineDynamoPolicy: "dev-venture-core-internal-payment-api-dynamodb-access",
  }));
  // ECS task role only for ecs services that invoke lambda
  expect(plan.ecsTaskRoles).toContainEqual(expect.objectContaining({
    roleName: "dev-venture-core-public-payments-app-task-role",
    inlinePolicy: "dev-venture-core-public-payments-app-lambda-invoke",
  }));
  // network is NOT in any teardown list
  expect(JSON.stringify(plan)).not.toContain("network");
});
```
> Before writing the implementation, READ `src/services/lambda/terraform.ts` + `src/services/ecs/terraform.ts` and confirm the exact suffixes: lambda role `physicalName(metadata,"lambda-role")`, log group `/aws/lambda/${physicalName}`, SG `physicalName(metadata,"sg")`, dynamodb inline `physicalName(metadata,"dynamodb-access")`; ECS task role `physicalName(metadata,"task-role")`, invoke inline `physicalName(metadata,"lambda-invoke")`. Mirror them in the planner. (`physicalName(m, suffix)` joins with `-`.)

- [ ] **Step 2: FAIL → implement `planResetTargets(manifest): ResetPlan`** — pure, iterating manifest entries by `serviceType`, deriving names as above, EXCLUDING `network`. Include `stateDirsToRemove` = `generatedDirectoryForService(metadata, "floci")` for every non-network service.
- [ ] **Step 3: Implement `runFlociReset()`** — check Floci reachable (a cheap SDK call); execute the plan via `aws.ts` wrappers in safe order (gateways → ECS services → clusters → ALBs/listeners/target-groups → lambda: detach basic-exec + vpc-access, delete inline dynamodb policy, delete role, delete function, delete log group, delete SG → ECS task roles: delete inline, delete role); spawn the kept `packages/platform/scripts/floci-ddb-reset.sh` with `scrubbedEnv()`; `rm -rf` the `stateDirsToRemove`. Print progress lines. Add `if (isCliEntry) runFlociReset()`.
- [ ] **Step 4: pure test PASS; suite + typecheck + lint; commit checkpoint** (`git add src/cli/reset.ts tests/platform/cli-reset.test.ts`).

---

### Task 4: `url.ts` — pure URL building + command

**Files:** Create `src/cli/url.ts`, `tests/platform/cli-url.test.ts`

- [ ] **Step 1: Failing test for `buildServiceUrls`** (pure; input = resolved per-app rows):
```ts
import { buildServiceUrls } from "../../src/cli/url";
test("gateway + alb urls for a fronted ecs app", () => {
  const lines = buildServiceUrls([
    { serviceName: "docs-app", basePath: "/docs", gatewayId: "abc", albDns: "docs-x.elb.localhost", containerHost: "docs.floci.localhost", containerPort: 3001 },
  ]).join("\n");
  expect(lines).toContain("http://localhost:4566/execute-api/abc/$default/docs");
  expect(lines).toContain("http://docs-x.elb.localhost/docs");
});
test("Not deployed when gatewayId missing", () => {
  expect(buildServiceUrls([{ serviceName: "docs-app", basePath: "/docs", gatewayId: undefined, albDns: undefined, containerHost: "h", containerPort: 3001 }]).join("\n")).toMatch(/not deployed/i);
});
```
- [ ] **Step 2: FAIL → implement `buildServiceUrls` (pure).** Also include a fixed "Payment API: invoked privately via SDK (no gateway)" note line (the payment-api has no URL). Base path = the fronting gateway's first route path, passed in.
- [ ] **Step 3: Implement `runFlociUrl()`** — load manifest; for each apigateway entry resolve API id via `getApiIdByName` (fallback to tfstate read); for each fronted ecs entry resolve ALB DNS from its floci tfstate; derive base paths from gateway route paths; print `buildServiceUrls(...)`. `if (isCliEntry) runFlociUrl()`.
- [ ] **Step 4: pure tests PASS; suite + typecheck + lint; commit checkpoint.**

---

### Task 5: `deploy.ts` — manifest-driven deploy (single build, network-first)

**Files:** Create `src/cli/deploy.ts`, `tests/platform/cli-deploy.test.ts`

- [ ] **Step 1: Failing tests for PURE helpers** (construct a real `ServiceManifestEntry` fixture — NO `as any`):
```ts
import { gatewayPathFor, dockerBuildArgsFor } from "../../src/cli/deploy";
test("gateway path", () => { expect(gatewayPathFor("abc")).toBe("/execute-api/abc/$default"); });
test("docker build args from manifest entry", () => {
  const entry = /* real ServiceManifestEntry for payments-app with app.base=payments, ecs.containerPort=3002 */;
  expect(dockerBuildArgsFor(entry)).toEqual({ APP_NAME: "payments", PORT: 3002 });
});
```
- [ ] **Step 2: FAIL → implement pure helpers** (`gatewayPathFor`, `dockerBuildArgsFor`, and `prerequisiteServices(entry, manifest)` returning the in-VPC deps an app needs deployed first — e.g. for payments-app: `network`, `customer-records`, `payment-api` because it invokes the lambda; derive lambda deps from `entry.service.config.permissions?.lambda` + always `network`).
- [ ] **Step 3: Implement `runFlociDeploy(serviceName)`** for an app service + its fronting gateway:
  1. Load manifest; find app `entry` + `frontedByGateway`.
  2. Ensure prerequisites: deploy `network` first; if the app invokes a lambda and that lambda isn't deployed (check via SDK `getFunction` equiv or `lambda_exists`), `platform:deploy network,<dynamo deps>,<lambda>` (package the lambda first via `pnpm app:<lambda>:package` if a packaging script exists). NO `payment-api-ingress`.
  3. Resolve the app's own gateway id via `getApiIdByName(frontedByGateway.physicalName)`. If missing → bootstrap the ECS app/ALB with a placeholder/cached image (NO full `next build`), `platform:deploy <app>` then `<gateway>`, re-resolve id.
  4. The SINGLE real build: `pnpm <app>:build` with `NEXT_PUBLIC_GATEWAY_PATH=gatewayPathFor(id)` set in the spawned env; `docker build -f apps/Dockerfile` with `dockerBuildArgsFor(entry)`.
  5. `platform:deploy <app>,<gateway>` (spawn `pnpm platform:deploy -- --env dev --venture venture --target floci --services ...` with `scrubbedEnv()`).
  6. `forceNewEcsDeployment(entry.ecs.clusterName, entry.ecs.clusterName)`.
  7. Print URLs via the url core.
  > Build-count: cold deploy does at most ONE `next build` per app. No `NEXT_PUBLIC_PAYMENT_API_BASE_URL` (gone). The payments task gets `PAYMENT_API_FUNCTION_NAME` + Floci AWS env from the ECS emitter automatically — the CLI does nothing special for it.
- [ ] **Step 4: pure tests PASS; suite + typecheck + lint; commit checkpoint.**

---

### Task 6: `dev.ts` — `floci-dev`

**Files:** Create `src/cli/dev.ts`

- [ ] **Step 1: Implement `runFlociDev(serviceName)`** — load manifest, find app entry + fronting gateway, resolve gateway id, spawn `pnpm --filter <app.packageName> dev` with `NEXT_PUBLIC_GATEWAY_PATH` + `scrubbedEnv()`. Generalizes `docs-dev-floci.sh` to any app. Omit the `lsof` lock cleanup unless trivial.
- [ ] **Step 2: typecheck + lint; commit checkpoint.**

---

### Task 7: Wire package.json; delete shell scripts; live verify

**Files:** Modify `packages/platform/package.json`, root `package.json`; delete 4 shell scripts.

- [ ] **Step 1: Platform script entries** (`packages/platform/package.json`): replace the shell `floci:reset:all` with `"floci:reset:all": "tsx --no-cache src/cli/reset.ts"`; add `"floci:url": "tsx --no-cache src/cli/url.ts"`, `"floci:deploy:service": "tsx --no-cache src/cli/deploy.ts"`, `"floci:dev": "tsx --no-cache src/cli/dev.ts"`.
- [ ] **Step 2: Root `package.json`:**
  - `floci:url` → `pnpm --filter @repo/platform run floci:url`
  - `floci:deploy:docs` → `pnpm --filter @repo/platform run floci:deploy:service -- docs-app`
  - `floci:deploy:payments` → `pnpm --filter @repo/platform run floci:deploy:service -- payments-app`
  - `docs:dev:floci` → `pnpm --filter @repo/platform run floci:dev -- docs-app`
  - `floci:deploy:all`, `floci:redeploy:all`, `floci:reset:all` (delegates to platform) stay.
  - Keep `docs:build`/`payments:build`/`*:docker:build` (the CLI may shell to them).
- [ ] **Step 3: Delete the 4 orchestration scripts** (reset script is replaced via the platform entry change in Step 1):
```bash
git rm scripts/floci-deploy-docs.sh scripts/floci-deploy-payments.sh scripts/floci-url.sh scripts/docs-dev-floci.sh packages/platform/scripts/floci-reset-all.sh
```
- [ ] **Step 4: Grep for dangling refs:**
```bash
grep -rn "floci-deploy-docs\|floci-deploy-payments\|floci-url.sh\|docs-dev-floci\|floci-reset-all" --include="*.json" --include="*.sh" . | grep -v docs/superpowers
```
Fix any. Confirm `reset.ts` spawns the KEPT `packages/platform/scripts/floci-ddb-reset.sh`.
- [ ] **Step 5: Live verify** (Floci up + Docker):
```bash
pnpm floci:redeploy:all        # now fully TS-driven reset + deploy
```
Then confirm: docs 200, payments 200, and a payment POST (`/payments/api/payments`) persists to DynamoDB (the Spec C acceptance flow). Also `pnpm floci:url` prints sane URLs and `pnpm floci:dev -- docs-app` starts. **Critically: the reset must succeed without the Spec-C-resource bug** — `planResetTargets` derives the lambda SG + ECS task role from the manifest, so they're torn down automatically.
- [ ] **Step 6: Write `docs/verify-cli-replaces-shell.md`** recording commands + results.
- [ ] **Step 7: Full green** — repo root `pnpm lint && pnpm --filter @repo/platform typecheck && pnpm --filter @repo/platform test`. Commit checkpoint (`git add -A` the cli, package.json, deleted scripts, verify doc).

---

## Self-Review Notes

- **Coverage:** spec §5 (TS CLI replaces the 4 orchestration scripts + the reset script; AWS SDK; manifest-driven; package.json collapsed). The obsolete Plan-4 `env`/`ref` Task (old Task 8) is REMOVED. The old Task 0 Plan-4 pre-reqs are REMOVED.
- **The bug this prevents:** `planResetTargets` derives teardown targets from service configs (lambda SG, ECS task role, vpc-access detach all fall out of reading the manifest), so the 2026-06-22 reset failure class cannot recur when a new resource type is added — you teach the planner once.
- **Network preserved:** reset never tears down the `network` module (no VPC/subnet/SG/endpoint deletes, no network state-dir removal) — matches current behavior and keeps redeploy idempotent.
- **Floci endpoint nuance:** CLI runs host-side → `http://localhost:4566`. (Container-side `host.docker.internal` is only for ECS task env, already handled by the ECS emitter.)
- **Single-build optimization** retained (Task 5 step 3).
- **No placeholders:** the one fixture spot in Task 5 explicitly requires a real typed `ServiceManifestEntry` (no `as any`).
- **Deps:** AWS SDK v3 (user-confirmed), incl. `@aws-sdk/client-ec2` for SG-by-name teardown.
- **Type consistency:** `planResetTargets`/`ResetPlan`, `buildServiceUrls`, `gatewayPathFor`/`dockerBuildArgsFor`/`prerequisiteServices`, `runFloci{Reset,Url,Deploy,Dev}`, `scrubbedEnv`/`flociClientConfig` used consistently.
