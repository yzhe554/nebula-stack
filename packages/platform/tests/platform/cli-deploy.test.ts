import { expect, test } from "vitest";
import { buildServiceManifest } from "../../src/registry";
import { gatewayPathFor, dockerBuildArgsFor, prerequisiteServices } from "../../src/cli/deploy";
import type { LoadedService } from "../../src/types";

test("gateway path", () => {
  expect(gatewayPathFor("abc")).toBe("/execute-api/abc/$default");
});

const paymentsApp: LoadedService = {
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
};

const paymentApiLambda: LoadedService = {
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
};

test("docker build args from entry", () => {
  const [entry] = buildServiceManifest([paymentsApp]);
  expect(dockerBuildArgsFor(entry)).toEqual({ APP_NAME: "payments", PORT: 3002 });
});

test("prerequisites include network and the invoked lambda", () => {
  const [entry] = buildServiceManifest([paymentsApp]);
  expect(prerequisiteServices(entry)).toEqual(expect.arrayContaining(["network", "payment-api"]));
});

test("prerequisites include dynamodb tables referenced by invoked lambdas", () => {
  const manifest = buildServiceManifest([paymentsApp, paymentApiLambda]);
  const entry = manifest.find((e) => e.metadata.serviceName === "payments-app");
  if (!entry) throw new Error("payments-app not in manifest");
  expect(prerequisiteServices(entry, manifest)).toEqual(
    expect.arrayContaining(["network", "payment-api", "customer-records"]),
  );
});
