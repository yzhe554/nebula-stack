# YAML Terraform Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript-based YAML-to-Terraform generator that supports Lambda and DynamoDB service configs and deploys selected services for one environment and venture at a time, either to real AWS or local Floci.

**Architecture:** Users define services under `infra/services/<env>/<venture>/<vpc>/<security-zone>/<service-name>.<service-type>.yaml`. TypeScript CLI commands validate YAML, derive metadata from paths, and generate one Terraform JSON root module per selected service under `__generated__/<target>/<env>/<venture>/<service-name>/main.tf.json`. Each service is intended to have separate Terraform state scoped by target, environment, venture, and service.

**Tech Stack:** Node.js, TypeScript, pnpm scripts, `tsx`, `yaml`, `zod`, Terraform JSON configuration, AWS provider.

---

## File Structure

- Create `package.json` for TypeScript scripts and dependencies.
- Create `tsconfig.json` for strict TypeScript settings.
- Create `packages/platform/src/types.ts` for shared metadata and service config types.
- Create `packages/platform/src/service-discovery.ts` for scanning `infra/services/<env>/**` and parsing service paths.
- Create `packages/platform/src/schemas.ts` for Lambda and DynamoDB Zod schemas.
- Create `packages/platform/schemas/lambda.schema.json` and `packages/platform/schemas/dynamodb.schema.json` for YAML editor validation.
- Create `packages/platform/src/terraform.ts` for Terraform JSON generation helpers.
- Create `packages/platform/src/generate.ts` for the `generate` CLI.
- Create `packages/platform/src/deploy.ts` for the `deploy` CLI wrapper around Terraform.
- Create example service files under `infra/services/dev/core/internal/` and `infra/services/dev/core/restricted/`.
- Modify `terraform.tf` only if needed after generated Terraform owns provider config.
- Create `.gitignore` for generated output and local Terraform files.
- Create `.github/workflows/terraform.yml` for manual selected-service deployment.

## Task 1: Initialize TypeScript Tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "learn-terraform-get-started-aws",
  "private": true,
  "type": "module",
  "scripts": {
    "generate": "tsx packages/platform/src/generate.ts",
    "deploy": "tsx packages/platform/src/deploy.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "yaml": "^2.6.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist-ts"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```gitignore
node_modules/
__generated__/
.terraform/
.terraform.lock.hcl
*.tfstate
*.tfstate.*
dist-ts/
```

- [ ] **Step 4: Install dependencies**

Run: `pnpm install`

Expected: `node_modules` and `pnpm-lock.yaml` are created.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`

Expected: command succeeds or reports no input files before source files exist.

## Task 2: Add Service Types and Schemas

**Files:**
- Create: `packages/platform/src/types.ts`
- Create: `packages/platform/src/schemas.ts`

- [ ] **Step 1: Create `packages/platform/src/types.ts`**

```ts
export type ServiceType = "lambda" | "dynamodb";

export type ServiceMetadata = {
  env: string;
  vpc: string;
  securityZone: string;
  serviceName: string;
  serviceType: ServiceType;
  sourcePath: string;
};

export type LambdaConfig = {
  runtime: string;
  handler: string;
  package: string;
  memoryMb?: number;
  timeoutSeconds?: number;
  logRetentionDays?: number;
  environment?: Record<string, string>;
};

export type DynamoDbAttributeType = "S" | "N" | "B";

export type DynamoDbConfig = {
  billingMode?: "PAY_PER_REQUEST";
  hashKey: {
    name: string;
    type: DynamoDbAttributeType;
  };
  rangeKey?: {
    name: string;
    type: DynamoDbAttributeType;
  };
  pointInTimeRecovery?: boolean;
};

export type LoadedService =
  | {
      metadata: ServiceMetadata & { serviceType: "lambda" };
      config: LambdaConfig;
    }
  | {
      metadata: ServiceMetadata & { serviceType: "dynamodb" };
      config: DynamoDbConfig;
    };
```

- [ ] **Step 2: Create `packages/platform/src/schemas.ts`**

```ts
import { z } from "zod";

export const lambdaSchema = z.object({
  runtime: z.string().min(1),
  handler: z.string().min(1),
  package: z.string().min(1),
  memoryMb: z.number().int().min(128).max(10240).default(128),
  timeoutSeconds: z.number().int().min(1).max(900).default(10),
  logRetentionDays: z.number().int().positive().default(7),
  environment: z.record(z.string()).default({}),
});

const dynamoDbAttributeSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["S", "N", "B"]),
});

export const dynamoDbSchema = z.object({
  billingMode: z.literal("PAY_PER_REQUEST").default("PAY_PER_REQUEST"),
  hashKey: dynamoDbAttributeSchema,
  rangeKey: dynamoDbAttributeSchema.optional(),
  pointInTimeRecovery: z.boolean().default(true),
});
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

## Task 3: Implement Service Discovery

**Files:**
- Create: `packages/platform/src/service-discovery.ts`

- [ ] **Step 1: Create `packages/platform/src/service-discovery.ts`**

```ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { dynamoDbSchema, lambdaSchema } from "./schemas.js";
import type { LoadedService, ServiceMetadata, ServiceType } from "./types.js";

const supportedServiceTypes = new Set<ServiceType>(["lambda", "dynamodb"]);

export type DiscoverOptions = {
  env: string;
  services?: string[];
  servicesRoot?: string;
};

export async function discoverServices(options: DiscoverOptions): Promise<LoadedService[]> {
  const servicesRoot = options.servicesRoot ?? "services";
  const envRoot = path.join(servicesRoot, options.env);
  const files = await listYamlFiles(envRoot);
  const selected = new Set(options.services ?? []);
  const loaded = await Promise.all(
    files.map(async (filePath) => loadService(filePath, servicesRoot))
  );
  const filtered = selected.size === 0
    ? loaded
    : loaded.filter((service) => selected.has(service.metadata.serviceName));

  if (selected.size > 0) {
    const found = new Set(filtered.map((service) => service.metadata.serviceName));
    const missing = [...selected].filter((serviceName) => !found.has(serviceName));
    if (missing.length > 0) {
      throw new Error(`Selected services were not found in env ${options.env}: ${missing.join(", ")}`);
    }
  }

  assertUniqueServiceNames(filtered, options.env);
  return filtered.sort((left, right) => left.metadata.serviceName.localeCompare(right.metadata.serviceName));
}

async function listYamlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listYamlFiles(entryPath);
    }
    if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      return [entryPath];
    }
    return [];
  }));

  return nested.flat();
}

