import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

type ApiGatewayEvent = {
  body?: string | Record<string, unknown> | null;
};

type ApiGatewayResponse = {
  statusCode: number;
  body: string;
};

type PaymentBody = {
  customerId?: string;
  paymentId?: string;
  message?: string;
};

type PaymentBodyKey = keyof PaymentBody;

type DynamoDbSender = {
  send(command: PutItemCommand): Promise<unknown>;
};

type HandlerOptions = {
  tableName: string;
  dynamoDbClient: DynamoDbSender;
};

export function createHandler({ tableName, dynamoDbClient }: HandlerOptions) {
  return async function handlePayment(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
    const body = parseBody(event);
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

    return {
      statusCode: 200,
      body: JSON.stringify({ customerId, stored: true }),
    };
  };
}

export async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
  const runtimeHandler = createHandler({
    tableName: requiredEnv("TABLE_NAME"),
    dynamoDbClient: new DynamoDBClient({
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
      endpoint: process.env.AWS_ENDPOINT_URL,
      credentials: process.env.AWS_ENDPOINT_URL
        ? { accessKeyId: "test", secretAccessKey: "test" }
        : undefined,
    }),
  });

  return runtimeHandler(event);
}

function parseBody(event: ApiGatewayEvent): PaymentBody {
  if (!event?.body) {
    return {};
  }

  if (typeof event.body === "string") {
    return paymentBodyFrom(JSON.parse(event.body));
  }

  return paymentBodyFrom(event.body);
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
