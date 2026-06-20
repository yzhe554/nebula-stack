# Turborepo Platform Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the repo into a pnpm/Turborepo workspace with the infrastructure platform in `packages/platform`, the sample Lambda in `apps/payment-api`, service YAML in `infra/services`, and generated Terraform in `__generated__`.

**Architecture:** The root package becomes orchestration-only and delegates work to workspace packages through Turborepo or pnpm filters. `packages/platform` owns the TypeScript platform CLI, schemas, platform tests, docs, and infra scripts. `apps/payment-api` owns the Lambda source, build config, package output, and app tests.

**Tech Stack:** pnpm workspaces, Turborepo, TypeScript, Vitest, tsx, Zod, Ajv, Rolldown, AWS SDK, Terraform JSON.

---

### Task 1: Workspace Scaffolding

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Modify: `package.json`

- [ ] Add workspace package globs for `apps/*` and `packages/*`.
- [ ] Add `turbo@latest` as a root dev dependency.
- [ ] Replace root scripts with orchestration scripts that delegate to `@repo/platform` and `@repo/payment-api`.

### Task 2: Move Platform Package

**Files:**
- Move: `src/platform/*` to `packages/platform/src/*`
- Move: `schemas/*` to `packages/platform/schemas/*`
- Move: `tests/platform/*` to `packages/platform/tests/platform/*`
- Move: platform scripts/docs to `packages/platform` as needed
- Create: `packages/platform/package.json`
- Create: `packages/platform/tsconfig.json`

- [ ] Update platform imports after moving files.
- [ ] Update schema JSON paths and sync output paths.
- [ ] Change default service root from `services` to `infra/services`.
- [ ] Change generated Terraform output from `generated` to `__generated__`.

### Task 3: Move Payment API App

**Files:**
- Keep source under: `apps/payment-api/index.mjs`
- Move: `tests/apps/payment-api/*` to `apps/payment-api/tests/*`
- Move: `rolldown.payment-api.config.mjs` to `apps/payment-api/rolldown.config.mjs`
- Create: `apps/payment-api/package.json`

- [ ] Update package output paths to write to root `dist/payment-api.zip`.
- [ ] Update tests to use app-local imports.

### Task 4: Move Infrastructure Config

**Files:**
- Move: `services/*` to `infra/services/*`
- Keep generated Terraform under: `__generated__/*`
- Update docs and scripts that reference `infra/services/` or `__generated__/`.

- [ ] Update YAML package paths if relative depth changes.
- [ ] Update schema comments to point at package schema JSON files or workspace-relative schema paths.
- [ ] Update validation tests for the new default `infra/services` root.

### Task 5: Verify Migration

**Commands:**
- `pnpm install`
- `pnpm platform:schema:sync`
- `pnpm app:payment-api:package`
- `pnpm platform:generate -- --env dev --venture venture --target floci --services customer-records,payment-api`
- `pnpm test`

- [ ] Fix only migration-related failures.
- [ ] Leave unrelated existing failures called out if they remain.
