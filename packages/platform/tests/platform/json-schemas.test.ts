import { readFile } from "node:fs/promises";
import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { generateSchemaObject, platformJsonSchemas } from "../../src/schema-json";

describe("service JSON schemas", () => {
  test("generates JSON schemas through the Zod schema instance", () => {
    const schema = z.object({ serviceName: z.string() });
    (schema as unknown as { toJSONSchema: () => Record<string, unknown> }).toJSONSchema = () => ({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { serviceName: { type: "string" } },
      required: ["serviceName"],
      additionalProperties: false,
    });

    expect(generateSchemaObject(schema, {
      id: "https://example.local/packages/platform/schemas/test.schema.json",
      title: "Test Schema",
      description: "Generated via schema.toJSONSchema().",
    })).toEqual({
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
    const yaml = parse(await readFile("../../infra/services/dev/venture/core/internal/payment-api.lambda.yaml", "utf8"));

    expect(validate(yaml), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("dynamodb schema validates the sample DynamoDB YAML", async () => {
    const validate = await compileSchema("schemas/dynamodb.schema.json");
    const yaml = parse(await readFile("../../infra/services/dev/venture/core/managed/customer-records.dynamodb.yaml", "utf8"));

    expect(validate(yaml), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("api gateway schema validates the sample API Gateway YAML", async () => {
    const validate = await compileSchema("schemas/apigateway.schema.json");
    const yaml = parse(await readFile("../../infra/services/dev/venture/core/public/docs.apigateway.yaml", "utf8"));

    expect(validate(yaml), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("lambda schema rejects unsupported runtime values", async () => {
    const validate = await compileSchema("schemas/lambda.schema.json");

    expect(validate({
      runtime: "ruby3.4",
      handler: "index.handler",
      package: "dist/app.zip",
      memoryMb: 128,
      timeoutSeconds: 10,
      logRetentionDays: 7,
      environment: {},
      permissions: { dynamodb: [] },
    })).toBe(false);
    expect(validate.errors?.some((error: ErrorObject) => error.instancePath === "/runtime" && error.keyword === "enum")).toBe(true);
  });

  test("network schema validates the sample network policy", async () => {
    const validate = await compileSchema("schemas/network.schema.json");
    const yaml = parse(await readFile("../../infra/services/dev/venture/core/network.yaml", "utf8"));

    expect(validate(yaml), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});

async function compileSchema(schemaPath: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  return ajv.compile(schema);
}
