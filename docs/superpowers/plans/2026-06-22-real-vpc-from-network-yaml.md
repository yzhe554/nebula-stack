# Real VPC from network.yaml Implementation Plan (Spec A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `network.yaml` generate a real VPC (subnets per zone, route tables with internal subnets having no internet route, per-zone security groups from `flows`, VPC flow logs) as a Terraform module applied first, and re-home ECS services off the AWS default VPC onto it via by-tag data-source lookups.

**Architecture:** Add a `network` service-type plugin (Plan-1 pattern) so `network.yaml` is discovered, schema-validated, and emitted as its own module applied before all other services. A new VPC emitter turns `network.yaml` into `aws_vpc` + subnets + routing + SGs + flow logs. A shared `vpc-lookup.ts` helper produces by-tag `data.aws_vpc.selected`/`data.aws_subnets.selected` blocks that replace `data.aws_vpc.default` in the three ECS emitter variants.

**Tech Stack:** TypeScript (ESM, `tsx`), Zod 4, Vitest, Terraform JSON, AWS provider.

**This is the implementation of Spec A** (`docs/superpowers/specs/2026-06-22-real-vpc-from-network-yaml-design.md`), foundational for Spec B (VPC endpoints) and Spec C (direct Lambda invoke).

---

## Ground Rules

