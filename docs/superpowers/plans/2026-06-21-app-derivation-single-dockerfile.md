# App Derivation + Single Dockerfile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive each app-backed service's build metadata (app directory, package name, build command, Dockerfile, dev port) by convention from the service name, expose it on the service manifest as an `app` field, collapse the two near-identical Next.js Dockerfiles into one parameterized Dockerfile, and convert `NEXT_PUBLIC_PAYMENT_API_BASE_URL` from a build-time-inlined client var to a runtime server-read var so no app-specific build args remain.

**Architecture:** Add an `app` field to `ServiceManifestEntry` (from Plan 2) computed by a pure `deriveApp(metadata, config)` function: strip a trailing `-app` from the service name to get the app base, map to `apps/<base>`, `@repo/<base>`, the shared Dockerfile, and the container port. Derivation is validated against the filesystem (the app dir and its `package.json` build script must exist) so a misnamed service fails fast. One parameterized `apps/Dockerfile` replaces `apps/docs/Dockerfile` and `apps/payments/Dockerfile`. The payments page is split into a server component that reads `PAYMENT_API_BASE_URL` (runtime) and passes it as a prop to the existing client component.

**Tech Stack:** TypeScript (ESM, `tsx`), Zod 4, Vitest, Next.js (standalone output), Docker, pnpm workspaces.

**This is Plan 3 of the 5-plan sequence** (plugins ✅ → registry (names) → **app-derivation/Dockerfile** → ECS env → TS CLI). Depends on Plan 2's `src/registry.ts` (`ServiceManifestEntry`, `buildServiceManifest`).

---

## Ground Rules

- Run from `packages/platform/` for platform tests; app changes are under `apps/`. Test: `pnpm test`; repo-root `pnpm lint` and `pnpm typecheck` (via turbo) must be clean.
- **oxlint forbids `no-unsafe-type-assertion`** — use type guards, not `as T`.
- **Do not commit** — stage and report each checkpoint; the user commits.
- This plan changes app runtime behavior (the payments env var). The platform-side manifest changes are behavior-preserving for Terraform generation (the `app` field is additive and not yet consumed by the generator). Verify the byte-identical Terraform gate still holds at the end.
- **Pre-req check:** confirm Plan 2 is merged/applied — `src/registry.ts` must exist and export `ServiceManifestEntry` and `buildServiceManifest`. If it does not, STOP: this plan cannot proceed.

## Background: verified current state

- **Dockerfiles take NO build args.** `apps/docs/Dockerfile` and `apps/payments/Dockerfile` are identical except `PORT`/`EXPOSE` (3001 vs 3002) and the `apps/<name>` copy paths. `NEXT_PUBLIC_*` values are baked during the host-side `pnpm <app>:build` (`next build`) BEFORE the Docker build — the Dockerfile just copies `.next/standalone` + `.next/static`.
- **`NEXT_PUBLIC_GATEWAY_PATH`** is consumed in `apps/<app>/next.config.ts` (sets `assetPrefix`/`rewrites`) — baked at `next build`, uniform across apps, derivable. Stays a build-time var (set before `next build`); NOT this plan's concern to change.
- **`NEXT_PUBLIC_PAYMENT_API_BASE_URL`** is read in `apps/payments/app/page.tsx` (a `"use client"` component) via `process.env`. Because it's `NEXT_PUBLIC_`, Next inlines it at build time — which is why the shell script sets it before `pnpm payments:build`. This plan converts it to a runtime server var.
- Service → app name mapping (verified): `docs-app`→`docs` (apigateway `docs` already owns the `docs` name, so the ECS service is `docs-app`), `payments-app`→`payments`, `payment-api`→`payment-api` (lambda, no `-app` suffix). Rule: **strip a single trailing `-app` if present**.
- App packages: `@repo/docs` (port 3001), `@repo/payments` (port 3002), `@repo/payment-api` (lambda, has `package` script not `build`).
- `ServiceManifestEntry` (Plan 2) currently has: `service`, `metadata`, `physicalName`, optional `ecs`, optional `frontedByGateway`.

---

## File Structure (end state)

