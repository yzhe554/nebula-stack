import path from "node:path";
import {
  baseTerraform,
  flociEndpointUrl,
  regionForTarget,
  tagsFor,
  type TerraformJson,
} from "../../terraform/base";
import { physicalName, terraformName } from "../../terraform/naming";
import type { TerraformContext } from "../../terraform/context";
import type { LoadedService } from "../../types";

export type LambdaService = Extract<LoadedService, { metadata: { serviceType: "lambda" } }>;

export function terraformForLambda(
  service: LambdaService,
  options: TerraformContext,
): TerraformJson {
  const resourceName = terraformName(service.metadata.serviceName);
  const roleName = `${resourceName}_lambda_role`;
  const logGroupName = `/aws/lambda/${physicalName(service.metadata)}`;
  const packagePath = lambdaPackagePath(service, options);

  return baseTerraform(service.metadata, options.target ?? "aws", {
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

function lambdaPackagePath(service: LambdaService, options: TerraformContext): string {
  if (!options.moduleDirectory) {
    return service.config.package;
  }

  const absolutePackagePath = path.resolve(
    path.dirname(service.metadata.sourcePath),
    service.config.package,
  );
  const relativePackagePath = path.relative(options.moduleDirectory, absolutePackagePath);

  return normalizeTerraformPath(relativePackagePath);
}

function normalizeTerraformPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function lambdaEnvironmentVariables(
  service: LambdaService,
  options: TerraformContext,
): Record<string, string> {
  return {
    ...service.config.environment,
    ...lambdaDynamoDbEnvironmentVariables(service, options),
    ...(options.target === "floci" ? { AWS_ENDPOINT_URL: flociEndpointUrl } : {}),
  };
}

function lambdaDynamoDbEnvironmentVariables(
  service: LambdaService,
  options: TerraformContext,
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
  service: LambdaService,
  resourceName: string,
  roleName: string,
  options: TerraformContext,
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

function tableNameForService(serviceName: string, options: TerraformContext): string {
  const configuredName = options.serviceNames?.[serviceName];
  if (configuredName) {
    return configuredName;
  }

  throw new Error(`permissions.dynamodb references unknown DynamoDB service ${serviceName}`);
}
