# Composable Service-Type Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the monolithic `terraform.ts` and the parallel per-type switches (`service-discovery.ts`, `schemas.ts`, `schema-json.ts`, `deploy.ts`, `validate.ts`) into one self-contained module per AWS service type, dispatched through a plugin registry, so adding a service type means adding one folder instead of editing six files.

**Architecture:** Introduce a `ServiceTypePlugin` interface that bundles a type's zod schema, JSON-schema metadata, Terraform emitter, and deploy priority. A central registry maps `serviceType → plugin`. Every former switch/if-chain becomes a registry lookup. The large Terraform emitters are **moved verbatim** (not rewritten) into `services/<type>/terraform.ts`, with shared helpers extracted to `terraform/naming.ts` and `terraform/base.ts`. The 42 existing tests in `tests/platform/` are byte-level regression guards: they must stay green at every commit.

**Tech Stack:** TypeScript (ESM, `tsx`), Zod 4, Vitest, pnpm workspaces.

**This is Plan 1 of a 5-plan sequence** (plugins → registry → app-derivation/Dockerfile → ECS env → TS CLI). It is behavior-preserving: generated Terraform output must not change.

---

## Ground Rules

- **Run from `packages/platform/`** unless a path says otherwise. Test command: `pnpm test` (alias for `vitest run`); single file: `pnpm vitest run tests/platform/<file>.test.ts`.
- **Verbatim move = cut/paste unchanged.** When a step says "move lines X–Y verbatim", copy the exact current function bodies; do not edit logic, names, or formatting. Only add/adjust `import` lines.
- **Green at every commit.** `pnpm test` (42 tests) and `pnpm typecheck` must pass before each commit. The pre-commit hook also runs `oxfmt`, `oxlint`, and `turbo typecheck` repo-wide.
- **Do not commit** — the user commits. Each "Commit" step below is a checkpoint: stage the listed files and report the diff to the user instead of running `git commit`.
- No behavior change. If a test needs editing to pass, STOP — that means output changed, which is a bug in the move.

## File Structure (end state)

```
packages/platform/src/
  terraform/
    base.ts          # baseTerraform, providerConfig, regionForTarget, tagsFor, TerraformJson, DeployTarget
    naming.ts        # physicalName, terraformName, truncateName, ecsLoadBalancerName, targetGroupNamePrefix
    context.ts       # TerraformContext type (renamed TerraformOptions) + cross-service lookups
  services/
    service-type.ts  # ServiceTypePlugin interface + registry (register/get/all/forFileName)
    dynamodb/
      schema.ts      # moved from schemas/dynamodb.schema.ts (re-exported for back-compat)
      terraform.ts   # terraformForDynamoDb (moved)
      index.ts       # dynamoDbPlugin
    lambda/
      schema.ts
      terraform.ts   # terraformForLambda + lambda helpers (moved)
      index.ts       # lambdaPlugin
    apigateway/
      schema.ts
      terraform.ts   # terraformForApiGateway + apigateway helpers (moved)
      index.ts       # apiGatewayPlugin
    ecs/
      schema.ts
      terraform.ts   # terraformForEcs + ec2/fargate/floci helpers (moved)
      index.ts       # ecsPlugin
    index.ts         # imports all plugins, registers them, re-exports registry
  terraform.ts       # shrinks to: re-export TerraformJson/DeployTarget/TerraformOptions + terraformForService(registry lookup)
```

Schemas currently live in `packages/platform/schemas/*.schema.ts` and are re-exported by `src/schemas.ts`. To minimize churn in Plan 1, **leave the `.schema.ts` files where they are** and have each plugin import its schema from there. Physically relocating schemas is out of scope (a later plan can move them under `services/<type>/`).

---

### Task 1: Extract shared naming helpers to `terraform/naming.ts`

**Files:**
- Create: `packages/platform/src/terraform/naming.ts`
- Modify: `packages/platform/src/terraform.ts` (remove moved helpers, import them back)
- Test: existing `tests/platform/terraform.test.ts` (regression guard, unchanged)

- [ ] **Step 1: Create the naming module by moving five helpers verbatim**

Move these functions **unchanged** from `terraform.ts` into the new file (current locations: `physicalName` `terraform.ts:1343-1354`, `terraformName` `:1356-1358`, `truncateName` `:1195-1201`, `ecsLoadBalancerName` `:1191-1193`, `targetGroupNamePrefix` `:1169-1171`). `ecsLoadBalancerName` references `ServiceMetadata`, so import the type.

```ts
// packages/platform/src/terraform/naming.ts
import type { ServiceMetadata } from "../types";

export function physicalName(metadata: ServiceMetadata, suffix?: string): string {
  return [
    metadata.env,
    metadata.venture,
    metadata.vpc,
    metadata.securityZone,
    metadata.serviceName,
    suffix,
  ]
    .filter(Boolean)
    .join("-");
}

export function terraformName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function truncateName(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength);
}

export function ecsLoadBalancerName(metadata: ServiceMetadata): string {
  return truncateName(physicalName(metadata), 32);
}

export function targetGroupNamePrefix(resourceName: string): string {
  return `${resourceName.replace(/_/g, "").slice(0, 5)}-`;
}
```

- [ ] **Step 2: Remove the five originals from `terraform.ts` and import them back**

Delete the five moved function definitions from `terraform.ts`. At the top of `terraform.ts`, add:

