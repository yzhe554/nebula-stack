# ECS EC2 Next.js Hosting Plan

## Goal

Add platform support for hosting Next.js apps on ECS using EC2 capacity instead of running them only as local dev servers behind HTTP proxy routes.

## Current Direction

- `docs` and future `payments` are Next.js apps.
- Today, local Floci API Gateway routes proxy to `host.docker.internal` dev servers.
- The next step is to package Next.js apps as containers and run them on ECS services backed by EC2 instances.
- API Gateway should route to the ECS-hosted apps instead of local dev servers for deployed environments.

## Step 1: Containerize Next.js Apps

Add Docker support for Next.js apps.

Likely files:

- `apps/docs/Dockerfile`
- `apps/payments/Dockerfile` once `apps/payments` exists
- `.dockerignore`

Expected behavior:

- Install dependencies.
- Build the Next.js app.
- Run `next start` or the standalone Next.js server.
- Expose the app port, likely `3000` inside the container.

For `docs`, preserve the existing `/docs` base path behavior.

## Step 2: Add Container Build Scripts

Add scripts for building app container images.

Likely files:

- `package.json`
- `apps/docs/package.json`
- `apps/payments/package.json` later

Example scripts:

```json
{
  "docs:docker:build": "docker build -f apps/docs/Dockerfile -t nebula-docs:local .",
  "payments:docker:build": "docker build -f apps/payments/Dockerfile -t nebula-payments:local ."
}
```

## Step 3: Add ECS Platform Service Type

Add a new platform service type for ECS apps.

Possible service type name:

- `ecs`
- or `container`

Likely files:

- `packages/platform/schemas/ecs.schema.ts`
- `packages/platform/schemas/ecs.schema.json`
- `packages/platform/src/types.ts`
- `packages/platform/src/schema-json.ts`
- `packages/platform/src/schemas.ts`
- `packages/platform/src/service-discovery.ts`
- `packages/platform/src/terraform.ts`

Expected config fields:

```yaml
cluster:
  capacity: ec2
  instanceType: t3.micro
  desiredCapacity: 1
service:
  desiredCount: 1
  containerPort: 3000
image:
  repository: docs
  tag: local
healthCheck:
  path: /docs
```

## Step 4: Generate ECS EC2 Infrastructure

Terraform should generate the ECS/EC2 resources required to run containers.

Expected AWS resources:

- ECS cluster.
- ECS task definition.
- ECS service.
- IAM task execution role.
- CloudWatch log group.
- EC2 launch template or launch configuration.
- Auto Scaling Group for ECS capacity.
- ECS capacity provider.
- Security groups.

Network assumptions:

- ECS services should run in the right network zone.
- Public apps can be reachable through a load balancer.
- Internal apps should stay internal.

## Step 5: Add Load Balancer Support

ECS services need an HTTP target for API Gateway or users.

Likely resources:

- Application Load Balancer.
- Target group.
- Listener.
- Security group rules.

Initial approach:

- One ALB per ECS app service, for simplicity.
- Later optimization can share ALBs across services.

## Step 6: Connect API Gateway To ECS Apps

Update API Gateway routes so HTTP proxy targets can point to deployed ECS app endpoints.

Current local route example:

```yaml
uri: http://host.docker.internal:3001/docs
```

Future deployed route example:

```yaml
uriFromService:
  type: ecs
  service: docs
```

Terraform should resolve that service reference to the ALB listener or DNS name.

## Step 7: Add Service YAML For Docs ECS Hosting

Add ECS service config for the docs app first.

Likely file:

- `infra/services/dev/venture/core/public/docs.ecs.yaml`

Expected behavior:

- Runs the docs container.
- Exposes `/docs` health path.
- Can be targeted by the public docs API Gateway.

Keep this as the first implementation target before adding `payments`.

## Step 8: Add Payments ECS Hosting Later

Once the `payments` Next.js app exists, add ECS hosting for it too.

Likely file:

- `infra/services/dev/venture/core/internal/payments.ecs.yaml`

Expected behavior:

- Runs the payments container.
- Exposes `/payments` health path.
- Can be targeted by the internal payments API Gateway.
- Later protected by Cognito/API Gateway auth.

## Step 9: Local Development Strategy

Decide how this works locally with Floci.

Possible approaches:

1. Keep local Floci routes proxying to Next.js dev servers.
2. Run containers locally with Docker Compose and proxy to those.
3. Use ECS only for real AWS deployments, not Floci.

Initial preference:

- Keep Floci local dev simple with `host.docker.internal` proxies.
- Use ECS EC2 hosting for AWS target first.

## Step 10: Tests And Verification

Add or update tests for:

- ECS schema validation.
- ECS service discovery.
- Terraform generation for ECS cluster/service/task definition.
- API Gateway route generation when targeting ECS services.
- Docs container build.
- Next.js app typecheck/build.

Useful commands:

```bash
pnpm --filter @repo/platform test
pnpm --filter @repo/platform run validate dev venture
pnpm platform:generate -- --env dev --venture venture --target aws
pnpm docs:build
docker build -f apps/docs/Dockerfile -t nebula-docs:local .
pnpm typecheck
```

## Open Questions

- Should ECS be AWS-only, or should Floci/local have an equivalent container path?
- Should ECS services use one shared cluster per env/venture/VPC, or one cluster per service?
- Should ALBs be shared or one per service initially?
- Should images be pushed to ECR as part of platform deploy?
- Should the platform create ECR repositories too?
- Should Next.js apps use standalone output for smaller container images?

## Suggested First Milestone

1. Containerize `apps/docs`.
2. Add `docs:docker:build` script.
3. Add ECS schema and Terraform generation for one simple ECS EC2 service.
4. Add `docs.ecs.yaml`.
5. Generate AWS Terraform for docs ECS hosting.
6. Update docs API Gateway to target the ECS-hosted docs app for AWS deployments.
7. Keep Floci local routing unchanged until ECS local behavior is explicitly needed.
