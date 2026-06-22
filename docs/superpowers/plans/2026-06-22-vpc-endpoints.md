# VPC Endpoints Implementation Plan (Spec B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate real VPC endpoints — gateway (DynamoDB/S3) and interface (Lambda/Logs/STS) — derived automatically from services' `permissions.*`, emitted by the `network` plugin, attached to Spec A's subnets/route-tables/SGs, and emitted only for the `aws` target (Floci uses `AWS_ENDPOINT_URL`).

**Architecture:** A pure `deriveRequiredAwsEndpoints(services)` helper computes the set of AWS services that in-VPC code must reach (today: `dynamodb` from `lambda.permissions.dynamodb`). `generate.ts` passes that set into the network service's `TerraformContext.requiredAwsEndpoints`. The network emitter turns each required service into a gateway or interface `aws_vpc_endpoint` (classified by a static map), gateway endpoints attaching to internal route tables and interface endpoints attaching to internal subnets + a dedicated endpoint security group. All endpoint resources are `aws`-target-only.

**Tech Stack:** TypeScript (ESM, `tsx`), Zod 4, Vitest, Terraform JSON, AWS provider.

**This implements Spec B** (`docs/superpowers/specs/2026-06-22-vpc-endpoints-design.md`). Depends on Spec A (applied). Precedes Spec C.

---

## Ground Rules

- Tests/typecheck from `packages/platform/`; `pnpm lint` from repo ROOT.
- **oxlint forbids `typescript/no-unsafe-type-assertion`** in source — type guards, not `as T`. In tests, reuse the `resource()`/`data()`/`objectProperty()` accessor helpers already in `network-terraform.test.ts` and `terraform.test.ts`.
- **Do not `git commit`.** Each "Commit" step = `git add` the listed files + report the diff. User commits.
- **Target-conditional, like Spec A's flow logs / SG rules:** all `aws_vpc_endpoint` and the endpoint SG are emitted ONLY when `target === "aws"`. On `floci` they are omitted (the SDK hits `http://localhost:4566` via `AWS_ENDPOINT_URL` already). Each emitter test asserts both present-on-aws and absent-on-floci.
- **Generated files are gitignored** (`__generated__/`), so the regression guard is the unit snapshot tests, not `git diff`. To verify byte-identical, snapshot-then-regenerate-then-diff actual file contents (see Task 6).

## Scope decision (YAGNI — deviation from spec, intentional)

