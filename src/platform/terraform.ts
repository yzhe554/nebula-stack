import type { LoadedService, ServiceMetadata } from "./types.js";

export type TerraformJson = Record<string, unknown>;
export type DeployTarget = "aws" | "floci";

export type TerraformOptions = {
  target?: DeployTarget;
  serviceNames?: Record<string, string>;
};

const flociEndpointUrl = "http://localhost.floci.io:4566";

export function terraformForService(service: LoadedService, options: TerraformOptions = {}): TerraformJson {
  if (isLambdaService(service)) {
    return terraformForLambda(service, options);
  }

  return terraformForDynamoDb(service, options);
}

function isLambdaService(
  service: LoadedService,
): service is Extract<LoadedService, { metadata: { serviceType: "lambda" } }> {
  return service.metadata.serviceType === "lambda";
}

function terraformForLambda(
  service: Extract<LoadedService, { metadata: { serviceType: "lambda" } }>,
  options: TerraformOptions,
): TerraformJson {
  const resourceName = terraformName(service.metadata.serviceName);
  const roleName = `${resourceName}_lambda_role`;
  const logGroupName = `/aws/lambda/${physicalName(service.metadata)}`;

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
        filename: service.config.package,
        source_code_hash: `\${filebase64sha256("${service.config.package}")}`,
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
            Resource: `arn:aws:dynamodb:ap-southeast-2:*:table/${tableNameForService(permission.service, options)}`,
          })),
        }),
      },
    },
  };
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

function baseTerraform(metadata: ServiceMetadata, options: TerraformOptions, resource: Record<string, unknown>): TerraformJson {
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
    resource,
  };
}

function providerConfig(metadata: ServiceMetadata, target: DeployTarget): Record<string, unknown> {
  const base = {
    region: "ap-southeast-2",
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
      dynamodb: "http://localhost:4566",
      iam: "http://localhost:4566",
      lambda: "http://localhost:4566",
      logs: "http://localhost:4566",
      s3: "http://localhost:4566",
      sts: "http://localhost:4566",
    },
  };
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
