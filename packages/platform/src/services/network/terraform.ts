import { baseTerraform, tagsFor, type TerraformJson } from "../../terraform/base";
import type { TerraformContext } from "../../terraform/context";
import type { LoadedService } from "../../types";

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
      availability_zone: `\${data.aws_availability_zones.available.names[${flatIndex}]}`,
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
    const rt: Record<string, unknown> = {
      vpc_id: "${aws_vpc.network.id}",
      tags: { ...tagsFor(m), Name: `${m.env}-${m.venture}-${m.vpc}-${zone}-rt` },
    };
    if (zone === "public") {
      rt["route"] = [
        { cidr_block: "0.0.0.0/0", gateway_id: "${aws_internet_gateway.network.id}" },
      ];
    }
    routeTables[zone] = rt;
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

  // Ingress rules for flows between real zones with ports
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

  // Flow logs
  const flowLogsPrefix = `${m.env}-${m.venture}-${m.vpc}`;

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

  return baseTerraform(
    m,
    options.target ?? "aws",
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
          tags: { ...tagsFor(m), Name: `${flowLogsPrefix}-igw` },
        },
      },
      aws_route_table: routeTables,
      aws_route_table_association: routeTableAssociations,
      aws_security_group: securityGroups,
      aws_security_group_rule: sgRules,
      aws_cloudwatch_log_group: {
        flow_logs: {
          name: `/vpc/${flowLogsPrefix}/flow-logs`,
          retention_in_days: 7,
          tags: tagsFor(m),
        },
      },
      aws_iam_role: {
        flow_logs: {
          name: `${flowLogsPrefix}-flow-logs-role`,
          assume_role_policy: flowLogsAssumeRolePolicy,
          tags: tagsFor(m),
        },
      },
      aws_iam_role_policy: {
        flow_logs: {
          name: `${flowLogsPrefix}-flow-logs-policy`,
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
    },
    {
      aws_availability_zones: { available: { state: "available" } },
    },
  );
}
