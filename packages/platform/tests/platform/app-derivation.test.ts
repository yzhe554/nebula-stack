import path from "node:path";
import { describe, expect, test } from "vitest";
import { deriveAppNames, validateAppExists } from "../../src/app-derivation";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

describe("deriveAppNames", () => {
  test("strips a trailing -app to get the app base", () => {
    expect(deriveAppNames("docs-app")).toEqual({
      base: "docs",
      dir: "apps/docs",
      packageName: "@repo/docs",
      dockerfile: "apps/Dockerfile",
    });
  });
  test("handles payments-app", () => {
    expect(deriveAppNames("payments-app").base).toBe("payments");
    expect(deriveAppNames("payments-app").packageName).toBe("@repo/payments");
  });
  test("leaves a name without -app suffix unchanged (lambda app)", () => {
    expect(deriveAppNames("payment-api")).toEqual({
      base: "payment-api",
      dir: "apps/payment-api",
      packageName: "@repo/payment-api",
      dockerfile: "apps/Dockerfile",
    });
  });
  test("only strips a SINGLE trailing -app", () => {
    expect(deriveAppNames("app-runner").base).toBe("app-runner");
    expect(deriveAppNames("my-app-app").base).toBe("my-app");
  });
});

test("validateAppExists passes for a real app (docs)", () => {
  expect(() => validateAppExists(deriveAppNames("docs-app"), repoRoot)).not.toThrow();
});
test("validateAppExists throws for a non-existent app", () => {
  expect(() => validateAppExists(deriveAppNames("ghost-app"), repoRoot)).toThrow(
    /app directory not found/i,
  );
});
