import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";

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

export function createApp({ tableName, dynamoDbClient }: AppOptions) {
  const app = new Hono();

  app.post("/api/payments", async (context) => {
    const body = paymentBodyFrom(await context.req.json().catch(() => ({})));
    const customerId = body.customerId ?? body.paymentId ?? `customer-${Date.now()}`;
    const message = body.message ?? "created";

    await dynamoDbClient.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          customerId: { S: customerId },
          message: { S: message },
        },
      }),
    );

    return context.json({ customerId, stored: true });
  });

  return app;
}

export function createLambdaHandler(options: AppOptions) {
  return handle(createApp(options));
}

type LambdaHandler = ReturnType<typeof handle>;

let runtimeHandler: LambdaHandler | undefined;

export function handler(...args: Parameters<LambdaHandler>) {
  runtimeHandler ??= createLambdaHandler(createRuntimeOptions());

  return runtimeHandler(...args);
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
