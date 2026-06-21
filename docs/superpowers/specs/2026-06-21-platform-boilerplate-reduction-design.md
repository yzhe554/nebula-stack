# Platform Boilerplate Reduction — Design

**Date:** 2026-06-21
**Status:** Approved (pending spec review)

## Problem

Adding a new service today requires touching code in many scattered places, and it is easy to miss one:

- **Shell scripts** (`scripts/`, `packages/platform/scripts/`) hardcode per-service physical names, API names, cluster names, ALB names, target-group prefixes, ports, state-dir paths, and URLs. The two deploy scripts (`floci-deploy-docs.sh`, `floci-deploy-payments.sh`) are ~95% identical. `floci-url.sh` and `floci-reset-all.sh` enumerate every resource by hand.
- **`package.json`** has per-service entries (`docs:build`, `payments:docker:build`, `floci:deploy:docs`, etc.).
- **`terraform.ts`** (42 KB) dispatches on `serviceType` via a hardcoded if-chain. Adding a service type means editing `terraform.ts`, `service-discovery.ts`, `schemas.ts`, and `types.ts` in lockstep.
- Shell is hard to review.

The names the shell scripts re-derive by hand are *already computed* inside `terraform.ts` (`physicalName`, `ecsLoadBalancerName`, `targetGroupNamePrefix`, container ports). The duplication is the root cause.

## Goals

1. Adding a service of an **existing type** requires only dropping a YAML file (plus, for an app-backed service, the app must exist in `apps/<name>` per the naming convention).
2. Logic lives in **TypeScript**, not shell. Shell scripts that do orchestration are replaced by reviewable TS CLI commands.
3. Service **type** definitions are **composable** — one module per type — so `terraform.ts` stops growing without bound.
4. Names are computed in **exactly one place** and consumed everywhere.

## Non-Goals

- Cross-environment env-var contract enforcement (only `dev` exists today). Deferred — see "Multi-env seam".
- Changing the deployed AWS/Floci topology or the generated Terraform output (behavior-preserving refactor + new CLI ergonomics).
- Touching the DynamoDB helper scripts' core behavior (`floci-ddb-*.sh`) beyond what the reset/CLI migration requires.

## Guiding Principles (from brainstorming)

- **YAML-only for existing types** where possible; TS/sh edits allowed only when genuinely needed.
- **Prefer TS over shell** — shell is hard to review.
- **Convention from path + repo layout.** Service path is `<env>/<venture>/<vpc>/<security-zone>/<app>.<aws-service>.yaml`; `<app>` corresponds to a repo project (`apps/<app>`).
- **Env-var split:** terraform-consumed build/deploy values live in YAML (validated by zod); app-consumed values come from the app/Dockerfile or runtime ECS task env.

---

## Architecture

Four threads, designed to reinforce each other. A "service type" becomes a single module owning its schema, Terraform emitter, and naming.

### 1. Composable service-type modules

Replace the hardcoded dispatch in `terraform.ts:34-51` and the parallel switches in `service-discovery.ts`, `schemas.ts`, `types.ts` with a plugin registry keyed by `serviceType`.

```
packages/platform/src/services/
  service-type.ts        # ServiceTypePlugin interface + plugin registry
  lambda/index.ts
  dynamodb/index.ts
  apigateway/index.ts
  ecs/index.ts           # ec2/fargate/floci variants stay as internal helpers here
packages/platform/src/terraform/
  base.ts                # baseTerraform, providerConfig, regionForTarget, tagsFor
  naming.ts              # physicalName, terraformName, ecsLoadBalancerName,
                         # targetGroupNamePrefix, truncateName  (extracted, shared)
```

```ts
type ServiceTypePlugin<Config> = {
  type: ServiceType;
  schema: ZodType<Config>;                 // replaces the schemas.ts entry
  toTerraform(svc, ctx: TerraformContext): TerraformJson;  // replaces terraformFor<Type>
  naming?(metadata): TypeNaming;           // type-specific names (ECS cluster/ALB/etc.)
};
```