async function loadService(filePath: string, servicesRoot: string): Promise<LoadedService> {
  const metadata = parseServicePath(filePath, servicesRoot);
  const raw = parse(await readFile(filePath, "utf8"));

  if (metadata.serviceType === "lambda") {
    return {
      metadata: { ...metadata, serviceType: "lambda" },
      config: lambdaSchema.parse(raw),
    };
  }

  return {
    metadata: { ...metadata, serviceType: "dynamodb" },
    config: dynamoDbSchema.parse(raw),
  };
}

function parseServicePath(filePath: string, servicesRoot: string): ServiceMetadata {
  const relative = path.relative(servicesRoot, filePath);
  const parts = relative.split(path.sep);

  if (parts.length !== 4) {
    throw new Error(`Service file must match infra/services/<env>/<vpc>/<security-zone>/<service-name>.<service-type>.yaml: ${filePath}`);
  }

  const [env, vpc, securityZone, fileName] = parts;
  const match = fileName.match(/^(.+)\.(lambda|dynamodb)\.ya?ml$/);

  if (!match) {
    throw new Error(`Unsupported service file name: ${filePath}`);
  }

  const [, serviceName, serviceType] = match;

  if (!supportedServiceTypes.has(serviceType as ServiceType)) {
    throw new Error(`Unsupported service type in ${filePath}: ${serviceType}`);
  }

  return {
    env,
    vpc,
    securityZone,
    serviceName,
    serviceType: serviceType as ServiceType,
    sourcePath: filePath,
  };
}