```
packages/platform/src/
  registry.ts                       # MODIFIED: add `app` field + deriveApp()
  app-derivation.ts                 # NEW: pure derivation + filesystem validation
packages/platform/tests/platform/
  app-derivation.test.ts            # NEW
  registry.test.ts                  # MODIFIED: assert app field
apps/
  Dockerfile                        # NEW: parameterized (ARG APP_NAME, ARG PORT)
  docs/Dockerfile                   # DELETED
  payments/Dockerfile               # DELETED
  payments/app/page.tsx             # MODIFIED: becomes server component
  payments/app/payments-form.tsx    # NEW: the existing client UI, takes baseUrl prop
package.json                        # MODIFIED: docker build commands use shared Dockerfile
```

---

### Task 1: Pure app-derivation function (no filesystem yet)

**Files:**
- Create: `packages/platform/src/app-derivation.ts`
- Create: `packages/platform/tests/platform/app-derivation.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/platform/tests/platform/app-derivation.test.ts
import { describe, expect, test } from "vitest";
import { deriveAppNames } from "../../src/app-derivation";

describe("deriveAppNames", () => {
  test("strips a trailing -app to get the app base", () => {
    expect(deriveAppNames("docs-app")).toEqual({
      base: "docs",
      dir: "apps/docs",
      packageName: "@repo/docs",
      dockerfile: "apps/Dockerfile",
    });
  });

  test("handles payments-app", () => {
    expect(deriveAppNames("payments-app").base).toBe("payments");
    expect(deriveAppNames("payments-app").packageName).toBe("@repo/payments");
  });

  test("leaves a name without -app suffix unchanged (lambda app)", () => {
    expect(deriveAppNames("payment-api")).toEqual({
      base: "payment-api",
      dir: "apps/payment-api",
      packageName: "@repo/payment-api",
      dockerfile: "apps/Dockerfile",
    });
  });

  test("only strips a SINGLE trailing -app, not mid-name", () => {
    expect(deriveAppNames("app-runner").base).toBe("app-runner");
    expect(deriveAppNames("my-app-app").base).toBe("my-app");
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `pnpm vitest run tests/platform/app-derivation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/platform/src/app-derivation.ts
export type AppNames = {
  base: string;
  dir: string;
  packageName: string;
  dockerfile: string;
};

export function deriveAppNames(serviceName: string): AppNames {
  const base = serviceName.endsWith("-app") ? serviceName.slice(0, -"-app".length) : serviceName;
  return {
    base,
    dir: `apps/${base}`,
    packageName: `@repo/${base}`,
    dockerfile: "apps/Dockerfile",
  };
}
```

- [ ] **Step 4: Run, confirm PASS (4 tests)**

Run: `pnpm vitest run tests/platform/app-derivation.test.ts`
Expected: PASS.

- [ ] **Step 5: Suite + typecheck + lint**

Run: `pnpm test && pnpm typecheck`, repo-root `pnpm lint`.
Expected: clean.

- [ ] **Step 6: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/app-derivation.ts packages/platform/tests/platform/app-derivation.test.ts
```
Report the diff.

---

### Task 2: Filesystem validation of derived apps

**Files:**
- Modify: `packages/platform/src/app-derivation.ts`
- Modify: `packages/platform/tests/platform/app-derivation.test.ts`

Derivation must fail fast if the app dir or its expected build script is missing, so a misnamed/typo'd service is caught at manifest-build time rather than silently mis-deployed.

- [ ] **Step 1: Add failing tests**

```ts
import { validateAppExists } from "../../src/app-derivation";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("validateAppExists passes for a real app (docs)", () => {
  expect(() => validateAppExists(deriveAppNames("docs-app"), repoRoot)).not.toThrow();
});

test("validateAppExists throws for a non-existent app", () => {
  expect(() => validateAppExists(deriveAppNames("ghost-app"), repoRoot)).toThrow(
    /app directory not found/i,
  );
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `pnpm vitest run tests/platform/app-derivation.test.ts`
Expected: FAIL — `validateAppExists` not exported.

- [ ] **Step 3: Implement**

```ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function validateAppExists(app: AppNames, repoRoot: string): void {
  const dir = path.join(repoRoot, app.dir);
  if (!existsSync(dir)) {
    throw new Error(`Derived app directory not found for ${app.packageName}: ${app.dir}`);
  }
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`Derived app has no package.json: ${app.dir}/package.json`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
  if (pkg.name !== app.packageName) {
    throw new Error(
      `Derived app package name mismatch: expected ${app.packageName}, found ${pkg.name ?? "<none>"} in ${app.dir}/package.json`,
    );
  }
}
```

> The `JSON.parse(...) as { name?: string }` cast may trip oxlint. If so, parse into `unknown` and read `name` via a small guard (`typeof obj === "object" && obj !== null && "name" in obj`). Report which you used.

- [ ] **Step 4: Run, confirm PASS (6 tests)**

Run: `pnpm vitest run tests/platform/app-derivation.test.ts`
Expected: PASS.

- [ ] **Step 5: Suite + typecheck + lint** (as before). Commit checkpoint:

```bash
git add packages/platform/src/app-derivation.ts packages/platform/tests/platform/app-derivation.test.ts
```
Report the diff.

---

### Task 3: Add the `app` field to the manifest

**Files:**
- Modify: `packages/platform/src/registry.ts`
- Modify: `packages/platform/tests/platform/registry.test.ts`

App metadata applies to ECS services (containerised apps) and Lambda services (packaged apps). DynamoDB and API Gateway services have no `app`.

- [ ] **Step 1: Add failing test to registry.test.ts**

```ts
test("attaches derived app metadata to ecs services with dev port", () => {
  const [entry] = buildServiceManifest([ecsService]); // payments-app from Plan 2 fixtures
  expect(entry.app).toMatchObject({
    base: "payments",
    dir: "apps/payments",
    packageName: "@repo/payments",
    dockerfile: "apps/Dockerfile",
    devPort: 3002,
  });
});

