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

type DynamoDbSender = {
  send(command: PutItemCommand): Promise<unknown>;
};

type HandlerOptions = {
  tableName: string;
  dynamoDbClient: DynamoDbSender;
};

export function createHandler({ tableName, dynamoDbClient }: HandlerOptions) {
  return async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
    const body = parseBody(event);
    const customerId = body.customerId ?? body.paymentId ?? `customer-${Date.now()}`;
    const message = body.message ?? "created";

    await dynamoDbClient.send(new PutItemCommand({
        TableName: tableName,
        Item: {
          customerId: { S: customerId },
          message: { S: message },
        },
    }));

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
    return JSON.parse(event.body) as PaymentBody;
  }

  return event.body as PaymentBody;
}

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