function assertUniqueServiceNames(services: LoadedService[], env: string): void {
  const seen = new Map<string, string>();

  for (const service of services) {
    const previous = seen.get(service.metadata.serviceName);
    if (previous) {
      throw new Error(`Duplicate service name in env ${env}: ${service.metadata.serviceName} (${previous}, ${service.metadata.sourcePath})`);
    }
    seen.set(service.metadata.serviceName, service.metadata.sourcePath);
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

## Task 4: Implement Terraform JSON Generation

**Files:**
- Create: `packages/platform/src/terraform.ts`

- [ ] **Step 1: Create `packages/platform/src/terraform.ts`**

```ts
import type { LoadedService, ServiceMetadata } from "./types.js";

export type TerraformJson = Record<string, unknown>;

export function terraformForService(service: LoadedService): TerraformJson {
  if (service.metadata.serviceType === "lambda") {
    return terraformForLambda(service);
  }

  return terraformForDynamoDb(service);
}

function terraformForLambda(service: Extract<LoadedService, { metadata: { serviceType: "lambda" } }>): TerraformJson {
  const resourceName = terraformName(service.metadata.serviceName);
  const roleName = `${resourceName}_lambda_role`;
  const logGroupName = `/aws/lambda/${physicalName(service.metadata)}`;

  return baseTerraform(service.metadata, {
    aws_iam_role: {
      [roleName]: {
        name: physicalName(service.metadata, "lambda-role"),
        assume_role_policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
            },
          ],
        }),
        tags: tagsFor(service.metadata),
      },
    },
    aws_iam_role_policy_attachment: {
      [`${roleName}_basic_execution`]: {
        role: `\${aws_iam_role.${roleName}.name}`,
        policy_arn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      },
    },
    aws_cloudwatch_log_group: {
      [resourceName]: {
        name: logGroupName,
        retention_in_days: service.config.logRetentionDays,
        tags: tagsFor(service.metadata),
      },
    },
    aws_lambda_function: {
      [resourceName]: {
        function_name: physicalName(service.metadata),
        filename: service.config.package,
        source_code_hash: `\${filebase64sha256("${service.config.package}")}`,
        role: `\${aws_iam_role.${roleName}.arn}`,
        handler: service.config.handler,
        runtime: service.config.runtime,
        memory_size: service.config.memoryMb,
        timeout: service.config.timeoutSeconds,
        environment: {
          variables: service.config.environment,
        },
        depends_on: [
          `aws_iam_role_policy_attachment.${roleName}_basic_execution`,
          `aws_cloudwatch_log_group.${resourceName}`,
        ],
        tags: tagsFor(service.metadata),
      },
    },
  });
}

function terraformForDynamoDb(service: Extract<LoadedService, { metadata: { serviceType: "dynamodb" } }>): TerraformJson {
  const resourceName = terraformName(service.metadata.serviceName);
  const attributes = [service.config.hashKey, service.config.rangeKey].filter(Boolean);

  return baseTerraform(service.metadata, {
    aws_dynamodb_table: {
      [resourceName]: {
        name: physicalName(service.metadata),
        billing_mode: service.config.billingMode,
        hash_key: service.config.hashKey.name,
        range_key: service.config.rangeKey?.name,
        attribute: attributes,
        point_in_time_recovery: {
          enabled: service.config.pointInTimeRecovery,
        },
        deletion_protection_enabled: true,
        lifecycle: {
          prevent_destroy: true,
        },
        tags: tagsFor(service.metadata),
      },
    },
  });
}

function baseTerraform(metadata: ServiceMetadata, resource: Record<string, unknown>): TerraformJson {
  return {
    terraform: {
      required_version: ">= 1.15.6",
      required_providers: {
        aws: {
          source: "hashicorp/aws",
          version: "~> 6.51",
        },
      },
    },
    provider: {
      aws: {
        region: "ap-southeast-2",
        default_tags: {
          tags: tagsFor(metadata),
        },
      },
    },
    resource,
  };
}

function tagsFor(metadata: ServiceMetadata): Record<string, string> {
  return {
    Environment: metadata.env,
    Vpc: metadata.vpc,
    SecurityZone: metadata.securityZone,
    ServiceName: metadata.serviceName,
    ServiceType: metadata.serviceType,
    ManagedBy: "yaml-terraform-platform",
  };
}

function physicalName(metadata: ServiceMetadata, suffix?: string): string {
  return [metadata.env, metadata.vpc, metadata.securityZone, metadata.serviceName, suffix]
    .filter(Boolean)
    .join("-");
}

function terraformName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

## Task 5: Add Generate CLI

**Files:**
- Create: `packages/platform/src/generate.ts`

- [ ] **Step 1: Create `packages/platform/src/generate.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { discoverServices } from "./service-discovery.js";
import { terraformForService } from "./terraform.js";

const args = parseArgs(process.argv.slice(2));

if (!args.env) {
  throw new Error("Missing required --env <env> argument");
}

const services = await discoverServices({ env: args.env, services: args.services });

for (const service of services) {
  const outputDirectory = path.join("generated", service.metadata.env, service.metadata.serviceName);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "main.tf.json"),
    `${JSON.stringify(terraformForService(service), null, 2)}\n`,
    "utf8"
  );
  console.log(`Generated ${outputDirectory}/main.tf.json from ${service.metadata.sourcePath}`);
}