The spec mentions "baseline logs/sts interface endpoints for in-VPC compute." **Nothing is in-VPC until Spec C.** So this plan:
- Builds the full **interface-endpoint machinery** (emitter + endpoint SG) and unit-tests it by driving it with a `lambda` required-service in tests.
- Does NOT emit baseline `logs`/`sts` endpoints that no deployed service consumes yet (would be dead infra + cost).
- Emits the **DynamoDB gateway endpoint** for real, because `lambda.permissions.dynamodb` already exists (payment-api), making it the first genuine consumer.
- The `lambda` interface endpoint becomes real in Spec C when `ecs.permissions.lambda` is added (Spec C's derivation feeds the same helper). Until then it's machinery + tests only.

This keeps Spec B shippable and free of unconsumed resources, while leaving the interface path fully built for Spec C.

## Background: verified current state

- `src/types.ts`: `LambdaConfig.permissions.dynamodb: DynamoDbPermission[]`; `DynamoDbPermission = { service: string; actions: [...] }`. `NetworkPolicy` has `awsEndpoints: Record<string, AwsEndpoint>` where `AwsEndpoint = { type: "gateway"|"interface"; serviceName; routeTableZoneNames?; policy: "default" }`. `networkAwsServiceValues = ["dynamodb","kms","lambda","logs","s3","sts"]` in `schemas/network.schema.ts`.
- `src/terraform/context.ts`: `TerraformContext` has `target?`, `moduleDirectory?`, `serviceNames?`, `serviceContainerPorts?`, `domainCertificateArns?`.
- `src/terraform/base.ts`: `regionForTarget(target)` → `"ap-southeast-2"` (aws) / `"us-east-1"` (floci).
- `src/services/network/terraform.ts`: `terraformForNetwork(service, options)`. Resources today: `aws_vpc.network`, `aws_subnet.<zone>_<i>` (tagged `Zone`), `aws_internet_gateway.network`, `aws_route_table.<zone>`, `aws_route.public_internet` (aws-conditional via `routes`), `aws_route_table_association.<key>`, `aws_security_group.<zone>`, `aws_security_group_rule.*` (aws-only), flow logs (aws-only via `flowLogResourcesFor`). Data block: `aws_availability_zones.available`. The `return baseTerraform(m, target, { …resources… }, { aws_availability_zones })` is at ~line 149.
- `generate.ts` (lines 33-44): builds `manifest`, `serviceNames`, `serviceContainerPorts` once, then per-service `terraformForService(service, { target, moduleDirectory, serviceNames, serviceContainerPorts })`.
- `src/registry.ts`: `buildServiceManifest`, `serviceNamesFromManifest`, etc. Good home for the derivation helper, or a new `src/services/network/endpoints.ts`.
- `src/network-zones.ts`: `validateDynamoDbEndpoint` currently REQUIRES a `network.yaml awsEndpoints.dynamodb` gateway entry for any dynamodb service.

---

## File Structure (end state)

```
packages/platform/src/
  services/network/endpoints.ts        # NEW: AwsEndpointService type, endpointKind map,
                                        #      deriveRequiredAwsEndpoints(services), endpoint TF builders
  services/network/terraform.ts        # MODIFIED: emit endpoints from context.requiredAwsEndpoints (aws-only)
  terraform/context.ts                 # MODIFIED: requiredAwsEndpoints?: AwsEndpointService[]
  generate.ts                          # MODIFIED: derive + pass requiredAwsEndpoints into context
  network-zones.ts                     # MODIFIED: relax validateDynamoDbEndpoint to derivation model
packages/platform/tests/platform/
  network-endpoints.test.ts            # NEW: derivation + endpoint emitter unit tests
  network-terraform.test.ts            # MODIFIED: endpoint emission via requiredAwsEndpoints (aws vs floci)
```

---

### Task 1: Endpoint classification + derivation helper

**Files:**
- Create: `packages/platform/src/services/network/endpoints.ts`
- Create: `packages/platform/tests/platform/network-endpoints.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/platform/tests/platform/network-endpoints.test.ts
import { describe, expect, test } from "vitest";
import { deriveRequiredAwsEndpoints, endpointKind } from "../../src/services/network/endpoints";
import type { LoadedService } from "../../src/types";

const lambdaWithDynamo: LoadedService = {
  metadata: {
    env: "dev", venture: "venture", vpc: "core", securityZone: "internal",
    serviceName: "payment-api", serviceType: "lambda",
    sourcePath: "infra/services/dev/venture/core/internal/payment-api.lambda.yaml",
  },
  config: {
    runtime: "nodejs22.x", handler: "index.handler", package: "../x.zip",
    memoryMb: 128, timeoutSeconds: 10, logRetentionDays: 7, environment: {},
    permissions: { dynamodb: [{ service: "customer-records", actions: ["dynamodb:PutItem"] }] },
  },
};

const dynamoOnly: LoadedService = {
  metadata: {
    env: "dev", venture: "venture", vpc: "core", securityZone: "managed",
    serviceName: "customer-records", serviceType: "dynamodb",
    sourcePath: "infra/services/dev/venture/core/managed/customer-records.dynamodb.yaml",
  },
  config: { billingMode: "PAY_PER_REQUEST", hashKey: { name: "id", type: "S" }, pointInTimeRecovery: false },
};

describe("deriveRequiredAwsEndpoints", () => {
  test("a lambda with dynamodb permission requires the dynamodb endpoint", () => {
    expect(deriveRequiredAwsEndpoints([lambdaWithDynamo, dynamoOnly])).toEqual(["dynamodb"]);
  });

  test("no permissions → no required endpoints", () => {
    expect(deriveRequiredAwsEndpoints([dynamoOnly])).toEqual([]);
  });

  test("result is de-duplicated and stable-sorted", () => {
    const second: LoadedService = {
      ...lambdaWithDynamo,
      metadata: { ...lambdaWithDynamo.metadata, serviceName: "other-api",
        sourcePath: "infra/services/dev/venture/core/internal/other-api.lambda.yaml" },
    };
    expect(deriveRequiredAwsEndpoints([lambdaWithDynamo, second])).toEqual(["dynamodb"]);
  });
});

describe("endpointKind", () => {
  test("dynamodb and s3 are gateway; lambda/logs/sts are interface", () => {
    expect(endpointKind("dynamodb")).toBe("gateway");
    expect(endpointKind("s3")).toBe("gateway");
    expect(endpointKind("lambda")).toBe("interface");
    expect(endpointKind("logs")).toBe("interface");
    expect(endpointKind("sts")).toBe("interface");
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `cd packages/platform && pnpm vitest run tests/platform/network-endpoints.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/platform/src/services/network/endpoints.ts
import type { LoadedService } from "../../types";

export type AwsEndpointService = "dynamodb" | "s3" | "lambda" | "logs" | "sts" | "kms";

const GATEWAY_SERVICES = new Set<AwsEndpointService>(["dynamodb", "s3"]);

export function endpointKind(service: AwsEndpointService): "gateway" | "interface" {
  return GATEWAY_SERVICES.has(service) ? "gateway" : "interface";
}

export function deriveRequiredAwsEndpoints(services: LoadedService[]): AwsEndpointService[] {
  const required = new Set<AwsEndpointService>();
  for (const service of services) {
    if (service.metadata.serviceType === "lambda" && service.config.permissions.dynamodb.length > 0) {
      required.add("dynamodb");
    }
    // Spec C adds: ecs.permissions.lambda → required.add("lambda")
  }
  return [...required].sort();
}
```

- [ ] **Step 4: Run, confirm PASS (4 tests)**

Run: `pnpm vitest run tests/platform/network-endpoints.test.ts`
Expected: PASS.

- [ ] **Step 5: Suite + typecheck + lint**, then commit checkpoint:

```bash
git add packages/platform/src/services/network/endpoints.ts packages/platform/tests/platform/network-endpoints.test.ts
```
Report the diff.

---

### Task 2: Endpoint Terraform builders (gateway + interface)

**Files:**
- Modify: `packages/platform/src/services/network/endpoints.ts`
- Modify: `packages/platform/tests/platform/network-endpoints.test.ts`

Pure builders that return the resource fragments, given the required services, the consuming zone (`internal` for the demo), region, and the VPC/zone references. Keep them pure so they're unit-testable without the full emitter.

- [ ] **Step 1: Add failing tests**

```ts
import { gatewayEndpointResources, interfaceEndpointResources } from "../../src/services/network/endpoints";

describe("gatewayEndpointResources", () => {
  test("builds an aws_vpc_endpoint Gateway for dynamodb attached to the internal route table", () => {
    const res = gatewayEndpointResources(["dynamodb"], {
      region: "ap-southeast-2", zone: "internal",
    });
    expect(res.aws_vpc_endpoint.dynamodb).toEqual({
      vpc_id: "${aws_vpc.network.id}",
      service_name: "com.amazonaws.ap-southeast-2.dynamodb",
      vpc_endpoint_type: "Gateway",
      route_table_ids: ["${aws_route_table.internal.id}"],
    });
  });

  test("no gateway services → empty object", () => {
    expect(gatewayEndpointResources([], { region: "ap-southeast-2", zone: "internal" })).toEqual({});
  });
});

describe("interfaceEndpointResources", () => {
  test("builds an Interface endpoint + endpoint SG for lambda", () => {
    const res = interfaceEndpointResources(["lambda"], {
      region: "ap-southeast-2", zone: "internal",
    });
    expect(res.aws_vpc_endpoint.lambda).toEqual({
      vpc_id: "${aws_vpc.network.id}",
      service_name: "com.amazonaws.ap-southeast-2.lambda",
      vpc_endpoint_type: "Interface",
      subnet_ids: "${data.aws_subnets.internal_endpoints.ids}",
      security_group_ids: ["${aws_security_group.endpoints.id}"],
      private_dns_enabled: true,
    });
    expect(res.aws_security_group.endpoints).toMatchObject({
      vpc_id: "${aws_vpc.network.id}",
    });
    expect(res.aws_security_group_rule.endpoints_ingress_443).toMatchObject({
      type: "ingress", from_port: 443, to_port: 443, protocol: "tcp",
      security_group_id: "${aws_security_group.endpoints.id}",
      source_security_group_id: "${aws_security_group.internal.id}",
    });
    expect(res.data.aws_subnets.internal_endpoints).toEqual({
      filter: [
        { name: "vpc-id", values: ["${aws_vpc.network.id}"] },
        { name: "tag:Zone", values: ["internal"] },
      ],
    });
  });

  test("no interface services → empty object", () => {
    expect(interfaceEndpointResources([], { region: "ap-southeast-2", zone: "internal" })).toEqual({});
  });
});
```

> NOTE on subnet reference: interface endpoints need subnet IDs. Within the network module the subnets are created as `aws_subnet.internal_0` etc., so endpoints could reference those directly. But to keep the builder zone-generic and avoid enumerating subnet keys, use a `data.aws_subnets.internal_endpoints` lookup by `tag:Zone` (the subnets are tagged `Zone` by Spec A). The builder returns a `data` fragment the emitter merges into the module's data block. Alternative (simpler, also fine): reference the concrete `aws_subnet.<zone>_<i>.id` list the emitter already has — if you prefer that, pass the subnet resource keys into the builder and drop the `data` fragment. Pick one; the test above assumes the `data.aws_subnets` lookup. If you switch to concrete subnet refs, update the test to assert `subnet_ids: ["${aws_subnet.internal_0.id}", ...]`.

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement the builders**

```ts
type EndpointContext = { region: string; zone: string };

export function gatewayEndpointResources(
  services: AwsEndpointService[],
  ctx: EndpointContext,
): Record<string, Record<string, unknown>> {
  const gateways = services.filter((s) => endpointKind(s) === "gateway");
  if (gateways.length === 0) {
    return {};
  }
  const endpoints: Record<string, unknown> = {};
  for (const service of gateways) {
    endpoints[service] = {
      vpc_id: "${aws_vpc.network.id}",
      service_name: `com.amazonaws.${ctx.region}.${service}`,
      vpc_endpoint_type: "Gateway",
      route_table_ids: [`\${aws_route_table.${ctx.zone}.id}`],
    };
  }
  return { aws_vpc_endpoint: endpoints };
}

export function interfaceEndpointResources(
  services: AwsEndpointService[],
  ctx: EndpointContext,
): Record<string, Record<string, unknown>> {
  const interfaces = services.filter((s) => endpointKind(s) === "interface");
  if (interfaces.length === 0) {
    return {};
  }
  const endpoints: Record<string, unknown> = {};
  for (const service of interfaces) {
    endpoints[service] = {
      vpc_id: "${aws_vpc.network.id}",
      service_name: `com.amazonaws.${ctx.region}.${service}`,
      vpc_endpoint_type: "Interface",
      subnet_ids: `\${data.aws_subnets.${ctx.zone}_endpoints.ids}`,
      security_group_ids: ["${aws_security_group.endpoints.id}"],
      private_dns_enabled: true,
    };
  }
  return {
    aws_vpc_endpoint: endpoints,
    aws_security_group: {
      endpoints: {
        name: "${aws_vpc.network.id}-endpoints-sg-placeholder",
        vpc_id: "${aws_vpc.network.id}",
      },
    },
    aws_security_group_rule: {
      endpoints_ingress_443: {
        type: "ingress", from_port: 443, to_port: 443, protocol: "tcp",
        security_group_id: "${aws_security_group.endpoints.id}",
        source_security_group_id: `\${aws_security_group.${ctx.zone}.id}`,
      },
    },
    data: {
      aws_subnets: {
        [`${ctx.zone}_endpoints`]: {
          filter: [
            { name: "vpc-id", values: ["${aws_vpc.network.id}"] },
            { name: "tag:Zone", values: [ctx.zone] },
          ],
        },
      },
    },
  };
}
```

> The endpoint SG `name` must be a real physical name, not a placeholder — the builder lacks metadata. EITHER pass the name prefix into `EndpointContext` (e.g. `ctx.namePrefix = "dev-venture-core"` → `name: "${namePrefix}-endpoints-sg"`) and update the test, OR have the emitter (Task 3) override the SG name after calling the builder. Prefer passing `namePrefix` into `EndpointContext`; update the interface test to assert `name: "dev-venture-core-endpoints-sg"`. Remove the placeholder.

- [ ] **Step 4: Run, confirm PASS**

- [ ] **Step 5: Suite + typecheck + lint**, commit checkpoint:

```bash
git add packages/platform/src/services/network/endpoints.ts packages/platform/tests/platform/network-endpoints.test.ts
```
Report the diff.

---

### Task 3: Thread `requiredAwsEndpoints` through `TerraformContext`

**Files:**
- Modify: `packages/platform/src/terraform/context.ts`

- [ ] **Step 1: Add the field**

```ts
import type { AwsEndpointService } from "../services/network/endpoints";

export type TerraformContext = {
  target?: DeployTarget;
  moduleDirectory?: string;
  serviceNames?: Record<string, string>;
  serviceContainerPorts?: Record<string, number>;
  domainCertificateArns?: Record<string, string>;
  requiredAwsEndpoints?: AwsEndpointService[];
};
```

> Verify this import doesn't create a cycle: `context.ts` would import from `services/network/endpoints.ts`, which imports `types.ts` only — no cycle (endpoints.ts does not import context). Confirm `pnpm typecheck` is clean.

- [ ] **Step 2: Typecheck + lint + full suite** (no behavior change). Commit checkpoint:

```bash
git add packages/platform/src/terraform/context.ts
```
Report the diff.

---

### Task 4: Emit endpoints from the network emitter (aws-target only)

**Files:**
- Modify: `packages/platform/src/services/network/terraform.ts`
- Modify: `packages/platform/tests/platform/network-terraform.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
describe("terraformForNetwork – vpc endpoints", () => {
  const ctxAws = { target: "aws" as const, requiredAwsEndpoints: ["dynamodb" as const] };

  test("emits a dynamodb gateway endpoint on aws when required", () => {
    const tf = terraformResult(terraformForNetwork(svc, ctxAws));
    const ep = resource(tf, "aws_vpc_endpoint", "dynamodb");
    expect(ep["vpc_endpoint_type"]).toBe("Gateway");
    expect(ep["service_name"]).toBe("com.amazonaws.us-east-1.dynamodb"); // floci region? NO — see note
  });

  test("emits NO endpoints when none required", () => {
    const tf = terraformResult(terraformForNetwork(svc, { target: "aws", requiredAwsEndpoints: [] }));
    expect(tf.resource["aws_vpc_endpoint"]).toBeUndefined();
  });

  test("omits endpoints entirely on the floci target even if required", () => {
    const tf = terraformResult(
      terraformForNetwork(svc, { target: "floci", requiredAwsEndpoints: ["dynamodb"] }),
    );
    expect(tf.resource["aws_vpc_endpoint"]).toBeUndefined();
  });
});
```

> REGION NOTE: `regionForTarget("aws")` = `ap-southeast-2`. The test fixture `svc` is built with no target in some describes; here we pass `target: "aws"`, so the region in `service_name` must be `ap-southeast-2`. Fix the assertion to `com.amazonaws.ap-southeast-2.dynamodb`. (The stray `us-east-1` above is wrong — use ap-southeast-2 for the aws target.) Derive region in the emitter via `regionForTarget(target)`.

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement in `terraform.ts`**

Import the builders + region helper:
```ts
import { gatewayEndpointResources, interfaceEndpointResources } from "./endpoints";
import { regionForTarget } from "../../terraform/base";
```
After computing `resolvedTarget` and before the `return baseTerraform(...)`, build endpoint resources ONLY for aws:
```ts
const requiredEndpoints = options.requiredAwsEndpoints ?? [];
const namePrefix = `${m.env}-${m.venture}-${m.vpc}`;
const endpointZone = "internal"; // demo consuming zone; see note
const endpointResources =
  resolvedTarget === "aws" && requiredEndpoints.length > 0
    ? mergeEndpointResources(
        gatewayEndpointResources(requiredEndpoints, { region: regionForTarget(resolvedTarget), zone: endpointZone, namePrefix }),
        interfaceEndpointResources(requiredEndpoints, { region: regionForTarget(resolvedTarget), zone: endpointZone, namePrefix }),
      )
    : { resources: {}, data: {} };
```
Where `mergeEndpointResources` separates the `data` fragment (interface endpoints contribute a `data.aws_subnets.<zone>_endpoints`) from resource fragments, since `baseTerraform(metadata, target, resources, data)` takes them as separate args. Merge `endpointResources.resources` into the main resource object (spread) and `endpointResources.data` into the data object alongside `aws_availability_zones`.

> `endpointZone = "internal"` hardcodes the demo's consuming zone. A cleaner generalization (which zone(s) actually have endpoint-consuming services) is possible but YAGNI for now — internal is the only private zone. Leave a comment. If you want it derived, pass the zone(s) from `generate.ts` based on which zones contain permission-declaring services; not required for Spec B.

Add the `mergeEndpointResources` helper in `endpoints.ts` (and a unit test) OR inline it in the emitter — inline is fine; if inlined, no extra export. Ensure the endpoint SG `name` uses `namePrefix` (Task 2 note), so the interface builder needs `namePrefix` in its `EndpointContext`.

- [ ] **Step 4: Run, confirm PASS**

- [ ] **Step 5: Suite + typecheck + lint**, commit checkpoint:

```bash
git add packages/platform/src/services/network/terraform.ts packages/platform/tests/platform/network-terraform.test.ts
```
Report the diff.

---

### Task 5: Derive + pass `requiredAwsEndpoints` in `generate.ts`; relax dynamodb validation

**Files:**
- Modify: `packages/platform/src/generate.ts`
- Modify: `packages/platform/src/network-zones.ts`

- [ ] **Step 1: Wire derivation into generate.ts**

Add import: `import { deriveRequiredAwsEndpoints } from "./services/network/endpoints";`. After `const scopedServices = …` / manifest build, compute once:
```ts
const requiredAwsEndpoints = deriveRequiredAwsEndpoints(scopedServices);
```
Pass it into the per-service context (it's only consumed by the network emitter; others ignore it):
```ts
terraformForService(service, { target, moduleDirectory: outputDirectory, serviceNames, serviceContainerPorts, requiredAwsEndpoints })
```

- [ ] **Step 2: Relax `validateDynamoDbEndpoint`**

Currently it throws unless `network.yaml` has an explicit `awsEndpoints.dynamodb` gateway entry. With derivation, the endpoint is auto-created, so the hand-written entry is no longer required. Change `validateDynamoDbEndpoint` (in `network-zones.ts`) so it NO LONGER requires the `awsEndpoints.dynamodb` block — derivation guarantees it. Keep any check that the consuming zone exists. Simplest correct change: remove the `validateDynamoDbEndpoint` call/throw for the "endpoint must be declared" condition; if the function becomes empty, delete it and its call sites.

> Read the current `network-zones.ts` carefully: `validateServiceNetworkZones` calls `validateDynamoDbEndpoint` in two places (when a dynamodb service's zone is `managed`, and generally for dynamodb services). Removing the requirement means those calls can be dropped. Confirm the existing `validate.test.ts` / `network-zones.test.ts` expectations — if a test asserts the OLD "awsEndpoints.dynamodb is required" error, update it to reflect that derivation now provides the endpoint (the error no longer fires). Grep: `grep -rn "awsEndpoints.dynamodb\|validateDynamoDbEndpoint\|requires awsEndpoints" packages/platform/{src,tests}`.

- [ ] **Step 3: Typecheck + lint + full suite**

Run: `pnpm test && pnpm typecheck`; repo-root `pnpm lint`.
Expected: green. Update any test asserting the removed validation error.

- [ ] **Step 4: Commit checkpoint**

```bash
git add packages/platform/src/generate.ts packages/platform/src/network-zones.ts
```
(Plus any updated validation test.) Report the diff.

---

### Task 6: Verification

**Files:** none (verification only)

- [ ] **Step 1: Generate both targets**

```bash
cd /Users/yu.zheng/dev/learn/nebula-stack
pnpm platform:generate -- --env dev --venture venture --target aws
pnpm platform:generate -- --env dev --venture venture --target floci
```

- [ ] **Step 2: Inspect the aws network module has the dynamodb gateway endpoint**

```bash
python3 -c "
import json
d=json.load(open('infra/services/dev/venture/core/__generated__/aws/network/main.tf.json'))
eps=d['resource'].get('aws_vpc_endpoint',{})
print('aws endpoints:', list(eps.keys()))
print('dynamodb type:', eps.get('dynamodb',{}).get('vpc_endpoint_type'))
print('dynamodb service:', eps.get('dynamodb',{}).get('service_name'))
"
```
Expected: `['dynamodb']`, `Gateway`, `com.amazonaws.ap-southeast-2.dynamodb`.

- [ ] **Step 3: Confirm floci network module has NO endpoints**

```bash
python3 -c "
import json
d=json.load(open('infra/services/dev/venture/core/__generated__/floci/network/main.tf.json'))
print('floci has aws_vpc_endpoint:', 'aws_vpc_endpoint' in d['resource'])
"
```
Expected: `False`.

- [ ] **Step 4: Byte-identical for non-network services**

Snapshot the 5 non-network aws `main.tf.json` (customer-records, payment-api, payment-api-ingress, docs, payments), regenerate, diff actual contents (generated files are gitignored so `git diff` won't show them — diff real files, as in Spec A Task 8). Expected: unchanged. Only the `network/main.tf.json` changes (gains the endpoint).

- [ ] **Step 5: Full green**

Run from repo root: `pnpm lint && pnpm --filter @repo/platform typecheck && pnpm --filter @repo/platform test`
Expected: clean/pass.

- [ ] **Step 6: Live Floci check (non-blocking on endpoint fidelity)**

```bash
pnpm platform:deploy -- --env dev --venture venture --target floci --services network
```
Expected: applies cleanly (endpoints omitted on floci, so no new failure vs Spec A). Then confirm docs/payments URLs still 200 (they don't depend on endpoints). If the network module applies and URLs are 200, Spec B is verified locally. Real-AWS endpoint correctness is by generated-Terraform inspection (Step 2). Report findings; do NOT block on Floci endpoint support.

- [ ] **Step 7: Commit checkpoint** — `git add packages/platform/` ; report final summary.

---

## Self-Review Notes

- **Spec coverage:** Spec B §Goals 1-2 (real endpoints, derived from permissions) → Tasks 1,2,4,5. §3 (interface attach to subnets + SG) → Task 2,4. §4 (endpoints in network module) → Task 4. §5 (awsEndpoints as optional override) → PARTIAL: this plan derives but does NOT yet merge `network.yaml awsEndpoints` explicit entries (B2). That merge is deferred — noted below as a gap, acceptable because nothing currently uses explicit `awsEndpoints` and the demo is fully covered by derivation. Add a follow-up task if explicit overrides are needed.
- **Intentional scope cut (YAGNI):** baseline logs/sts endpoints NOT emitted (nothing in-VPC consumes them until Spec C). Interface-endpoint machinery is built + unit-tested via the `lambda`/`interface` path; it goes live in Spec C.
- **Spec §5 gap (explicit awsEndpoints merge):** not implemented; derivation-only. Documented. Future task if needed.
- **Target-conditional:** endpoints aws-only, mirroring Spec A flow-logs/SG-rules; every emitter test asserts aws-present + floci-absent.
- **Placeholders:** none. Two implementer-choice notes (subnet-ref style; endpoint SG name via namePrefix) are bounded with a stated default + test-consistency requirement, and the region-in-test correction is called out explicitly.
- **Type consistency:** `AwsEndpointService`, `endpointKind`, `deriveRequiredAwsEndpoints`, `gatewayEndpointResources`, `interfaceEndpointResources`, `requiredAwsEndpoints` used identically across tasks.
- **Cycle check:** `context.ts` → `endpoints.ts` → `types.ts` only; no cycle. Verified in Task 3.
- **Byte-identical caveat:** generated files gitignored; verified by snapshot-diff of real files (Task 6 Step 4), like Spec A.
```