```ts
import {
  ecsLoadBalancerName,
  physicalName,
  targetGroupNamePrefix,
  terraformName,
  truncateName,
} from "./terraform/naming";
```

Leave all call sites unchanged — they now resolve to the imports.

- [ ] **Step 3: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 42 passed; typecheck clean. (If `truncateName` shows as unused in `terraform.ts` because its only callers also moved, that's fine — it's imported by `naming.ts` internally; remove it from the `terraform.ts` import list if oxlint flags it as unused there.)

- [ ] **Step 4: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/terraform/naming.ts packages/platform/src/terraform.ts
```
Report the diff to the user.

---

### Task 2: Extract shared Terraform scaffolding to `terraform/base.ts`

**Files:**
- Create: `packages/platform/src/terraform/base.ts`
- Modify: `packages/platform/src/terraform.ts`
- Test: existing `tests/platform/terraform.test.ts` (regression guard)

- [ ] **Step 1: Create `base.ts` by moving scaffolding verbatim**

Move `baseTerraform` (`terraform.ts:1265-1287`), `providerConfig` (`:1289-1325`), `regionForTarget` (`:1327-1329`), `tagsFor` (`:1331-1341`), the type aliases `TerraformJson`/`DeployTarget` (`:9-10`), and the module constants `flociEndpointUrl`/`awsRegion`/`flociRegion` (`:30-32`) into `base.ts`. `baseTerraform` and `providerConfig` reference `TerraformOptions`; to avoid a cycle, change `baseTerraform`'s signature to take the resolved `target` and optional `data` directly instead of the full options object.

```ts
// packages/platform/src/terraform/base.ts
import type { ServiceMetadata } from "../types";

export type TerraformJson = Record<string, unknown>;
export type DeployTarget = "aws" | "floci";

export const flociEndpointUrl = "http://localhost.floci.io:4566";
const awsRegion = "ap-southeast-2";
const flociRegion = "us-east-1";

export function baseTerraform(
  metadata: ServiceMetadata,
  target: DeployTarget,
  resource: Record<string, unknown>,
  data?: Record<string, unknown>,
): TerraformJson {
  return {
    terraform: {
      required_version: ">= 1.15.6",
      required_providers: {
        aws: { source: "hashicorp/aws", version: "~> 6.51" },
      },
    },
    provider: { aws: providerConfig(metadata, target) },
    ...(data ? { data } : {}),
    resource,
  };
}

export function providerConfig(
  metadata: ServiceMetadata,
  target: DeployTarget,
): Record<string, unknown> {
  const base = {
    region: regionForTarget(target),
    default_tags: { tags: tagsFor(metadata) },
  };

  if (target === "aws") {
    return base;
  }

  return {
    ...base,
    access_key: "test",
    secret_key: "test",
    skip_credentials_validation: true,
    skip_metadata_api_check: true,
    skip_requesting_account_id: true,
    s3_use_path_style: true,
    endpoints: {
      applicationautoscaling: "http://localhost:4566",
      apigateway: "http://localhost:4566",
      apigatewayv2: "http://localhost:4566",
      dynamodb: "http://localhost:4566",
      ec2: "http://localhost:4566",
      ecs: "http://localhost:4566",
      elbv2: "http://localhost:4566",
      iam: "http://localhost:4566",
      route53: "http://localhost:4566",
      lambda: "http://localhost:4566",
      logs: "http://localhost:4566",
      s3: "http://localhost:4566",
      sts: "http://localhost:4566",
    },
  };
}

export function regionForTarget(target: DeployTarget): string {
  return target === "floci" ? flociRegion : awsRegion;
}

export function tagsFor(metadata: ServiceMetadata): Record<string, string> {
  return {
    Environment: metadata.env,
    Venture: metadata.venture,
    Vpc: metadata.vpc,
    SecurityZone: metadata.securityZone,
    ServiceName: metadata.serviceName,
    ServiceType: metadata.serviceType,
    ManagedBy: "yaml-terraform-platform",
  };
}
```

- [ ] **Step 2: Update `terraform.ts` to use `base.ts` and fix `baseTerraform` call sites**

Delete the moved definitions and constants from `terraform.ts`. Add:

```ts
import {
  baseTerraform,
  type DeployTarget,
  flociEndpointUrl,
  providerConfig,
  regionForTarget,
  tagsFor,
  type TerraformJson,
} from "./terraform/base";
```

Re-export the two types so existing importers of `terraform.ts` keep working:

```ts
export type { TerraformJson, DeployTarget } from "./terraform/base";
```

Every current `baseTerraform(metadata, options, resource, data?)` call must change to `baseTerraform(metadata, options.target ?? "aws", resource, data?)`. There are four call sites (lambda, ecs, apigateway, dynamodb emitters). Update each.

- [ ] **Step 3: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 42 passed; typecheck clean.

- [ ] **Step 4: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/terraform/base.ts packages/platform/src/terraform.ts
```
Report the diff to the user.

---

### Task 3: Define the `TerraformContext` type

**Files:**
- Create: `packages/platform/src/terraform/context.ts`
- Modify: `packages/platform/src/terraform.ts`
- Test: existing terraform tests (regression guard)

`TerraformOptions` (`terraform.ts:12-18`) is the cross-service data bag passed into every emitter. Rename it to `TerraformContext` in a shared module so plugins can import it without importing `terraform.ts` (which would cycle). Keep `TerraformOptions` as a deprecated alias so external callers (`generate.ts`, `deploy.ts`, tests) keep compiling.

