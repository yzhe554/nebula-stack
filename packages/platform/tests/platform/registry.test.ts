import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildServiceManifest,
  loadServiceManifest,
  serviceNamesFromManifest,
  serviceContainerPortsFromManifest,
} from "../../src/registry";
import type { LoadedService } from "../../src/types";

const dynamoService: LoadedService = {
  metadata: {
    env: "dev",
    venture: "venture",
    vpc: "core",
    securityZone: "managed",
    serviceName: "customer-records",
    serviceType: "dynamodb",
    sourcePath: "infra/services/dev/venture/core/managed/customer-records.dynamodb.yaml",
  },
  config: {
    billingMode: "PAY_PER_REQUEST",
    hashKey: { name: "id", type: "S" },
    pointInTimeRecovery: false,
  },
};

const ecsService: LoadedService = {
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
  },
};

describe("buildServiceManifest", () => {
  test("computes the physical name for a service", () => {
    const [entry] = buildServiceManifest([dynamoService]);
    expect(entry.physicalName).toBe("dev-venture-core-managed-customer-records");
    expect(entry.metadata.serviceName).toBe("customer-records");
  });
  test("leaves ecs and frontedByGateway unset for non-ecs services", () => {
    const [entry] = buildServiceManifest([dynamoService]);
    expect(entry.ecs).toBeUndefined();
    expect(entry.frontedByGateway).toBeUndefined();
  });
  test("preserves input order / length", () => {
    expect(buildServiceManifest([dynamoService])).toHaveLength(1);
  });

  test("computes ecs names including the 32-char truncated ALB name", () => {
    const [entry] = buildServiceManifest([ecsService]);
    expect(entry.ecs).toEqual({
      clusterName: "dev-venture-core-public-payments-app",
      albName: "dev-venture-core-public-payments",
      targetGroupPrefix: "payme-",
      containerPort: 3002,
    });
  });

  test("computes docs-app target group prefix as docsa-", () => {
    const docsApp: LoadedService = {
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
    };
    const [entry] = buildServiceManifest([docsApp]);
    expect(entry.ecs?.targetGroupPrefix).toBe("docsa-");
    expect(entry.ecs?.albName).toBe("dev-venture-core-public-docs-app");
  });

  const docsGateway: LoadedService = {
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
      description: "Docs app ingress.",
      routes: [
        {
          path: "/docs",
          method: "ANY",
          target: { type: "http_proxy", uri: "http://host.docker.internal:3001/docs" },
          targets: {
            floci: { type: "ecs", service: "docs-app" },
            aws: { type: "ecs", service: "docs-app" },
          },
        },
      ],
    },
  };
  const docsAppForGateway: LoadedService = {
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
  };

  test("links an ecs service to the gateway that fronts it (via targets map)", () => {
    const manifest = buildServiceManifest([docsAppForGateway, docsGateway]);
    expect(manifest.find((e) => e.metadata.serviceName === "docs-app")?.frontedByGateway).toEqual({
      serviceName: "docs",
      physicalName: "dev-venture-core-public-docs",
    });
  });

  test("links via a route's top-level target too", () => {
    const paymentsGateway: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "public",
        serviceName: "payments",
        serviceType: "apigateway",
        sourcePath: "infra/services/dev/venture/core/public/payments.apigateway.yaml",
      },
      config: {
        description: "Payments app public ingress.",
        routes: [
          { path: "/payments", method: "ANY", target: { type: "ecs", service: "payments-app" } },
        ],
      },
    };
    const manifest = buildServiceManifest([ecsService, paymentsGateway]);
    expect(
      manifest.find((e) => e.metadata.serviceName === "payments-app")?.frontedByGateway
        ?.serviceName,
    ).toBe("payments");
  });

  test("serviceNamesFromManifest maps dynamodb/lambda/ecs names to physical names", () => {
    const manifest = buildServiceManifest([dynamoService, ecsService]);
    expect(serviceNamesFromManifest(manifest)).toEqual({
      "customer-records": "dev-venture-core-managed-customer-records",
      "payments-app": "dev-venture-core-public-payments-app",
    });
  });

  test("serviceContainerPortsFromManifest maps only ecs services to ports", () => {
    const manifest = buildServiceManifest([dynamoService, ecsService]);
    expect(serviceContainerPortsFromManifest(manifest)).toEqual({ "payments-app": 3002 });
  });

  test("attaches derived app metadata to ecs services with dev port", () => {
    const [entry] = buildServiceManifest([ecsService]);
    expect(entry.app).toMatchObject({
      base: "payments",
      dir: "apps/payments",
      packageName: "@repo/payments",
      dockerfile: "apps/Dockerfile",
      devPort: 3002,
    });
  });
  test("does not attach app metadata to dynamodb services", () => {
    const [entry] = buildServiceManifest([dynamoService]);
    expect(entry.app).toBeUndefined();
  });

  test("loadServiceManifest discovers services then builds the manifest", async () => {
    const servicesRoot = path.resolve(import.meta.dirname, "../../../../infra/services");
    const manifest = await loadServiceManifest({ env: "dev", venture: "venture", servicesRoot });
    const names = manifest.map((entry) => entry.metadata.serviceName).sort();
    expect(names).toContain("docs-app");
    expect(names).toContain("customer-records");
    expect(
      manifest.find((entry) => entry.metadata.serviceName === "docs-app")?.frontedByGateway
        ?.serviceName,
    ).toBe("docs");
  });
});
