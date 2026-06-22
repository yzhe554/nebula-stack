# Content-Hashed ECS Image Tags — Design

**Date:** 2026-06-22
**Status:** Approved (pending spec review)

## Problem

ECS services use a static image tag (`image.tag: local` in the `.ecs.yaml`), so the generated ECS task definition's image string (`nebula-payments:local`) is byte-identical on every deploy — even after the app is rebuilt with new content. Consequences:

- `terraform apply` sees no diff in the task definition → ECS keeps running the **old** container.
- To compensate, the `floci-deploy` CLI calls `aws.forceNewEcsDeployment(...)` **unconditionally** on every deploy. This tears down a healthy task and starts a new one even when nothing changed, producing a transient unhealthy window (briefly 502 / "Not deployed" via the gateway) and behavior unlike a real AWS deploy.

This is the same anti-pattern as tagging every ECR push `:latest` on AWS — the fix applies to both environments, not just Floci.

## Goal

Make the deploy AWS-idiomatic: the ECS task definition's image reference changes **only when the image content changes**, so Terraform redeploys the ECS service only when there's a real change. Remove the unconditional `forceNewEcsDeployment` hack.

## Non-Goals

- **AWS / ECR push.** No live AWS deploy exists yet. The design is AWS-ready (the digest-tag mechanism is environment-agnostic; AWS later adds a `docker push` to ECR + an ECR image ref before generation), but the ECR path is NOT built now (YAGNI).
- Changing `platform:generate` / `platform:deploy` behavior for non-CLI callers. Plain generation must stay byte-identical.
- Hashing build inputs (source/Dockerfile). We use the **built image's content digest** (truest content address; no risk of missing an input).

## Guiding principles (from brainstorming)

- **Safe = isolate the dynamic behavior to the deploy path.** `ecs.yaml` keeps the static `tag: local` default; only `floci-deploy` computes and injects the hashed tag. Existing generation + the 135-test suite stay byte-identical.
- **Digest from the built image** (`docker inspect`), not from inputs.
- **Environment-agnostic mechanism**, Floci-only wiring for now.

## Architecture

### 1. Static default preserved
`infra/services/dev/venture/core/public/*.ecs.yaml` keep `image: { repository: nebula-<app>, tag: local }`. `pnpm platform:generate` (no override) and all unit tests produce exactly today's output. Zero blast radius for non-deploy callers.

### 2. ECS emitter honors an optional per-service tag override
`TerraformContext` gains:
```ts
imageTagOverride?: Record<string, string>; // serviceName -> image tag
```
In the ECS emitter, the `container_definitions` image string becomes:
```ts
const tag = options.imageTagOverride?.[service.metadata.serviceName] ?? service.config.image.tag;
image: `${service.config.image.repository}:${tag}`,
```
When `imageTagOverride` is absent or lacks the service, behavior is identical to today (uses `config.image.tag`). This is the ONLY emitter change. Applies in all three ECS variants (ec2/fargate/floci).

### 3. `generate.ts` accepts the override via a CLI arg
`platform:generate` gains an optional repeatable arg:
```
--image-tag <serviceName>=<tag>
```
parsed into `imageTagOverride` and passed into every `terraformForService(...)` call (only ECS services consume it). Multiple `--image-tag` args allowed (one per built service). No arg → no override → byte-identical.

> Rationale for the arg (vs the CLI calling generation directly): `platform:deploy` already shells to `platform:generate`; keeping the shell boundary means the deploy CLI just adds args, no refactor of the generate entrypoint.

### 4. `floci-deploy` computes the digest tag and threads it through
New helper(s) in the CLI:
- `imageDigestTag(repository, builtTag): string` — runs `docker inspect --format '{{.Id}}' <repository>:<builtTag>`, parses the `sha256:<hex>` Id, returns a short tag like `<hex first 12>`. Throws if inspect fails (image missing).
- After the **single real build** (`<app>:build` + `<app>:docker:build`, which produces `<repo>:local`):
  1. `const hash = imageDigestTag(repository, "local")`.
  2. `docker tag <repo>:local <repo>:<hash>` (retag; keep `:local` too — harmless).
  3. Pass `--image-tag <serviceName>=<hash>` into the `platform:deploy` invocation (which forwards it to `platform:generate`). The ECS task def now references `<repo>:<hash>`.
