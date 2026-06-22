# Real VPC from network.yaml — Design (Spec A)

**Date:** 2026-06-22
**Status:** Approved (pending spec review)

## Context

This is **Spec A**, the foundational piece of a three-part architecture change driven by a banking-grade security requirement: the internal payment-api Lambda should be reachable privately from inside the VPC (no public internet, no API Gateway in front), with API Gateway reserved for genuinely public/third-party access.

The full decomposition:

- **Spec A (this doc): Real VPC from `network.yaml`** — generate the VPC, subnets, route tables, security groups, and flow logs that `network.yaml` already describes but never built. Re-home existing services off the AWS default VPC.
- **Spec B: VPC endpoints** — interface (lambda, logs, sts, …) and gateway (dynamodb, s3) endpoints, auto-derived from `permissions.*`, attached to Spec A's subnets.
- **Spec C: Direct Lambda invoke** — `permissions.lambda` on ECS (IAM + function-name env), payment-api accepts direct SDK invoke, payments app calls it server-side via SDK `Invoke` (eliminating the cross-origin `PAYMENT_API_BASE_URL` / `force-dynamic` workaround), remove `payment-api-ingress`, keep API Gateway as the optional public path.

Specs B and C depend on A: interface VPC endpoints and Lambda VPC config need real subnets and security groups to attach to.

## Problem

`network.yaml` is **validation-only today**. It declares a `10.20.0.0/16` VPC with `public`/`internal` zones, subnets, `flows`, and `awsEndpoints`, but:

- `service-discovery.ts` explicitly skips `network.yaml`; it emits **zero Terraform**.
- Every service module hard-codes `data.aws_vpc.default` + `data.aws_subnets.default` — i.e. everything runs in the **AWS default VPC**, whose subnets are all public (internet gateway, default route to `0.0.0.0/0`).
- `flows` and `awsEndpoints` describe intentions that are never enforced or built.

For a bank this is disqualifying: no network segmentation, no private subnets, no controlled egress, default-VPC usage (an audit red flag), and no way to give an internal service a subnet with no internet route. The "private fiber" property the broader goal wants only holds in a properly-segmented private subnet reaching AWS via VPC endpoints.

## Goals

1. Generate a real VPC from `network.yaml`: `aws_vpc`, per-zone subnets across AZs, route tables (public has IGW route; **internal has no default route**), per-zone security groups derived from `flows`, and VPC flow logs.
2. Make `network.yaml` a discoverable, generated module applied **first**.
3. Re-home existing services (ECS) off `data.aws_vpc.default` onto the generated VPC, selecting subnets by the service's own `securityZone`.
4. Reference the VPC from other modules via **by-tag data sources** — consistent with the existing `data.aws_lb.<name>` cross-module pattern; no remote state.

## Non-Goals

- **NAT gateway / outbound internet from internal subnets.** Internal services reach AWS via VPC endpoints (Spec B), not the internet. Excluded now (YAGNI + cost); add a NAT gateway only if an internal service later needs general outbound internet.
- **VPC endpoints themselves** — Spec B. (Spec A sets `enable_dns_support`/`enable_dns_hostnames` so B can add interface endpoints.)
- **The Lambda-invoke change and API Gateway removal** — Spec C.
- **Multi-VPC / VPC peering / Transit Gateway** — out of scope; one VPC per `<env>/<venture>/<vpc>`.
- **Terraform remote-state composition** — rejected in favor of by-tag data sources.

## Guiding Principles (from brainstorming)

- **Configuration stays in `network.yaml`** — no new config file or schema; generate Terraform from the existing document.
- **By-tag data-source references** between modules — matches the repo's existing pattern, no new state mechanism.
- **Bank-grade defaults:** internal = no internet route; segmentation enforced via SGs from `flows`; flow logs on for audit.
- **Follow the Plan-1 plugin pattern** — `network` becomes a service-type plugin.

---

## Architecture

### Module model

`network.yaml` compiles to its own Terraform module at:

```
infra/services/<env>/<venture>/<vpc>/__generated__/<target>/network/main.tf.json
```

It is applied **first** (lowest deploy priority) and torn down **last**. Every other service module replaces the default-VPC data sources with by-tag lookups of this module's VPC and subnets.

This mirrors the existing cross-module reference style: API Gateway already finds an ECS service's load balancer via `data.aws_lb.<name>` (a by-name lookup against separately-applied infrastructure). The VPC is found the same way — by a predictable tag.

### The `network` service-type plugin

Following the Plan-1 composable-plugin pattern (`src/services/<type>/`), add a `network` plugin:

