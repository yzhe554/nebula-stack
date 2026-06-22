import { expect, test } from "vitest";
import { buildServiceUrls } from "../../src/cli/url";

test("gateway + alb urls for a fronted ecs app", () => {
  const out = buildServiceUrls([
    {
      serviceName: "docs-app",
      basePath: "/docs",
      gatewayId: "abc",
      albDns: "docs-x.elb.localhost",
      containerHost: "docs.floci.localhost",
      containerPort: 3001,
    },
  ]).join("\n");
  expect(out).toContain("http://localhost:4566/execute-api/abc/$default/docs");
  expect(out).toContain("http://docs-x.elb.localhost/docs");
});
test("Not deployed when gatewayId missing", () => {
  const out = buildServiceUrls([
    {
      serviceName: "docs-app",
      basePath: "/docs",
      gatewayId: undefined,
      albDns: undefined,
      containerHost: "h",
      containerPort: 3001,
    },
  ]).join("\n");
  expect(out).toMatch(/not deployed/i);
});
