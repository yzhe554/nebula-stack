import path from "node:path";
import type { ApiGatewayRoute, LoadedService, ServiceMetadata } from "./types";

export type TerraformJson = Record<string, unknown>;
export type DeployTarget = "aws" | "floci";

export type TerraformOptions = {
  target?: DeployTarget;
  moduleDirectory?: string;
  serviceNames?: Record<string, string>;
  domainCertificateArns?: Record<string, string>;
};

type ApiGatewayLambdaRoute = ApiGatewayRoute & {
  target: Extract<ApiGatewayRoute["target"], { type: "lambda" }>;
};

const flociEndpointUrl = "http://localhost.floci.io:4566";
const awsRegion = "ap-southeast-2";
const flociRegion = "us-east-1";

export function terraformForService(service: LoadedService, options: TerraformOptions = {}): TerraformJson {
  if (isLambdaService(service)) {
    return terraformForLambda(service, options);
  }

  if (isApiGatewayService(service)) {
    return terraformForApiGateway(service, options);
  }

  return terraformForDynamoDb(service, options);
}

function isLambdaService(
  service: LoadedService,
): service is Extract<LoadedService, { metadata: { serviceType: "lambda" } }> {
  return service.metadata.serviceType === "lambda";
}

function isApiGatewayService(
  service: LoadedService,
): service is Extract<LoadedService, { metadata: { serviceType: "apigateway" } }> {
  return service.metadata.serviceType === "apigateway";
}

function terraformForLambda(
  service: Extract<LoadedService, { metadata: { serviceType: "lambda" } }>,
  options: TerraformOptions,
): TerraformJson {
  const resourceName = terraformName(service.metadata.serviceName);
  const roleName = `${resourceName}_lambda_role`;
  const logGroupName = `/aws/lambda/${physicalName(service.metadata)}`;
  const packagePath = lambdaPackagePath(service, options);

  return baseTerraform(service.metadata, options, {
    aws_iam_role: {
      [roleName]: {
        name: physicalName(service.metadata, "lambda-role"),
        assume_role_policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
            },
          ],
        }),
        tags: tagsFor(service.metadata),
      },
    },
    aws_iam_role_policy_attachment: {
      [`${roleName}_basic_execution`]: {
        role: `\${aws_iam_role.${roleName}.name}`,
        policy_arn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      },
    },
    ...lambdaDynamoDbPolicies(service, resourceName, roleName, options),
    aws_cloudwatch_log_group: {
      [resourceName]: {
        name: logGroupName,
        retention_in_days: service.config.logRetentionDays,
        tags: tagsFor(service.metadata),
      },
    },
    aws_lambda_function: {
      [resourceName]: {
        function_name: physicalName(service.metadata),
        filename: packagePath,
        source_code_hash: `\${filebase64sha256("${packagePath}")}`,
        role: `\${aws_iam_role.${roleName}.arn}`,
        handler: service.config.handler,
        runtime: service.config.runtime,
        memory_size: service.config.memoryMb,
        timeout: service.config.timeoutSeconds,
        environment: {
          variables: lambdaEnvironmentVariables(service, options),
        },
        depends_on: [
          `aws_iam_role_policy_attachment.${roleName}_basic_execution`,
          `aws_cloudwatch_log_group.${resourceName}`,
        ],
        tags: tagsFor(service.metadata),
      },
    },
  });
}

function lambdaPackagePath(
  service: Extract<LoadedService, { metadata: { serviceType: "lambda" } }>,
  options: TerraformOptions,
): string {
  if (!options.moduleDirectory) {
    return service.config.package;
  }

  const absolutePackagePath = path.resolve(path.dirname(service.metadata.sourcePath), service.config.package);
  const relativePackagePath = path.relative(options.moduleDirectory, absolutePackagePath);

  return normalizeTerraformPath(relativePackagePath);
}

function normalizeTerraformPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function lambdaEnvironmentVariables(
  service: Extract<LoadedService, { metadata: { serviceType: "lambda" } }>,
  options: TerraformOptions,
): Record<string, string> {
  return {
    ...service.config.environment,
    ...lambdaDynamoDbEnvironmentVariables(service, options),
    ...(options.target === "floci" ? { AWS_ENDPOINT_URL: flociEndpointUrl } : {}),
  };
}

function lambdaDynamoDbEnvironmentVariables(
  service: Extract<LoadedService, { metadata: { serviceType: "lambda" } }>,
  options: TerraformOptions,
): Record<string, string> {
  if (service.config.permissions.dynamodb.length !== 1) {
    return {};
  }

  const [permission] = service.config.permissions.dynamodb;

  return {
    TABLE_NAME: tableNameForService(permission.service, options),
  };
}

