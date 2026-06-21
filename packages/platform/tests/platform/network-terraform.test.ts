import { describe, expect, test } from "vitest";
import { terraformForNetwork } from "../../src/services/network/terraform";
import type { TerraformJson } from "../../src/terraform";
import type { LoadedService } from "../../src/types";

// Re-export TerraformJson type alias for local use
type TerraformObject = Record<string, unknown>;
type TerraformResult = TerraformJson & {
  data: TerraformObject;
  provider: { aws: TerraformObject };
  resource: TerraformObject;
};

function terraformResult(terraform: TerraformJson): TerraformResult {
  const provider = objectProperty(terraform, "provider");
  const resources = objectProperty(terraform, "resource");

  return {
    ...terraform,
    data: objectProperty(terraform, "data", true),
    provider: { aws: objectProperty(provider, "aws") },
    resource: resources,
  };
}

function resource(terraform: TerraformResult, type: string, name: string): TerraformObject {
  return objectProperty(objectProperty(terraform.resource, type), name);
}

function data(terraform: TerraformResult, type: string, name: string): TerraformObject {
  return objectProperty(objectProperty(terraform.data, type), name);
}

function objectProperty(
  object: TerraformObject,
  property: string,
  optional = false,
): TerraformObject {
  const value = object[property];

  if (optional && value === undefined) {
    return {};
  }

  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  if (!isTerraformObject(value)) {
    throw new TypeError(`Expected ${property} to be an object`);
  }

  return value;
}

