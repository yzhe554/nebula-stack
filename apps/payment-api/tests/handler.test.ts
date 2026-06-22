import { describe, expect, test } from "vitest";
import type { PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { LambdaEvent } from "hono/aws-lambda";
import { createApp, createLambdaHandler, invokeDirect } from "../index";

describe("payment-api app", () => {
  test("writes one payment message to DynamoDB", async () => {
    const sent: unknown[] = [];
    const app = createApp({
      tableName: "payments-table",
      dynamoDbClient: {
        send: async (command: PutItemCommand) => {
          sent.push(command.input);
          return {};
        },
      },
    });

    const response = await app.request("/api/payments", {
      method: "POST",
      body: JSON.stringify({ customerId: "customer-123", message: "approved" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ customerId: "customer-123", stored: true });
    expect(sent).toEqual([
      {
        TableName: "payments-table",
        Item: {
          customerId: { S: "customer-123" },
          message: { S: "approved" },
        },
      },
    ]);
  });

  test("returns not found for unsupported routes", async () => {
    const app = createApp({
      tableName: "payments-table",
      dynamoDbClient: {
        send: async () => ({}),
      },
    });

    const response = await app.request("/api/unknown", { method: "POST" });

    expect(response.status).toBe(404);
  });

  test("maps direct Lambda invoke payloads to the Hono payment route", async () => {
    const sent: unknown[] = [];
    const handler = createLambdaHandler({
      tableName: "payments-table",
      dynamoDbClient: {
        send: async (command: PutItemCommand) => {
          sent.push(command.input);
          return {};
        },
      },
    });

    const response = await handler(paymentApiGatewayEvent("customer-direct", "approved-direct"));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      customerId: "customer-direct",
      stored: true,
    });
    expect(sent).toEqual([
      {
        TableName: "payments-table",
        Item: {
          customerId: { S: "customer-direct" },
          message: { S: "approved-direct" },
        },
      },
    ]);
  });
});

test("invokeDirect writes a raw payload to DynamoDB and returns stored", async () => {
  const sent: unknown[] = [];
  const result = await invokeDirect(
    { customerId: "c-direct", message: "raw-invoke" },
    {
      tableName: "payments-table",
      dynamoDbClient: {
        send: async (command: PutItemCommand) => {
          sent.push(command.input);
          return {};
        },
      },
    },
  );
  expect(result).toEqual({ customerId: "c-direct", stored: true });
  expect(sent).toEqual([
    {
      TableName: "payments-table",
      Item: { customerId: { S: "c-direct" }, message: { S: "raw-invoke" } },
    },
  ]);
});

function paymentApiGatewayEvent(customerId: string, message: string): LambdaEvent {
  return {
    version: "2.0",
    routeKey: "POST /api/payments",
    rawPath: "/api/payments",
    rawQueryString: "",
    headers: { "content-type": "application/json", host: "lambda.local" },
    requestContext: {
      accountId: "local",
      apiId: "local",
      authentication: null,
      authorizer: {},
      domainName: "lambda.local",
      domainPrefix: "lambda",
      http: {
        method: "POST",
        path: "/api/payments",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "local-invoke",
      },
      requestId: "local",
      routeKey: "POST /api/payments",
      stage: "$default",
      time: "01/Jan/1970:00:00:00 +0000",
      timeEpoch: 0,
    },
    body: JSON.stringify({ customerId, message }),
    isBase64Encoded: false,
  };
}
