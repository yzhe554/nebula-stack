import { describe, expect, test } from "vitest";
import { vpcDataSources, vpcNameTag } from "../../src/terraform/vpc-lookup";
import type { ServiceMetadata } from "../../src/types";

const metadata: ServiceMetadata = {
  env: "dev",
  venture: "venture",
  vpc: "core",
  securityZone: "public",
  serviceName: "docs-app",
  serviceType: "ecs",
  sourcePath: "infra/services/dev/venture/core/public/docs-app.ecs.yaml",
};

describe("vpcDataSources", () => {
  test("vpcNameTag builds the predictable vpc Name tag", () => {
    expect(vpcNameTag(metadata)).toBe("dev-venture-core-vpc");
  });

  test("emits aws_vpc selected by Name tag and subnets by Zone tag", () => {
    const data = vpcDataSources(metadata);
    expect(data.aws_vpc).toEqual({
      selected: { filter: { name: "tag:Name", values: ["dev-venture-core-vpc"] } },
    });
    expect(data.aws_subnets).toEqual({
      selected: {
        filter: [
          { name: "vpc-id", values: ["${data.aws_vpc.selected.id}"] },
          { name: "tag:Zone", values: ["public"] },
        ],
      },
    });
  });
});
