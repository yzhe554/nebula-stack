import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";

type PaymentBody = {
  customerId?: string;
  paymentId?: string;
  message?: string;
};

type PaymentBodyKey = keyof PaymentBody;

type DynamoDbSender = {
  send(command: PutItemCommand): Promise<unknown>;
};

type AppOptions = {
  tableName: string;
  dynamoDbClient: DynamoDbSender;
};

async function storePayment(
  body: PaymentBody,
  options: AppOptions,
): Promise<{ customerId: string; stored: true }> {
  const customerId = body.customerId ?? body.paymentId ?? `customer-${Date.now()}`;
  const message = body.message ?? "created";
  await options.dynamoDbClient.send(
    new PutItemCommand({
      TableName: options.tableName,
      Item: {
        customerId: { S: customerId },
        message: { S: message },
      },
    }),
  );
  return { customerId, stored: true };
}

export function createApp({ tableName, dynamoDbClient }: AppOptions) {
  const app = new Hono();

  app.post("/api/payments", async (context) => {
    const result = await storePayment(paymentBodyFrom(await context.req.json().catch(() => ({}))), {
      tableName,
      dynamoDbClient,
    });
    return context.json(result);
  });

  return app;
}

export function createLambdaHandler(options: AppOptions) {
  return handle(createApp(options));
}

type LambdaHandler = ReturnType<typeof handle>;

let runtimeHandler: LambdaHandler | undefined;

function isApiGatewayEvent(event: unknown): event is LambdaEvent {
  return (
    typeof event === "object" && event !== null && "requestContext" in event && "version" in event
  );
}

export async function invokeDirect(payload: unknown, options: AppOptions) {
  return storePayment(paymentBodyFrom(payload), options);
}

export function handler(event: unknown, context?: LambdaContext) {
  if (!isApiGatewayEvent(event)) {
    return invokeDirect(event, createRuntimeOptions());
  }
  runtimeHandler ??= createLambdaHandler(createRuntimeOptions());
  return runtimeHandler(event, context);
}

function createRuntimeOptions(): AppOptions {
  return {
    tableName: requiredEnv("TABLE_NAME"),
    dynamoDbClient: new DynamoDBClient({
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
      endpoint: process.env.AWS_ENDPOINT_URL,
      credentials: process.env.AWS_ENDPOINT_URL
        ? { accessKeyId: "test", secretAccessKey: "test" }
        : undefined,
    }),
  };
}

function paymentBodyFrom(value: unknown): PaymentBody {
  if (!value || typeof value !== "object") {
    return {};
  }

  return {
    customerId: propertyString(value, "customerId"),
    paymentId: propertyString(value, "paymentId"),
    message: propertyString(value, "message"),
  };
}

function propertyString(
  value: Partial<Record<PaymentBodyKey, unknown>>,
  property: PaymentBodyKey,
): string | undefined {
  if (!(property in value)) {
    return undefined;
  }

  return stringOrUndefined(value[property]);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