test("does not attach app metadata to dynamodb services", () => {
  const [entry] = buildServiceManifest([dynamoService]);
  expect(entry.app).toBeUndefined();
});
```

> `ecsService`/`dynamoService` are the fixtures defined in `registry.test.ts` in Plan 2. If validation against the real filesystem is in play, `payments` exists so it passes. If your `buildServiceManifest` calls `validateAppExists`, the test fixtures use real app names (`payments-app`, `docs-app`) so they validate; ensure `dynamoService` (customer-records) gets no `app` and thus no validation.

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement in registry.ts**

Add `app?: AppMetadata` to `ServiceManifestEntry`, where:
```ts
import { deriveAppNames, validateAppExists, type AppNames } from "./app-derivation";

export type AppMetadata = AppNames & { devPort?: number };
```
Compute it only for ecs/lambda. For ECS, `devPort = config.service.containerPort`. For Lambda, no `devPort`. `buildServiceManifest` needs a repo root to validate; add an optional param defaulting to the platform-relative repo root used elsewhere (match how `generate.ts`/`validate.ts` compute `repoRoot` = `path.resolve(import.meta.dirname, "../../..")`).

```ts
function appMetadataFor(service: LoadedService, repoRoot: string): AppMetadata | undefined {
  const t = service.metadata.serviceType;
  if (t !== "ecs" && t !== "lambda") {
    return undefined;
  }
  const names = deriveAppNames(service.metadata.serviceName);
  validateAppExists(names, repoRoot);
  return t === "ecs"
    ? { ...names, devPort: (service as Extract<LoadedService, { metadata: { serviceType: "ecs" } }>).config.service.containerPort }
    : names;
}
```

> Avoid the `as` cast above by using the existing `isEcsService` guard you already have in `registry.ts` (from Plan 2). Rewrite `appMetadataFor` to branch on `isEcsService(service)` so the config access is type-safe. Report the final form.

Wire into `buildServiceManifest` (add `repoRoot` param, default it):
```ts
import path from "node:path";
const defaultRepoRoot = path.resolve(import.meta.dirname, "../../..");

export function buildServiceManifest(
  services: LoadedService[],
  repoRoot: string = defaultRepoRoot,
): ServiceManifestEntry[] {
  const fronting = gatewayFrontingByService(services);
  return services.map((service) => ({
    service,
    metadata: service.metadata,
    physicalName: physicalName(service.metadata),
    ...(isEcsService(service) ? { ecs: ecsNamesFor(service) } : {}),
    ...(fronting.has(service.metadata.serviceName)
      ? { frontedByGateway: fronting.get(service.metadata.serviceName) }
      : {}),
    ...(appMetadataFor(service, repoRoot) ? { app: appMetadataFor(service, repoRoot) } : {}),
  }));
}
```
(Compute `appMetadataFor` once into a local to avoid calling twice.)

- [ ] **Step 4: Run registry tests, confirm PASS**

Run: `pnpm vitest run tests/platform/registry.test.ts`
Expected: PASS. NOTE: Plan 2's `loadServiceManifest` test reads the real tree — confirm every ecs/lambda service in `infra/services` has a matching `apps/<base>` dir, else `buildServiceManifest` now throws. The three apps (docs, payments, payment-api) all exist, so it passes. If a service has no app dir, that's a real finding — report it.

- [ ] **Step 5: Suite + typecheck + lint.** Commit checkpoint:

```bash
git add packages/platform/src/registry.ts packages/platform/tests/platform/registry.test.ts
```
Report the diff.

---

### Task 4: Parameterized single Dockerfile

**Files:**
- Create: `apps/Dockerfile`
- Test: manual docker build of both apps

- [ ] **Step 1: Create `apps/Dockerfile`**

```dockerfile
ARG NODE_IMAGE_TAG=24