function lambdaDynamoDbPolicies(
  service: Extract<LoadedService, { metadata: { serviceType: "lambda" } }>,
  resourceName: string,
  roleName: string,
  options: TerraformOptions,
): Record<string, unknown> {
  if (service.config.permissions.dynamodb.length === 0) {
    return {};
  }

  return {
    aws_iam_role_policy: {
      [`${resourceName}_dynamodb_access`]: {
        name: physicalName(service.metadata, "dynamodb-access"),
        role: `\${aws_iam_role.${roleName}.id}`,
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: service.config.permissions.dynamodb.map((permission) => ({
            Effect: "Allow",
            Action: permission.actions,
            Resource: `arn:aws:dynamodb:${regionForTarget(options.target ?? "aws")}:*:table/${tableNameForService(permission.service, options)}`,
          })),
        }),
      },
    },
  };
}

function terraformForApiGateway(
  service: Extract<LoadedService, { metadata: { serviceType: "apigateway" } }>,
  options: TerraformOptions,
): TerraformJson {
  const resourceName = terraformName(service.metadata.serviceName);

  const domainTerraform = apiGatewayDomainResources(service, resourceName, options);

  return baseTerraform(service.metadata, options, {
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
    aws_apigatewayv2_integration: Object.fromEntries(service.config.routes.map((route) => {
      const routeName = apiGatewayRouteName(resourceName, route);

      return [routeName, {
        api_id: `\${aws_apigatewayv2_api.${resourceName}.id}`,
        integration_type: route.target.type === "http_proxy" ? "HTTP_PROXY" : "AWS_PROXY",
        integration_method: route.method,
        integration_uri: apiGatewayIntegrationUri(route, options),
        payload_format_version: route.target.type === "lambda" ? "2.0" : undefined,
      }];
    })),
    aws_apigatewayv2_route: Object.fromEntries(service.config.routes.map((route) => {
      const routeName = apiGatewayRouteName(resourceName, route);

      return [routeName, {
        api_id: `\${aws_apigatewayv2_api.${resourceName}.id}`,
        route_key: `${route.method} ${route.path}`,
        target: `integrations/\${aws_apigatewayv2_integration.${routeName}.id}`,
      }];
    })),
    ...apiGatewayLambdaPermissions(service, resourceName, options),
    ...domainTerraform.resource,
  }, domainTerraform.data);
}

function apiGatewayStageTagConfig(metadata: ServiceMetadata, options: TerraformOptions): Record<string, unknown> {
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
  service: Extract<LoadedService, { metadata: { serviceType: "apigateway" } }>,
  resourceName: string,
  options: TerraformOptions,
): Record<string, unknown> {
  const lambdaRoutes = service.config.routes.filter(isApiGatewayLambdaRoute);

  if (lambdaRoutes.length === 0) {
    return {};
  }

  return {
    aws_lambda_permission: Object.fromEntries(lambdaRoutes.map((route) => {
      const routeName = apiGatewayRouteName(resourceName, route);
      const lambdaName = lambdaNameForService(route.target.service, options);

      return [routeName, {
        statement_id: `${routeName}_allow_apigateway`,
        action: "lambda:InvokeFunction",
        function_name: lambdaName,
        principal: "apigateway.amazonaws.com",
        source_arn: `\${aws_apigatewayv2_api.${resourceName}.execution_arn}/*/*`,
      }];
    })),
  };
}

