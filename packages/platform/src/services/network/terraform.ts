import { baseTerraform, regionForTarget, tagsFor, type TerraformJson } from "../../terraform/base";
import type { TerraformContext } from "../../terraform/context";
import type { LoadedService } from "../../types";
import { gatewayEndpointResources, interfaceEndpointResources } from "./endpoints";

export type NetworkService = Extract<LoadedService, { metadata: { serviceType: "network" } }>;

function vpcName(m: NetworkService["metadata"]): string {
  return `${m.env}-${m.venture}-${m.vpc}-vpc`;
}

type SubnetEntry = { key: string; zone: string; index: number; cidr: string };

function subnetEntries(service: NetworkService): SubnetEntry[] {
  const entries: SubnetEntry[] = [];
  for (const [zone, cfg] of Object.entries(service.config.zones)) {
    cfg.subnets.forEach((cidr, index) =>
      entries.push({ key: `${zone}_${index}`, zone, index, cidr }),
    );
  }
  return entries;
}

export function terraformForNetwork(
  service: NetworkService,
  options: TerraformContext,
): TerraformJson {
  const m = service.metadata;
  const entries = subnetEntries(service);
  const zones = Object.keys(service.config.zones);

  // -------------------------------------------------------------------------
  // Sub-task A: VPC + subnets
  // -------------------------------------------------------------------------

  const subnets: Record<string, unknown> = {};
  entries.forEach((entry, flatIndex) => {
    subnets[entry.key] = {
      vpc_id: "${aws_vpc.network.id}",
      cidr_block: entry.cidr,
      // Index modulo the available-AZ count so configs with more subnets than
      // AZs (or AZ-poor environments like LocalStack's 3) still resolve.
      availability_zone: `\${data.aws_availability_zones.available.names[${flatIndex} % length(data.aws_availability_zones.available.names)]}`,
      map_public_ip_on_launch: entry.zone === "public",
      tags: {
        ...tagsFor(m),
        Name: `${m.env}-${m.venture}-${m.vpc}-${entry.zone}-${entry.index}`,
        Zone: entry.zone,
      },
    };
  });

  // -------------------------------------------------------------------------
  // Sub-task B: routing
  // -------------------------------------------------------------------------

  const routeTables: Record<string, unknown> = {};
  for (const zone of zones) {
    routeTables[zone] = {
      vpc_id: "${aws_vpc.network.id}",
      tags: { ...tagsFor(m), Name: `${m.env}-${m.venture}-${m.vpc}-${zone}-rt` },
    };
  }

  // Internet route for public zones expressed as a standalone aws_route resource.
  // Inline `route` blocks on aws_route_table require every possible target
  // attribute to be set, so a standalone resource is the correct shape.
  const routes: Record<string, unknown> = {};
  if (zones.includes("public")) {
    routes["public_internet"] = {
      route_table_id: "${aws_route_table.public.id}",
      destination_cidr_block: "0.0.0.0/0",
      gateway_id: "${aws_internet_gateway.network.id}",
    };
  }

  const routeTableAssociations: Record<string, unknown> = {};
  for (const entry of entries) {
    routeTableAssociations[entry.key] = {
      subnet_id: `\${aws_subnet.${entry.key}.id}`,
      route_table_id: `\${aws_route_table.${entry.zone}.id}`,
    };
  }

  // -------------------------------------------------------------------------
  // Sub-task C: security groups + flow logs
  // -------------------------------------------------------------------------

  const securityGroups: Record<string, unknown> = {};
  for (const zone of zones) {
    const sgName = `${m.env}-${m.venture}-${m.vpc}-${zone}-sg`;
    securityGroups[zone] = {
      name: sgName,
      vpc_id: "${aws_vpc.network.id}",
      tags: { ...tagsFor(m), Name: sgName },
    };
  }

  const zoneSet = new Set(zones);
  const sgRules: Record<string, unknown> = {};
  const resolvedTarget = options.target ?? "aws";

  // Inter-zone ingress rules (source_security_group_id) express the bank-grade
  // segmentation posture and are emitted only for the aws target. Floci does not
  // support security-group-rule creation that references a source SG, and these
  // rules are not on the ECS/API Gateway connectivity path (ECS uses its own SG;
  // the VPC lookup only consumes aws_vpc + aws_subnets).
  if (resolvedTarget === "aws") {
    for (const flow of service.config.flows) {
      if (!zoneSet.has(flow.from) || !zoneSet.has(flow.to)) {
        continue;
      }
      if (!flow.ports) {
        continue;
      }
      for (const port of flow.ports) {
        const key = `${flow.to}_from_${flow.from}_${port}`;
        sgRules[key] = {
          type: "ingress",
          from_port: port,
          to_port: port,
          protocol: "tcp",
          security_group_id: `\${aws_security_group.${flow.to}.id}`,
          source_security_group_id: `\${aws_security_group.${flow.from}.id}`,
        };
      }
    }

    // Egress-all rules per zone
    for (const zone of zones) {
      sgRules[`${zone}_egress_all`] = {
        type: "egress",
        from_port: 0,
        to_port: 0,
        protocol: "-1",
        cidr_blocks: ["0.0.0.0/0"],
        security_group_id: `\${aws_security_group.${zone}.id}`,
      };
    }
  }

  const namePrefix = `${m.env}-${m.venture}-${m.vpc}`;
  const target = options.target ?? "aws";

  // VPC Flow Logs are emitted only for the aws target. LocalStack (Community)
  // does not support CreateFlowLogs, so they are omitted for floci so the
  // network module can apply locally. Real AWS keeps full audit logging.
  const flowLogResources = target === "aws" ? flowLogResourcesFor(m, namePrefix) : {};

  // VPC endpoints (gateway + interface) are derived from services' permissions
  // and emitted only for the aws target. Floci reaches AWS via AWS_ENDPOINT_URL,
  // so no real endpoint is needed locally. Interface endpoints contribute an
  // endpoints security group + ingress rule + a subnet data source, all merged
  // into the corresponding maps below.
  const requiredEndpoints = options.requiredAwsEndpoints ?? [];
  const endpointContext = {
    region: regionForTarget(target),
    zone: "internal",
    namePrefix,
  };
  const gatewayEndpoints: Record<string, unknown> =
    target === "aws" ? gatewayEndpointResources(requiredEndpoints, endpointContext) : {};
  const interfaceEndpoints: Record<string, unknown> =
    target === "aws" ? interfaceEndpointResources(requiredEndpoints, endpointContext) : {};

  const vpcEndpoints: Record<string, unknown> = {
    ...(isRecord(gatewayEndpoints.aws_vpc_endpoint) ? gatewayEndpoints.aws_vpc_endpoint : {}),
    ...(isRecord(interfaceEndpoints.aws_vpc_endpoint) ? interfaceEndpoints.aws_vpc_endpoint : {}),
  };

  const mergedSecurityGroups: Record<string, unknown> = {
    ...securityGroups,
    ...(isRecord(interfaceEndpoints.aws_security_group)
      ? interfaceEndpoints.aws_security_group
      : {}),
  };
  const mergedSgRules: Record<string, unknown> = {
    ...sgRules,
    ...(isRecord(interfaceEndpoints.aws_security_group_rule)
      ? interfaceEndpoints.aws_security_group_rule
      : {}),
  };
  const interfaceData = isRecord(interfaceEndpoints.data) ? interfaceEndpoints.data : {};
  const endpointSubnetData = isRecord(interfaceData.aws_subnets) ? interfaceData.aws_subnets : {};

  return baseTerraform(
    m,
    target,
    {
      aws_vpc: {
        network: {
          cidr_block: service.config.cidrs.ipv4.vpc,
          enable_dns_support: true,
          enable_dns_hostnames: true,
          tags: { ...tagsFor(m), Name: vpcName(m) },
        },
      },
      aws_subnet: subnets,
      aws_internet_gateway: {
        network: {
          vpc_id: "${aws_vpc.network.id}",
          tags: { ...tagsFor(m), Name: `${namePrefix}-igw` },
        },
      },
      aws_route_table: routeTables,
      ...(Object.keys(routes).length > 0 ? { aws_route: routes } : {}),
      aws_route_table_association: routeTableAssociations,
      aws_security_group: mergedSecurityGroups,
      ...(Object.keys(mergedSgRules).length > 0 ? { aws_security_group_rule: mergedSgRules } : {}),
      ...(Object.keys(vpcEndpoints).length > 0 ? { aws_vpc_endpoint: vpcEndpoints } : {}),
      ...flowLogResources,
    },
    {
      aws_availability_zones: { available: { state: "available" } },
      ...(Object.keys(endpointSubnetData).length > 0 ? { aws_subnets: endpointSubnetData } : {}),
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function flowLogResourcesFor(
  m: NetworkService["metadata"],
  namePrefix: string,
): Record<string, unknown> {
  const flowLogsRolePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
        ],
        Resource: "*",
      },
    ],
  });

  const flowLogsAssumeRolePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: { Service: "vpc-flow-logs.amazonaws.com" },
      },
    ],
  });

  return {
    aws_cloudwatch_log_group: {
      flow_logs: {
        name: `/vpc/${namePrefix}/flow-logs`,
        retention_in_days: 7,
        tags: tagsFor(m),
      },
    },
    aws_iam_role: {
      flow_logs: {
        name: `${namePrefix}-flow-logs-role`,
        assume_role_policy: flowLogsAssumeRolePolicy,
        tags: tagsFor(m),
      },
    },
    aws_iam_role_policy: {
      flow_logs: {
        name: `${namePrefix}-flow-logs-policy`,
        role: "${aws_iam_role.flow_logs.id}",
        policy: flowLogsRolePolicy,
      },
    },
    aws_flow_log: {
      network: {
        vpc_id: "${aws_vpc.network.id}",
        traffic_type: "ALL",
        log_destination_type: "cloud-watch-logs",
        log_destination: "${aws_cloudwatch_log_group.flow_logs.arn}",
        iam_role_arn: "${aws_iam_role.flow_logs.arn}",
        tags: tagsFor(m),
      },
    },
  };
}
