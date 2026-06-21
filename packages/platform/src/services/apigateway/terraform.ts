import { baseTerraform, regionForTarget, tagsFor, type TerraformJson } from "../../terraform/base";
import { physicalName, terraformName } from "../../terraform/naming";
import { requireServiceContainerPorts, type TerraformContext } from "../../terraform/context";
import type {
  ApiGatewayRoute,
  ApiGatewayRouteTarget,
  LoadedService,
  ServiceMetadata,
} from "../../types";

export type ApiGatewayService = Extract<LoadedService, { metadata: { serviceType: "apigateway" } }>;

type ResolvedApiGatewayRoute = ApiGatewayRoute & { resolvedTarget: ApiGatewayRouteTarget };
type ResolvedLambdaRoute = ResolvedApiGatewayRoute & {
  resolvedTarget: Extract<ApiGatewayRouteTarget, { type: "lambda" }>;
};
type ResolvedEcsRoute = ResolvedApiGatewayRoute & {
  resolvedTarget: Extract<ApiGatewayRouteTarget, { type: "ecs" }>;
};

export function terraformForApiGateway(
  service: ApiGatewayService,
  options: TerraformContext,
): TerraformJson {
  const resourceName = terraformName(service.metadata.serviceName);
  const routes = service.config.routes.map((route) => resolveApiGatewayRoute(route, options));

  const domainTerraform = apiGatewayDomainResources(service, resourceName, options);
  const dataTerraform = {
    ...domainTerraform.data,
    ...apiGatewayEcsTargetData(routes, options),
  };

  return baseTerraform(
    service.metadata,
    options.target ?? "aws",
    {
      aws_apigatewayv2_api: {
        [resourceName]: {
          name: physicalName(service.metadata),
          protocol_type: "HTTP",
          description: service.config.description,
          tags: tagsFor(service.metadata),
        },
      },
      aws_apigatewayv2_stage: {
        [`${resourceName}_default`]: {
          api_id: `\${aws_apigatewayv2_api.${resourceName}.id}`,
          name: "$default",
          auto_deploy: true,
          ...apiGatewayStageTagConfig(service.metadata, options),
        },
      },
      aws_apigatewayv2_integration: Object.fromEntries(
        routes.map((route) => {
          const routeName = apiGatewayRouteName(resourceName, route);

          return [
            routeName,
            {
              api_id: `\${aws_apigatewayv2_api.${resourceName}.id}`,
              integration_type: route.resolvedTarget.type === "lambda" ? "AWS_PROXY" : "HTTP_PROXY",
              integration_method: route.method,
              integration_uri: apiGatewayIntegrationUri(route, options),
              payload_format_version: route.resolvedTarget.type === "lambda" ? "2.0" : undefined,
            },
          ];
        }),
      ),
      aws_apigatewayv2_route: Object.fromEntries(
        routes.map((route) => {
          const routeName = apiGatewayRouteName(resourceName, route);

          return [
            routeName,
            {
              api_id: `\${aws_apigatewayv2_api.${resourceName}.id}`,
              route_key: `${route.method} ${route.path}`,
              target: `integrations/\${aws_apigatewayv2_integration.${routeName}.id}`,
            },
          ];
        }),
      ),
      ...apiGatewayLambdaPermissions(routes, resourceName, options),
      ...domainTerraform.resource,
    },
    Object.keys(dataTerraform).length > 0 ? dataTerraform : undefined,
  );
}

function resolveApiGatewayRoute(
  route: ApiGatewayRoute,
  options: TerraformContext,
): ResolvedApiGatewayRoute {
  const target = route.targets?.[options.target ?? "aws"] ?? route.target;
  return { ...route, resolvedTarget: target };
}

function apiGatewayStageTagConfig(
  metadata: ServiceMetadata,
  options: TerraformContext,
): Record<string, unknown> {
  if (options.target === "floci") {
    return {
      lifecycle: {
        ignore_changes: ["tags", "tags_all"],
      },
    };
  }

  return {
    tags: tagsFor(metadata),
  };
}

function apiGatewayLambdaPermissions(
  routes: ResolvedApiGatewayRoute[],
  resourceName: string,
  options: TerraformContext,
): Record<string, unknown> {
  const lambdaRoutes = routes.filter(isApiGatewayLambdaRoute);

  if (lambdaRoutes.length === 0) {
    return {};
  }

  return {
    aws_lambda_permission: Object.fromEntries(
      lambdaRoutes.map((route) => {
        const routeName = apiGatewayRouteName(resourceName, route);
        const lambdaName = lambdaNameForService(route.resolvedTarget.service, options);

        return [
          routeName,
          {
            statement_id: `${routeName}_allow_apigateway`,
            action: "lambda:InvokeFunction",
            function_name: lambdaName,
            principal: "apigateway.amazonaws.com",
            source_arn: `\${aws_apigatewayv2_api.${resourceName}.execution_arn}/*/*`,
          },
        ];
      }),
    ),
  };
}

function apiGatewayEcsTargetData(
  routes: ResolvedApiGatewayRoute[],
  options: TerraformContext,
): Record<string, unknown> {
  const ecsRoutes = routes.filter(isApiGatewayEcsRoute);

  if (ecsRoutes.length === 0) {
    return {};
  }

  return {
    aws_lb: Object.fromEntries(
      ecsRoutes.map((route) => {
        const serviceName = route.resolvedTarget.service;
        return [
          terraformName(serviceName),
          {
            name: serviceNameFor(
              serviceName,
              options,
              "apigateway route references unknown ECS service",
            ).slice(0, 32),
          },
        ];
      }),
    ),
  };
}

