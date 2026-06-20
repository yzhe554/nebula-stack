import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { discoverServices } from "../../src/service-discovery";
import { loadNetworkPolicy } from "../../src/network-zones";

describe("network zone policies", () => {
  test("loads zone policy for an environment venture and vpc", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "platform-zones-"));
    const platformRoot = path.join(root, "platform");
    await mkdir(path.join(platformRoot, "services", "dev", "venture", "core"), { recursive: true });
    await writeFile(
      path.join(platformRoot, "services", "dev", "venture", "core", "network.yaml"),
      [
        "cidrs:",
        "  ipv4:",
        "    vpc: 10.20.0.0/16",
        "zones:",
        "  internal:",
        "    description: Application services that are not public.",
        "    subnets:",
        "      - 10.20.10.0/24",
        "      - 10.20.11.0/24",
        "flows:",
        "  - from: internal",
        "    to: restricted",
        "    ports: [443]",
        "  - from: internal",
        "    to: aws",
        "    services: [dynamodb, logs]",
        "awsEndpoints:",
        "  dynamodb:",
        "    type: gateway",
        "    serviceName: com.amazonaws.ap-southeast-2.dynamodb",
        "    routeTableZoneNames: [internal]",
        "    policy: default",
      ].join("\n"),
    );

    const policy = await loadNetworkPolicy({
      env: "dev",
      venture: "venture",
      vpc: "core",
      servicesRoot: path.join(platformRoot, "services"),
    });

    expect(policy.cidrs.ipv4.vpc).toBe("10.20.0.0/16");
    expect(policy.zones.internal).toMatchObject({
      description: "Application services that are not public.",
      subnets: ["10.20.10.0/24", "10.20.11.0/24"],
    });
    expect(policy.flows).toContainEqual({
      from: "internal",
      to: "aws",
      services: ["dynamodb", "logs"],
    });
    expect(policy.awsEndpoints.dynamodb).toEqual({
      type: "gateway",
      serviceName: "com.amazonaws.ap-southeast-2.dynamodb",
      routeTableZoneNames: ["internal"],
      policy: "default",
    });
  });

  test("requires explicit DynamoDB gateway endpoint config when flows use DynamoDB", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "platform-zones-"));
    const servicesRoot = path.join(root, "services");

    await mkdir(path.join(servicesRoot, "dev", "venture", "core"), { recursive: true });
    await writeFile(
      path.join(servicesRoot, "dev", "venture", "core", "network.yaml"),
      [
        "cidrs:",
        "  ipv4:",
        "    vpc: 10.20.0.0/16",
        "zones:",
        "  internal:",
        "    description: Application services that are not public.",
        "    subnets:",
        "      - 10.20.10.0/24",
        "flows:",
        "  - from: internal",
        "    to: aws",
        "    services: [dynamodb]",
      ].join("\n"),
    );

    await expect(
      loadNetworkPolicy({ env: "dev", venture: "venture", vpc: "core", servicesRoot }),
    ).rejects.toThrow("awsEndpoints.dynamodb is required");
  });

  test("requires DynamoDB services to have a default gateway endpoint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "platform-zones-"));
    const servicesRoot = path.join(root, "services");

    await mkdir(path.join(servicesRoot, "dev", "venture", "core", "managed"), { recursive: true });
    await writeFile(
      path.join(
        servicesRoot,
        "dev",
        "venture",
        "core",
        "managed",
        "customer-records.dynamodb.yaml",
      ),
      [
        "billingMode: PAY_PER_REQUEST",
        "hashKey:",
        "  name: customerId",
        "  type: S",
        "pointInTimeRecovery: true",
      ].join("\n"),
    );
    await writeFile(
      path.join(servicesRoot, "dev", "venture", "core", "network.yaml"),
      [
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
      ].join("\n"),
    );

    await expect(
      discoverServices({ env: "dev", venture: "venture", servicesRoot }),
    ).rejects.toThrow(
      "DynamoDB service customer-records requires awsEndpoints.dynamodb default gateway endpoint",
    );
  });

  test("allows managed DynamoDB services outside subnet-backed zones", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "platform-zones-"));
    const servicesRoot = path.join(root, "services");

    await mkdir(path.join(servicesRoot, "dev", "venture", "core", "managed"), { recursive: true });
    await writeFile(
      path.join(
        servicesRoot,
        "dev",
        "venture",
        "core",
        "managed",
        "customer-records.dynamodb.yaml",
      ),
      [
        "billingMode: PAY_PER_REQUEST",
        "hashKey:",
        "  name: customerId",
        "  type: S",
        "pointInTimeRecovery: true",
      ].join("\n"),
    );
    await writeFile(
      path.join(servicesRoot, "dev", "venture", "core", "network.yaml"),
      [
        "cidrs:",
        "  ipv4:",
        "    vpc: 10.20.0.0/16",
        "zones:",
        "  internal:",
        "    description: Application services that are not public.",
        "    subnets:",
        "      - 10.20.10.0/24",
        "flows: []",
        "awsEndpoints:",
        "  dynamodb:",
        "    type: gateway",
        "    serviceName: com.amazonaws.ap-southeast-2.dynamodb",
        "    routeTableZoneNames: [internal]",
        "    policy: default",
      ].join("\n"),
    );

    const services = await discoverServices({ env: "dev", venture: "venture", servicesRoot });

    expect(services[0].metadata.securityZone).toBe("managed");
  });

  test("service discovery rejects a security zone that is not defined for the vpc", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "platform-zones-"));
    const servicesRoot = path.join(root, "services");

    await mkdir(path.join(servicesRoot, "dev", "venture", "core", "unknown"), { recursive: true });
    await writeFile(
      path.join(servicesRoot, "dev", "venture", "core", "unknown", "payment-api.lambda.yaml"),
      [
        "runtime: nodejs22.x",
        "handler: index.handler",
        "package: ../../dist/payment-api.zip",
        "memoryMb: 128",
        "timeoutSeconds: 10",
        "logRetentionDays: 7",
        "environment: {}",
        "permissions:",
        "  dynamodb: []",
      ].join("\n"),
    );
    await writeFile(
      path.join(servicesRoot, "dev", "venture", "core", "network.yaml"),
      [
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
      ].join("\n"),
    );

    await expect(
      discoverServices({ env: "dev", venture: "venture", servicesRoot }),
    ).rejects.toThrow("Security zone unknown is not defined");
  });
});
