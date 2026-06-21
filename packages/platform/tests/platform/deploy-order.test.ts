import { describe, expect, test } from "vitest";
import { serviceTypeRegistry } from "../../src/services";

describe("deploy priority", () => {
  test("orders dynamodb < lambda < ecs < apigateway", () => {
    const priority = (t: "dynamodb" | "lambda" | "ecs" | "apigateway") =>
      serviceTypeRegistry.get(t).deployPriority;
    expect(priority("dynamodb")).toBeLessThan(priority("lambda"));
    expect(priority("lambda")).toBeLessThan(priority("ecs"));
    expect(priority("ecs")).toBeLessThan(priority("apigateway"));
  });

  test("network deploys before all other service types", () => {
    const priority = (t: "network" | "dynamodb" | "lambda" | "ecs" | "apigateway") =>
      serviceTypeRegistry.get(t).deployPriority;
    expect(priority("network")).toBeLessThan(priority("dynamodb"));
    expect(priority("network")).toBeLessThan(priority("lambda"));
    expect(priority("network")).toBeLessThan(priority("ecs"));
    expect(priority("network")).toBeLessThan(priority("apigateway"));
  });
});
