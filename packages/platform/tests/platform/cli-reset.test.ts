import { describe, expect, test } from "vitest";
import { buildServiceManifest } from "../../src/registry";
import { planResetTargets } from "../../src/cli/reset";
import type { LoadedService } from "../../src/types";

const services: LoadedService[] = [
  {
    metadata: {
      env: "dev",
      venture: "venture",
      vpc: "core",
      securityZone: "internal",
      serviceName: "payment-api",
      serviceType: "lambda",
      sourcePath: "infra/services/dev/venture/core/internal/payment-api.lambda.yaml",
    },
    config: {
      runtime: "nodejs22.x",
      handler: "index.handler",
      package: "../x.zip",
      memoryMb: 128,
      timeoutSeconds: 10,
      logRetentionDays: 7,
      environment: {},
      permissions: { dynamodb: [{ service: "customer-records", actions: ["dynamodb:PutItem"] }] },
    },
  },
  {
    metadata: {
      env: "dev",
      venture: "venture",
      vpc: "core",
      securityZone: "public",
      serviceName: "docs",
      serviceType: "apigateway",
      sourcePath: "infra/services/dev/venture/core/public/docs.apigateway.yaml",
    },
    config: {
      description: "d",
      routes: [{ path: "/docs", method: "ANY", target: { type: "ecs", service: "docs-app" } }],
    },
  },
  {
    metadata: {
      env: "dev",
      venture: "venture",
      vpc: "core",
      securityZone: "public",
      serviceName: "docs-app",
      serviceType: "ecs",
      sourcePath: "infra/services/dev/venture/core/public/docs-app.ecs.yaml",
    },
    config: {
      cluster: { capacity: "fargate" },
      service: { desiredCount: 1, containerPort: 3001 },
      task: { cpu: 256, memoryMb: 512 },
      image: { repository: "nebula-docs", tag: "local" },
      healthCheck: { path: "/docs" },
    },
  },
  {
    metadata: {
      env: "dev",
      venture: "venture",
      vpc: "core",
      securityZone: "public",
      serviceName: "payments-app",
      serviceType: "ecs",
      sourcePath: "infra/services/dev/venture/core/public/payments-app.ecs.yaml",
    },
    config: {
      cluster: { capacity: "fargate" },
      service: { desiredCount: 1, containerPort: 3002 },
      task: { cpu: 256, memoryMb: 512 },
      image: { repository: "nebula-payments", tag: "local" },
      healthCheck: { path: "/payments" },
      permissions: { lambda: [{ service: "payment-api", actions: ["lambda:InvokeFunction"] }] },
    },
  },
  {
    metadata: {
      env: "dev",
      venture: "venture",
      vpc: "core",
      securityZone: "network",
      serviceName: "network",
      serviceType: "network",
      sourcePath: "infra/services/dev/venture/core/network.yaml",
    },
    config: {
      cidrs: { ipv4: { vpc: "10.20.0.0/16" } },
      zones: { internal: { description: "i", subnets: ["10.20.10.0/24"] } },
      flows: [],
      awsEndpoints: {},
    },
  },
];

describe("planResetTargets", () => {
  const plan = planResetTargets(buildServiceManifest(services));

  test("API gateways are NOT torn down (preserved so the Floci api id stays stable)", () => {
    expect(plan).not.toHaveProperty("apiGatewayNames");
    // The gateway's generated state dir is also preserved (not removed).
    expect(plan.stateDirsToRemove.some((dir) => dir.includes("/docs/"))).toBe(false);
    expect(plan.stateDirsToRemove.some((dir) => dir.includes("/payments/"))).toBe(false);
  });
  test("ecs services with alb + target-group prefix", () => {
    expect(plan.ecs).toContainEqual(
      expect.objectContaining({
        cluster: "dev-venture-core-public-payments-app",
        service: "dev-venture-core-public-payments-app",
        albName: "dev-venture-core-public-payments",
        targetGroupPrefix: "payme-",
      }),
    );
  });
  test("lambda resources with all the spec-c suffixes", () => {
    expect(plan.lambdas).toContainEqual(
      expect.objectContaining({
        functionName: "dev-venture-core-internal-payment-api",
        roleName: "dev-venture-core-internal-payment-api-lambda-role",
        logGroup: "/aws/lambda/dev-venture-core-internal-payment-api",
        securityGroupName: "dev-venture-core-internal-payment-api-sg",
        inlineDynamoPolicy: "dev-venture-core-internal-payment-api-dynamodb-access",
      }),
    );
  });
  test("ecs task roles only for lambda-invoking services", () => {
    expect(plan.ecsTaskRoles).toContainEqual(
      expect.objectContaining({
        roleName: "dev-venture-core-public-payments-app-task-role",
        inlinePolicy: "dev-venture-core-public-payments-app-lambda-invoke",
      }),
    );
    // docs-app does NOT invoke lambda → no task role for it
    expect(plan.ecsTaskRoles.find((r) => r.roleName.includes("docs-app"))).toBeUndefined();
  });
  test("network is excluded everywhere", () => {
    expect(JSON.stringify(plan)).not.toContain("network");
  });
});
