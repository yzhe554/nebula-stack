import type { z } from "zod";
import { networkPolicySchema } from "../schemas/network.schema";
import { serviceTypeRegistry } from "./services";

type JsonSchemaMetadata = { id: string; title: string; description: string };

export function generateSchema(schema: z.ZodType, metadata: JsonSchemaMetadata): string {
  return JSON.stringify(generateSchemaObject(schema, metadata), null, 2);
}

export function generateSchemaObject(
  schema: z.ZodType,
  metadata: JsonSchemaMetadata,
): Record<string, unknown> {
  const jsonSchema = schema.toJSONSchema() as Record<string, unknown>;

  return {
    ...jsonSchema,
    $id: metadata.id,
    title: metadata.title,
    description: metadata.description,
  };
}

function idFor(fileName: string): string {
  return `https://example.local/packages/platform/schemas/${fileName}`;
}

export function networkJsonSchema(): Record<string, unknown> {
  return generateSchemaObject(networkPolicySchema, {
    id: idFor("network.schema.json"),
    title: "Platform Network",
    description: "AWS-first IPv4 network intent for one env/venture/VPC.",
  });
}

export const platformJsonSchemas: Record<string, () => Record<string, unknown>> = {
  ...Object.fromEntries(
    serviceTypeRegistry.all().map((plugin) => [
      plugin.jsonSchemaMetadata.fileName,
      () =>
        generateSchemaObject(plugin.schema, {
          id: idFor(plugin.jsonSchemaMetadata.fileName),
          title: plugin.jsonSchemaMetadata.title,
          description: plugin.jsonSchemaMetadata.description,
        }),
    ]),
  ),
  "network.schema.json": networkJsonSchema,
};