- `terraformForService`, the `service-discovery` loader, `schemas.ts`, and `schema-json.ts`/`sync-schemas.ts` all collapse into lookups against the plugin registry.
- Cross-service data (`serviceNames`, `serviceContainerPorts`, route target resolution) is passed in via `TerraformContext`, so plugins stay decoupled but can reference siblings.
- The large ECS variants (`terraform.ts:221-808`) remain internal to `ecs/`, isolated and only loaded for ECS.
- **Adding a service type = add one folder under `services/` + register it.**

### 2. Service Registry (single source of truth for names)

```
packages/platform/src/registry.ts
```

```ts
type ServiceEntry = {
  metadata: ServiceMetadata;
  config: LoadedService["config"];
  physicalName: string;                       // dev-venture-core-public-docs-app
  generatedDir(target): string;               // reuses generated-paths
  ecs?: { clusterName; albName; targetGroupPrefix; containerPort };
  app?: { dir; packageName; dockerfile; imageRepository; devPort };  // derived, §3
  frontedByGateway?: { serviceName; physicalName };
};

function buildRegistry(services: LoadedService[]): ServiceEntry[];
```

- Reuses `terraform/naming.ts` and each plugin's `naming()` — names computed once.
- `frontedByGateway` is found by scanning `apigateway` configs for a route whose `target.service` equals this service's name (what the shell scripts hardcode today).
- **Every CLI command reads the registry; no command re-derives a name.**

### 3. App derivation (convention) + single Dockerfile

For ECS `*-app` services and lambda services, `app` is derived — no new config:

| Derived | Rule | Example |
|---|---|---|
| app dir | strip trailing `-app`, → `apps/<base>` | `docs-app` → `apps/docs`; `payment-api` → `apps/payment-api` |
| package name | `@repo/<base>` | `@repo/docs` |
| build command | `pnpm --filter @repo/<base> build` (lambda: `package`) | |
| Dockerfile | single shared parameterized Dockerfile (ECS) | |
| image repository | from ECS YAML `image.repository` | `nebula-docs` |
| dev port | from ECS YAML `service.containerPort` | `3001` |

Derivation is **validated**: if `apps/<base>` or the expected package script is missing, `buildRegistry` throws with a clear message — misnamed services fail fast.

