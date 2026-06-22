import { describe, expect, test } from "vitest";
import { scrubbedEnv, FLOCI_ENDPOINT } from "../../src/cli/floci-env";

describe("floci scrubbed env", () => {
  test("sets test creds + region, keeps PATH", () => {
    const env = scrubbedEnv({ HTTP_PROXY: "http://corp", PATH: "/usr/bin" });
    expect(env.AWS_ACCESS_KEY_ID).toBe("test");
    expect(env.AWS_DEFAULT_REGION).toBe("us-east-1");
    expect(env.PATH).toBe("/usr/bin");
  });
  test("removes proxy vars", () => {
    const env = scrubbedEnv({ HTTP_PROXY: "x", HTTPS_PROXY: "y", http_proxy: "z" });
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
  });
  test("host-side endpoint", () => {
    expect(FLOCI_ENDPOINT).toBe("http://localhost:4566");
  });
});
