import { describe, expect, test } from "vitest";
import { createHandler } from "../index.mjs";

describe("payment-api handler", () => {
  test("writes one payment message to DynamoDB", async () => {
    const sent = [];
    const handler = createHandler({
      tableName: "payments-table",
      dynamoDbClient: {
        send: async (command) => {
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
