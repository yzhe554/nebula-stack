import { describe, expect, test } from "vitest";
import { deriveRequiredAwsEndpoints, endpointKind } from "../../src/services/network/endpoints";
import type { LoadedService } from "../../src/types";

const lambdaWithDynamo: LoadedService = {
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
const dynamoOnly: LoadedService = {
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

describe("deriveRequiredAwsEndpoints", () => {
  test("a lambda with dynamodb permission requires the dynamodb endpoint", () => {
    expect(deriveRequiredAwsEndpoints([lambdaWithDynamo, dynamoOnly])).toEqual(["dynamodb"]);
  });
  test("no permissions → no required endpoints", () => {
    expect(deriveRequiredAwsEndpoints([dynamoOnly])).toEqual([]);
  });
  test("result is de-duplicated and stable-sorted", () => {
    const second: LoadedService = {
      ...lambdaWithDynamo,
      metadata: {
        ...lambdaWithDynamo.metadata,
        serviceName: "other-api",
        sourcePath: "infra/services/dev/venture/core/internal/other-api.lambda.yaml",
      },
    };
    expect(deriveRequiredAwsEndpoints([lambdaWithDynamo, second])).toEqual(["dynamodb"]);
  });

  test("an ecs service with permissions.lambda requires the lambda interface endpoint", () => {
    const ecsInvokingLambda: LoadedService = {
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
        image: { repository: "x", tag: "local" },
        healthCheck: { path: "/payments" },
        permissions: { lambda: [{ service: "payment-api", actions: ["lambda:InvokeFunction"] }] },
      },
    };
    expect(deriveRequiredAwsEndpoints([ecsInvokingLambda])).toEqual(["lambda"]);
  });

  test("a lambda-invoking ecs plus a dynamodb-using lambda require both endpoints", () => {
    const ecsInvokingLambda: LoadedService = {
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
        image: { repository: "x", tag: "local" },
        healthCheck: { path: "/payments" },
        permissions: { lambda: [{ service: "payment-api", actions: ["lambda:InvokeFunction"] }] },
      },
    };
    expect(deriveRequiredAwsEndpoints([lambdaWithDynamo, ecsInvokingLambda])).toEqual([
      "dynamodb",
      "lambda",
    ]);
  });
});

describe("endpointKind", () => {
  test("dynamodb and s3 are gateway; lambda/logs/sts are interface", () => {
    expect(endpointKind("dynamodb")).toBe("gateway");
    expect(endpointKind("s3")).toBe("gateway");
    expect(endpointKind("lambda")).toBe("interface");
    expect(endpointKind("logs")).toBe("interface");
    expect(endpointKind("sts")).toBe("interface");
  });
});

import {
  gatewayEndpointResources,
  interfaceEndpointResources,
} from "../../src/services/network/endpoints";

const ctx = { region: "ap-southeast-2", zone: "internal", namePrefix: "dev-venture-core" };

describe("gatewayEndpointResources", () => {
  test("builds an aws_vpc_endpoint Gateway for dynamodb attached to the internal route table", () => {
    const res = gatewayEndpointResources(["dynamodb"], ctx);
    expect(res.aws_vpc_endpoint.dynamodb).toEqual({
      vpc_id: "${aws_vpc.network.id}",
      service_name: "com.amazonaws.ap-southeast-2.dynamodb",
      vpc_endpoint_type: "Gateway",
      route_table_ids: ["${aws_route_table.internal.id}"],
    });
  });
  test("no gateway services → empty object", () => {
    expect(gatewayEndpointResources([], ctx)).toEqual({});
  });
});

describe("interfaceEndpointResources", () => {
  test("builds an Interface endpoint + endpoint SG for lambda", () => {
    const result = interfaceEndpointResources(["lambda"], ctx);
    if (!("data" in result)) throw new Error("Expected non-empty result");
    const res = result;
    expect(res.aws_vpc_endpoint.lambda).toEqual({
      vpc_id: "${aws_vpc.network.id}",
      service_name: "com.amazonaws.ap-southeast-2.lambda",
      vpc_endpoint_type: "Interface",
      subnet_ids: "${data.aws_subnets.internal_endpoints.ids}",
      security_group_ids: ["${aws_security_group.endpoints.id}"],
      private_dns_enabled: true,
    });
    expect(res.aws_security_group.endpoints).toMatchObject({
      name: "dev-venture-core-endpoints-sg",
      vpc_id: "${aws_vpc.network.id}",
    });
    expect(res.aws_security_group_rule.endpoints_ingress_443).toMatchObject({
      type: "ingress",
      from_port: 443,
      to_port: 443,
      protocol: "tcp",
      security_group_id: "${aws_security_group.endpoints.id}",
      source_security_group_id: "${aws_security_group.internal.id}",
    });
    expect(res.data.aws_subnets.internal_endpoints).toEqual({
      filter: [
        { name: "vpc-id", values: ["${aws_vpc.network.id}"] },
        { name: "tag:Zone", values: ["internal"] },
      ],
    });
  });
  test("no interface services → empty object", () => {
    expect(interfaceEndpointResources([], ctx)).toEqual({});
  });
});
