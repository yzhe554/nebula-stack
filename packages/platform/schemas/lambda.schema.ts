import { z } from "zod";

export const lambdaRuntimeValues = [
  "nodejs22.x",
  "nodejs20.x",
  "python3.13",
  "python3.12",
  "java21",
  "dotnet8",
  "provided.al2023",
] as const;

export const lambdaLogRetentionDaysValues = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288,
  3653,
] as const;

export const dynamoDbActionValues = [
  "dynamodb:PutItem",
  "dynamodb:GetItem",
  "dynamodb:UpdateItem",
  "dynamodb:DeleteItem",
  "dynamodb:Query",
  "dynamodb:Scan",
] as const;

export const lambdaSchema = z.object({
  runtime: z.enum(lambdaRuntimeValues),
  handler: z.string().min(1),
  package: z.string().min(1),
  memoryMb: z.number().int().min(128).max(10240),
  timeoutSeconds: z.number().int().min(1).max(900),
  logRetentionDays: z.literal(lambdaLogRetentionDaysValues),
  environment: z.record(z.string(), z.string()),
  zone: z.string().min(1).default("internal").optional(),
  permissions: z.object({
    dynamodb: z.array(
      z.object({
        service: z.string().min(1),
        actions: z.array(z.enum(dynamoDbActionValues)).min(1),
      }),
    ),
  }),
});
