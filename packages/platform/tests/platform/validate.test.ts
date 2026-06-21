import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { validateAllConfigs, validateConfigs } from "../../src/validate";

describe("validateConfigs", () => {
  test("validates all config files for an env and venture", async () => {
    const root = await createValidConfigTree();

    const result = await validateConfigs({
      env: "dev",
      venture: "venture",
      servicesRoot: path.join(root, "infra", "services"),
    });

    expect(result.valid).toBe(true);
    expect(result.files).toEqual([
      "services/dev/venture/core/internal/payment-api.lambda.yaml",
      "services/dev/venture/core/managed/customer-records.dynamodb.yaml",
      "services/dev/venture/core/network.yaml",
    ]);
    expect(result.errors).toEqual([]);
  });

  test("reports schema errors for missing explicit Lambda fields", async () => {
    const root = await createValidConfigTree();
    await writeFile(
      path.join(
        root,
        "infra",
        "services",
        "dev",
        "venture",
        "core",
        "internal",
        "payment-api.lambda.yaml",
      ),
      [
        "runtime: nodejs22.x",
        "handler: index.handler",
        "package: ../../../../../../apps/payment-api/dist/payment-api.zip",
      ].join("\n"),
    );

    const result = await validateConfigs({
      env: "dev",
      venture: "venture",
      servicesRoot: path.join(root, "infra", "services"),
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) =>
          error.file.endsWith("payment-api.lambda.yaml") &&
          error.messages.some((message) => message.includes("memoryMb")),
      ),
    ).toBe(true);
  });

  test("reports Lambda permissions that reference unknown DynamoDB services", async () => {
    const root = await createValidConfigTree();
    await writeFile(
      path.join(
        root,
        "infra",
        "services",
        "dev",
        "venture",
        "core",
        "internal",
        "payment-api.lambda.yaml",
      ),
      [
        "runtime: nodejs22.x",
        "handler: index.handler",
        "package: ../../../../../../apps/payment-api/dist/payment-api.zip",
        "memoryMb: 128",
        "timeoutSeconds: 10",
        "logRetentionDays: 7",
        "environment: {}",
        "permissions:",
        "  dynamodb:",
        "    - service: customer-records-typo",
        "      actions:",
        "        - dynamodb:PutItem",
      ].join("\n"),
    );

    const result = await validateConfigs({
      env: "dev",
      venture: "venture",
      servicesRoot: path.join(root, "infra", "services"),
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) =>
        error.messages.some((message) =>
          message.includes(
            "permissions.dynamodb[0].service references unknown DynamoDB service customer-records-typo",
          ),
        ),
      ),
    ).toBe(true);
  });

  test("reports API Gateway routes that reference unknown services", async () => {
    const root = await createValidConfigTree();
    const publicRoot = path.join(root, "infra", "services", "dev", "venture", "core", "public");
    await mkdir(publicRoot, { recursive: true });
    await writeFile(
      path.join(publicRoot, "payments.apigateway.yaml"),
      [
        "description: Payments app public ingress.",
        "routes:",
        "  - path: /payments",
        "    method: ANY",
        "    target:",
        "      type: ecs",
        "      service: payments-app-typo",
        "  - path: /api/payments",
        "    method: POST",
        "    target:",
        "      type: lambda",
        "      service: payment-api-typo",
      ].join("\n"),
    );

    const result = await validateConfigs({
      env: "dev",
      venture: "venture",
      servicesRoot: path.join(root, "infra", "services"),
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) =>
        error.messages.some((message) =>
          message.includes(
            "routes[0].target.service references unknown ECS service payments-app-typo",
          ),
        ),
      ),
    ).toBe(true);
    expect(
      result.errors.some((error) =>
        error.messages.some((message) =>
          message.includes(
            "routes[1].target.service references unknown Lambda service payment-api-typo",
          ),
        ),
      ),
    ).toBe(true);
  });

  test("reports supported Fargate task sizes in terminal validation errors", async () => {
    const root = await createValidConfigTree();
    const publicRoot = path.join(root, "infra", "services", "dev", "venture", "core", "public");
    await mkdir(publicRoot, { recursive: true });
    await writeFile(
      path.join(publicRoot, "docs-app.ecs.yaml"),
      [
        "cluster:",
        "  capacity: fargate",
        "service:",
        "  desiredCount: 1",
        "  containerPort: 3001",
        "task:",
        "  cpu: 256",
        "  memoryMb: 4096",
        "image:",
        "  repository: nebula-docs",
        "  tag: local",
        "healthCheck:",
        "  path: /docs",
      ].join("\n"),
    );

    const result = await validateConfigs({
      env: "dev",
      venture: "venture",
      servicesRoot: path.join(root, "infra", "services"),
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) =>
          error.file.endsWith("docs-app.ecs.yaml") &&
          error.messages.includes(
            "task.memoryMb: 4096 is not valid for Fargate task.cpu 256. Supported memoryMb values: 512, 1024, 2048.",
          ),
      ),
    ).toBe(true);
  });

  test("validates every env and venture when no scope is provided", async () => {
    const root = await createValidConfigTree();

    const result = await validateAllConfigs({ servicesRoot: path.join(root, "infra", "services") });

    expect(result.valid).toBe(true);
    expect(result.scopes).toEqual(["dev/venture"]);
    expect(result.files).toContain("services/dev/venture/core/network.yaml");
  });
});

async function createValidConfigTree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "platform-validate-"));
  const servicesRoot = path.join(root, "infra", "services", "dev", "venture", "core");
  await mkdir(path.join(servicesRoot, "internal"), { recursive: true });
  await mkdir(path.join(servicesRoot, "managed"), { recursive: true });

  await writeFile(
    path.join(servicesRoot, "network.yaml"),
    [
      "cidrs:",
      "  ipv4:",
      "    vpc: 10.20.0.0/16",
      "zones:",
      "  internal:",
      "    description: Application services that are not public.",
      "    subnets:",
      "      - 10.20.10.0/24",
      "  public:",
      "    description: Public application entrypoints.",
      "    subnets:",
      "      - 10.20.20.0/24",
      "flows:",
      "  - from: internal",
      "    to: aws",
      "    services: [dynamodb]",
      "awsEndpoints:",
      "  dynamodb:",
      "    type: gateway",
      "    serviceName: com.amazonaws.ap-southeast-2.dynamodb",
      "    routeTableZoneNames: [internal]",
      "    policy: default",
    ].join("\n"),
  );

  await writeFile(
    path.join(servicesRoot, "internal", "payment-api.lambda.yaml"),
    [
      "runtime: nodejs22.x",
      "handler: index.handler",
      "package: ../../../../../../apps/payment-api/dist/payment-api.zip",
      "memoryMb: 128",
      "timeoutSeconds: 10",
      "logRetentionDays: 7",
      "environment:",
      "  TABLE_NAME: dev-venture-core-managed-customer-records",
      "permissions:",
      "  dynamodb:",
      "    - service: customer-records",
      "      actions:",
      "        - dynamodb:PutItem",
    ].join("\n"),
  );

  await writeFile(
    path.join(servicesRoot, "managed", "customer-records.dynamodb.yaml"),
    [
      "billingMode: PAY_PER_REQUEST",
      "hashKey:",
      "  name: customerId",
      "  type: S",
      "pointInTimeRecovery: true",
    ].join("\n"),
  );

  return root;
}