FROM node:${NODE_IMAGE_TAG}-alpine AS runner
ARG APP_NAME
ARG PORT
ENV NODE_ENV=production
ENV PORT=${PORT}
WORKDIR /app

COPY apps/${APP_NAME}/.next/standalone ./
COPY apps/${APP_NAME}/.next/static ./apps/${APP_NAME}/.next/static

EXPOSE ${PORT}
CMD ["sh", "-c", "node apps/${APP_NAME}/server.js"]
```

> NOTE: the original used `CMD ["node", "apps/docs/server.js"]` (exec form, no shell). Because `APP_NAME` must expand at runtime, use the shell form `sh -c`. This is the one intentional deviation from the originals; it is functionally equivalent for these apps. If you prefer to keep exec form, bake the path at build time via a heredoc — but `sh -c` is simpler and acceptable.

- [ ] **Step 2: Build both images using the shared Dockerfile**

First ensure builds exist (host-side):
```bash
pnpm docs:build && pnpm payments:build
```
Then:
```bash
docker build -f apps/Dockerfile --build-arg APP_NAME=docs --build-arg PORT=3001 -t nebula-docs:local .
docker build -f apps/Dockerfile --build-arg APP_NAME=payments --build-arg PORT=3002 -t nebula-payments:local .
```
Expected: both succeed. Spot-check: `docker run --rm -e PORT=3001 -p 3001:3001 nebula-docs:local` starts and serves (Ctrl-C to stop), or at minimum `docker create` + inspect the image entrypoint.

- [ ] **Step 3: Update package.json docker build scripts**

Replace:
```json
"docs:docker:build": "docker build -f apps/docs/Dockerfile -t nebula-docs:local .",
"payments:docker:build": "docker build -f apps/payments/Dockerfile -t nebula-payments:local ."
```
with:
```json
"docs:docker:build": "docker build -f apps/Dockerfile --build-arg APP_NAME=docs --build-arg PORT=3001 -t nebula-docs:local .",
"payments:docker:build": "docker build -f apps/Dockerfile --build-arg APP_NAME=payments --build-arg PORT=3002 -t nebula-payments:local ."
```
(These per-app script entries get fully removed in Plan 5 when the CLI derives them from the manifest. For now, keep them working.)

- [ ] **Step 4: Delete the old Dockerfiles**

```bash
git rm apps/docs/Dockerfile apps/payments/Dockerfile
```

- [ ] **Step 5: Verify .dockerignore doesn't break the shared context** — the build context is repo root (`.`), unchanged from before. Confirm `pnpm docs:docker:build` and `pnpm payments:docker:build` both still succeed after the script edit.

- [ ] **Step 6: Commit (checkpoint — stage, report, do not commit)**

```bash
git add apps/Dockerfile package.json && git rm --cached apps/docs/Dockerfile apps/payments/Dockerfile
```
(The `git rm` in Step 4 already staged the deletions; ensure they're staged. Do NOT commit.)
Report the diff.

---

### Task 5: Convert `NEXT_PUBLIC_PAYMENT_API_BASE_URL` to a runtime server var

**Files:**
- Create: `apps/payments/app/payments-form.tsx`
- Modify: `apps/payments/app/page.tsx`
- Test: manual (Next dev + the live flow in Plan 5's verify)

The client component reads `process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL` (build-time inlined). Convert: `page.tsx` becomes a server component that reads `process.env.PAYMENT_API_BASE_URL` at runtime and passes it as a prop to a new client component holding the existing form UI.

- [ ] **Step 1: Read the full current `apps/payments/app/page.tsx`**

Run: `cat apps/payments/app/page.tsx`. Note the entire client component (state, `submitPayment`, JSX, `trimTrailingSlash`, `defaultPaymentApiBaseUrl`).

- [ ] **Step 2: Create the client component `payments-form.tsx`**

Move the ENTIRE current client component into `apps/payments/app/payments-form.tsx`, unchanged EXCEPT:
- Keep `"use client";` at the top.
- Accept the base URL as a prop instead of reading `process.env`:
  ```ts
  export function PaymentsForm({ paymentApiBaseUrl: rawBaseUrl }: { paymentApiBaseUrl: string }) {
    const paymentApiBaseUrl = useMemo(() => trimTrailingSlash(rawBaseUrl ?? ""), [rawBaseUrl]);
    // ...rest identical (isConfigured, submitPayment, JSX)...
  }
  ```
- Move `trimTrailingSlash` and any helpers with it.

- [ ] **Step 3: Rewrite `page.tsx` as a server component**

```tsx
import { PaymentsForm } from "./payments-form";