- [ ] **Step 1: Create `context.ts`**

```ts
// packages/platform/src/terraform/context.ts
import type { DeployTarget } from "./base";

export type TerraformContext = {
  target?: DeployTarget;
  moduleDirectory?: string;
  serviceNames?: Record<string, string>;
  serviceContainerPorts?: Record<string, number>;
  domainCertificateArns?: Record<string, string>;
};
```

- [ ] **Step 2: Re-point `terraform.ts` to the shared context type**

Remove the inline `TerraformOptions` definition from `terraform.ts`. Add:

```ts
import type { TerraformContext } from "./terraform/context";
export type TerraformOptions = TerraformContext;
```

All internal uses of `TerraformOptions` continue to compile via the alias.

- [ ] **Step 3: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 42 passed; typecheck clean.

- [ ] **Step 4: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/terraform/context.ts packages/platform/src/terraform.ts
```
Report the diff to the user.

---

### Task 4: Define the `ServiceTypePlugin` interface and registry

**Files:**
- Create: `packages/platform/src/services/service-type.ts`
- Test: Create `packages/platform/tests/platform/service-type-registry.test.ts`

- [ ] **Step 1: Write the failing registry test**

```ts
// packages/platform/tests/platform/service-type-registry.test.ts
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createServiceTypeRegistry,
  type ServiceTypePlugin,
} from "../../src/services/service-type";

const fakePlugin: ServiceTypePlugin = {
  type: "dynamodb",
  fileSuffix: "dynamodb",
  schema: z.object({}).passthrough(),
  jsonSchemaMetadata: { fileName: "x.schema.json", title: "X", description: "x" },
  deployPriority: 0,
  toTerraform: () => ({ resource: {} }),
};

