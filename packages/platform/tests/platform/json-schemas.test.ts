import { readFile } from "node:fs/promises";
import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ecsSchema } from "../../schemas/ecs.schema";
import { generateSchemaObject, platformJsonSchemas } from "../../src/schema-json";

describe("service JSON schemas", () => {
  test("generates JSON schemas through the Zod schema instance", () => {
    const schema = z.object({ serviceName: z.string() });
    Object.defineProperty(schema, "toJSONSchema", {
      value: () => ({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { serviceName: { type: "string" } },
        required: ["serviceName"],
        additionalProperties: false,
      }),
    });

    expect(
      generateSchemaObject(schema, {
        id: "https://example.local/packages/platform/schemas/test.schema.json",
        title: "Test Schema",
        description: "Generated via schema.toJSONSchema().",
      }),
    ).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { serviceName: { type: "string" } },
      required: ["serviceName"],
      additionalProperties: false,
      $id: "https://example.local/packages/platform/schemas/test.schema.json",
      title: "Test Schema",
      description: "Generated via schema.toJSONSchema().",
    });
  });

  test("checked-in JSON schemas are generated from platform schema source", async () => {
    for (const [fileName, schemaFactory] of Object.entries(platformJsonSchemas)) {
      await readFile(`schemas/${fileName.replace(/\.json$/, ".ts")}`, "utf8");
      const checkedIn = JSON.parse(await readFile(`schemas/${fileName}`, "utf8"));

      expect(checkedIn).toEqual(schemaFactory());
    }
  });

  test("lambda schema validates the sample Lambda YAML", async () => {
    const validate = await compileSchema("schemas/lambda.schema.json");
    const yaml = parse(
      await readFile(
        "../../infra/services/dev/venture/core/internal/payment-api.lambda.yaml",
        "utf8",
      ),
    );

    expect(validate(yaml), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("dynamodb schema validates the sample DynamoDB YAML", async () => {
    const validate = await compileSchema("schemas/dynamodb.schema.json");
    const yaml = parse(
      await readFile(
        "../../infra/services/dev/venture/core/managed/customer-records.dynamodb.yaml",
        "utf8",
      ),
    );

    expect(validate(yaml), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("api gateway schema validates the sample API Gateway YAML", async () => {
    const validate = await compileSchema("schemas/apigateway.schema.json");
    const yaml = parse(
      await readFile("../../infra/services/dev/venture/core/public/docs.apigateway.yaml", "utf8"),
    );

    expect(validate(yaml), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("api gateway schema validates the payments app API Gateway YAML", async () => {
    const validate = await compileSchema("schemas/apigateway.schema.json");
    const yaml = parse(
      await readFile(
        "../../infra/services/dev/venture/core/public/payments.apigateway.yaml",
        "utf8",
      ),
    );

    expect(validate(yaml), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("ecs schema validates the sample ECS YAML", async () => {
    const validate = await compileSchema("schemas/ecs.schema.json");
    const yaml = parse(
      await readFile("../../infra/services/dev/venture/core/public/docs-app.ecs.yaml", "utf8"),
    );

    expect(validate(yaml), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("ecs schema rejects task CPU above one vCPU", async () => {
    const validate = await compileSchema("schemas/ecs.schema.json");

    expect(
      validate({
        cluster: { capacity: "ec2", instanceType: "t3.micro", desiredCapacity: 1 },
        service: { desiredCount: 1, containerPort: 3001 },
        task: { cpu: 2048, memoryMb: 512 },
        image: { repository: "nebula-docs", tag: "local" },
        healthCheck: { path: "/docs" },
      }),
    ).toBe(false);
    expect(
      validate.errors?.some(
        (error: ErrorObject) => error.instancePath === "/task/cpu" && error.keyword === "maximum",
      ),
    ).toBe(true);
  });

  test("ecs schema rejects invalid autoscaling bounds", async () => {
    expect(
      ecsSchema.safeParse({
        cluster: {
          capacity: "ec2",
          instanceType: "t3.micro",
          desiredCapacity: 1,
          autoscaling: { minCapacity: 3, maxCapacity: 2 },
        },
        service: {
          desiredCount: 1,
          containerPort: 3001,
          autoscaling: { minCount: 4, maxCount: 2, targetCpuUtilization: 60 },
        },
        task: { cpu: 256, memoryMb: 512 },
        image: { repository: "nebula-docs", tag: "local" },
        healthCheck: { path: "/docs" },
      }).success,
    ).toBe(false);
  });

  test("ecs schema rejects autoscaling without target metrics", () => {
    expect(
      ecsSchema.safeParse({
        cluster: { capacity: "fargate" },
        service: {
          desiredCount: 1,
          containerPort: 3001,
          autoscaling: { minCount: 1, maxCount: 2 },
        },
        task: { cpu: 256, memoryMb: 512 },
        image: { repository: "nebula-docs", tag: "local" },
        healthCheck: { path: "/docs" },
      }).success,
    ).toBe(false);
  });

  test("ecs schema rejects invalid Fargate task size pairs", () => {
    expect(
      ecsSchema.safeParse({
        cluster: { capacity: "fargate" },
        service: { desiredCount: 1, containerPort: 3001 },
        task: { cpu: 256, memoryMb: 4096 },
        image: { repository: "nebula-docs", tag: "local" },
        healthCheck: { path: "/docs" },
      }).success,
    ).toBe(false);
  });

  test("ecs schema rejects EC2-only fields for Fargate", async () => {
    const validate = await compileSchema("schemas/ecs.schema.json");
    const config = {
      cluster: {
        capacity: "fargate",
        instanceType: "t3.micro",
        desiredCapacity: 1,
      },
      service: { desiredCount: 1, containerPort: 3001 },
      task: { cpu: 256, memoryMb: 512 },
      image: { repository: "nebula-docs", tag: "local" },
      healthCheck: { path: "/docs" },
    };

    expect(validate(config)).toBe(false);
    expect(
      validate.errors?.some(
        (error: ErrorObject) => error.instancePath === "/cluster" && error.keyword === "oneOf",
      ),
    ).toBe(true);
    expect(ecsSchema.safeParse(config).success).toBe(false);
  });

  test("ecs schema rejects missing EC2 capacity fields", () => {
    expect(
      ecsSchema.safeParse({
        cluster: { capacity: "ec2" },
        service: { desiredCount: 1, containerPort: 3001 },
        task: { cpu: 256, memoryMb: 512 },
        image: { repository: "nebula-docs", tag: "local" },
        healthCheck: { path: "/docs" },
      }).success,
    ).toBe(false);
  });

  test("lambda schema rejects unsupported runtime values", async () => {
    const validate = await compileSchema("schemas/lambda.schema.json");

    expect(
      validate({
        runtime: "ruby3.4",
        handler: "index.handler",
        package: "dist/app.zip",
        memoryMb: 128,
        timeoutSeconds: 10,
        logRetentionDays: 7,
        environment: {},
        permissions: { dynamodb: [] },
      }),
    ).toBe(false);
    expect(
      validate.errors?.some(
        (error: ErrorObject) => error.instancePath === "/runtime" && error.keyword === "enum",
      ),
    ).toBe(true);
  });

  test("network schema validates the sample network policy", async () => {
    const validate = await compileSchema("schemas/network.schema.json");
    const yaml = parse(
      await readFile("../../infra/services/dev/venture/core/network.yaml", "utf8"),
    );

    expect(validate(yaml), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});

async function compileSchema(schemaPath: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  return ajv.compile(schema);
}
