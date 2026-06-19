import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

export function createHandler({ tableName, dynamoDbClient }) {
  return async function handler(event) {
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

export async function handler(event) {
  const runtimeHandler = createHandler({
    tableName: requiredEnv("TABLE_NAME"),
    dynamoDbClient: new DynamoDBClient({
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "ap-southeast-2",
      endpoint: process.env.AWS_ENDPOINT_URL,
      credentials: process.env.AWS_ENDPOINT_URL
        ? { accessKeyId: "test", secretAccessKey: "test" }
        : undefined,
    }),
  });

  return runtimeHandler(event);
}

function parseBody(event) {
  if (!event?.body) {
    return {};
  }

  if (typeof event.body === "string") {
    return JSON.parse(event.body);
  }

  return event.body;
}

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