- `type: "network"`, `fileSuffix: "network"` (the file is literally `network.yaml`; discovery handles its distinct location — see below).
- `schema: networkPolicySchema` (existing, unchanged).
- `jsonSchemaMetadata`: the existing `network.schema.json`.
- `deployPriority`: lowest, so it applies before dynamodb/lambda/ecs/apigateway. (Current priorities: dynamodb=0, lambda=1, ecs=2, apigateway=3. Network becomes `-1`, or all shift +1 and network=0 — implementer picks the cleaner of the two; the registry-driven `compareDeployOrder` then orders it first automatically.)
- `toTerraform`: the new VPC emitter (below).
- No `validateReferences` (network references nothing).

### Discovery change

`network.yaml` lives at `<env>/<venture>/<vpc>/network.yaml` — a **4-segment** path — whereas services are `<env>/<venture>/<vpc>/<zone>/<name>.<type>.yaml` (5-segment). `service-discovery.ts` currently:
- `listYamlFiles` **excludes** `network.yaml`.
- `parseServicePath` requires 5 path segments.

Change: `listYamlFiles` includes `network.yaml`; `parseServicePath` recognizes the 4-segment `network.yaml` shape and produces metadata `{ env, venture, vpc, securityZone: "<none>"/"network", serviceName: "network", serviceType: "network", sourcePath }`. The exact sentinel for the (absent) security zone is an implementation detail; it must not collide with a real zone and must route through the `network` plugin. Generated dir uses `serviceName: "network"`.

---

## What the network module generates

From `network.yaml` (`cidrs`, `zones`, `flows`, `awsEndpoints`):

### VPC
- `aws_vpc` with `cidr_block = cidrs.ipv4.vpc`, `enable_dns_support = true`, `enable_dns_hostnames = true` (required for interface endpoints in Spec B).
- Tagged `Name = <env>-<venture>-<vpc>-vpc` (e.g. `dev-venture-core-vpc`) plus standard `tagsFor` tags. This `Name` tag is the contract other modules filter on.

### Subnets
- One `aws_subnet` per CIDR listed in each zone's `subnets[]`.
- Spread across AZs via `data.aws_availability_zones.available` (index modulo AZ count).
- Tags: `Zone = <zoneName>`, `Name = <env>-<venture>-<vpc>-<zone>-<index>`, plus standard tags. The `Zone` tag is the contract for per-zone subnet lookup.
- `map_public_ip_on_launch = true` for `public`-zone subnets; `false` otherwise.

