import type { z } from "zod";
import { dynamoDbSchema } from "../../schemas/dynamodb.schema.js";
import { lambdaSchema } from "../../schemas/lambda.schema.js";
import { networkPolicySchema } from "../../schemas/network.schema.js";

type JsonSchemaMetadata = { id: string; title: string; description: string };

export function generateSchema(schema: z.ZodType, metadata: JsonSchemaMetadata): string {
  return JSON.stringify(generateSchemaObject(schema, metadata), null, 2);
}

export function generateSchemaObject(schema: z.ZodType, metadata: JsonSchemaMetadata): Record<string, unknown> {
  const jsonSchema = schema.toJSONSchema() as Record<string, unknown>;

  return {
    ...jsonSchema,
    $id: metadata.id,
    title: metadata.title,
    description: metadata.description,
  };
}

export function lambdaJsonSchema(): Record<string, unknown> {
  return generateSchemaObject(lambdaSchema, {
    id: "https://example.local/schemas/lambda.schema.json",
    title: "Platform Lambda Service",
    description: "YAML schema for AWS Lambda services deployed by the platform.",
  });
}

export function dynamoDbJsonSchema(): Record<string, unknown> {
  return generateSchemaObject(dynamoDbSchema, {
    id: "https://example.local/schemas/dynamodb.schema.json",
    title: "Platform DynamoDB Service",
    description: "YAML schema for AWS DynamoDB tables deployed by the platform.",
  });
}

export function networkJsonSchema(): Record<string, unknown> {
  return generateSchemaObject(networkPolicySchema, {
    id: "https://example.local/schemas/network.schema.json",
    title: "Platform Network",
    description: "AWS-first IPv4 network intent for one env/venture/VPC.",
  });
}

export const platformJsonSchemas = {
  "lambda.schema.json": lambdaJsonSchema,
  "dynamodb.schema.json": dynamoDbJsonSchema,
  "network.schema.json": networkJsonSchema,
} as const;