**Single shared Dockerfile.** Today there are two near-identical Next.js Dockerfiles. Consolidate to one parameterized Dockerfile (`ARG APP_NAME` + workspace filter, `output: "standalone"`). `NEXT_PUBLIC_GATEWAY_PATH` stays a generic build arg (uniform across all Next apps, derivable as the app's own gateway path). Result: 2 Dockerfiles → 1.

**`NEXT_PUBLIC_PAYMENT_API_BASE_URL` conversion.** Currently inlined at build time in a `"use client"` component (`apps/payments/app/page.tsx:19`), which forces an app-specific build arg. Convert it to a **server-read env var** (`PAYMENT_API_BASE_URL`) consumed in a Server Component and passed to the client as a prop. The platform then injects it as an **ECS task env var at deploy time**, with the gateway base URL discovered during deploy. This removes the last app-specific build arg, enabling the single Dockerfile, and makes the value runtime (picked up on redeploy, no rebuild).

### 4. ECS env vars in YAML

Extend the ECS YAML schema (zod → regenerated JSON schema) with an optional `env` block holding terraform-consumed values for that env's service file:

```yaml
env:
  PAYMENT_API_BASE_URL:
    ref: { gatewayBaseUrl: payment-api-ingress }   # resolved at deploy time
  SOME_STATIC:
    static: "literal-value"
```

- `static`: literal string → emitted directly into the ECS task definition env.
- `ref: { gatewayBaseUrl: <serviceName> }`: resolved from the registry's discovered gateway base URL at deploy time.

The deploy command resolves `ref` values, injects them as task env vars, and (for the build-arg path) passes discovered gateway IDs to `docker build` as generic build args (`GATEWAY_PATH`, etc.) that the shared Dockerfile maps to `NEXT_PUBLIC_*`.

### 5. TS CLI (replaces shell orchestration)

New platform CLI subcommands, all reading the registry, using the **AWS SDK** (already a dependency) instead of the `aws` CLI:

| Command | Replaces | Behavior |
|---|---|---|
| `floci:deploy [services]` | `floci-deploy-docs.sh`, `floci-deploy-payments.sh` | Bootstrap ordering: deploy gateway → discover API id → build app + image → deploy app/stack → force ECS new deployment. Generic over registry; per-service specifics derived. |
| `floci:url` | `floci-url.sh` | Print URLs for all (or selected) services from registry + discovered gateway ids / ALB DNS (from tfstate or SDK). |
| `floci:reset` | `floci-reset-all.sh` | Tear down all registry resources (API GW, ECS svc/cluster, ALB + listeners + target groups, Lambda + role + policies + log group, DynamoDB), tolerant of already-absent. Remove generated floci state dirs. |
| `floci:dev <service>` | `docs-dev-floci.sh` | Resolve gateway path, export build env, run the app's dev server. |

- Proxy-stripping / scrubbed env (the `env -u HTTP_PROXY` trick) handled via `spawnSync` with a cleaned `env`.
- Docker build invoked from TS via `spawnSync`.
- All five orchestration shell scripts deleted: `scripts/floci-deploy-docs.sh`, `scripts/floci-deploy-payments.sh`, `scripts/floci-url.sh`, `scripts/docs-dev-floci.sh`, `packages/platform/scripts/floci-reset-all.sh`.
- `package.json` per-service script entries collapse to generic ones that call the CLI with a service argument.

---

## Data Flow (deploy example)

```
YAML files
  → discoverServices()            (plugin registry validates each by type)
  → buildRegistry()               (computes all names, app linkage, gateway fronting)
  → floci:deploy CLI
      → for each service in deploy order:
          resolve env refs (gateway base URLs) from registry + SDK discovery
          generate Terraform (plugin.toTerraform via TerraformContext)
          terraform init/plan/apply
          if app-backed: build app + docker image (generic build args), force new ECS deployment
  → floci:url prints resolved endpoints
```

## Error Handling

- `buildRegistry` throws on: missing `apps/<base>` dir, missing expected package script, ECS service with no fronting gateway when one is required, unknown `ref` target service.
- Plugin registry throws on unknown `serviceType` (same as today, centralized).
- CLI teardown tolerates already-absent resources (preserves current `floci-reset-all.sh` semantics).

## Testing

- **Unit:** `buildRegistry` name computation and app derivation (incl. failure cases); each plugin's `toTerraform` output; `ref` resolution.
- **Snapshot:** generated `main.tf.json` per service must be **byte-identical** to current output (behavior-preserving guarantee). Reuse/extend `tests/platform/terraform.test.ts`.
- **Schema:** regenerated JSON schemas match committed ones (`json-schemas.test.ts`), now including the ECS `env` block.
- **CLI:** unit-test command logic with the AWS SDK mocked; assert correct resource names/order from a fixture registry.
- Manual: full `floci:reset` → `floci:deploy` → `floci:url` round trip against local Floci, verifying docs + payments + payment-api still work.

## Multi-env seam (deferred)

Env-var values live per-env in each ECS YAML. A cross-env **contract** (required keys shared across envs, with fail-fast drift detection) is **not** built now — only `dev` exists. When a second env is added, introduce the contract check (Terraform-style: declare-once keys + per-env values). The ECS `env` schema is designed to accept this later without restructuring. Idiomatic precedent: Terraform `variables.tf` + `*.tfvars`; T3 Env for the Next.js layer.

## Migration / Sequencing

1. Extract `terraform/naming.ts` + `terraform/base.ts` (pure move, snapshot tests stay green).
2. Introduce `ServiceTypePlugin` + `services/<type>/` modules; route dispatch/discovery/schemas through the registry. Snapshot tests stay green.
3. Add `registry.ts` (`buildRegistry`) with app derivation + validation.
4. Add ECS `env` block to zod schema; regenerate JSON schema; wire into ECS plugin's task def.
5. Convert `apps/payments` `NEXT_PUBLIC_PAYMENT_API_BASE_URL` → server-read `PAYMENT_API_BASE_URL` prop; add `env` to `payments-app.ecs.yaml`.
6. Consolidate to single parameterized Dockerfile.
7. Build TS CLI subcommands; switch `package.json` to generic entries.
8. Delete the five orchestration shell scripts.

Each step is independently verifiable; steps 1–2 are guarded by byte-identical Terraform snapshots.
