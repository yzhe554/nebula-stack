import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { validateAllConfigs, validateConfigs } from "../../src/platform/validate.js";

describe("validateConfigs", () => {
  test("validates all config files for an env and venture", async () => {
    const root = await createValidConfigTree();

    const result = await validateConfigs({ env: "dev", venture: "venture", servicesRoot: path.join(root, "services") });

    expect(result.valid).toBe(true);
    expect(result.files).toEqual([
      "services/dev/venture/core/internal/payment-api.lambda.yaml",
      "services/dev/venture/core/network.yaml",
      "services/dev/venture/core/restricted/customer-records.dynamodb.yaml",
    ]);
    expect(result.errors).toEqual([]);
  });

  test("reports schema errors for missing explicit Lambda fields", async () => {
    const root = await createValidConfigTree();
    await writeFile(path.join(root, "services", "dev", "venture", "core", "internal", "payment-api.lambda.yaml"), [
      "runtime: nodejs22.x",
      "handler: index.handler",
      "package: ../../../../../dist/payment-api.zip",
    ].join("\n"));

    const result = await validateConfigs({ env: "dev", venture: "venture", servicesRoot: path.join(root, "services") });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.file.endsWith("payment-api.lambda.yaml") && error.messages.some((message) => message.includes("memoryMb")))).toBe(true);
  });

  test("reports Lambda permissions that reference unknown DynamoDB services", async () => {
    const root = await createValidConfigTree();
    await writeFile(path.join(root, "services", "dev", "venture", "core", "internal", "payment-api.lambda.yaml"), [
      "runtime: nodejs22.x",
      "handler: index.handler",
      "package: ../../../../../dist/payment-api.zip",
      "memoryMb: 128",
      "timeoutSeconds: 10",
      "logRetentionDays: 7",
      "environment: {}",
      "permissions:",
      "  dynamodb:",
      "    - service: customer-records-typo",
      "      actions:",
      "        - dynamodb:PutItem",
    ].join("\n"));

    const result = await validateConfigs({ env: "dev", venture: "venture", servicesRoot: path.join(root, "services") });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.messages.some((message) => (
      message.includes("permissions.dynamodb[0].service references unknown DynamoDB service customer-records-typo")
    )))).toBe(true);
  });

  test("validates every env and venture when no scope is provided", async () => {
    const root = await createValidConfigTree();

    const result = await validateAllConfigs({ servicesRoot: path.join(root, "services") });

    expect(result.valid).toBe(true);
    expect(result.scopes).toEqual(["dev/venture"]);
    expect(result.files).toContain("services/dev/venture/core/network.yaml");
  });
});

async function createValidConfigTree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "platform-validate-"));
  const servicesRoot = path.join(root, "services", "dev", "venture", "core");
  await mkdir(path.join(servicesRoot, "internal"), { recursive: true });
  await mkdir(path.join(servicesRoot, "restricted"), { recursive: true });

  await writeFile(path.join(servicesRoot, "network.yaml"), [
    "cidrs:",
    "  ipv4:",
    "    vpc: 10.20.0.0/16",
    "zones:",
    "  internal:",
    "    description: Application services that are not public.",
    "    subnets:",
    "      - 10.20.10.0/24",
    "  restricted:",
    "    description: Data services and sensitive resources.",
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
    "    routeTableZoneNames: [internal, restricted]",
    "    policy: default",
  ].join("\n"));

  await writeFile(path.join(servicesRoot, "internal", "payment-api.lambda.yaml"), [
    "runtime: nodejs22.x",
    "handler: index.handler",
    "package: ../../../../../dist/payment-api.zip",
    "memoryMb: 128",
    "timeoutSeconds: 10",
    "logRetentionDays: 7",
    "environment:",
    "  TABLE_NAME: dev-venture-core-restricted-customer-records",
    "permissions:",
    "  dynamodb:",
    "    - service: customer-records",
    "      actions:",
    "        - dynamodb:PutItem",
  ].join("\n"));

  await writeFile(path.join(servicesRoot, "restricted", "customer-records.dynamodb.yaml"), [
    "billingMode: PAY_PER_REQUEST",
    "hashKey:",
    "  name: customerId",
    "  type: S",
    "pointInTimeRecovery: true",
  ].join("\n"));

  return root;
}