### Routing
- `aws_internet_gateway` attached to the VPC (used only by the public route table).
- Public route table: route `0.0.0.0/0` → IGW; associated with all `public`-zone subnets.
- **Internal route table: NO `0.0.0.0/0` route** (local routes only); associated with all `internal`-zone subnets. This is the core isolation property — internal services have no internet path.
- Generalization: any zone named `public` gets the IGW route; all other zones get an internet-less route table. (If the model later needs per-zone egress nuance, that's a future change; for now `public` vs not is the rule and matches `network.yaml`.)

### Security groups (from `flows`)
- One `aws_security_group` per zone (e.g. `dev-venture-core-public-sg`, `dev-venture-core-internal-sg`).
- For each `flow` with `ports`, emit an ingress rule on the `to` zone's SG allowing those ports **from the `from` zone's SG** (source = security-group id, not CIDR). Example: `public→internal ports [443]` → internal SG ingress 443 from public SG.
- Flows with `services` (AWS-service flows like `internal→aws [dynamodb, logs]`) are **not** SG rules — they inform Spec B's endpoints. Spec A ignores `services` flows for SG generation (documented, not silently).
- Egress: default-deny is not imposed in Spec A beyond what AWS defaults give; SGs start with no egress rule added by us (AWS default SG egress is all-allow, but internal subnets have no internet route, so egress is constrained at the routing layer). Tightening SG egress is a possible future hardening; not in scope now.

### Flow logs
- `aws_flow_log` capturing all traffic to a dedicated `aws_cloudwatch_log_group` (e.g. `/vpc/<env>-<venture>-<vpc>/flow-logs`), with the IAM role the flow log needs. For audit/compliance.

---

## Re-homing existing services

### Shared VPC data-source helper
New helper in `src/terraform/` (e.g. `vpc-lookup.ts`) exporting something like `vpcDataSources(metadata)` that returns the `data` block:

- `data.aws_vpc.selected` filtered by tag `Name = <env>-<venture>-<vpc>-vpc`.
- `data.aws_subnets.selected` filtered by tags `vpc-id = <that vpc>` AND `Zone = <metadata.securityZone>`.

A service deploys into **its own zone's** subnets: `securityZone` (already in metadata, derived from the file path) selects the zone. So `docs-app`/`payments-app` (public) land in public subnets; an `internal` service lands in internal subnets.

### ECS emitter
All three ECS variants (`awsEc2EcsResources`, `awsFargateEcsResources`, `flociEcsResources`) replace `data.aws_vpc.default` / `data.aws_subnets.default` with the helper's tagged lookups. The ECS-created security group stays but lives in the looked-up VPC. References to `data.aws_vpc.default.id` / `data.aws_subnets.default.ids` become `data.aws_vpc.selected.id` / `data.aws_subnets.selected.ids`.

### Behavior-preservation exception (important)
This is the **one place Spec A intentionally breaks byte-identical Terraform output.** Swapping the default-VPC data sources for tagged lookups changes every ECS service's `main.tf.json`. This is the whole point of the spec. Consequently:
- The `terraform.test.ts` snapshot assertions referencing `data.aws_vpc.default` **will be updated** to the tagged-lookup shape.
- All OTHER generated output (lambda, dynamodb, apigateway) stays byte-identical — only the VPC/subnet data sources in ECS change.

---

## Deploy / reset / validation flow

- **Deploy order:** the `network` plugin's lowest `deployPriority` makes `compareDeployOrder` (already registry-driven) apply network first. No change to `deploy.ts` logic beyond the plugin priority.
- **Reset order:** network is destroyed **last** — after every module that looks it up — to avoid dependent data-source lookups failing mid-teardown. The reset flow (today shell, Plan 5 the TS CLI) reverses deploy order; document that network is the final teardown step.
- **Validation:** `validateServiceNetworkZones` stays (service zone must exist in `network.yaml`). New check: the service's `securityZone` zone must declare at least one subnet (so the by-tag subnet lookup resolves at apply). Missing/empty zone → fail at generate time with a clear message. The existing dynamodb-endpoint validation is untouched (Spec B revisits it).

## Error handling

- Network YAML invalid → existing `networkPolicySchema` parse error (now surfaced via the plugin path).
- Service in a zone with no subnets → generate-time error naming the service and zone.
- Service in an undeclared zone → existing `validateServiceNetworkZones` error.

## Testing

### Unit — new network emitter (`network` plugin)
Assert from a fixture `network.yaml`:
- `aws_vpc`: cidr `10.20.0.0/16`, `enable_dns_support`/`enable_dns_hostnames` true, `Name` tag `dev-venture-core-vpc`.
- subnets: correct count per zone, each tagged with its `Zone` and a `Name`; public subnets `map_public_ip_on_launch=true`, internal `false`.
- `aws_internet_gateway` present; public route table has `0.0.0.0/0`→IGW; **internal route table has no `0.0.0.0/0` route**.
- SG rules: `public→internal [443]` produces an internal-SG ingress on 443 sourced from the public SG; `services` flows produce no SG rule.
- `aws_flow_log` + its log group + role present.

### Unit — updated ECS snapshot tests
Update the `data.aws_vpc.default` assertions to the tagged-lookup shape; confirm all three variants reference `data.aws_vpc.selected` / `data.aws_subnets.selected`.

### Discovery
`network.yaml` is discovered and schema-validated as a `network`-type service; deploy ordering places it first.

### Live verification (Floci)
Generate both targets; apply the network module then a dependent service; confirm clean apply and a working redeploy. NOTE: LocalStack does not meaningfully enforce route tables / SG isolation, so the **security properties (no internet route, SG segmentation) are verified by inspecting generated Terraform**, not by Floci behavior. Floci verifies that the by-tag lookups resolve and modules apply in order.

## Migration / Sequencing within Spec A

1. Add the `network` service-type plugin (schema reuse) + discovery changes (include `network.yaml`, 4-segment path parsing). No emitter yet → returns minimal/empty; tests for discovery.
2. Implement the VPC emitter (vpc, subnets, routing, SGs, flow logs) with unit tests.
3. Add the shared `vpc-lookup.ts` helper + unit test.
4. Re-home the ECS emitter (3 variants) onto the helper; update ECS snapshot tests.
5. Set deploy priority (network first); update reset ordering notes; validation for zone-has-subnets.
6. Live verify on Floci (generate + apply order + redeploy).

Each step is independently testable. Steps 1–3 are additive; step 4 is the intentional non-byte-identical change guarded by updated unit tests.

## Dependencies for later specs

- Spec B attaches interface/gateway endpoints to the subnets and SGs created here, keyed off the same `Zone`/`Name` tags, and consumes `services` flows (which Spec A deliberately leaves unenforced at the SG layer).
- Spec C puts the Lambda in VPC config (or relies on the Lambda interface endpoint from B) using these subnets, and has the in-VPC payments ECS task invoke it via SDK.