- Run from `packages/platform/` for tests/typecheck (`pnpm test`, `pnpm typecheck`); run `pnpm lint` from repo ROOT.
- **oxlint runs `--type-aware --type-check --deny-warnings` and FORBIDS `typescript/no-unsafe-type-assertion`.** No `as T` casts — use type guards / typed predicates. (The ONE pre-existing exception is the documented cast in `service-discovery.ts` `loadService`; don't add new ones.)
- **Do not `git commit`.** Each "Commit" step means: `git add` the listed files and report the diff to the user. The user commits.
- **Behavior preservation with ONE intended exception:** all generated Terraform stays byte-identical EXCEPT ECS services' VPC/subnet data sources, which change from `data.aws_vpc.default` to tagged lookups (Task 6). Lambda/dynamodb/apigateway output stays byte-identical — verified in Task 8.
- Follow the existing plugin pattern in `src/services/<type>/` and the registry in `src/services/index.ts`.

## Terraform correctness notes (read before Task 4)

- **Security group egress is deny-all by default in Terraform.** An `aws_security_group` resource with no `egress` block configures NO egress rules (Terraform does not replicate AWS's console default of allow-all). For Spec A we DO add an explicit allow-all egress per zone SG (`egress` cidr `0.0.0.0/0`), because the internet *route* is what enforces isolation for internal subnets (no `0.0.0.0/0` route table entry), not the SG. Tightening egress is a future hardening, out of scope. This corrects a parenthetical in the spec ("AWS default SG egress is all-allow") — in Terraform we must add it explicitly.
- **Subnet AZ spread:** use `data.aws_availability_zones.available` and index into `.names[index % length]` via Terraform expressions. Subnets are created from the static CIDR list in `network.yaml`, so the count is known at generate time; emit one `aws_subnet` resource per CIDR with a deterministic resource key.
- **Floci/LocalStack:** route/SG isolation is not enforced locally. Tasks assert on generated Terraform JSON, not Floci behavior, for the security properties.

## Background: verified current state

- `src/types.ts`: `ServiceType = "lambda" | "dynamodb" | "apigateway" | "ecs"` (line 1); `LoadedService` is a 4-member discriminated union (lines 117-133). `NetworkPolicy`, `NetworkZone`, `NetworkFlow`, `AwsEndpoint` types exist (lines 135-163).
- `src/services/service-type.ts`: `ServiceTypePlugin` has `type`, `fileSuffix`, `schema`, `jsonSchemaMetadata`, `deployPriority`, optional `validateReferences`, `toTerraform`. `createServiceTypeRegistry` throws on duplicate type/suffix.
- `src/services/index.ts`: `serviceTypeRegistry = createServiceTypeRegistry([dynamoDbPlugin, lambdaPlugin, apiGatewayPlugin, ecsPlugin])`. Priorities: dynamodb=0, lambda=1, ecs=2, apigateway=3.
- `src/service-discovery.ts`: `listYamlFiles` EXCLUDES `network.yaml` (line 62); `parseServicePath` requires exactly 5 path segments (line 87) and parses `<name>.<suffix>.yaml`; `loadService` looks up the plugin by `metadata.serviceType` and parses with its schema.
- `src/network-zones.ts`: `validateServiceNetworkZones` loops ALL discovered services and requires each `securityZone` to exist in `network.yaml` zones (special-casing dynamodb/managed).
- `src/generated-paths.ts`: generated dir = `<dirname(sourcePath)>/__generated__/<target>/<serviceName>`.
- `schemas/network.schema.ts`: `networkPolicySchema` (exported), `network.schema.json` committed. `networkAwsServiceValues` includes `lambda`.
- ECS emitter `src/services/ecs/terraform.ts`: three variants emit `data.aws_vpc.default` (`{ default: true }`) + `data.aws_subnets.default` (filter vpc-id) and reference `${data.aws_vpc.default.id}` / `${data.aws_subnets.default.ids}` (lines ~139, 150, 190, 240, 284-296, 364, 374, 398).
- `src/terraform/base.ts`: `baseTerraform(metadata, target, resource, data?)`, `tagsFor(metadata)`, `regionForTarget(target)`, `type DeployTarget`, `type TerraformJson`.
- `src/terraform/naming.ts`: `physicalName(metadata, suffix?)`, `terraformName(value)`.

---

## File Structure (end state)

```
packages/platform/src/
  types.ts                              # MODIFIED: ServiceType + LoadedService gain "network"
  service-discovery.ts                  # MODIFIED: include network.yaml; parse 4-segment path
  network-zones.ts                      # MODIFIED: skip the network service itself in zone validation
  terraform/vpc-lookup.ts               # NEW: vpcDataSources(metadata) by-tag lookup block
  services/network/
    terraform.ts                        # NEW: terraformForNetwork (vpc/subnets/routing/sg/flowlog)
    index.ts                            # NEW: networkPlugin
  services/index.ts                     # MODIFIED: register networkPlugin; shift priorities
  services/ecs/terraform.ts             # MODIFIED: 3 variants use vpcDataSources
packages/platform/tests/platform/
  network-terraform.test.ts             # NEW: VPC emitter assertions
  vpc-lookup.test.ts                    # NEW: helper assertions
  terraform.test.ts                     # MODIFIED: ECS data-source assertions updated
  service-discovery.test.ts             # MODIFIED/added: network.yaml discovered
```

---

### Task 1: Add `"network"` to the type system

**Files:**
- Modify: `packages/platform/src/types.ts`

- [ ] **Step 1: Extend `ServiceType` and `LoadedService`**

In `src/types.ts` line 1:
```ts
export type ServiceType = "lambda" | "dynamodb" | "apigateway" | "ecs" | "network";
```
Add a `network` member to the `LoadedService` union (after the ecs member, before the closing). Network's config is the existing `NetworkPolicy` type:
```ts
  | {
      metadata: ServiceMetadata & { serviceType: "network" };
      config: NetworkPolicy;
    };
```
(`NetworkPolicy` is already declared later in the file; referencing it here is fine since it's a type.)

- [ ] **Step 2: Typecheck**

Run: `cd packages/platform && pnpm typecheck`
Expected: This will likely surface exhaustiveness errors where code switches over `serviceType` (e.g. registry consumers). That's expected — note them; they're resolved as later tasks add the plugin. If `tsc` errors ONLY in places that later tasks touch (registry/discovery), proceed. If it errors elsewhere unexpectedly, report.

- [ ] **Step 3: Commit (checkpoint — stage, report, do not commit)**

```bash
git add packages/platform/src/types.ts
```
Report the diff.

---

### Task 2: VPC lookup helper (`vpc-lookup.ts`)

**Files:**
- Create: `packages/platform/src/terraform/vpc-lookup.ts`
- Create: `packages/platform/tests/platform/vpc-lookup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/platform/tests/platform/vpc-lookup.test.ts
import { describe, expect, test } from "vitest";
import { vpcDataSources, vpcNameTag } from "../../src/terraform/vpc-lookup";
import type { ServiceMetadata } from "../../src/types";

const metadata: ServiceMetadata = {
  env: "dev", venture: "venture", vpc: "core", securityZone: "public",
  serviceName: "docs-app", serviceType: "ecs",
  sourcePath: "infra/services/dev/venture/core/public/docs-app.ecs.yaml",
};

describe("vpcDataSources", () => {
  test("vpcNameTag builds the predictable vpc Name tag", () => {
    expect(vpcNameTag(metadata)).toBe("dev-venture-core-vpc");
  });

  test("emits aws_vpc selected by Name tag and subnets by Zone tag", () => {
    const data = vpcDataSources(metadata);
    expect(data.aws_vpc).toEqual({
      selected: { filter: { name: "tag:Name", values: ["dev-venture-core-vpc"] } },
    });
    expect(data.aws_subnets).toEqual({
      selected: {
        filter: [
          { name: "vpc-id", values: ["${data.aws_vpc.selected.id}"] },
          { name: "tag:Zone", values: ["public"] },
        ],
      },
    });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `pnpm vitest run tests/platform/vpc-lookup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/platform/src/terraform/vpc-lookup.ts
import type { ServiceMetadata } from "../types";

export function vpcNameTag(metadata: ServiceMetadata): string {
  return `${metadata.env}-${metadata.venture}-${metadata.vpc}-vpc`;
}

export function vpcDataSources(metadata: ServiceMetadata): Record<string, unknown> {
  return {
    aws_vpc: {
      selected: { filter: { name: "tag:Name", values: [vpcNameTag(metadata)] } },
    },
    aws_subnets: {
      selected: {
        filter: [
          { name: "vpc-id", values: ["${data.aws_vpc.selected.id}"] },
          { name: "tag:Zone", values: [metadata.securityZone] },
        ],
      },
    },
  };
}
```

- [ ] **Step 4: Run, confirm PASS (2 tests)**

Run: `pnpm vitest run tests/platform/vpc-lookup.test.ts`
Expected: PASS.

- [ ] **Step 5: Suite + lint** — `pnpm test` (existing still green), repo-root `pnpm lint` clean.

- [ ] **Step 6: Commit (checkpoint)**

```bash
git add packages/platform/src/terraform/vpc-lookup.ts packages/platform/tests/platform/vpc-lookup.test.ts
```
Report the diff.

---

### Task 3: Network VPC emitter — VPC + subnets

**Files:**
- Create: `packages/platform/src/services/network/terraform.ts`
- Create: `packages/platform/tests/platform/network-terraform.test.ts`

Build the emitter incrementally (Tasks 3–5). Start with VPC + subnets + AZ data source.

- [ ] **Step 1: Write the failing test**

```ts
// packages/platform/tests/platform/network-terraform.test.ts
import { describe, expect, test } from "vitest";
import { terraformForNetwork } from "../../src/services/network/terraform";
import type { LoadedService } from "../../src/types";

const networkService: LoadedService = {
  metadata: {
    env: "dev", venture: "venture", vpc: "core", securityZone: "network",
    serviceName: "network", serviceType: "network",
    sourcePath: "infra/services/dev/venture/core/network.yaml",
  },
  config: {
    cidrs: { ipv4: { vpc: "10.20.0.0/16" } },
    zones: {
      public: { description: "Public edge.", subnets: ["10.20.0.0/24", "10.20.1.0/24"] },
      internal: { description: "Internal.", subnets: ["10.20.10.0/24", "10.20.11.0/24"] },
    },
    flows: [
      { from: "public", to: "internal", ports: [443] },
      { from: "internal", to: "aws", services: ["dynamodb", "logs"] },
    ],
    awsEndpoints: {},
  },
};

type TF = { resource: Record<string, Record<string, Record<string, unknown>>>; data: Record<string, unknown> };

describe("terraformForNetwork: vpc + subnets", () => {
  test("creates the vpc with dns enabled and the Name tag", () => {
    const tf = terraformForNetwork(networkService, { target: "aws" }) as TF;
    const vpc = tf.resource.aws_vpc.network as Record<string, unknown>;
    expect(vpc.cidr_block).toBe("10.20.0.0/16");
    expect(vpc.enable_dns_support).toBe(true);
    expect(vpc.enable_dns_hostnames).toBe(true);
    expect((vpc.tags as Record<string, string>).Name).toBe("dev-venture-core-vpc");
  });

  test("creates one subnet per cidr, tagged by zone, public maps public ip", () => {
    const tf = terraformForNetwork(networkService, { target: "aws" }) as TF;
    const subnets = tf.resource.aws_subnet;
    expect(Object.keys(subnets).sort()).toEqual([
      "internal_0", "internal_1", "public_0", "public_1",
    ]);
    const pub0 = subnets.public_0 as Record<string, unknown>;
    expect(pub0.cidr_block).toBe("10.20.0.0/24");
    expect(pub0.map_public_ip_on_launch).toBe(true);
    expect((pub0.tags as Record<string, string>).Zone).toBe("public");
    expect((pub0.tags as Record<string, string>).Name).toBe("dev-venture-core-public-0");
    const int0 = subnets.internal_0 as Record<string, unknown>;
    expect(int0.map_public_ip_on_launch).toBe(false);
    expect((int0.tags as Record<string, string>).Zone).toBe("internal");
  });

  test("includes an availability-zones data source and spreads subnets across AZs", () => {
    const tf = terraformForNetwork(networkService, { target: "aws" }) as TF;
    expect(tf.data).toHaveProperty("aws_availability_zones");
    const pub0 = tf.resource.aws_subnet.public_0 as Record<string, unknown>;
    expect(pub0.availability_zone).toBe("${data.aws_availability_zones.available.names[0]}");
    const pub1 = tf.resource.aws_subnet.public_1 as Record<string, unknown>;
    expect(pub1.availability_zone).toBe("${data.aws_availability_zones.available.names[1]}");
  });
});
```

> The `as Record<...>` casts here are in TEST code reading untyped Terraform JSON. oxlint may flag them; mirror however `terraform.test.ts` reads nested output (it uses helper functions `resource()`/`objectProperty()`). PREFER reusing that style: import/replicate small typed accessors rather than raw casts. If you keep casts in tests, confirm `pnpm lint` passes; if it complains, switch to the accessor-helper style used in `terraform.test.ts`.

- [ ] **Step 2: Run, confirm FAIL**

Run: `pnpm vitest run tests/platform/network-terraform.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement VPC + subnets**

```ts
// packages/platform/src/services/network/terraform.ts
import { baseTerraform, tagsFor, type TerraformJson } from "../../terraform/base";
import type { TerraformContext } from "../../terraform/context";
import type { LoadedService } from "../../types";

type NetworkService = Extract<LoadedService, { metadata: { serviceType: "network" } }>;

function vpcName(metadata: NetworkService["metadata"]): string {
  return `${metadata.env}-${metadata.venture}-${metadata.vpc}-vpc`;
}

type SubnetEntry = { key: string; zone: string; index: number; cidr: string };

function subnetEntries(service: NetworkService): SubnetEntry[] {
  const entries: SubnetEntry[] = [];
  for (const [zone, zoneConfig] of Object.entries(service.config.zones)) {
    zoneConfig.subnets.forEach((cidr, index) => {
      entries.push({ key: `${zone}_${index}`, zone, index, cidr });
    });
  }
  return entries;
}

export function terraformForNetwork(
  service: NetworkService,
  options: TerraformContext,
): TerraformJson {
  const metadata = service.metadata;
  const entries = subnetEntries(service);

  const subnets: Record<string, unknown> = {};
  entries.forEach((entry, flatIndex) => {
    subnets[entry.key] = {
      vpc_id: "${aws_vpc.network.id}",
      cidr_block: entry.cidr,
      availability_zone: `\${data.aws_availability_zones.available.names[${flatIndex}]}`,
      map_public_ip_on_launch: entry.zone === "public",
      tags: {
        ...tagsFor(metadata),
        Name: `${metadata.env}-${metadata.venture}-${metadata.vpc}-${entry.zone}-${entry.index}`,
        Zone: entry.zone,
      },
    };
  });

  return baseTerraform(
    metadata,
    options.target ?? "aws",
    {
      aws_vpc: {
        network: {
          cidr_block: service.config.cidrs.ipv4.vpc,
          enable_dns_support: true,
          enable_dns_hostnames: true,
          tags: { ...tagsFor(metadata), Name: vpcName(metadata) },
        },
      },
      aws_subnet: subnets,
    },
    {
      aws_availability_zones: { available: { state: "available" } },
    },
  );
}
```

> NOTE on AZ index: this spreads ALL subnets across AZs by flat index (public_0→az0, public_1→az1, internal_0→az2...). If you prefer per-zone AZ spread (public_0→az0, internal_0→az0), index within the zone instead. The test above asserts flat-index for public_0/public_1 = az0/az1. Keep the implementation and test consistent; flat index is simplest. Real AWS regions have ≥3 AZs so `names[2]`, `names[3]` resolve; if a region has fewer, modulo would be safer — use `names[index % length(...)]` via a Terraform expression if you want robustness, but the test asserts plain `[0]`/`[1]`, so keep it plain unless you also update the test.

- [ ] **Step 4: Run, confirm PASS (3 tests)**

Run: `pnpm vitest run tests/platform/network-terraform.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (checkpoint)**

```bash
git add packages/platform/src/services/network/terraform.ts packages/platform/tests/platform/network-terraform.test.ts
```
Report the diff.

---

### Task 4: Network emitter — routing (IGW + route tables)

**Files:**
- Modify: `packages/platform/src/services/network/terraform.ts`
- Modify: `packages/platform/tests/platform/network-terraform.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
describe("terraformForNetwork: routing", () => {
  test("creates an internet gateway", () => {
    const tf = terraformForNetwork(networkService, { target: "aws" }) as TF;
    expect(tf.resource.aws_internet_gateway.network).toMatchObject({
      vpc_id: "${aws_vpc.network.id}",
    });
  });

  test("public route table has a 0.0.0.0/0 route to the IGW", () => {
    const tf = terraformForNetwork(networkService, { target: "aws" }) as TF;
    const publicRt = tf.resource.aws_route_table.public as Record<string, unknown>;
    expect(publicRt.route).toEqual([
      { cidr_block: "0.0.0.0/0", gateway_id: "${aws_internet_gateway.network.id}" },
    ]);
  });

  test("internal route table has NO 0.0.0.0/0 route", () => {
    const tf = terraformForNetwork(networkService, { target: "aws" }) as TF;
    const internalRt = tf.resource.aws_route_table.internal as Record<string, unknown> | undefined;
    // internal RT exists but has no default route (no `route` entries, or empty)
    expect(internalRt).toBeDefined();
    const routes = (internalRt?.route as Array<{ cidr_block: string }> | undefined) ?? [];
    expect(routes.some((r) => r.cidr_block === "0.0.0.0/0")).toBe(false);
  });

  test("associates each subnet with its zone route table", () => {
    const tf = terraformForNetwork(networkService, { target: "aws" }) as TF;
    const assoc = tf.resource.aws_route_table_association;
    expect(assoc.public_0).toMatchObject({
      subnet_id: "${aws_subnet.public_0.id}",
      route_table_id: "${aws_route_table.public.id}",
    });
    expect(assoc.internal_0).toMatchObject({
      subnet_id: "${aws_subnet.internal_0.id}",
      route_table_id: "${aws_route_table.internal.id}",
    });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement routing**

In `terraform.ts`, compute the set of zones from `service.config.zones`. Add to the resource object:
- `aws_internet_gateway.network = { vpc_id: "${aws_vpc.network.id}", tags: { ...tagsFor, Name: \`${...}-igw\` } }`
- `aws_route_table`: one per zone. The `public` zone's table gets `route: [{ cidr_block: "0.0.0.0/0", gateway_id: "${aws_internet_gateway.network.id}" }]`. Every other zone gets a table with NO `route` key (omit it entirely — local routes are implicit). Tag each `Name: \`${...}-${zone}-rt\``.
- `aws_route_table_association`: one per subnet entry, key = entry.key, `{ subnet_id: "${aws_subnet.<key>.id}", route_table_id: "${aws_route_table.<zone>.id}" }`.

Helper sketch:
```ts
const zones = Object.keys(service.config.zones);
const routeTables: Record<string, unknown> = {};
for (const zone of zones) {
  routeTables[zone] = {
    vpc_id: "${aws_vpc.network.id}",
    ...(zone === "public"
      ? { route: [{ cidr_block: "0.0.0.0/0", gateway_id: "${aws_internet_gateway.network.id}" }] }
      : {}),
    tags: { ...tagsFor(metadata), Name: `${metadata.env}-${metadata.venture}-${metadata.vpc}-${zone}-rt` },
  };
}
const associations: Record<string, unknown> = {};
for (const entry of entries) {
  associations[entry.key] = {
    subnet_id: `\${aws_subnet.${entry.key}.id}`,
    route_table_id: `\${aws_route_table.${entry.zone}.id}`,
  };
}
```
Merge `aws_internet_gateway`, `aws_route_table: routeTables`, `aws_route_table_association: associations` into the resource object.

- [ ] **Step 4: Run, confirm PASS**

- [ ] **Step 5: Commit (checkpoint)**

```bash
git add packages/platform/src/services/network/terraform.ts packages/platform/tests/platform/network-terraform.test.ts
```
Report the diff.

---

### Task 5: Network emitter — security groups (from flows) + flow logs

**Files:**
- Modify: `packages/platform/src/services/network/terraform.ts`
- Modify: `packages/platform/tests/platform/network-terraform.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
describe("terraformForNetwork: security groups + flow logs", () => {
  test("one security group per zone", () => {
    const tf = terraformForNetwork(networkService, { target: "aws" }) as TF;
    expect(Object.keys(tf.resource.aws_security_group).sort()).toEqual(["internal", "public"]);
    const internalSg = tf.resource.aws_security_group.internal as Record<string, unknown>;
    expect(internalSg.vpc_id).toBe("${aws_vpc.network.id}");
    expect((internalSg.tags as Record<string, string>).Name).toBe("dev-venture-core-internal-sg");
  });

  test("port flow public->internal[443] becomes an internal ingress from the public SG", () => {
    const tf = terraformForNetwork(networkService, { target: "aws" }) as TF;
    const rule = tf.resource.aws_security_group_rule.internal_from_public_443 as Record<string, unknown>;
    expect(rule).toMatchObject({
      type: "ingress",
      from_port: 443,
      to_port: 443,
      protocol: "tcp",
      security_group_id: "${aws_security_group.internal.id}",
      source_security_group_id: "${aws_security_group.public.id}",
    });
  });

  test("service flows (internal->aws) produce NO security group rule", () => {
    const tf = terraformForNetwork(networkService, { target: "aws" }) as TF;
    const ruleKeys = Object.keys(tf.resource.aws_security_group_rule ?? {});
    expect(ruleKeys.some((k) => k.includes("aws"))).toBe(false);
  });

  test("each zone SG has an explicit allow-all egress", () => {
    const tf = terraformForNetwork(networkService, { target: "aws" }) as TF;
    const egress = tf.resource.aws_security_group_rule.internal_egress_all as Record<string, unknown>;
    expect(egress).toMatchObject({
      type: "egress", from_port: 0, to_port: 0, protocol: "-1",
      cidr_blocks: ["0.0.0.0/0"], security_group_id: "${aws_security_group.internal.id}",
    });
  });

  test("creates a flow log to a cloudwatch log group", () => {
    const tf = terraformForNetwork(networkService, { target: "aws" }) as TF;
    expect(tf.resource.aws_flow_log.network).toMatchObject({
      vpc_id: "${aws_vpc.network.id}",
      traffic_type: "ALL",
    });
    expect(tf.resource.aws_cloudwatch_log_group.flow_logs).toMatchObject({
      name: "/vpc/dev-venture-core/flow-logs",
    });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement SGs + rules + flow logs**

- `aws_security_group`: one per zone, key = zone, `{ name: \`${env}-${venture}-${vpc}-${zone}-sg\`, vpc_id: "${aws_vpc.network.id}", tags: { ...tagsFor, Name: same } }`.
- `aws_security_group_rule`: iterate `service.config.flows`. For each flow with `ports` AND whose `from`/`to` are both real zones (exist in `config.zones`): for each port, emit key `${to}_from_${from}_${port}` = `{ type: "ingress", from_port: port, to_port: port, protocol: "tcp", security_group_id: "${aws_security_group.${to}.id}", source_security_group_id: "${aws_security_group.${from}.id}" }`. Flows whose `to` is `aws` (or that have `services` not `ports`) are SKIPPED for SG rules. Also emit one egress allow-all per zone: key `${zone}_egress_all` = `{ type: "egress", from_port: 0, to_port: 0, protocol: "-1", cidr_blocks: ["0.0.0.0/0"], security_group_id: "${aws_security_group.${zone}.id}" }`.
- Flow logs: `aws_cloudwatch_log_group.flow_logs = { name: \`/vpc/${env}-${venture}-${vpc}/flow-logs\`, retention_in_days: 7, tags }`; an IAM role `aws_iam_role.flow_logs` with the vpc-flow-logs assume policy + a role policy allowing `logs:CreateLogStream`/`logs:PutLogEvents`; `aws_flow_log.network = { vpc_id: "${aws_vpc.network.id}", traffic_type: "ALL", log_destination_type: "cloud-watch-logs", log_destination: "${aws_cloudwatch_log_group.flow_logs.arn}", iam_role_arn: "${aws_iam_role.flow_logs.arn}", tags }`.

> The IAM role for flow logs adds a few resources; include them so `aws_flow_log` is valid. Keep the assume-role principal `vpc-flow-logs.amazonaws.com`. Exact policy JSON: assume = `{Version,Statement:[{Action:"sts:AssumeRole",Effect:"Allow",Principal:{Service:"vpc-flow-logs.amazonaws.com"}}]}`; inline policy actions `["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents","logs:DescribeLogGroups","logs:DescribeLogStreams"]` on `"*"`.

- [ ] **Step 4: Run, confirm PASS (all network-terraform tests)**

- [ ] **Step 5: Suite + typecheck + lint**, then commit checkpoint:

```bash
git add packages/platform/src/services/network/terraform.ts packages/platform/tests/platform/network-terraform.test.ts
```
Report the diff.

---

### Task 6: The `network` plugin + registry registration + discovery

**Files:**
- Create: `packages/platform/src/services/network/index.ts`
- Modify: `packages/platform/src/services/index.ts`
- Modify: `packages/platform/src/service-discovery.ts`
- Modify: `packages/platform/src/network-zones.ts`
- Modify: `packages/platform/tests/platform/service-discovery.test.ts`

- [ ] **Step 1: Create the plugin**

```ts
// packages/platform/src/services/network/index.ts
import { networkPolicySchema } from "../../../schemas/network.schema";
import type { ServiceTypePlugin } from "../service-type";
import type { LoadedService } from "../../types";
import { terraformForNetwork } from "./terraform";

type NetworkService = Extract<LoadedService, { metadata: { serviceType: "network" } }>;

function isNetworkService(service: LoadedService): service is NetworkService {
  return service.metadata.serviceType === "network";
}

export const networkPlugin: ServiceTypePlugin = {
  type: "network",
  fileSuffix: "network",
  schema: networkPolicySchema,
  jsonSchemaMetadata: {
    fileName: "network.schema.json",
    title: "Platform Network",
    description: "AWS-first IPv4 network intent for one env/venture/VPC.",
  },
  deployPriority: -1,
  toTerraform: (service, context) => {
    if (!isNetworkService(service)) {
      throw new Error(`networkPlugin received non-network service: ${service.metadata.serviceType}`);
    }
    return terraformForNetwork(service, context);
  },
};
```

> NOTE `deployPriority: -1` so network applies before dynamodb(0)/lambda(1)/ecs(2)/apigateway(3). `compareDeployOrder` sorts ascending by priority, so -1 is first. Reset reverses, so network is last to tear down. The `fileSuffix: "network"` is used by Task 6 Step 3's discovery for `network.yaml` (file stem is `network`, no `.network.yaml` — see Step 3).

- [ ] **Step 2: Register in `services/index.ts`**

```ts
import { networkPlugin } from "./network";
export const serviceTypeRegistry = createServiceTypeRegistry([
  networkPlugin,
  dynamoDbPlugin,
  lambdaPlugin,
  apiGatewayPlugin,
  ecsPlugin,
]);
```

- [ ] **Step 3: Discovery — include `network.yaml` and parse its 4-segment path**

In `service-discovery.ts`:
- `listYamlFiles`: REMOVE the `entry.name !== "network.yaml"` exclusion so network.yaml is listed.
- `parseServicePath`: handle the network case. `network.yaml` relative path has 4 segments `<env>/<venture>/<vpc>/network.yaml` (no zone). Add, before the 5-segment check:
```ts
if (parts.length === 4 && parts[3] === "network.yaml") {
  const [env, venture, vpc] = parts;
  return {
    env, venture, vpc,
    securityZone: "network",
    serviceName: "network",
    serviceType: "network",
    sourcePath: filePath,
  };
}
```
Keep the existing 5-segment logic for everything else. (The `securityZone: "network"` sentinel never collides with a real zone since zones are `public`/`internal`; it routes nothing through subnet lookup because the network service doesn't use `vpcDataSources`.)

> `loadService` already does `serviceTypeRegistry.get(metadata.serviceType).schema.parse(raw)` → for network it parses with `networkPolicySchema`. Works unchanged.

- [ ] **Step 4: Network-zones validation — skip the network service itself**

In `network-zones.ts` `validateServiceNetworkZones`, the loop checks every service's `securityZone` exists in zones. The network service has `securityZone: "network"` which is NOT a zone → would throw. Add a skip at the top of the loop body:
```ts
if (service.serviceType === "network") {
  continue;
}
```

- [ ] **Step 5: Add/extend discovery test**

In `service-discovery.test.ts`, add a test that builds a temp tree WITH a `network.yaml` at `<env>/<venture>/<vpc>/network.yaml` and asserts `discoverServices` returns an entry with `serviceType: "network"`, `serviceName: "network"`. (Follow the existing temp-fixture style in that file — it uses `mkdir`/`writeFile` under a temp `servicesRoot`.) Include a minimal valid network.yaml body (cidrs/zones/flows/awsEndpoints:{}).

- [ ] **Step 6: Run discovery + full suite + typecheck + lint**

Run: `pnpm vitest run tests/platform/service-discovery.test.ts` then `pnpm test && pnpm typecheck`; repo-root `pnpm lint`.
Expected: all green. The Task 1 exhaustiveness errors should now be resolved (network plugin registered).

- [ ] **Step 7: Commit (checkpoint)**

```bash
git add packages/platform/src/services/network/index.ts packages/platform/src/services/index.ts packages/platform/src/service-discovery.ts packages/platform/src/network-zones.ts packages/platform/tests/platform/service-discovery.test.ts
```
Report the diff.

---

### Task 7: Re-home ECS onto the VPC lookup

**Files:**
- Modify: `packages/platform/src/services/ecs/terraform.ts`
- Modify: `packages/platform/tests/platform/terraform.test.ts`

- [ ] **Step 1: Update ECS snapshot-test expectations FIRST (this is the intended break)**

In `terraform.test.ts`, the ECS tests assert `network_configuration.subnets: "${data.aws_subnets.default.ids}"` and security_group references, and (for the EC2 variant) `data.aws_vpc.default`/`data.aws_subnets.default`. Update these to the new shape:
- `subnets` references become `"${data.aws_subnets.selected.ids}"`.
- `vpc_id` references become `"${data.aws_vpc.selected.id}"`.
- The `data` block assertions change from `{ aws_vpc: { default: { default: true } }, aws_subnets: { default: {...} } }` to the `vpcDataSources` shape: `aws_vpc.selected` filtered by `tag:Name` = `dev-venture-core-public-docs-app`... wait — the VPC Name tag is per-VPC (`dev-venture-core-vpc`), NOT per-service. Assert `aws_vpc.selected.filter = { name: "tag:Name", values: ["dev-venture-core-vpc"] }` and `aws_subnets.selected.filter` includes `{ name: "tag:Zone", values: ["public"] }` (docs-app is in the public zone).

Grep first: `grep -n "aws_vpc.default\|aws_subnets.default\|data.aws_subnets\|data.aws_vpc" tests/platform/terraform.test.ts` to find every assertion to update.

- [ ] **Step 2: Run, confirm the ECS tests now FAIL (old output still emitted)**

Run: `pnpm vitest run tests/platform/terraform.test.ts`
Expected: ECS tests FAIL (impl still emits `.default`). This confirms the tests are now asserting the new shape.

- [ ] **Step 3: Update the ECS emitter**

In `ecs/terraform.ts`, import the helper: `import { vpcDataSources } from "../../terraform/vpc-lookup";`. In all THREE variants (`awsEc2EcsResources`, `awsFargateEcsResources`, `flociEcsResources`):
- Replace the `data` block's `aws_vpc: { default: { default: true } }` + `aws_subnets: { default: { filter: {...} } }` with `...vpcDataSources(service.metadata)` (spread into the data object; keep other data entries like `aws_ssm_parameter`).
- Replace every `${data.aws_vpc.default.id}` → `${data.aws_vpc.selected.id}` and `${data.aws_subnets.default.ids}` → `${data.aws_subnets.selected.ids}`.

Grep: `grep -n "aws_vpc.default\|aws_subnets.default\|aws_vpc:\|aws_subnets:" src/services/ecs/terraform.ts` to find all sites across the 3 variants.

- [ ] **Step 4: Run, confirm PASS**

Run: `pnpm vitest run tests/platform/terraform.test.ts`
Expected: PASS (ECS tests now match the selected-lookup shape).

- [ ] **Step 5: Suite + typecheck + lint**, commit checkpoint:

```bash
git add packages/platform/src/services/ecs/terraform.ts packages/platform/tests/platform/terraform.test.ts
```
Report the diff.

---

### Task 8: Verification — byte-identical for non-ECS, generated VPC present, deploy order

**Files:** none (verification only)

- [ ] **Step 1: Regenerate both targets**

```bash
cd /Users/yu.zheng/dev/learn/nebula-stack
pnpm platform:generate -- --env dev --venture venture --target floci
pnpm platform:generate -- --env dev --venture venture --target aws
```
Expected: completes. NEW: a `network/main.tf.json` is generated under each target (`infra/services/dev/venture/core/__generated__/<target>/network/main.tf.json`).

- [ ] **Step 2: Confirm the intended diff shape**

```bash
git status --short infra/services
git diff --stat infra/services
```
Expected:
- NEW `network/main.tf.json` files (untracked) for floci and aws.
- MODIFIED `main.tf.json` ONLY for the ECS services (docs-app, payments-app) — the `data.aws_vpc.selected`/subnet change.
- UNCHANGED: lambda (payment-api), dynamodb (customer-records), apigateway (docs/payments/payment-api-ingress) `main.tf.json`. Verify with:
```bash
git diff infra/services -- '*payment-api/main.tf.json' '*customer-records/main.tf.json' '*/docs/main.tf.json' '*payments/main.tf.json' '*payment-api-ingress/main.tf.json'
```
Expected: NO output (those are byte-identical). If any non-ECS service changed, STOP — investigate.

- [ ] **Step 3: Inspect the generated VPC Terraform (security properties)**

```bash
cat infra/services/dev/venture/core/__generated__/aws/network/main.tf.json | python3 -m json.tool | grep -A3 '"route"'
```
Expected: the public route table shows a `0.0.0.0/0`→igw route; the internal route table has NO `0.0.0.0/0` route. Confirm visually.

- [ ] **Step 4: Confirm deploy order places network first**

Add/confirm a unit assertion (extend `deploy-order.test.ts`):
```ts
test("network deploys before all other service types", () => {
  const p = (t: "network" | "dynamodb" | "lambda" | "ecs" | "apigateway") =>
    serviceTypeRegistry.get(t).deployPriority;
  expect(p("network")).toBeLessThan(p("dynamodb"));
});
```
Run: `pnpm vitest run tests/platform/deploy-order.test.ts` → PASS.

- [ ] **Step 5: Full green check**

Run from repo root: `pnpm lint && pnpm --filter @repo/platform typecheck && pnpm --filter @repo/platform test`
Expected: all clean/pass.

- [ ] **Step 6: Commit (checkpoint)**

```bash
git add packages/platform/tests/platform/deploy-order.test.ts
```
Report the final diff + a summary: list which `main.tf.json` changed (ECS only), confirm non-ECS byte-identical, confirm network module generated, note the live-Floci verification is deferred to a manual redeploy.

---

### Task 9: Live Floci verification (manual, after merge-ready)

**Files:** none

- [ ] **Step 1: Confirm Floci up + apply order**

The generated network module must apply before ECS. Run a scoped deploy that includes network + an ECS service:
```bash
pnpm floci:up   # if not running
pnpm platform:deploy -- --env dev --venture venture --target floci --services network,docs-app,docs
```
Expected: network applies first (creates vpc/subnets/SGs in LocalStack), then docs-app's `data.aws_vpc.selected` lookup resolves to it, then docs gateway. NOTE: LocalStack VPC support is partial; if the by-tag `data.aws_subnets.selected` lookup returns empty in LocalStack, document it — the AWS-target generated Terraform is the source of truth for correctness, and a follow-up may need a Floci-specific fallback (out of scope for Spec A; report findings).

- [ ] **Step 2: Record findings**

If Floci applies cleanly, note it. If LocalStack can't resolve the tagged VPC/subnet lookups, record exactly where it breaks — this informs whether Spec A needs a Floci-compat shim (a known LocalStack limitation, not a design flaw). Either way, the AWS-target output is verified by Task 8.

- [ ] **Step 2 caveat:** Do NOT block Spec A completion on LocalStack VPC fidelity. Report status to the user and let them decide.

---

## Self-Review Notes

- **Spec coverage:** §Architecture (network plugin, module-first) → Tasks 1,6. §What the network module generates (vpc/subnets/routing/SG/flowlog) → Tasks 3,4,5. §Re-homing (vpc-lookup helper + ECS) → Tasks 2,7. §Deploy/reset order → Task 6 (priority -1) + Task 8 Step 4. §Validation (skip network in zone check) → Task 6 Step 4. §Testing → Tasks 3-5,7,8. §Byte-identical exception → Task 7 + Task 8 Step 2.
- **Spec correction made:** the spec said "AWS default SG egress is all-allow"; in Terraform a bare `aws_security_group` is deny-all egress, so the plan explicitly emits an allow-all egress rule per zone SG (Task 5) and documents why (isolation comes from the route table, not the SG).
- **Placeholder scan:** no TBD/TODO. Test bodies and Terraform shapes are concrete. The two implementer-choice notes (AZ flat-index vs per-zone; test accessor style vs casts) are bounded with a stated default and a consistency requirement.
- **Type consistency:** `terraformForNetwork(service, context)`, `vpcDataSources(metadata)`, `vpcNameTag(metadata)`, `networkPlugin`, `serviceType: "network"`, resource keys (`aws_vpc.network`, `aws_subnet.<zone>_<index>`, `aws_route_table.<zone>`, `aws_security_group.<zone>`) are used identically across tasks and tests.
- **oxlint:** flagged test-side casts; default to the existing `terraform.test.ts` accessor-helper style if lint complains. No new `as` in src.
- **Floci reality:** Task 9 explicitly does not block on LocalStack VPC fidelity; AWS-target generated Terraform is the correctness source (matches the spec's Floci caveat).
