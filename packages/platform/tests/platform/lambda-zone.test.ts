import { describe, expect, test } from "vitest";
import { lambdaSchema } from "../../schemas/lambda.schema";

const base = {
  runtime: "nodejs22.x",
  handler: "index.handler",
  package: "../x.zip",
  memoryMb: 128,
  timeoutSeconds: 10,
  logRetentionDays: 7,
  environment: {},
  permissions: { dynamodb: [] },
};

describe("lambdaSchema zone", () => {
  test("defaults zone to internal when omitted", () => {
    expect(lambdaSchema.parse(base).zone).toBe("internal");
  });

  test("accepts an explicit zone", () => {
    expect(lambdaSchema.parse({ ...base, zone: "restricted" }).zone).toBe("restricted");
  });
});