- The bootstrap (cold) build path: the placeholder image deployed during bootstrap can keep `:local` (it's replaced by the real hashed deploy in the same run); the FINAL deploy uses the hashed tag. So the task def's final state is the hashed tag.

### 5. Remove the force-deploy hack
Delete the `await aws.forceNewEcsDeployment(...)` call from `runFlociDeploy`. The task-definition diff (new image tag when content changed) now drives ECS to deploy a new task only when needed. `forceNewEcsDeployment` may remain in `aws.ts` (unused) or be removed — remove it to avoid dead code unless another caller exists (none does).

### How `platform:deploy` forwards the arg
`src/deploy.ts` parses its own args and shells to `platform:generate`. It must forward `--image-tag` occurrences to the generate call. Add `--image-tag` parsing to `deploy.ts`'s `parseArgs` (collect into an array) and append them to the generate args. The per-service terraform apply loop is unchanged.

## Data flow (deploy, Floci)

```
floci-deploy <app>:
  deploy prerequisites (network, lambda, dynamodb)  [unchanged]
  resolve/bootstrap gateway id                       [unchanged]
  pnpm <app>:build (NEXT_PUBLIC_GATEWAY_PATH=...)     [the single real build]
  pnpm <app>:docker:build                             → <repo>:local
  hash = docker inspect <repo>:local → sha256 → short
  docker tag <repo>:local <repo>:<hash>
  pnpm platform:deploy ... --services <app>,<gw> --image-tag <app-service>=<hash>
      → platform:generate ... --image-tag <app-service>=<hash>
          → ECS task def image = <repo>:<hash>
      → terraform apply  (task def changed ⟺ image changed ⟹ ECS redeploys only when needed)
  (no forceNewEcsDeployment)
  print URLs
```

## Error handling

- `docker inspect` failure (image absent / docker down) → throw with a clear message before generation; deploy aborts rather than producing a task def pointing at a missing tag.
- `--image-tag` malformed (no `=`) → generate/deploy arg parser throws `Invalid --image-tag, expected <service>=<tag>`.
- Override naming uses the **service name** (`docs-app`/`payments-app`), matching `service.metadata.serviceName` — not the app base or repository.

## Testing

- **Unit (ECS emitter):** with `imageTagOverride: { "docs-app": "abc123" }`, the docs_app container image is `nebula-docs:abc123`; with no override, it's `nebula-docs:local` (byte-identical guard). Cover a service NOT in the override map (keeps its static tag).
- **Unit (generate arg parsing):** `--image-tag docs-app=abc --image-tag payments-app=def` → `{ "docs-app":"abc", "payments-app":"def" }`; malformed throws.
- **Unit (deploy arg forwarding):** `deploy.ts` parseArgs collects `--image-tag` and forwards them to the generate args.
- **Pure (CLI):** `imageDigestTag` parsing of a `sha256:<64hex>` Id → 12-char short tag (mock the inspect output via a tiny injectable runner, or unit-test the parse function separately from the spawn).
- **Live (Floci) — the acceptance test:**
  1. `floci:redeploy:all` → both docs + payments deploy; **both API Gateway URLs return 200** (the explicit requirement).
  2. Immediately run `floci:deploy:payments` again with NO code change → the ECS task def is unchanged (same hash) → `terraform apply` reports **no ECS task-def change / no new deployment** (the AWS-like win; no transient restart).
  3. Confirm a payment still persists through the SDK-invoke path.
- Full green: 135 platform tests + new unit tests; lint + typecheck clean.

## Sequencing

1. Add `imageTagOverride` to `TerraformContext`; ECS emitter honors it (unit tests, byte-identical guard).
2. `generate.ts` `--image-tag` parsing → context (unit test).
3. `deploy.ts` forward `--image-tag` (unit test).
4. CLI `imageDigestTag` + retag + pass `--image-tag`; remove `forceNewEcsDeployment` from the flow.
5. Live verify: `redeploy:all` → both gateway URLs 200; re-deploy no-op shows no ECS churn; payment persists.
