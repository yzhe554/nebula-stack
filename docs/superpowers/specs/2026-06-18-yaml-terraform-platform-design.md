# YAML Terraform Platform Design

## Goal

Build a small platform in this repository that lets users define AWS services in YAML, generate Terraform JSON configuration with TypeScript, and deploy selected services for one environment at a time through local commands or GitHub Actions.

## Source Layout

Service configuration files live under:

```text
infra/services/<env>/<venture>/<vpc>/<security-zone>/<service-name>.<service-type>.yaml
```

Example:

```text
infra/services/dev/venture/core/internal/payment-api.lambda.yaml
infra/services/dev/venture/core/restricted/customer-records.dynamodb.yaml
infra/services/prod/venture/core/internal/payment-api.lambda.yaml
```

The generator derives these fields from the path:

- `env`
- `venture`
- `vpc`
- `securityZone`
- `serviceName`
- `serviceType`

The service YAML contains only service-specific configuration. Venture, VPC, security zone, environment, service name, and service type are not repeated inside the YAML.

## Supported MVP Services

The MVP supports two service types:

- Lambda from `*.lambda.yaml`
- DynamoDB from `*.dynamodb.yaml`

Each service type has its own JSON Schema file for YAML authoring and its own runtime Zod validation rules in TypeScript. Shared path-derived metadata is validated separately.

All service-owned configuration must be explicit in YAML. The schemas avoid hidden defaults so reviewers can see the full AWS configuration intent in pull requests.

Schema files live under:

```text
packages/platform/schemas/lambda.schema.json
packages/platform/schemas/dynamodb.schema.json
```

Service YAML files may include a YAML Language Server `$schema` comment to enable editor autocomplete and validation without adding schema metadata to runtime config.

## Deployment Model

The environment is the hard deployment boundary. Every command must require `--env`, and no command deploys multiple environments in one run.

The deployment unit is a service. Users can deploy:

- all services in an environment
- one selected service in an environment
- multiple selected services in an environment

Example commands:

```bash
pnpm platform:generate -- --env dev --venture venture
pnpm platform:generate -- --env dev --venture venture --target floci
pnpm platform:generate -- --env dev --venture venture --services payment-api,customer-records
pnpm platform:deploy -- --env dev --venture venture --target floci --services payment-api,customer-records
```

Each selected service is generated and deployed as its own Terraform root module.

## Generated Layout

Generated Terraform uses Terraform JSON syntax because it is safer for TypeScript to generate structured JSON than string-based HCL.

```text
__generated__/<target>/<env>/<venture>/<service-name>/main.tf.json
```

Example:

```text
__generated__/aws/dev/venture/payment-api/main.tf.json
__generated__/floci/dev/venture/customer-records/main.tf.json
```

Each generated service folder is intended to have its own Terraform state, scoped by environment and service.

The target segment keeps real AWS state separate from local Floci state.

## State Strategy

Use one Terraform state per `env + venture + service`.

Benefits:

- selected service deploys are safe
- failed deploys are isolated to one service
- retry is simple
- one service cannot accidentally remove another service from Terraform state

Tradeoff:

- cross-service dependencies must be explicit later, through outputs, SSM parameters, or service discovery, not direct same-state Terraform references.

## Safety Defaults

DynamoDB defaults:

- point-in-time recovery enabled
- deletion protection enabled when supported by provider/resource
- generated lifecycle `prevent_destroy = true`
- pay-per-request billing as the default MVP billing mode

Lambda defaults:

- package path points to an existing zip artifact
- basic execution role for CloudWatch logs
- CloudWatch log retention configured
- conservative memory and timeout defaults

Generated resources are tagged with:

- environment
- vpc
- security zone
- service name
- service type
- venture
- managed-by platform marker

## GitHub Actions Model

GitHub Actions runs the same commands as local development:

```bash
pnpm platform:generate -- --env dev --venture venture --services payment-api,customer-records
```

Then it runs Terraform for each generated service folder. AWS authentication should use GitHub OIDC and an IAM role, not long-lived access keys. Floci deployments use generated fake credentials and local endpoints instead of AWS OIDC.

## Local AWS Emulation

The platform supports `--target floci` for local AWS-compatible testing. Floci runs locally on `http://localhost:4566`, and generated Terraform config adds AWS provider endpoint overrides for supported MVP services.

## Network

IPv4 network CIDRs, zones, and ingress/egress flow intent are defined alongside the services for each environment, venture, and VPC:

```text
infra/services/<env>/<venture>/<vpc>/network.yaml
```

Services must live under a security zone that is defined in the matching network policy. The MVP validates zone existence and captures IPv4 CIDRs, subnets, flow intent, and explicit AWS endpoint intent. DynamoDB AWS flows require an explicit gateway VPC endpoint configuration. The MVP does not yet generate VPC subnets, security groups, route tables, or VPC endpoints from that policy.

## MVP Non-Goals

The MVP does not create VPCs.
The MVP does not implement cross-service dependencies.
The MVP does not deploy multiple environments in one command.
The MVP does not provide a UI.
The MVP does not generate human-written HCL.
