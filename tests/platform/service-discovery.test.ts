import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { discoverServices } from "../../src/platform/service-discovery.js";

describe("discoverServices", () => {
  test("loads selected services for one environment and derives path metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "platform-services-"));
    const servicesRoot = path.join(root, "services");
    await mkdir(path.join(servicesRoot, "dev", "venture", "core", "internal"), { recursive: true });
    await mkdir(path.join(servicesRoot, "prod", "venture", "core", "internal"), { recursive: true });

    await writeFile(path.join(servicesRoot, "dev", "venture", "core", "internal", "payment-api.lambda.yaml"), [
      "runtime: nodejs22.x",
      "handler: index.handler",
      "package: ../../dist/payment-api.zip",
      "memoryMb: 128",
      "timeoutSeconds: 10",
      "logRetentionDays: 7",
      "environment: {}",
      "permissions:",
      "  dynamodb: []",
    ].join("\n"));
    await writeFile(path.join(servicesRoot, "prod", "venture", "core", "internal", "payment-api.lambda.yaml"), [
      "runtime: nodejs22.x",
      "handler: index.handler",
      "package: ../../dist/payment-api.zip",
      "memoryMb: 128",
      "timeoutSeconds: 10",
      "logRetentionDays: 7",
      "environment: {}",
      "permissions:",
      "  dynamodb: []",
    ].join("\n"));
    await writeFile(path.join(servicesRoot, "dev", "venture", "core", "network.yaml"), [
      "cidrs:",
      "  ipv4:",
      "    vpc: 10.20.0.0/16",
      "zones:",
      "  internal:",
      "    description: Application services that are not public.",
      "    subnets:",
      "      - 10.20.10.0/24",
      "flows: []",
      "awsEndpoints: {}",
    ].join("\n"));

    const services = await discoverServices({
      env: "dev",
      services: ["payment-api"],
      servicesRoot,
    });

    expect(services).toHaveLength(1);
    expect(services[0].metadata).toMatchObject({
      env: "dev",
      venture: "venture",
      vpc: "core",
      securityZone: "internal",
      serviceName: "payment-api",
      serviceType: "lambda",
    });
    expect(services[0].config).toMatchObject({
      runtime: "nodejs22.x",
      memoryMb: 128,
      timeoutSeconds: 10,
      logRetentionDays: 7,
    });
  });

  test("rejects duplicate service names within the same environment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "platform-services-"));
    const servicesRoot = path.join(root, "services");
    await mkdir(path.join(servicesRoot, "dev", "venture", "core", "internal"), { recursive: true });
    await mkdir(path.join(servicesRoot, "dev", "venture", "analytics", "internal"), { recursive: true });

    const yaml = [
      "runtime: nodejs22.x",
      "handler: index.handler",
      "package: ../../dist/payment-api.zip",
      "memoryMb: 128",
      "timeoutSeconds: 10",
      "logRetentionDays: 7",
      "environment: {}",
      "permissions:",
      "  dynamodb: []",
    ].join("\n");
    await writeFile(path.join(servicesRoot, "dev", "venture", "core", "internal", "payment-api.lambda.yaml"), yaml);
    await writeFile(path.join(servicesRoot, "dev", "venture", "analytics", "internal", "payment-api.lambda.yaml"), yaml);

    await expect(discoverServices({ env: "dev", servicesRoot })).rejects.toThrow("Duplicate service name");
  });
});