function parseArgs(argv: string[]): { env?: string; services?: string[] } {
  const parsed: { env?: string; services?: string[] } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env") {
      parsed.env = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--services") {
      parsed.services = argv[index + 1]
        .split(",")
        .map((service) => service.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

## Task 6: Add Example Service YAML Files

**Files:**
- Create: `infra/services/dev/core/internal/payment-api.lambda.yaml`
- Create: `infra/services/dev/core/managed/customer-records.dynamodb.yaml`

- [ ] **Step 1: Create Lambda example**

```yaml
runtime: nodejs22.x
handler: index.handler
package: ../../dist/payment-api.zip
memoryMb: 128
timeoutSeconds: 10
logRetentionDays: 7
environment:
  TABLE_SERVICE_NAME: customer-records
```

- [ ] **Step 2: Create DynamoDB example**

```yaml
billingMode: PAY_PER_REQUEST
hashKey:
  name: customerId
  type: S
pointInTimeRecovery: true
```

- [ ] **Step 3: Generate dev services**

Run: `pnpm platform:generate -- --env dev --venture venture`

Expected: generated Terraform JSON files are created for `payment-api` and `customer-records`.

## Task 7: Add Deploy CLI

**Files:**
- Create: `packages/platform/src/deploy.ts`

- [ ] **Step 1: Create `packages/platform/src/deploy.ts`**

```ts
import { spawnSync } from "node:child_process";
import path from "node:path";
import { discoverServices } from "./service-discovery.js";

const args = parseArgs(process.argv.slice(2));

if (!args.env) {
  throw new Error("Missing required --env <env> argument");
}

run("pnpm", ["generate", "--", "--env", args.env, ...(args.services.length > 0 ? ["--services", args.services.join(",")] : [])], process.cwd());

const services = await discoverServices({ env: args.env, services: args.services });

for (const service of services) {
  const cwd = path.join(process.cwd(), "generated", service.metadata.env, service.metadata.serviceName);
  run("terraform", ["init"], cwd);
  run("terraform", ["plan", "-out=tfplan"], cwd);
  run("terraform", ["apply", "tfplan"], cwd);
}

function parseArgs(argv: string[]): { env?: string; services: string[] } {
  const parsed: { env?: string; services: string[] } = { services: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env") {
      parsed.env = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--services") {
      parsed.services = argv[index + 1]
        .split(",")
        .map((service) => service.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function run(command: string, args: string[], cwd: string): void {
  console.log(`Running: ${command} ${args.join(" ")} in ${cwd}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

## Task 8: Add GitHub Actions Workflow

**Files:**
- Create: `.github/workflows/terraform.yml`

- [ ] **Step 1: Create workflow**

```yaml
name: Terraform Deploy

on:
  workflow_dispatch:
    inputs:
      environment:
        description: Environment to deploy
        required: true
        type: choice
        options:
          - dev
          - prod
      services:
        description: Comma-separated service names. Leave empty for all services in the environment.
        required: false
        type: string
        default: ""

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<ACCOUNT_ID>:role/github-actions-terraform
          aws-region: ap-southeast-2

      - uses: hashicorp/setup-terraform@v3

      - run: pnpm typecheck

      - name: Deploy selected services
        run: |
          if [ -n "${{ inputs.services }}" ]; then
            pnpm platform:deploy -- --env "${{ inputs.environment }}" --venture "${{ inputs.venture }}" --services "${{ inputs.services }}"
          else
            pnpm platform:deploy -- --env "${{ inputs.environment }}" --venture "${{ inputs.venture }}"
          fi
```

- [ ] **Step 2: Replace AWS role placeholder**

Edit `.github/workflows/terraform.yml` and replace `arn:aws:iam::<ACCOUNT_ID>:role/github-actions-terraform` with the real role ARN.

## Task 9: Validate End-to-End Locally

**Files:**
- Generated: `__generated__/dev/payment-api/main.tf.json`
- Generated: `__generated__/dev/customer-records/main.tf.json`

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 2: Generate one service**

Run: `pnpm platform:generate -- --env dev --venture venture --services customer-records`

Expected: `__generated__/dev/customer-records/main.tf.json` is created.

- [ ] **Step 3: Generate multiple services**

Run: `pnpm platform:generate -- --env dev --venture venture --services payment-api,customer-records`

Expected: both generated service folders are created.

- [ ] **Step 4: Validate DynamoDB Terraform**

Run: `cd __generated__/dev/customer-records && terraform init && terraform validate`

Expected: Terraform initializes the AWS provider and reports valid configuration.

- [ ] **Step 5: Validate Lambda Terraform after package exists**

Create `dist/payment-api.zip` from the real app or a placeholder package before planning Lambda.

Run: `cd __generated__/dev/payment-api && terraform init && terraform validate`

Expected: Terraform reports valid configuration.

## Self-Review

- Spec coverage: The plan covers service folder layout, Lambda and DynamoDB schemas, TypeScript generation, selected service deploys, env boundary, Terraform JSON output, GitHub Actions, and safety defaults.
- Placeholder scan: The GitHub Actions role ARN is intentionally a user-owned value that must be replaced before CI can deploy.
- Type consistency: Service type names, metadata fields, generated paths, and CLI flags are consistent across tasks.