function apiGatewayDomainResources(
  service: ApiGatewayService,
  resourceName: string,
  options: TerraformContext,
): { resource: Record<string, unknown>; data?: Record<string, unknown> } {
  const target = options.target ?? "aws";
  const domain = service.config.domain?.[target];

  if (!domain) {
    return { resource: {} };
  }

  if (target === "floci") {
    return { resource: {} };
  }

  const certificateArn =
    certificateArnForDomain(domain.certificate, resourceName) ??
    options.domainCertificateArns?.[domain.name];
  if (!certificateArn) {
    throw new Error(
      `domain.${target}.certificate is required for API Gateway domain ${domain.name}`,
    );
  }

  const certificateData =
    domain.certificate && "lookupDomain" in domain.certificate
      ? {
          aws_acm_certificate: {
            [resourceName]: {
              domain: domain.certificate.lookupDomain,
              statuses: ["ISSUED"],
              most_recent: true,
            },
          },
        }
      : {};

  const domainConfig: Record<string, unknown> = {
    endpoint_type: "REGIONAL",
    security_policy: "TLS_1_2",
    certificate_arn: certificateArn,
  };

  return {
    resource: {
      aws_apigatewayv2_domain_name: {
        [resourceName]: {
          domain_name: domain.name,
          domain_name_configuration: domainConfig,
          tags: tagsFor(service.metadata),
        },
      },
      aws_apigatewayv2_api_mapping: {
        [resourceName]: {
          api_id: `\${aws_apigatewayv2_api.${resourceName}.id}`,
          domain_name: `\${aws_apigatewayv2_domain_name.${resourceName}.id}`,
          stage: `\${aws_apigatewayv2_stage.${resourceName}_default.id}`,
        },
      },
      aws_route53_record: {
        [resourceName]: {
          zone_id: `\${data.aws_route53_zone.${resourceName}.zone_id}`,
          name: domain.name,
          type: "A",
          alias: {
            name: `\${aws_apigatewayv2_domain_name.${resourceName}.domain_name_configuration[0].target_domain_name}`,
            zone_id: `\${aws_apigatewayv2_domain_name.${resourceName}.domain_name_configuration[0].hosted_zone_id}`,
            evaluate_target_health: false,
          },
        },
      },
    },
    data: {
      ...certificateData,
      aws_route53_zone: {
        [resourceName]: {
          name: domain.zoneName,
          private_zone: false,
        },
      },
    },
  };
}

function certificateArnForDomain(
  certificate: { arn: string } | { lookupDomain: string } | undefined,
  resourceName: string,
): string | undefined {
  if (!certificate) {
    return undefined;
  }

  if ("arn" in certificate) {
    return certificate.arn;
  }

  return `\${data.aws_acm_certificate.${resourceName}.arn}`;
}

function isApiGatewayLambdaRoute(route: ResolvedApiGatewayRoute): route is ResolvedLambdaRoute {
  return route.resolvedTarget.type === "lambda";
}

function isApiGatewayEcsRoute(route: ResolvedApiGatewayRoute): route is ResolvedEcsRoute {
  return route.resolvedTarget.type === "ecs";
}

function apiGatewayIntegrationUri(
  route: ResolvedApiGatewayRoute,
  options: TerraformContext,
): string {
  if (route.resolvedTarget.type === "http_proxy") {
    return route.resolvedTarget.uri;
  }

  if (route.resolvedTarget.type === "ecs") {
    const resourceName = ecsResourceNameForService(route.resolvedTarget.service, options);
    const port =
      options.target === "floci"
        ? `:${ecsContainerPortForService(route.resolvedTarget.service, options)}`
        : "";
    return `http://\${data.aws_lb.${resourceName}.dns_name}${port}${apiGatewayIntegrationPath(route.path)}`;
  }

  const lambdaName = lambdaNameForService(route.resolvedTarget.service, options);

  const region = regionForTarget(options.target ?? "aws");

  return `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${region}:*:function:${lambdaName}/invocations`;
}

function ecsResourceNameForService(serviceName: string, options: TerraformContext): string {
  serviceNameFor(serviceName, options, "apigateway route references unknown ECS service");
  return terraformName(serviceName);
}

function serviceNameFor(serviceName: string, options: TerraformContext, message: string): string {
  const configuredName = options.serviceNames?.[serviceName];
  if (configuredName) {
    return configuredName;
  }

  throw new Error(`${message} ${serviceName}`);
}

function ecsContainerPortForService(serviceName: string, options: TerraformContext): number {
  const context = requireServiceContainerPorts(
    options,
    `apigateway route references ECS service without container port ${serviceName}`,
  );
  const configuredPort = context.serviceContainerPorts[serviceName];
  if (configuredPort) {
    return configuredPort;
  }

  throw new Error(`apigateway route references ECS service without container port ${serviceName}`);
}

function apiGatewayIntegrationPath(routePath: string): string {
  return routePath.replace("{proxy+}", "{proxy}");
}

function lambdaNameForService(serviceName: string, options: TerraformContext): string {
  const configuredName = options.serviceNames?.[serviceName];
  if (configuredName) {
    return configuredName;
  }

  throw new Error(`apigateway route references unknown Lambda service ${serviceName}`);
}

function apiGatewayRouteName(resourceName: string, route: ResolvedApiGatewayRoute): string {
  const pathName =
    route.path === "/{proxy+}"
      ? "proxy"
      : route.path
          .replace(/^\//, "")
          .replace(/[^a-zA-Z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "");

  return terraformName(`${resourceName}_${route.resolvedTarget.type}_${pathName || "root"}`);
}