export default function PaymentsPage() {
  const paymentApiBaseUrl = process.env.PAYMENT_API_BASE_URL ?? "";
  return <PaymentsForm paymentApiBaseUrl={paymentApiBaseUrl} />;
}
```
Remove `"use client";` from page.tsx (it's now a server component). Ensure no `useState`/`useMemo`/event handlers remain in page.tsx.

- [ ] **Step 4: Typecheck the app**

Run: `pnpm --filter @repo/payments typecheck`
Expected: clean.

- [ ] **Step 5: Smoke-test locally**

Run: `PAYMENT_API_BASE_URL=http://example.test/base pnpm --filter @repo/payments dev` (port 3002), open `http://localhost:3002/payments`, confirm the page renders and shows configured state. Ctrl-C to stop. (Full end-to-end against Floci happens in Plan 5's verify.)

> IMPORTANT consequence for the shell scripts: `scripts/floci-deploy-payments.sh` currently sets `NEXT_PUBLIC_PAYMENT_API_BASE_URL` before `pnpm payments:build`. After this change, that build-time var is dead — the value must instead be supplied as a runtime ECS task env (`PAYMENT_API_BASE_URL`), which is Plan 4's job (the ECS `env` block). Until Plan 4 + Plan 5 land, the payments app will not receive the payment-api URL in a deployed container. Note this in the report. Do NOT edit the shell script here — it is replaced wholesale in Plan 5. This means: after Plan 3 alone, a deployed payments container shows the "not configured" state until Plan 4 supplies the runtime env. That is expected and acceptable mid-sequence.

- [ ] **Step 6: Commit (checkpoint — stage, report, do not commit)**

```bash
git add apps/payments/app/page.tsx apps/payments/app/payments-form.tsx
```
Report the diff and the mid-sequence consequence above.

---

### Task 6: Final verification

- [ ] **Step 1: Byte-identical Terraform gate**

The `app` manifest field is not consumed by `generate.ts`, so output must be unchanged:
```bash
pnpm platform:generate -- --env dev --venture venture --target floci
pnpm platform:generate -- --env dev --venture venture --target aws
git status --short infra/services | grep main.tf.json || echo "BYTE-IDENTICAL"
```
Expected: `BYTE-IDENTICAL`.

- [ ] **Step 2: Full green check**

Run from repo root: `pnpm lint && pnpm typecheck && pnpm --filter @repo/platform test`
Expected: all clean/pass.

- [ ] **Step 3: Both images build via the shared Dockerfile**

```bash
pnpm docs:build && pnpm docs:docker:build
pnpm payments:build && pnpm payments:docker:build
```
Expected: both succeed.

- [ ] **Step 4: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/ apps/ package.json
```
Report final diff + summary.

---

## Self-Review Notes

- **Spec coverage:** Implements spec §3 (app derivation by convention + single Dockerfile + the `NEXT_PUBLIC_PAYMENT_API_BASE_URL`→runtime conversion). The actual *injection* of the runtime value (ECS `env` block) is spec §4 / Plan 4; the deploy command that passes build args + restarts ECS is Plan 5.
- **Cross-plan dependency made explicit:** Task 5 flags that after Plan 3 alone, deployed payments lacks the payment-api URL until Plan 4 supplies the runtime env — expected mid-sequence, not a regression.
- **Behavior preservation (platform):** the `app` field is additive; Task 6 asserts byte-identical Terraform.
- **Convention rule:** strip a single trailing `-app`; validated against the filesystem (dir + package.json name) so typos fail fast.
- **oxlint:** flagged the two spots that may need a guard instead of `as` (JSON.parse, ECS config access) with instructions to use guards.
- **No placeholders.** Every step has concrete code/commands.
```
