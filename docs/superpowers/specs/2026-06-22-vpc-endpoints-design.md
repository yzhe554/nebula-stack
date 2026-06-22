# VPC Endpoints — Design (Spec B)

**Date:** 2026-06-22
**Status:** Implemented (core). Depends on Spec A (Real VPC).

## Decision (2026-06-22): zone egress model — interface endpoints over NAT

Confirmed with the user. Driven by **security and performance** (cost explicitly deprioritized):

| Zone | AWS API access | Internet egress |
|---|---|---|
| **restricted** | gateway endpoints (DynamoDB/S3) only | none |
| **internal** | gateway + **interface endpoints** (PrivateLink, private) | none (no NAT) |
| **public** | gateway + interface | NAT / IGW |

- **Interface endpoints, not NAT, for internal→AWS-API traffic.** PrivateLink keeps traffic on the AWS backbone (never public internet) and is a direct in-VPC ENI hop (lower/more consistent latency, no NAT bottleneck). NAT's only edge was cost/simplicity, which the user deprioritized.
- **Gateway endpoints (DynamoDB/S3) are always auto-derived** regardless of zone — free and private.
- **NAT is deprioritized** to a rarely-used escape hatch (Spec C's "conditional NAT") for a zone that genuinely needs general outbound internet. `internal` stays internet-less and reaches AWS privately via endpoints.
- **Interface endpoints are also the mechanism for cross-VPC sharing** if that need arises later, but the primary driver here is private AWS-API access from internet-less subnets.

This validates the implemented design: the interface-endpoint machinery (built in this spec) is triggered by auto-derivation; in Spec C `ecs.permissions.lambda` adds `lambda` to the required set, lighting up the Lambda interface endpoint for the ECS→Lambda private invoke.

### Validation relaxation: DEFERRED (follow-up)

The spec's "relax `validateDynamoDbEndpoint`" item is **deferred**. That validation is load-bearing — it doubles as the `managed`-zone escape hatch in `validateServiceNetworkZones`, and there's a parallel `superRefine` in `network.schema.ts` plus two tests. It is NOT required for Spec B to function: the real `network.yaml` declares `awsEndpoints.dynamodb`, so existing validation passes AND derivation generates the endpoint — they coexist harmlessly (redundant hand-declaration). Revisit once the restricted/internal/public zone model above is implemented, so validation is rewritten against the final zone semantics rather than twice.

## Context

Second of three specs driven by the banking-grade requirement that internal services reach AWS privately, never via the public internet:

- **Spec A (done): Real VPC from `network.yaml`** — generates VPC, per-zone subnets, route tables (internal = no internet route), per-zone security groups, flow logs. ECS re-homed onto it via by-tag `data.aws_vpc.selected` / `data.aws_subnets.selected` lookups.
- **Spec B (this doc): VPC endpoints** — interface (lambda, logs, sts, …) and gateway (dynamodb, s3) endpoints, auto-derived from service `permissions.*`, attached to Spec A's subnets and security groups.
- **Spec C: in-VPC Lambda + direct invoke** — Lambda always in VPC, payments invokes it server-side via SDK through the Lambda interface endpoint from Spec B, conditional NAT + conditional public API Gateway.

Spec B is the bridge: once Spec C puts the Lambda in the internal zone (no internet route), the Lambda can only reach DynamoDB and the payments task can only invoke the Lambda if the corresponding VPC endpoints exist.

## Problem

Internal-zone subnets (Spec A) have **no `0.0.0.0/0` route** — by design. So any AWS API call from an internal service (Lambda → DynamoDB, ECS → Lambda `InvokeFunction`, anything → CloudWatch Logs / STS) has no network path unless a **VPC endpoint** exists in the VPC:

- **Gateway endpoints** (DynamoDB, S3): free, route-table entries; traffic to the service's prefix list routes privately.
- **Interface endpoints** (Lambda, Logs, STS, most others): AWS PrivateLink ENIs in the subnets + a security group; the SDK resolves the service's DNS to the private ENI.

Today `network.yaml` has an `awsEndpoints` block, but it is **validation-only** — no `aws_vpc_endpoint` Terraform is generated anywhere (confirmed in Spec A exploration). And there is no link between "this service needs to call DynamoDB/Lambda" and "an endpoint exists for it." The decision in brainstorming was **option 1: auto-derive endpoints from `permissions.*`** and build real endpoint Terraform for both interface and gateway types.

## Goals

1. Generate real `aws_vpc_endpoint` Terraform — gateway type for DynamoDB/S3, interface type for Lambda/Logs/STS/etc.
2. **Auto-derive** which endpoints to create from services' `permissions.*` declarations (the existing `lambda.permissions.dynamodb`, and the new `ecs.permissions.lambda` from Spec C), rather than hand-declaring them in `network.yaml`.
3. Attach interface endpoints to the correct zone's subnets + a dedicated endpoint security group (so internal services can reach them).
4. Make endpoints part of the `network` module (they are VPC-scoped, singular, shared infra — same module that owns the VPC).
5. Keep `network.yaml`'s `awsEndpoints` as an **optional override / explicit declaration** path, but the default is derivation.

## Non-Goals

- The actual `permissions.lambda` field and Lambda-in-VPC config — that's Spec C. Spec B builds the *endpoint* machinery and wires DynamoDB (whose `permissions.dynamodb` already exists) as the first real consumer; the Lambda interface endpoint is built here but its consumer (`ecs.permissions.lambda`) lands in Spec C.
- NAT gateway — Spec C, conditional.
- Removing API Gateway — Spec C.
- Endpoint policies beyond `"default"` (least-privilege endpoint policies are a future hardening).

## Guiding principles (from brainstorming)

- **Auto-derive from `permissions.*`** (option 1), build real endpoint Terraform.
- Endpoints live in the **`network` module** (VPC-scoped shared infra).
- **Floci caveat:** Floci may not support `aws_vpc_endpoint` creation (as it didn't support flow logs / source-SG rules in Spec A). Endpoints are likely **aws-target-only**, following the `flociEndpointUrl` / flow-log precedent — the SDK on Floci already hits `http://localhost:4566` directly via `AWS_ENDPOINT_URL`, so no real endpoint is needed locally. Confirm during implementation; the AWS-target generated Terraform is the correctness source.
- Reuse Spec A patterns: by-tag references, the `network` plugin, target-conditional emission.

---

## Architecture

### Where endpoints are generated

Endpoints are emitted by the **`network` plugin** (`src/services/network/terraform.ts`), because they are VPC-scoped singletons that belong with the VPC/subnets/SGs. But *which* endpoints to emit is **derived from the full set of discovered services' permissions**, which the network emitter does not currently see.

This requires a new input to the network emitter: the **set of AWS services that in-VPC services need to reach**, computed from the manifest. Two design options for plumbing this:

**B1 (recommended): pass a derived `requiredAwsEndpoints` set into the network emitter via `TerraformContext`.**
- A new helper (e.g. in `registry.ts` or a new `endpoints.ts`) scans all discovered services and produces the set of required AWS services: `lambda.permissions.dynamodb` → `dynamodb`; `ecs.permissions.lambda` (Spec C) → `lambda`; plus always-on baseline (`logs`, `sts`) for any in-VPC compute.
- `generate.ts` computes this set once and passes it to the network service's `terraformForService` via `TerraformContext.requiredAwsEndpoints`.
- The network emitter creates one endpoint per required AWS service, choosing gateway vs interface by a static map (`dynamodb`/`s3` = gateway; everything else = interface).

**B2: union of `network.yaml awsEndpoints` (explicit) + derived.** Same as B1 but `network.yaml awsEndpoints` entries are merged in as explicit additions/overrides. Keep `awsEndpoints` meaningful rather than dead.

Recommendation: **B1 for derivation + keep B2's merge** so `awsEndpoints` becomes "explicit additions on top of derived," not dead config. The endpoint *type* (gateway/interface) for a derived service comes from a static classification map; an `awsEndpoints` entry can override the type/serviceName.

### Endpoint type classification

```
gateway:   dynamodb, s3
interface: lambda, logs, sts, kms, (default for anything else)
```
`networkAwsServiceValues` in `network.schema.ts` already enumerates `dynamodb, kms, lambda, logs, s3, sts` — reuse it. Add a `const endpointKind: Record<AwsService, "gateway" | "interface">`.

### Generated Terraform

**Gateway endpoint (e.g. dynamodb):**
```
aws_vpc_endpoint.dynamodb {
  vpc_id            = data.… / ${aws_vpc.network.id}
  service_name      = "com.amazonaws.<region>.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [<internal zone route table id(s)>]   # the zones that need it
  tags              = …
}
```
Attaches to the **route tables** of the zones whose services need it (internal). No SG.

**Interface endpoint (e.g. lambda):**
```
aws_vpc_endpoint.lambda {
  vpc_id              = ${aws_vpc.network.id}
  service_name        = "com.amazonaws.<region>.lambda"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [<internal zone subnet ids>]
  security_group_ids  = [${aws_security_group.endpoints.id}]
  private_dns_enabled = true
  tags                = …
}
```
Plus a dedicated **endpoints security group** (`aws_security_group.endpoints`) allowing inbound 443 from the internal zone SG (so internal compute can reach the ENIs). `private_dns_enabled = true` is why Spec A set `enable_dns_support`/`enable_dns_hostnames` on the VPC.

Region comes from the existing `regionForTarget(target)` helper in `terraform/base.ts`.

### Which zones / subnets / route tables

- Interface endpoints attach to the **internal** zone's subnets (where the private compute lives). Generalize: attach to the subnets of every zone that has a service requiring that AWS service. For the demo, that's `internal`.
- Gateway endpoints attach to the **route tables** of those same zones.
- The endpoint SG lives in the VPC; ingress 443 from the zone SG(s) of the consuming zones.

---

## Data flow

```
discoverServices() → all services (incl. permissions.dynamodb, and Spec C's permissions.lambda)
  → deriveRequiredAwsEndpoints(services): Set<AwsService>
      lambda.permissions.dynamodb[].service exists → "dynamodb"
      ecs.permissions.lambda[].service exists (Spec C) → "lambda"
      baseline for in-VPC compute → "logs", "sts"
      ∪ network.yaml awsEndpoints keys (explicit)
  → generate.ts passes the set into the network service's TerraformContext
  → network emitter: for each required service, emit gateway or interface endpoint
      (aws target only; floci omits — SDK uses AWS_ENDPOINT_URL locally)
```

## Validation / error handling

- If a service declares a permission requiring an AWS service that maps to an endpoint, and `network.yaml` defines no zone the endpoint can attach to → generate-time error.
- The existing `validateDynamoDbEndpoint` in `network-zones.ts` (which currently asserts a `network.yaml awsEndpoints.dynamodb` gateway entry) should be **relaxed/replaced**: derivation now guarantees the endpoint, so the validation becomes "a dynamodb-consuming service implies a derived dynamodb gateway endpoint" rather than requiring a hand-written `awsEndpoints` block. Keep a check that the consuming zone has subnets/route tables.

## Testing

- **Unit (network emitter):** given `requiredAwsEndpoints = {dynamodb}`, emits one `aws_vpc_endpoint` of type Gateway with the dynamodb service name + internal route table ids, no SG. Given `{lambda}`, emits an Interface endpoint with subnet ids + endpoint SG + `private_dns_enabled=true`, and the `aws_security_group.endpoints` with 443 ingress from the internal SG. Given `{}`, emits no endpoints.
- **Unit (derivation):** `deriveRequiredAwsEndpoints` maps `lambda.permissions.dynamodb` → dynamodb; (Spec C) `ecs.permissions.lambda` → lambda; merges `network.yaml awsEndpoints`; includes baseline logs/sts for in-VPC compute.
- **Target-conditional:** endpoints present on `aws`, omitted on `floci` (assert both).
- **Byte-identical:** non-network services unchanged; network module gains endpoint resources only when services require them. NOTE: adding derivation will change the network module's generated output once dynamodb is consumed — that's intended; assert the new shape.
- **Live (Floci):** network module still applies on Floci (endpoints omitted there); docs/payments URLs still 200. On AWS, correctness is by generated-Terraform inspection.

## Migration / sequencing within Spec B

1. Add `endpointKind` classification + `deriveRequiredAwsEndpoints(services)` helper with unit tests.
2. Extend `TerraformContext` with `requiredAwsEndpoints?: Set<...>` (or array); wire `generate.ts` to compute + pass it.
3. Network emitter: emit gateway endpoints (dynamodb) — aws-target-only — with unit tests.
4. Network emitter: emit interface endpoints + endpoint SG (lambda/logs/sts) — aws-target-only — with unit tests.
5. Relax `validateDynamoDbEndpoint` to the derivation model.
6. Verify: unit green, byte-identical for non-network, Floci applies (endpoints omitted), docs/payments 200.

## Dependencies for Spec C

- Spec C's `ecs.permissions.lambda` becomes a derivation input here (lambda interface endpoint). Spec B should build the lambda interface endpoint machinery so that when Spec C adds `permissions.lambda`, the endpoint already appears. Until Spec C lands, the lambda endpoint is derived only if something already declares a lambda permission (nothing does yet) — so Spec B's visible effect is the **dynamodb gateway endpoint** + the **baseline logs/sts interface endpoints**.