function apiGatewayDomainResources(
  service: Extract<LoadedService, { metadata: { serviceType: "apigateway" } }>,
  resourceName: string,
  options: TerraformOptions,
): { resource: Record<string, unknown>; data?: Record<string, unknown> } {
  const target = options.target ?? "aws";
  const domain = service.config.domain?.[target];

  if (!domain) {
    return { resource: {} };
  }

  if (target === "floci") {
    return { resource: {} };
  }

  const certificateArn = certificateArnForDomain(domain.certificate, resourceName)
    ?? options.domainCertificateArns?.[domain.name];
  if (!certificateArn) {
    throw new Error(`domain.${target}.certificate is required for API Gateway domain ${domain.name}`);
  }

  const certificateData = domain.certificate && "lookupDomain" in domain.certificate
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

function certificateArnForDomain(certificate: { arn: string } | { lookupDomain: string } | undefined, resourceName: string): string | undefined {
  if (!certificate) {
    return undefined;
  }

  if ("arn" in certificate) {
    return certificate.arn;
  }

  return `\${data.aws_acm_certificate.${resourceName}.arn}`;
}

function isApiGatewayLambdaRoute(
  route: ApiGatewayRoute,
): route is ApiGatewayLambdaRoute {
  return route.target.type === "lambda";
}

function apiGatewayIntegrationUri(
  route: ApiGatewayRoute,
  options: TerraformOptions,
): string {
  if (route.target.type === "http_proxy") {
    return route.target.uri;
  }

  const lambdaName = lambdaNameForService(route.target.service, options);

  const region = regionForTarget(options.target ?? "aws");

  return `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${region}:*:function:${lambdaName}/invocations`;
}

function lambdaNameForService(serviceName: string, options: TerraformOptions): string {
  const configuredName = options.serviceNames?.[serviceName];
  if (configuredName) {
    return configuredName;
  }

  throw new Error(`apigateway route references unknown Lambda service ${serviceName}`);
}

function apiGatewayRouteName(
  resourceName: string,
  route: ApiGatewayRoute,
): string {
  const pathName = route.path === "/{proxy+}"
    ? "proxy"
    : route.path.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  return terraformName(`${resourceName}_${route.target.type}_${pathName || "root"}`);
}

function tableNameForService(
  serviceName: string,
  options: TerraformOptions,
): string {
  const configuredName = options.serviceNames?.[serviceName];
  if (configuredName) {
    return configuredName;
  }

  throw new Error(`permissions.dynamodb references unknown DynamoDB service ${serviceName}`);
}

function terraformForDynamoDb(
  service: Extract<LoadedService, { metadata: { serviceType: "dynamodb" } }>,
  options: TerraformOptions,
): TerraformJson {
  const resourceName = terraformName(service.metadata.serviceName);
  const attributes = [service.config.hashKey, service.config.rangeKey].filter(Boolean);

  return baseTerraform(service.metadata, options, {
    aws_dynamodb_table: {
      [resourceName]: {
        name: physicalName(service.metadata),
        billing_mode: service.config.billingMode,
        hash_key: service.config.hashKey.name,
        range_key: service.config.rangeKey?.name,
        attribute: attributes,
        point_in_time_recovery: {
          enabled: service.config.pointInTimeRecovery,
        },
        deletion_protection_enabled: true,
        lifecycle: {
          prevent_destroy: true,
        },
        tags: tagsFor(service.metadata),
      },
    },
  });
}

function baseTerraform(metadata: ServiceMetadata, options: TerraformOptions, resource: Record<string, unknown>, data?: Record<string, unknown>): TerraformJson {
  return {
    terraform: {
      required_version: ">= 1.15.6",
      required_providers: {
        aws: {
          source: "hashicorp/aws",
          version: "~> 6.51",
        },
      },
    },
    provider: {
      aws: providerConfig(metadata, options.target ?? "aws"),
    },
    ...(data ? { data } : {}),
    resource,
  };
}

function providerConfig(metadata: ServiceMetadata, target: DeployTarget): Record<string, unknown> {
  const base = {
    region: regionForTarget(target),
    default_tags: {
      tags: tagsFor(metadata),
    },
  };

  if (target === "aws") {
    return base;
  }

  return {
    ...base,
    access_key: "test",
    secret_key: "test",
    skip_credentials_validation: true,
    skip_metadata_api_check: true,
    skip_requesting_account_id: true,
    s3_use_path_style: true,
    endpoints: {
      apigateway: "http://localhost:4566",
      apigatewayv2: "http://localhost:4566",
      dynamodb: "http://localhost:4566",
      iam: "http://localhost:4566",
      route53: "http://localhost:4566",
      lambda: "http://localhost:4566",
      logs: "http://localhost:4566",
      s3: "http://localhost:4566",
      sts: "http://localhost:4566",
    },
  };
}

function regionForTarget(target: DeployTarget): string {
  return target === "floci" ? flociRegion : awsRegion;
}

function tagsFor(metadata: ServiceMetadata): Record<string, string> {
  return {
    Environment: metadata.env,
    Venture: metadata.venture,
    Vpc: metadata.vpc,
    SecurityZone: metadata.securityZone,
    ServiceName: metadata.serviceName,
    ServiceType: metadata.serviceType,
    ManagedBy: "yaml-terraform-platform",
  };
}

function physicalName(metadata: ServiceMetadata, suffix?: string): string {
  return [metadata.env, metadata.venture, metadata.vpc, metadata.securityZone, metadata.serviceName, suffix]
    .filter(Boolean)
    .join("-");
}

function terraformName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}