function isTerraformObject(value: unknown): value is TerraformObject {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const networkService: LoadedService = {
  metadata: {
    env: "dev",
    venture: "venture",
    vpc: "core",
    securityZone: "network",
    serviceName: "network",
    serviceType: "network",
    sourcePath: "infra/services/dev/venture/core/network.yaml",
  },
  config: {
    cidrs: { ipv4: { vpc: "10.20.0.0/16" } },
    zones: {
      public: { description: "Public edge.", subnets: ["10.20.0.0/24", "10.20.1.0/24"] },
      internal: { description: "Internal.", subnets: ["10.20.10.0/24", "10.20.11.0/24"] },
    },
    flows: [
      { from: "public", to: "internal", ports: [443] },
      { from: "internal", to: "aws", services: ["dynamodb", "logs"] },
    ],
    awsEndpoints: {},
  },
};

// Narrow the type once so we can pass it to terraformForNetwork
type NetworkService = Extract<LoadedService, { metadata: { serviceType: "network" } }>;
const svc: NetworkService = networkService;

// ---------------------------------------------------------------------------
// Sub-task A: VPC + subnets
// ---------------------------------------------------------------------------

describe("terraformForNetwork – VPC + subnets", () => {
  const tf = terraformResult(terraformForNetwork(svc, { target: "aws" }));

  test("emits aws_vpc.network with correct CIDR and DNS settings", () => {
    const vpc = resource(tf, "aws_vpc", "network");
    expect(vpc).toMatchObject({
      cidr_block: "10.20.0.0/16",
      enable_dns_support: true,
      enable_dns_hostnames: true,
    });
    const tags = objectProperty(vpc, "tags");
    expect(tags["Name"]).toBe("dev-venture-core-vpc");
  });

  test("emits exactly the expected aws_subnet keys", () => {
    const subnetMap = objectProperty(tf.resource, "aws_subnet");
    const keys = Object.keys(subnetMap).sort();
    expect(keys).toEqual(["internal_0", "internal_1", "public_0", "public_1"]);
  });

  test("public_0 subnet has correct CIDR, map_public_ip_on_launch, and tags", () => {
    const subnet = resource(tf, "aws_subnet", "public_0");
    expect(subnet["cidr_block"]).toBe("10.20.0.0/24");
    expect(subnet["map_public_ip_on_launch"]).toBe(true);
    const tags = objectProperty(subnet, "tags");
    expect(tags["Zone"]).toBe("public");
    expect(tags["Name"]).toBe("dev-venture-core-public-0");
  });

  test("internal_0 subnet has map_public_ip_on_launch false and Zone tag", () => {
    const subnet = resource(tf, "aws_subnet", "internal_0");
    expect(subnet["map_public_ip_on_launch"]).toBe(false);
    const tags = objectProperty(subnet, "tags");
    expect(tags["Zone"]).toBe("internal");
  });

  test("data source aws_availability_zones.available is present", () => {
    const az = data(tf, "aws_availability_zones", "available");
    expect(az["state"]).toBe("available");
  });

  test("public_0 availability_zone references names[0]", () => {
    const subnet = resource(tf, "aws_subnet", "public_0");
    expect(subnet["availability_zone"]).toBe(
      "${data.aws_availability_zones.available.names[0]}",
    );
  });

  test("public_1 availability_zone references names[1]", () => {
    const subnet = resource(tf, "aws_subnet", "public_1");
    expect(subnet["availability_zone"]).toBe(
      "${data.aws_availability_zones.available.names[1]}",
    );
  });
});

// ---------------------------------------------------------------------------
// Sub-task B: routing
// ---------------------------------------------------------------------------

describe("terraformForNetwork – routing", () => {
  const tf = terraformResult(terraformForNetwork(svc, { target: "aws" }));

  test("emits aws_internet_gateway.network with vpc_id", () => {
    const igw = resource(tf, "aws_internet_gateway", "network");
    expect(igw["vpc_id"]).toBe("${aws_vpc.network.id}");
  });

  test("public route table has 0.0.0.0/0 route via IGW", () => {
    const rt = resource(tf, "aws_route_table", "public");
    expect(rt["route"]).toEqual([
      { cidr_block: "0.0.0.0/0", gateway_id: "${aws_internet_gateway.network.id}" },
    ]);
  });

  test("internal route table exists and has NO 0.0.0.0/0 route", () => {
    const rt = resource(tf, "aws_route_table", "internal");
    // Our implementation omits the `route` key entirely for non-public zones.
    expect(rt["route"]).toBeUndefined();
  });

  test("aws_route_table_association.public_0 points to public subnet and RT", () => {
    const assoc = resource(tf, "aws_route_table_association", "public_0");
    expect(assoc["subnet_id"]).toBe("${aws_subnet.public_0.id}");
    expect(assoc["route_table_id"]).toBe("${aws_route_table.public.id}");
  });

  test("aws_route_table_association.internal_0 points to internal subnet and RT", () => {
    const assoc = resource(tf, "aws_route_table_association", "internal_0");
    expect(assoc["subnet_id"]).toBe("${aws_subnet.internal_0.id}");
    expect(assoc["route_table_id"]).toBe("${aws_route_table.internal.id}");
  });
});

// ---------------------------------------------------------------------------
// Sub-task C: security groups + flow logs
// ---------------------------------------------------------------------------

describe("terraformForNetwork – security groups", () => {
  const tf = terraformResult(terraformForNetwork(svc, { target: "aws" }));

  test("emits aws_security_group keys [internal, public]", () => {
    const sgMap = objectProperty(tf.resource, "aws_security_group");
    const keys = Object.keys(sgMap).sort();
    expect(keys).toEqual(["internal", "public"]);
  });

  test("internal SG has vpc_id and correct Name tag", () => {
    const sg = resource(tf, "aws_security_group", "internal");
    expect(sg["vpc_id"]).toBe("${aws_vpc.network.id}");
    const tags = objectProperty(sg, "tags");
    expect(tags["Name"]).toBe("dev-venture-core-internal-sg");
  });

  test("emits ingress rule internal_from_public_443", () => {
    const rule = resource(tf, "aws_security_group_rule", "internal_from_public_443");
    expect(rule).toMatchObject({
      type: "ingress",
      from_port: 443,
      to_port: 443,
      protocol: "tcp",
      security_group_id: "${aws_security_group.internal.id}",
      source_security_group_id: "${aws_security_group.public.id}",
    });
  });

  test("NO security_group_rule key contains 'aws' (internal->aws flow produces no SG rule)", () => {
    const ruleMap = objectProperty(tf.resource, "aws_security_group_rule");
    const awsKeys = Object.keys(ruleMap).filter((k) => k.includes("aws"));
    expect(awsKeys).toEqual([]);
  });

  test("emits egress_all rule for internal zone", () => {
    const rule = resource(tf, "aws_security_group_rule", "internal_egress_all");
    expect(rule).toMatchObject({
      type: "egress",
      from_port: 0,
      to_port: 0,
      protocol: "-1",
      cidr_blocks: ["0.0.0.0/0"],
      security_group_id: "${aws_security_group.internal.id}",
    });
  });
});

describe("terraformForNetwork – flow logs", () => {
  const tf = terraformResult(terraformForNetwork(svc, { target: "aws" }));

  test("emits aws_flow_log.network with correct attributes", () => {
    const fl = resource(tf, "aws_flow_log", "network");
    expect(fl).toMatchObject({
      vpc_id: "${aws_vpc.network.id}",
      traffic_type: "ALL",
      log_destination_type: "cloud-watch-logs",
      log_destination: "${aws_cloudwatch_log_group.flow_logs.arn}",
      iam_role_arn: "${aws_iam_role.flow_logs.arn}",
    });
  });

  test("emits aws_cloudwatch_log_group.flow_logs with correct name", () => {
    const lg = resource(tf, "aws_cloudwatch_log_group", "flow_logs");
    expect(lg["name"]).toBe("/vpc/dev-venture-core/flow-logs");
    expect(lg["retention_in_days"]).toBe(7);
  });

  test("emits aws_iam_role.flow_logs", () => {
    const role = resource(tf, "aws_iam_role", "flow_logs");
    expect(role["name"]).toBe("dev-venture-core-flow-logs-role");
  });

  test("emits aws_iam_role_policy.flow_logs", () => {
    const policy = resource(tf, "aws_iam_role_policy", "flow_logs");
    expect(policy["name"]).toBe("dev-venture-core-flow-logs-policy");
    expect(policy["role"]).toBe("${aws_iam_role.flow_logs.id}");
  });
});
