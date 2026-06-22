import { describe, expect, test } from "vitest";
import { parseImageTagOverrides } from "../../src/image-tag-args";

describe("parseImageTagOverrides", () => {
  test("parses multiple service=tag pairs", () => {
    expect(parseImageTagOverrides(["docs-app=abc", "payments-app=def"])).toEqual({
      "docs-app": "abc",
      "payments-app": "def",
    });
  });

  test("empty input → empty map", () => {
    expect(parseImageTagOverrides([])).toEqual({});
  });

  test("tag may contain characters but the first = is the separator", () => {
    expect(parseImageTagOverrides(["docs-app=sha256:abc=def"])).toEqual({
      "docs-app": "sha256:abc=def",
    });
  });

  test("throws on a value with no =", () => {
    expect(() => parseImageTagOverrides(["docs-app"])).toThrow(/Invalid --image-tag/);
  });

  test("throws on a value beginning with =", () => {
    expect(() => parseImageTagOverrides(["=abc"])).toThrow(/Invalid --image-tag/);
  });
});
