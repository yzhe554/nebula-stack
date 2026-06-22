import type { LoadedService, LambdaConfig, EcsConfig, ServiceMetadata } from "../../types";

export type AwsEndpointService = "dynamodb" | "s3" | "lambda" | "logs" | "sts" | "kms";

const GATEWAY_SERVICES = new Set<AwsEndpointService>(["dynamodb", "s3"]);

export function endpointKind(service: AwsEndpointService): "gateway" | "interface" {
  return GATEWAY_SERVICES.has(service) ? "gateway" : "interface";
}

type LambdaService = {
  metadata: ServiceMetadata & { serviceType: "lambda" };
  config: LambdaConfig;
};

type EcsService = {
  metadata: ServiceMetadata & { serviceType: "ecs" };
  config: EcsConfig;
};

function isLambdaService(service: LoadedService): service is LambdaService {
  return service.metadata.serviceType === "lambda";
}

function isEcsService(service: LoadedService): service is EcsService {
  return service.metadata.serviceType === "ecs";
}

export function deriveRequiredAwsEndpoints(services: LoadedService[]): AwsEndpointService[] {
  const required = new Set<AwsEndpointService>();
  for (const service of services) {
    if (isLambdaService(service) && service.config.permissions.dynamodb.length > 0) {
      required.add("dynamodb");
    }
    if (isEcsService(service) && (service.config.permissions?.lambda?.length ?? 0) > 0) {
      required.add("lambda");
    }
  }
  return [...required].sort();
}

export type EndpointContext = { region: string; zone: string; namePrefix: string };

export type GatewayEndpointResult = Record<string, Record<string, unknown>>;
export type InterfaceEndpointResult = {
  aws_vpc_endpoint: Record<string, unknown>;
  aws_security_group: Record<string, unknown>;
  aws_security_group_rule: Record<string, unknown>;
  data: {
    aws_subnets: Record<string, Record<string, unknown>>;
  };
};

export function gatewayEndpointResources(
  services: AwsEndpointService[],
  ctx: EndpointContext,
): GatewayEndpointResult {
  const gateways = services.filter((s) => endpointKind(s) === "gateway");
  if (gateways.length === 0) return {};
  const endpoints: Record<string, unknown> = {};
  for (const service of gateways) {
    endpoints[service] = {
      vpc_id: "${aws_vpc.network.id}",
      service_name: `com.amazonaws.${ctx.region}.${service}`,
      vpc_endpoint_type: "Gateway",
      route_table_ids: [`\${aws_route_table.${ctx.zone}.id}`],
    };
  }
  return { aws_vpc_endpoint: endpoints };
}

export function interfaceEndpointResources(
  services: AwsEndpointService[],
  ctx: EndpointContext,
): InterfaceEndpointResult | Record<never, never> {
  const interfaces = services.filter((s) => endpointKind(s) === "interface");
  if (interfaces.length === 0) return {};
  const endpoints: Record<string, unknown> = {};
  for (const service of interfaces) {
    endpoints[service] = {
      vpc_id: "${aws_vpc.network.id}",
      service_name: `com.amazonaws.${ctx.region}.${service}`,
      vpc_endpoint_type: "Interface",
      subnet_ids: `\${data.aws_subnets.${ctx.zone}_endpoints.ids}`,
      security_group_ids: ["${aws_security_group.endpoints.id}"],
      private_dns_enabled: true,
    };
  }
  return {
    aws_vpc_endpoint: endpoints,
    aws_security_group: {
      endpoints: { name: `${ctx.namePrefix}-endpoints-sg`, vpc_id: "${aws_vpc.network.id}" },
    },
    aws_security_group_rule: {
      endpoints_ingress_443: {
        type: "ingress",
        from_port: 443,
        to_port: 443,
        protocol: "tcp",
        security_group_id: "${aws_security_group.endpoints.id}",
        source_security_group_id: `\${aws_security_group.${ctx.zone}.id}`,
      },
    },
    data: {
      aws_subnets: {
        [`${ctx.zone}_endpoints`]: {
          filter: [
            { name: "vpc-id", values: ["${aws_vpc.network.id}"] },
            { name: "tag:Zone", values: [ctx.zone] },
          ],
        },
      },
    },
  };
}
