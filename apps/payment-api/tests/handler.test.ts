import { describe, expect, test } from "vitest";
import type { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { createHandler } from "../index";

describe("payment-api handler", () => {
  test("writes one payment message to DynamoDB", async () => {
    const sent: unknown[] = [];
    const handler = createHandler({
      tableName: "payments-table",
      dynamoDbClient: {
        send: async (command: PutItemCommand) => {
          sent.push(command.input);
          return {};
        },
      },
    });

    const response = await handler({
      body: JSON.stringify({ customerId: "customer-123", message: "approved" }),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ customerId: "customer-123", stored: true });
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
});