describe("service type registry", () => {
  test("registers and retrieves a plugin by type", () => {
    const registry = createServiceTypeRegistry([fakePlugin]);
    expect(registry.get("dynamodb")).toBe(fakePlugin);
  });

  test("looks up a plugin by file suffix", () => {
    const registry = createServiceTypeRegistry([fakePlugin]);
    expect(registry.forFileSuffix("dynamodb")).toBe(fakePlugin);
    expect(registry.forFileSuffix("nope")).toBeUndefined();
  });

  test("throws for an unknown type", () => {
    const registry = createServiceTypeRegistry([fakePlugin]);
    expect(() => registry.get("lambda")).toThrow("No plugin registered for service type lambda");
  });

  test("lists all plugins", () => {
    const registry = createServiceTypeRegistry([fakePlugin]);
    expect(registry.all()).toEqual([fakePlugin]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/platform/service-type-registry.test.ts`
Expected: FAIL — cannot find module `../../src/services/service-type`.

- [ ] **Step 3: Implement the interface and registry**

```ts
// packages/platform/src/services/service-type.ts
import type { ZodType } from "zod";
import type { LoadedService, ServiceType } from "../types";
import type { TerraformContext } from "../terraform/context";
import type { TerraformJson } from "../terraform/base";

export type JsonSchemaMetadata = {
  fileName: string;
  title: string;
  description: string;
};

export type ServiceTypePlugin<Config = unknown> = {
  type: ServiceType;
  fileSuffix: string;
  schema: ZodType<Config>;
  jsonSchemaMetadata: JsonSchemaMetadata;
  deployPriority: number;
  toTerraform(service: LoadedService, context: TerraformContext): TerraformJson;
};

export type ServiceTypeRegistry = {
  get(type: ServiceType): ServiceTypePlugin;
  forFileSuffix(suffix: string): ServiceTypePlugin | undefined;
  all(): ServiceTypePlugin[];
};

export function createServiceTypeRegistry(plugins: ServiceTypePlugin[]): ServiceTypeRegistry {
  const byType = new Map<ServiceType, ServiceTypePlugin>();
  const bySuffix = new Map<string, ServiceTypePlugin>();

  for (const plugin of plugins) {
    byType.set(plugin.type, plugin);
    bySuffix.set(plugin.fileSuffix, plugin);
  }

  return {
    get(type) {
      const plugin = byType.get(type);
      if (!plugin) {
        throw new Error(`No plugin registered for service type ${type}`);
      }
      return plugin;
    },
    forFileSuffix(suffix) {
      return bySuffix.get(suffix);
    },
    all() {
      return [...plugins];
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/platform/service-type-registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/services/service-type.ts packages/platform/tests/platform/service-type-registry.test.ts
```
Report the diff to the user.

---

### Task 5: Extract the DynamoDB plugin (smallest emitter first)

**Files:**
- Create: `packages/platform/src/services/dynamodb/terraform.ts`, `packages/platform/src/services/dynamodb/index.ts`
- Modify: `packages/platform/src/terraform.ts`
- Test: existing terraform tests (regression guard)

DynamoDB is the smallest emitter and exercises the full move pattern used in Tasks 6–8.

- [ ] **Step 1: Move `terraformForDynamoDb` verbatim into `services/dynamodb/terraform.ts`**

Move `terraformForDynamoDb` (`terraform.ts:1237-1263`) unchanged except: it now takes `(service, context)` and calls `baseTerraform(metadata, context.target ?? "aws", ...)`. Type the service param via the `LoadedService` discriminant.

```ts
// packages/platform/src/services/dynamodb/terraform.ts
import { baseTerraform } from "../../terraform/base";
import { physicalName, terraformName } from "../../terraform/naming";
import { tagsFor } from "../../terraform/base";
import type { TerraformContext } from "../../terraform/context";
import type { TerraformJson } from "../../terraform/base";
import type { LoadedService } from "../../types";

type DynamoDbService = Extract<LoadedService, { metadata: { serviceType: "dynamodb" } }>;

export function terraformForDynamoDb(
  service: DynamoDbService,
  context: TerraformContext,
): TerraformJson {
  const resourceName = terraformName(service.metadata.serviceName);
  const attributes = [service.config.hashKey, service.config.rangeKey].filter(Boolean);

  return baseTerraform(service.metadata, context.target ?? "aws", {
    aws_dynamodb_table: {
      [resourceName]: {
        name: physicalName(service.metadata),
        billing_mode: service.config.billingMode,
        hash_key: service.config.hashKey.name,
        range_key: service.config.rangeKey?.name,
        attribute: attributes,
        point_in_time_recovery: { enabled: service.config.pointInTimeRecovery },
        deletion_protection_enabled: true,
        lifecycle: { prevent_destroy: true },
        tags: tagsFor(service.metadata),
      },
    },
  });
}
```

- [ ] **Step 2: Create the plugin**

```ts
// packages/platform/src/services/dynamodb/index.ts
import { dynamoDbSchema } from "../../../schemas/dynamodb.schema";
import type { ServiceTypePlugin } from "../service-type";
import type { LoadedService } from "../../types";
import { terraformForDynamoDb } from "./terraform";

type DynamoDbService = Extract<LoadedService, { metadata: { serviceType: "dynamodb" } }>;

export const dynamoDbPlugin: ServiceTypePlugin = {
  type: "dynamodb",
  fileSuffix: "dynamodb",
  schema: dynamoDbSchema,
  jsonSchemaMetadata: {
    fileName: "dynamodb.schema.json",
    title: "Platform DynamoDB Service",
    description: "YAML schema for AWS DynamoDB tables deployed by the platform.",
  },
  deployPriority: 0,
  toTerraform: (service, context) =>
    terraformForDynamoDb(service as DynamoDbService, context),
};
```

- [ ] **Step 3: Route the dynamodb branch of `terraformForService` through the plugin**

In `terraform.ts`, delete the old `terraformForDynamoDb` body and replace the final `return terraformForDynamoDb(service, options);` (`terraform.ts:50`) with `return dynamoDbPlugin.toTerraform(service, options);`. Add `import { dynamoDbPlugin } from "./services/dynamodb";`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 42 passed (the two DynamoDB tests + Floci provider test exercise this path); typecheck clean.

- [ ] **Step 5: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/services/dynamodb/ packages/platform/src/terraform.ts
```
Report the diff to the user.

---

### Task 6: Extract the Lambda plugin

**Files:**
- Create: `packages/platform/src/services/lambda/terraform.ts`, `packages/platform/src/services/lambda/index.ts`
- Modify: `packages/platform/src/terraform.ts`
- Test: existing terraform tests (regression guard)

- [ ] **Step 1: Move the Lambda emitter and its private helpers verbatim**

Move these from `terraform.ts` into `services/lambda/terraform.ts`, **unchanged** except `baseTerraform(metadata, ctx.target ?? "aws", …)` and importing shared helpers:
- `terraformForLambda` (`:69-130`)
- `lambdaPackagePath` (`:132-147`)
- `normalizeTerraformPath` (`:149-151`)
- `lambdaEnvironmentVariables` (`:153-162`)
- `lambdaDynamoDbEnvironmentVariables` (`:164-177`)
- `lambdaDynamoDbPolicies` (`:179-205`)
- `lambdaNameForService` (`:1207-1214`) and `tableNameForService` (`:1228-1235`) — these are used only by Lambda; move them here. (Confirm with `grep -n "lambdaNameForService\|tableNameForService" src/terraform.ts` before deleting from `terraform.ts`; if apigateway also uses `lambdaNameForService`, see Task 7 note.)

Header imports for the new file:

```ts
import { baseTerraform, flociEndpointUrl, regionForTarget } from "../../terraform/base";
import { physicalName, terraformName } from "../../terraform/naming";
import type { TerraformContext } from "../../terraform/context";
import type { TerraformJson } from "../../terraform/base";
import type { LoadedService } from "../../types";

type LambdaService = Extract<LoadedService, { metadata: { serviceType: "lambda" } }>;
```

> NOTE on `lambdaNameForService`: `grep` shows it is also called by the API Gateway emitter (`apiGatewayIntegrationUri`). To avoid a lambda↔apigateway import cycle, place `lambdaNameForService`, `tableNameForService`, `ecsResourceNameForService`, `ecsContainerPortForService`, and `serviceNameFor` (`terraform.ts:1164-1189`, `:1207-1235`) into a shared `terraform/service-refs.ts` instead of inside a plugin, and import from there in both lambda and apigateway plugins. Create that file in this step:

```ts
// packages/platform/src/terraform/service-refs.ts
import type { TerraformContext } from "./context";
import { terraformName } from "./naming";

export function serviceNameFor(
  serviceName: string,
  context: TerraformContext,
  message: string,
): string {
  const configuredName = context.serviceNames?.[serviceName];
  if (configuredName) {
    return configuredName;
  }
  throw new Error(`${message} ${serviceName}`);
}

export function lambdaNameForService(serviceName: string, context: TerraformContext): string {
  const configuredName = context.serviceNames?.[serviceName];
  if (configuredName) {
    return configuredName;
  }
  throw new Error(`apigateway route references unknown Lambda service ${serviceName}`);
}

export function tableNameForService(serviceName: string, context: TerraformContext): string {
  const configuredName = context.serviceNames?.[serviceName];
  if (configuredName) {
    return configuredName;
  }
  throw new Error(`permissions.dynamodb references unknown DynamoDB service ${serviceName}`);
}

export function ecsResourceNameForService(serviceName: string, context: TerraformContext): string {
  serviceNameFor(serviceName, context, "apigateway route references unknown ECS service");
  return terraformName(serviceName);
}

export function ecsContainerPortForService(serviceName: string, context: TerraformContext): number {
  const configuredPort = context.serviceContainerPorts?.[serviceName];
  if (configuredPort) {
    return configuredPort;
  }
  throw new Error(`apigateway route references ECS service without container port ${serviceName}`);
}
```

Delete these five helpers from `terraform.ts`.

- [ ] **Step 2: Create the Lambda plugin**

```ts
// packages/platform/src/services/lambda/index.ts
import { lambdaSchema } from "../../../schemas/lambda.schema";
import type { ServiceTypePlugin } from "../service-type";
import type { LoadedService } from "../../types";
import { terraformForLambda } from "./terraform";

type LambdaService = Extract<LoadedService, { metadata: { serviceType: "lambda" } }>;

export const lambdaPlugin: ServiceTypePlugin = {
  type: "lambda",
  fileSuffix: "lambda",
  schema: lambdaSchema,
  jsonSchemaMetadata: {
    fileName: "lambda.schema.json",
    title: "Platform Lambda Service",
    description: "YAML schema for AWS Lambda services deployed by the platform.",
  },
  deployPriority: 1,
  toTerraform: (service, context) => terraformForLambda(service as LambdaService, context),
};
```

- [ ] **Step 3: Route the lambda branch through the plugin**

In `terraform.ts`, replace the `isLambdaService` branch (`terraform.ts:38-40`) body with `return lambdaPlugin.toTerraform(service, options);`. Keep `isLambdaService` only if still referenced; otherwise delete it. Add `import { lambdaPlugin } from "./services/lambda";`. Update the API Gateway emitter still in `terraform.ts` to import `lambdaNameForService` from `./terraform/service-refs`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 42 passed (Lambda package/permissions/floci-endpoint tests cover this); typecheck clean.

- [ ] **Step 5: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/services/lambda/ packages/platform/src/terraform/service-refs.ts packages/platform/src/terraform.ts
```
Report the diff to the user.

---

### Task 7: Extract the API Gateway plugin

**Files:**
- Create: `packages/platform/src/services/apigateway/terraform.ts`, `packages/platform/src/services/apigateway/index.ts`
- Modify: `packages/platform/src/terraform.ts`
- Test: existing terraform tests (regression guard)

- [ ] **Step 1: Move the API Gateway emitter and helpers verbatim**

Move into `services/apigateway/terraform.ts`, unchanged except shared-helper imports and `baseTerraform(metadata, ctx.target ?? "aws", …)`:
- `terraformForApiGateway` (`:876-944`)
- `resolveApiGatewayRoute` (`:946-952`)
- `apiGatewayStageTagConfig` (`:954-969`)
- `apiGatewayLambdaPermissions` (`:971-1001`)
- `apiGatewayEcsTargetData` (`:1003-1030`)
- `apiGatewayDomainResources` (`:1032-1115`)
- `certificateArnForDomain` (`:1117-1130`)
- `isApiGatewayLambdaRoute` (`:1132-1134`), `isApiGatewayEcsRoute` (`:1136-1138`)
- `apiGatewayIntegrationUri` (`:1140-1162`)
- `apiGatewayIntegrationPath` (`:1203-1205`)
- `apiGatewayRouteName` (`:1216-1226`)
- the route type aliases `ResolvedApiGatewayRoute`/`ResolvedLambdaRoute`/`ResolvedEcsRoute` (`:20-26`)

Import `lambdaNameForService`, `ecsResourceNameForService`, `ecsContainerPortForService`, `serviceNameFor` from `../../terraform/service-refs`; `physicalName`/`terraformName` from naming; `baseTerraform`/`regionForTarget`/`tagsFor` from base.

- [ ] **Step 2: Create the API Gateway plugin**

```ts
// packages/platform/src/services/apigateway/index.ts
import { apiGatewaySchema } from "../../../schemas/apigateway.schema";
import type { ServiceTypePlugin } from "../service-type";
import type { LoadedService } from "../../types";
import { terraformForApiGateway } from "./terraform";

type ApiGatewayService = Extract<LoadedService, { metadata: { serviceType: "apigateway" } }>;

export const apiGatewayPlugin: ServiceTypePlugin = {
  type: "apigateway",
  fileSuffix: "apigateway",
  schema: apiGatewaySchema,
  jsonSchemaMetadata: {
    fileName: "apigateway.schema.json",
    title: "Platform API Gateway Service",
    description: "YAML schema for AWS API Gateway HTTP APIs deployed by the platform.",
  },
  deployPriority: 3,
  toTerraform: (service, context) =>
    terraformForApiGateway(service as ApiGatewayService, context),
};
```

- [ ] **Step 3: Route the apigateway branch through the plugin**

In `terraform.ts`, replace the `isApiGatewayService` branch body (`:42-44`) with `return apiGatewayPlugin.toTerraform(service, options);`. Add `import { apiGatewayPlugin } from "./services/apigateway";`. Remove now-unused helpers/`isApiGatewayService` if no longer referenced.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 42 passed (the six API Gateway tests cover routes, domains, certs, ECS/Lambda targets); typecheck clean.

- [ ] **Step 5: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/services/apigateway/ packages/platform/src/terraform.ts
```
Report the diff to the user.

---

### Task 8: Extract the ECS plugin (largest emitter)

**Files:**
- Create: `packages/platform/src/services/ecs/terraform.ts`, `packages/platform/src/services/ecs/index.ts`
- Modify: `packages/platform/src/terraform.ts`
- Test: existing terraform tests (regression guard)

- [ ] **Step 1: Move the ECS emitter and all variant helpers verbatim**

Move into `services/ecs/terraform.ts`, unchanged except shared-helper imports and `baseTerraform(metadata, ctx.target ?? "aws", …)`:
- `terraformForEcs` (`:207-219`)
- `awsEc2EcsResources` (`:221-498`)
- `flociEcsResources` (`:500-607`)
- `awsFargateEcsResources` (`:609-807`)
- `ecsServiceAutoscalingResources` (`:809-852`)
- `ecsTargetTrackingPolicy` (`:854-874`)
- the `EcsService` type alias (`:28`)

Import `ecsLoadBalancerName`/`targetGroupNamePrefix`/`physicalName`/`terraformName`/`truncateName` from naming; `baseTerraform`/`tagsFor` from base.

- [ ] **Step 2: Create the ECS plugin**

```ts
// packages/platform/src/services/ecs/index.ts
import { ecsSchema } from "../../../schemas/ecs.schema";
import type { ServiceTypePlugin } from "../service-type";
import type { LoadedService } from "../../types";
import { terraformForEcs } from "./terraform";

type EcsService = Extract<LoadedService, { metadata: { serviceType: "ecs" } }>;

export const ecsPlugin: ServiceTypePlugin = {
  type: "ecs",
  fileSuffix: "ecs",
  schema: ecsSchema,
  jsonSchemaMetadata: {
    fileName: "ecs.schema.json",
    title: "Platform ECS Service",
    description: "YAML schema for AWS ECS services deployed by the platform.",
  },
  deployPriority: 2,
  toTerraform: (service, context) => terraformForEcs(service as EcsService, context),
};
```

- [ ] **Step 3: Route the ecs branch through the plugin**

In `terraform.ts`, replace the `isEcsService` branch body (`:46-48`) with `return ecsPlugin.toTerraform(service, options);`. Add `import { ecsPlugin } from "./services/ecs";`. Remove now-unused `isEcsService`/`EcsService` from `terraform.ts`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 42 passed (Fargate, EC2-capacity, and Floci ECS tests cover all three variants); typecheck clean.

- [ ] **Step 5: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/services/ecs/ packages/platform/src/terraform.ts
```
Report the diff to the user.

---

### Task 9: Assemble the registry and collapse `terraformForService`

**Files:**
- Create: `packages/platform/src/services/index.ts`
- Modify: `packages/platform/src/terraform.ts`
- Test: existing terraform tests + add one dispatch test

- [ ] **Step 1: Create the registry assembly module**

```ts
// packages/platform/src/services/index.ts
import { createServiceTypeRegistry } from "./service-type";
import { dynamoDbPlugin } from "./dynamodb";
import { lambdaPlugin } from "./lambda";
import { apiGatewayPlugin } from "./apigateway";
import { ecsPlugin } from "./ecs";

export const serviceTypeRegistry = createServiceTypeRegistry([
  dynamoDbPlugin,
  lambdaPlugin,
  apiGatewayPlugin,
  ecsPlugin,
]);

export { createServiceTypeRegistry } from "./service-type";
export type { ServiceTypePlugin, ServiceTypeRegistry } from "./service-type";
```

- [ ] **Step 2: Collapse `terraformForService` to a single registry lookup**

Replace the entire if-chain in `terraformForService` (`terraform.ts:34-51`) with:

```ts
import { serviceTypeRegistry } from "./services";
import type { TerraformContext } from "./terraform/context";
import type { LoadedService } from "./types";

export function terraformForService(
  service: LoadedService,
  options: TerraformContext = {},
): TerraformJson {
  return serviceTypeRegistry.get(service.metadata.serviceType).toTerraform(service, options);
}
```

Delete the now-unused per-branch `import { xPlugin }` lines added in Tasks 5–8 and the `is*Service` guards if unreferenced. `terraform.ts` should now be a thin file: the type re-exports plus this function.

- [ ] **Step 3: Add a dispatch regression test**

```ts
// append to tests/platform/terraform.test.ts
test("dispatches every service type through the registry", () => {
  const dynamo = terraformForService(
    {
      metadata: {
        env: "dev", venture: "venture", vpc: "core", securityZone: "managed",
        serviceName: "customer-records", serviceType: "dynamodb",
        sourcePath: "infra/services/dev/venture/core/managed/customer-records.dynamodb.yaml",
      },
      config: { billingMode: "PAY_PER_REQUEST", hashKey: { name: "id", type: "S" }, pointInTimeRecovery: false },
    },
    { target: "aws" },
  );
  expect(Object.keys((dynamo as { resource: Record<string, unknown> }).resource)).toContain(
    "aws_dynamodb_table",
  );
});
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 43 passed (42 + new dispatch test); typecheck clean.

- [ ] **Step 5: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/services/index.ts packages/platform/src/terraform.ts packages/platform/tests/platform/terraform.test.ts
```
Report the diff to the user.

---

### Task 10: Route service discovery through the registry

**Files:**
- Modify: `packages/platform/src/service-discovery.ts`
- Test: existing `tests/platform/service-discovery.test.ts` (regression guard)

- [ ] **Step 1: Replace the per-type parse switch with a registry lookup**

In `service-discovery.ts`, replace the body of `loadService` (`:75-104`) so the schema comes from the plugin:

```ts
import { serviceTypeRegistry } from "./services";

async function loadService(filePath: string, servicesRoot: string): Promise<LoadedService> {
  const metadata = parseServicePath(filePath, servicesRoot);
  const raw = parse(await readFile(filePath, "utf8"));
  const plugin = serviceTypeRegistry.get(metadata.serviceType);
  return { metadata, config: plugin.schema.parse(raw) } as LoadedService;
}
```

Leave `parseServicePath`/`parseServiceType` as-is (they still validate the path shape and the four known suffixes). Remove the now-unused `apiGatewaySchema, dynamoDbSchema, ecsSchema, lambdaSchema` import.

- [ ] **Step 2: Run tests and typecheck**

Run: `pnpm vitest run tests/platform/service-discovery.test.ts && pnpm typecheck`
Expected: all discovery tests pass; typecheck clean.

- [ ] **Step 3: Run the full suite**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 4: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/service-discovery.ts
```
Report the diff to the user.

---

### Task 11: Route JSON-schema generation through the registry

**Files:**
- Modify: `packages/platform/src/schema-json.ts`
- Test: existing `tests/platform/json-schemas.test.ts` (regression guard); verify generated files unchanged

`network.schema` is NOT a service type — keep it as a standalone entry. Only the four service-type schemas come from the registry.

- [ ] **Step 1: Build the service-type JSON schemas from the registry**

Rewrite `schema-json.ts` so the four service entries derive from `serviceTypeRegistry.all()`, preserving the exact `$id` URL pattern `https://example.local/packages/platform/schemas/<fileName>`:

```ts
import type { z } from "zod";
import { networkPolicySchema } from "../schemas/network.schema";
import { serviceTypeRegistry } from "./services";

type JsonSchemaMetadata = { id: string; title: string; description: string };

export function generateSchemaObject(
  schema: z.ZodType,
  metadata: JsonSchemaMetadata,
): Record<string, unknown> {
  const jsonSchema = schema.toJSONSchema() as Record<string, unknown>;
  return { ...jsonSchema, $id: metadata.id, title: metadata.title, description: metadata.description };
}

export function generateSchema(schema: z.ZodType, metadata: JsonSchemaMetadata): string {
  return JSON.stringify(generateSchemaObject(schema, metadata), null, 2);
}

function idFor(fileName: string): string {
  return `https://example.local/packages/platform/schemas/${fileName}`;
}

export function networkJsonSchema(): Record<string, unknown> {
  return generateSchemaObject(networkPolicySchema, {
    id: idFor("network.schema.json"),
    title: "Platform Network",
    description: "AWS-first IPv4 network intent for one env/venture/VPC.",
  });
}

export const platformJsonSchemas: Record<string, () => Record<string, unknown>> = {
  ...Object.fromEntries(
    serviceTypeRegistry.all().map((plugin) => [
      plugin.jsonSchemaMetadata.fileName,
      () =>
        generateSchemaObject(plugin.schema, {
          id: idFor(plugin.jsonSchemaMetadata.fileName),
          title: plugin.jsonSchemaMetadata.title,
          description: plugin.jsonSchemaMetadata.description,
        }),
    ]),
  ),
  "network.schema.json": networkJsonSchema,
};
```

> If `json-schemas.test.ts` imports the named factory functions (`lambdaJsonSchema`, etc.), check the test first: `grep -n "JsonSchema" tests/platform/json-schemas.test.ts`. If it does, keep thin named exports that delegate to the registry entry, OR update the test to read from `platformJsonSchemas`. Prefer not changing committed schema JSON — the `$id`, `title`, `description`, and key order must match `schemas/*.schema.json` exactly.

- [ ] **Step 2: Verify committed JSON schemas are byte-identical**

Run:
```bash
pnpm schema:sync /tmp/schema-check && for f in lambda dynamodb apigateway ecs network; do diff -u schemas/$f.schema.json /tmp/schema-check/$f.schema.json && echo "OK $f"; done
```
Expected: `OK` for all five, no diff output.

- [ ] **Step 3: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 4: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/schema-json.ts
```
Report the diff to the user. (If a test needed updating in Step 1, include it.)

---

### Task 12: Route deploy ordering through the registry

**Files:**
- Modify: `packages/platform/src/deploy.ts`
- Test: Create `packages/platform/tests/platform/deploy-order.test.ts`

`deploy.ts` has its own `serviceDeployPriority` (`:63-77`) duplicating the ordering knowledge. Replace it with the registry's `deployPriority`.

- [ ] **Step 1: Write a failing test for registry-driven priority**

```ts
// packages/platform/tests/platform/deploy-order.test.ts
import { describe, expect, test } from "vitest";
import { serviceTypeRegistry } from "../../src/services";

describe("deploy priority", () => {
  test("orders dynamodb < lambda < ecs < apigateway", () => {
    const priority = (t: "dynamodb" | "lambda" | "ecs" | "apigateway") =>
      serviceTypeRegistry.get(t).deployPriority;
    expect(priority("dynamodb")).toBeLessThan(priority("lambda"));
    expect(priority("lambda")).toBeLessThan(priority("ecs"));
    expect(priority("ecs")).toBeLessThan(priority("apigateway"));
  });
});
```

- [ ] **Step 2: Run it to confirm it passes against the plugin priorities set in Tasks 5–8**

Run: `pnpm vitest run tests/platform/deploy-order.test.ts`
Expected: PASS (priorities are 0/1/2/3 from the plugins). If it fails, fix the `deployPriority` values in the plugins to match dynamodb=0, lambda=1, ecs=2, apigateway=3.

- [ ] **Step 3: Replace `serviceDeployPriority` in `deploy.ts`**

Delete `serviceDeployPriority` (`deploy.ts:63-77`) and update `compareDeployOrder` (`:52-61`) to use the registry:

```ts
import { serviceTypeRegistry } from "./services";

function compareDeployOrder(
  left: Awaited<ReturnType<typeof discoverServices>>[number],
  right: Awaited<ReturnType<typeof discoverServices>>[number],
): number {
  return (
    serviceTypeRegistry.get(left.metadata.serviceType).deployPriority -
      serviceTypeRegistry.get(right.metadata.serviceType).deployPriority ||
    left.metadata.serviceName.localeCompare(right.metadata.serviceName)
  );
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 5: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/deploy.ts packages/platform/tests/platform/deploy-order.test.ts
```
Report the diff to the user.

---

### Task 13: Route validation extension-parsing through the registry

**Files:**
- Modify: `packages/platform/src/validate.ts`
- Test: existing `tests/platform/validate.test.ts` (regression guard)

`validateYamlFile` (`validate.ts:134-172`) has a per-extension if-chain. Replace the four service-type branches with a registry lookup keyed by the file suffix, keeping the `network.yaml` special-case.

- [ ] **Step 1: Replace the service-type branches**

In `validate.ts`, after the `network.yaml` block, replace the four `if (fileName.endsWith(".lambda.yaml") …)` branches (`:151-171`) with:

```ts
import { serviceTypeRegistry } from "./services";

  const match = fileName.match(/\.([^.]+)\.ya?ml$/);
  const plugin = match ? serviceTypeRegistry.forFileSuffix(match[1]) : undefined;
  if (plugin) {
    plugin.schema.parse(raw);
    return;
  }

  throw new Error(`Unsupported YAML config file: ${filePath}`);
```

Remove the now-unused `apiGatewaySchema, dynamoDbSchema, ecsSchema, lambdaSchema` import from `validate.ts`.

- [ ] **Step 2: Run tests and typecheck**

Run: `pnpm vitest run tests/platform/validate.test.ts && pnpm typecheck`
Expected: all validate tests pass; typecheck clean.

- [ ] **Step 3: Run the full suite**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 4: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/validate.ts
```
Report the diff to the user.

---

### Task 14: Final verification and dead-code sweep

**Files:**
- Modify: `packages/platform/src/terraform.ts`, `packages/platform/src/schemas.ts` (only if dead code remains)

- [ ] **Step 1: Confirm `terraform.ts` is now thin**

Run: `wc -l src/terraform.ts`
Expected: roughly under 30 lines (type re-exports + `terraformForService`). If large blocks remain, they were missed in Tasks 5–8 — move them.

- [ ] **Step 2: Grep for orphaned helpers/imports**

Run: `pnpm lint` (oxlint with `--deny-warnings`) from repo root, or `cd ../.. && pnpm lint`.
Expected: no unused-import/var warnings. Fix any flagged orphans by deleting them (per AGENTS.md §3, only orphans your changes created).

- [ ] **Step 3: Full green check**

Run from repo root: `pnpm lint && pnpm typecheck && pnpm --filter @repo/platform test`
Expected: lint clean, typecheck clean, all platform tests pass.

- [ ] **Step 4: Verify generated Terraform is unchanged end-to-end**

Run from repo root:
```bash
pnpm platform:generate -- --env dev --venture venture --target floci
git status --short infra/services
```
Expected: no modifications to any committed `main.tf.json` under `infra/services/**/__generated__/` (the generator overwrites them; `git status` showing them unchanged proves byte-identical output). If any differ, a move altered output — investigate before proceeding.

- [ ] **Step 5: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/
```
Report the final diff and a summary to the user.

---

## Self-Review Notes

- **Spec coverage:** This plan implements spec §1 (composable service-type modules) only. §2 (registry), §3 (app derivation/Dockerfile), §4 (ECS env), §5 (TS CLI) are deliberately deferred to Plans 2–5, since each is an independent, separately-testable subsystem.
- **Cycle avoidance:** Cross-service ref helpers (`lambdaNameForService`, `tableNameForService`, ECS ref helpers, `serviceNameFor`) live in `terraform/service-refs.ts`, imported by both lambda and apigateway plugins — no plugin↔plugin imports.
- **Behavior preservation:** Every task is guarded by the 42 existing tests plus a final byte-identical generated-output check (Task 14 Step 4). No task edits an existing test's expectations.
- **Schema files:** Left physically in `schemas/*.schema.ts`; plugins import them. `src/schemas.ts` barrel is untouched and still valid.
