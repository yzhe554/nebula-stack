import { z } from "zod";

export const dynamoDbAttributeTypeValues = ["S", "N", "B"] as const;

const dynamoDbAttributeSchema = z.object({
  name: z.string().min(1),
  type: z.enum(dynamoDbAttributeTypeValues),
});

export const dynamoDbSchema = z.object({
  billingMode: z.literal("PAY_PER_REQUEST"),
  hashKey: dynamoDbAttributeSchema,
  rangeKey: dynamoDbAttributeSchema.optional(),
  pointInTimeRecovery: z.boolean(),
});
