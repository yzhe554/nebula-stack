import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createServiceTypeRegistry, type ServiceTypePlugin } from "../../src/services/service-type";

const fakePlugin: ServiceTypePlugin = {
  type: "dynamodb",
  fileSuffix: "dynamodb",
  schema: z.object({}).passthrough(),
  jsonSchemaMetadata: { fileName: "x.schema.json", title: "X", description: "x" },
  deployPriority: 0,
  validateReferences: () => [],
  toTerraform: () => ({ resource: {} }),
};

describe("service type registry", () => {
  test("registers and retrieves a plugin by type", () => {
    const registry = createServiceTypeRegistry([fakePlugin]);
    expect(registry.get("dynamodb")).toBe(fakePlugin);
  });

  test("looks up a plugin by file suffix", () => {
    const registry = createServiceTypeRegistry([fakePlugin]);
    expect(registry.forFileSuffix("dynamodb")).toBe(fakePlugin);
    expect(registry.forFileSuffix("nope")).toBeUndefined();
  });

  test("throws for an unknown type", () => {
    const registry = createServiceTypeRegistry([fakePlugin]);
    expect(() => registry.get("lambda")).toThrow("No plugin registered for service type lambda");
  });

  test("rejects duplicate plugin types", () => {
    expect(() => createServiceTypeRegistry([fakePlugin, fakePlugin])).toThrow(
      "Duplicate service type plugin registered for dynamodb",
    );
  });

  test("rejects duplicate plugin file suffixes", () => {
    const duplicateSuffixPlugin: ServiceTypePlugin = {
      ...fakePlugin,
      type: "lambda",
    };

    expect(() => createServiceTypeRegistry([fakePlugin, duplicateSuffixPlugin])).toThrow(
      "Duplicate service type plugin file suffix registered for dynamodb",
    );
  });

  test("lists all plugins", () => {
    const registry = createServiceTypeRegistry([fakePlugin]);
    expect(registry.all()).toEqual([fakePlugin]);
  });
});
