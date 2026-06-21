import path from "node:path";
import type {
  ApiGatewayRoute,
  ApiGatewayRouteTarget,
  LoadedService,
  ServiceMetadata,
} from "./types";

export type TerraformJson = Record<string, unknown>;
export type DeployTarget = "aws" | "floci";

export type TerraformOptions = {
  target?: DeployTarget;
  moduleDirectory?: string;
  serviceNames?: Record<string, string>;
  domainCertificateArns?: Record<string, string>;
};

type ResolvedApiGatewayRoute = ApiGatewayRoute & { resolvedTarget: ApiGatewayRouteTarget };
type ResolvedLambdaRoute = ResolvedApiGatewayRoute & {
  resolvedTarget: Extract<ApiGatewayRouteTarget, { type: "lambda" }>;
};
type ResolvedEcsRoute = ResolvedApiGatewayRoute & {
  resolvedTarget: Extract<ApiGatewayRouteTarget, { type: "ecs" }>;
};

type EcsService = Extract<LoadedService, { metadata: { serviceType: "ecs" } }>;

const flociEndpointUrl = "http://localhost.floci.io:4566";
const awsRegion = "ap-southeast-2";
const flociRegion = "us-east-1";

export function terraformForService(
  service: LoadedService,
  options: TerraformOptions = {},
): TerraformJson {
  if (isLambdaService(service)) {
    return terraformForLambda(service, options);
  }

  if (isApiGatewayService(service)) {
    return terraformForApiGateway(service, options);
  }

  if (isEcsService(service)) {
    return terraformForEcs(service, options);
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

function isEcsService(service: LoadedService): service is EcsService {
  return service.metadata.serviceType === "ecs";
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

function terraformForEcs(service: EcsService, options: TerraformOptions): TerraformJson {
  const resourceName = terraformName(service.metadata.serviceName);

  if (options.target === "floci") {
    return flociEcsResources(service, resourceName);
  }

  if (service.config.cluster.capacity === "fargate") {
    return awsFargateEcsResources(service, resourceName, options);
  }

  return awsEc2EcsResources(service, resourceName, options);
}

function awsEc2EcsResources(
  service: EcsService,
  resourceName: string,
  options: TerraformOptions,
): TerraformJson {
  const physicalServiceName = physicalName(service.metadata);
  const roleName = `${resourceName}_task_execution_role`;
  const instanceRoleName = `${resourceName}_instance_role`;
  const desiredCapacity = service.config.cluster.desiredCapacity ?? 1;
  const instanceType = service.config.cluster.instanceType ?? "t3.micro";

  return baseTerraform(
    service.metadata,
    options,
    {
      aws_ecs_cluster: {
        [resourceName]: {
          name: physicalServiceName,
          tags: tagsFor(service.metadata),
        },
      },
      aws_iam_role: {
        [roleName]: {
          name: physicalName(service.metadata, "task-execution-role"),
          assume_role_policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: { Service: "ecs-tasks.amazonaws.com" },
              },
            ],
          }),
          tags: tagsFor(service.metadata),
        },
        [instanceRoleName]: {
          name: physicalName(service.metadata, "instance-role"),
          assume_role_policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: { Service: "ec2.amazonaws.com" },
              },
            ],
          }),
          tags: tagsFor(service.metadata),
        },
      },
      aws_iam_role_policy_attachment: {
        [`${roleName}_execution`]: {
          role: `\${aws_iam_role.${roleName}.name}`,
          policy_arn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
        },
        [`${instanceRoleName}_ecs`]: {
          role: `\${aws_iam_role.${instanceRoleName}.name}`,
          policy_arn: "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
        },
      },
      aws_iam_instance_profile: {
        [resourceName]: {
          name: physicalName(service.metadata, "instance-profile"),
          role: `\${aws_iam_role.${instanceRoleName}.name}`,
        },
      },
      aws_cloudwatch_log_group: {
        [resourceName]: {
          name: `/ecs/${physicalServiceName}`,
          retention_in_days: 7,
          tags: tagsFor(service.metadata),
        },
      },
      aws_ecs_task_definition: {
        [resourceName]: {
          family: physicalServiceName,
          network_mode: "bridge",
          requires_compatibilities: ["EC2"],
          cpu: String(service.config.task.cpu),
          memory: String(service.config.task.memoryMb),
          execution_role_arn: `\${aws_iam_role.${roleName}.arn}`,
          container_definitions: JSON.stringify([
            {
              name: resourceName,
              image: `${service.config.image.repository}:${service.config.image.tag}`,
              essential: true,
              portMappings: [
                {
                  containerPort: service.config.service.containerPort,
                  hostPort: 0,
                  protocol: "tcp",
                },
              ],
              logConfiguration: {
                logDriver: "awslogs",
                options: {
                  "awslogs-group": `/ecs/${physicalServiceName}`,
                  "awslogs-region": regionForTarget(options.target ?? "aws"),
                  "awslogs-stream-prefix": resourceName,
                },
              },
            },
          ]),
        },
      },
      aws_lb: {
        [resourceName]: {
          name: physicalServiceName,
          load_balancer_type: "application",
          internal: service.metadata.securityZone !== "public",
          subnets: "${data.aws_subnets.default.ids}",
          security_groups: [`\${aws_security_group.${resourceName}.id}`],
          tags: tagsFor(service.metadata),
        },
      },
      aws_lb_target_group: {
        [resourceName]: {
          name: physicalServiceName,
          port: service.config.service.containerPort,
          protocol: "HTTP",
          target_type: "instance",
          vpc_id: "${data.aws_vpc.default.id}",
          health_check: {
            path: service.config.healthCheck.path,
            protocol: "HTTP",
          },
          tags: tagsFor(service.metadata),
        },
      },
      aws_lb_listener: {
        [resourceName]: {
          load_balancer_arn: `\${aws_lb.${resourceName}.arn}`,
          port: 80,
          protocol: "HTTP",
          default_action: {
            type: "forward",
            target_group_arn: `\${aws_lb_target_group.${resourceName}.arn}`,
          },
        },
      },
      aws_launch_template: {
        [resourceName]: {
          name_prefix: `${physicalServiceName}-`,
          image_id: "${data.aws_ssm_parameter.ecs_optimized_ami.value}",
          instance_type: instanceType,
          iam_instance_profile: {
            name: `\${aws_iam_instance_profile.${resourceName}.name}`,
          },
          user_data: `\${base64encode("ECS_CLUSTER=\${aws_ecs_cluster.${resourceName}.name}\\n")}`,
          vpc_security_group_ids: [`\${aws_security_group.${resourceName}.id}`],
          tag_specifications: {
            resource_type: "instance",
            tags: tagsFor(service.metadata),
          },
        },
      },
      aws_autoscaling_group: {
        [resourceName]: {
          desired_capacity: desiredCapacity,
          min_size: service.config.cluster.autoscaling?.minCapacity ?? desiredCapacity,
          max_size: service.config.cluster.autoscaling?.maxCapacity ?? desiredCapacity,
          vpc_zone_identifier: "${data.aws_subnets.default.ids}",
          launch_template: {
            id: `\${aws_launch_template.${resourceName}.id}`,
            version: "$Latest",
          },
          tag: Object.entries(tagsFor(service.metadata)).map(([key, value]) => ({
            key,
            value,
            propagate_at_launch: true,
          })),
        },
      },
      aws_ecs_capacity_provider: {
        [resourceName]: {
          name: physicalName(service.metadata, "capacity-provider"),
          auto_scaling_group_provider: {
            auto_scaling_group_arn: `\${aws_autoscaling_group.${resourceName}.arn}`,
            managed_scaling: {
              status: "ENABLED",
              target_capacity: 100,
            },
          },
        },
      },
      aws_ecs_cluster_capacity_providers: {
        [resourceName]: {
          cluster_name: `\${aws_ecs_cluster.${resourceName}.name}`,
          capacity_providers: [`\${aws_ecs_capacity_provider.${resourceName}.name}`],
        },
      },
      aws_ecs_service: {
        [resourceName]: {
          name: physicalServiceName,
          cluster: `\${aws_ecs_cluster.${resourceName}.id}`,
          task_definition: `\${aws_ecs_task_definition.${resourceName}.arn}`,
          desired_count: service.config.service.desiredCount,
          launch_type: "EC2",
          load_balancer: {
            target_group_arn: `\${aws_lb_target_group.${resourceName}.arn}`,
            container_name: resourceName,
            container_port: service.config.service.containerPort,
          },
          depends_on: [`aws_lb_listener.${resourceName}`],
          tags: tagsFor(service.metadata),
        },
      },
      aws_security_group: {
        [resourceName]: {
          name: physicalServiceName,
          description: `Security group for ${physicalServiceName}`,
          vpc_id: "${data.aws_vpc.default.id}",
          ingress: [
            {
              description: "Allow HTTP ingress",
              from_port: 80,
              to_port: 80,
              protocol: "tcp",
              cidr_blocks: ["0.0.0.0/0"],
              ipv6_cidr_blocks: [],
              prefix_list_ids: [],
              security_groups: [],
              self: false,
            },
            {
              description: "Allow container traffic from this security group",
              from_port: service.config.service.containerPort,
              to_port: service.config.service.containerPort,
              protocol: "tcp",
              cidr_blocks: [],
              ipv6_cidr_blocks: [],
              prefix_list_ids: [],
              security_groups: [],
              self: true,
            },
          ],
          egress: [
            {
              description: "Allow all egress",
              from_port: 0,
              to_port: 0,
              protocol: "-1",
              cidr_blocks: ["0.0.0.0/0"],
              ipv6_cidr_blocks: [],
              prefix_list_ids: [],
              security_groups: [],
              self: false,
            },
          ],
          tags: tagsFor(service.metadata),
        },
      },
      ...ecsServiceAutoscalingResources(service, resourceName),
    },
    {
      aws_vpc: {
        default: {
          default: true,
        },
      },
      aws_subnets: {
        default: {
          filter: {
            name: "vpc-id",
            values: ["${data.aws_vpc.default.id}"],
          },
        },
      },
      aws_ssm_parameter: {
        ecs_optimized_ami: {
          name: "/aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id",
        },
      },
    },
  );
}

function flociEcsResources(service: EcsService, resourceName: string): TerraformJson {
  const physicalServiceName = physicalName(service.metadata);

  return baseTerraform(
    service.metadata,
    { target: "floci" },
    {
      aws_ecs_cluster: {
        [resourceName]: {
          name: physicalServiceName,
          tags: tagsFor(service.metadata),
        },
      },
      aws_ecs_task_definition: {
        [resourceName]: {
          family: physicalServiceName,
          network_mode: "bridge",
          requires_compatibilities: ["EC2"],
          cpu: String(service.config.task.cpu),
          memory: String(service.config.task.memoryMb),
          container_definitions: JSON.stringify([
            {
              name: resourceName,
              image: `${service.config.image.repository}:${service.config.image.tag}`,
              essential: true,
              portMappings: [
                {
                  containerPort: service.config.service.containerPort,
                  hostPort: service.config.service.containerPort,
                  protocol: "tcp",
                },
              ],
            },
          ]),
        },
      },
      aws_ecs_service: {
        [resourceName]: {
          name: physicalServiceName,
          cluster: `\${aws_ecs_cluster.${resourceName}.id}`,
          task_definition: `\${aws_ecs_task_definition.${resourceName}.arn}`,
          desired_count: service.config.service.desiredCount,
          launch_type: "EC2",
          load_balancer: {
            target_group_arn: `\${aws_lb_target_group.${resourceName}.arn}`,
            container_name: resourceName,
            container_port: service.config.service.containerPort,
          },
          depends_on: [`aws_lb_listener.${resourceName}`],
          tags: tagsFor(service.metadata),
        },
      },
      aws_lb: {
        [resourceName]: {
          name: physicalServiceName,
          load_balancer_type: "application",
          internal: false,
          subnets: "${data.aws_subnets.default.ids}",
          tags: tagsFor(service.metadata),
        },
      },
      aws_lb_target_group: {
        [resourceName]: {
          name_prefix: targetGroupNamePrefix(resourceName),
          port: service.config.service.containerPort,
          protocol: "HTTP",
          target_type: "ip",
          vpc_id: "${data.aws_vpc.default.id}",
          health_check: {
            path: service.config.healthCheck.path,
            protocol: "HTTP",
          },
          tags: tagsFor(service.metadata),
          lifecycle: {
            create_before_destroy: true,
          },
        },
      },
      aws_lb_listener: {
        [resourceName]: {
          load_balancer_arn: `\${aws_lb.${resourceName}.arn}`,
          port: 80,
          protocol: "HTTP",
          default_action: {
            type: "forward",
            target_group_arn: `\${aws_lb_target_group.${resourceName}.arn}`,
          },
        },
      },
    },
    {
      aws_vpc: {
        default: {
          default: true,
        },
      },
      aws_subnets: {
        default: {
          filter: {
            name: "vpc-id",
            values: ["${data.aws_vpc.default.id}"],
          },
        },
      },
    },
  );
}

function awsFargateEcsResources(
  service: EcsService,
  resourceName: string,
  options: TerraformOptions,
): TerraformJson {
  const physicalServiceName = physicalName(service.metadata);
  const roleName = `${resourceName}_task_execution_role`;

  return baseTerraform(
    service.metadata,
    options,
    {
      aws_ecs_cluster: {
        [resourceName]: {
          name: physicalServiceName,
          tags: tagsFor(service.metadata),
        },
      },
      aws_iam_role: {
        [roleName]: {
          name: physicalName(service.metadata, "task-execution-role"),
          assume_role_policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: { Service: "ecs-tasks.amazonaws.com" },
              },
            ],
          }),
          tags: tagsFor(service.metadata),
        },
      },
      aws_iam_role_policy_attachment: {
        [`${roleName}_execution`]: {
          role: `\${aws_iam_role.${roleName}.name}`,
          policy_arn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
        },
      },
      aws_cloudwatch_log_group: {
        [resourceName]: {
          name: `/ecs/${physicalServiceName}`,
          retention_in_days: 7,
          tags: tagsFor(service.metadata),
        },
      },
      aws_ecs_task_definition: {
        [resourceName]: {
          family: physicalServiceName,
          network_mode: "awsvpc",
          requires_compatibilities: ["FARGATE"],
          cpu: String(service.config.task.cpu),
          memory: String(service.config.task.memoryMb),
          execution_role_arn: `\${aws_iam_role.${roleName}.arn}`,
          container_definitions: JSON.stringify([
            {
              name: resourceName,
              image: `${service.config.image.repository}:${service.config.image.tag}`,
              essential: true,
              portMappings: [
                {
                  containerPort: service.config.service.containerPort,
                  hostPort: service.config.service.containerPort,
                  protocol: "tcp",
                },
              ],
              logConfiguration: {
                logDriver: "awslogs",
                options: {
                  "awslogs-group": `/ecs/${physicalServiceName}`,
                  "awslogs-region": regionForTarget(options.target ?? "aws"),
                  "awslogs-stream-prefix": resourceName,
                },
              },
            },
          ]),
        },
      },
      aws_lb: {
        [resourceName]: {
          name: physicalServiceName,
          load_balancer_type: "application",
          internal: service.metadata.securityZone !== "public",
          subnets: "${data.aws_subnets.default.ids}",
          security_groups: [`\${aws_security_group.${resourceName}.id}`],
          tags: tagsFor(service.metadata),
        },
      },
      aws_lb_target_group: {
        [resourceName]: {
          name: physicalServiceName,
          port: service.config.service.containerPort,
          protocol: "HTTP",
          target_type: "ip",
          vpc_id: "${data.aws_vpc.default.id}",
          health_check: {
            path: service.config.healthCheck.path,
            protocol: "HTTP",
          },
          tags: tagsFor(service.metadata),
        },
      },
      aws_lb_listener: {
        [resourceName]: {
          load_balancer_arn: `\${aws_lb.${resourceName}.arn}`,
          port: 80,
          protocol: "HTTP",
          default_action: {
            type: "forward",
            target_group_arn: `\${aws_lb_target_group.${resourceName}.arn}`,
          },
        },
      },
      aws_ecs_service: {
        [resourceName]: {
          name: physicalServiceName,
          cluster: `\${aws_ecs_cluster.${resourceName}.id}`,
          task_definition: `\${aws_ecs_task_definition.${resourceName}.arn}`,
          desired_count: service.config.service.desiredCount,
          launch_type: "FARGATE",
          network_configuration: {
            subnets: "${data.aws_subnets.default.ids}",
            security_groups: [`\${aws_security_group.${resourceName}.id}`],
            assign_public_ip: service.metadata.securityZone === "public",
          },
          load_balancer: {
            target_group_arn: `\${aws_lb_target_group.${resourceName}.arn}`,
            container_name: resourceName,
            container_port: service.config.service.containerPort,
          },
          depends_on: [`aws_lb_listener.${resourceName}`],
          tags: tagsFor(service.metadata),
        },
      },
      aws_security_group: {
        [resourceName]: {
          name: physicalServiceName,
          description: `Security group for ${physicalServiceName}`,
          vpc_id: "${data.aws_vpc.default.id}",
          ingress: [
            {
              description: "Allow HTTP ingress",
              from_port: 80,
              to_port: 80,
              protocol: "tcp",
              cidr_blocks: ["0.0.0.0/0"],
              ipv6_cidr_blocks: [],
              prefix_list_ids: [],
              security_groups: [],
              self: false,
            },
            {
              description: "Allow container traffic from this security group",
              from_port: service.config.service.containerPort,
              to_port: service.config.service.containerPort,
              protocol: "tcp",
              cidr_blocks: [],
              ipv6_cidr_blocks: [],
              prefix_list_ids: [],
              security_groups: [],
              self: true,
            },
          ],
          egress: [
            {
              description: "Allow all egress",
              from_port: 0,
              to_port: 0,
              protocol: "-1",
              cidr_blocks: ["0.0.0.0/0"],
              ipv6_cidr_blocks: [],
              prefix_list_ids: [],
              security_groups: [],
              self: false,
            },
          ],
          tags: tagsFor(service.metadata),
        },
      },
      ...ecsServiceAutoscalingResources(service, resourceName),
    },
    {
      aws_vpc: {
        default: {
          default: true,
        },
      },
      aws_subnets: {
        default: {
          filter: {
            name: "vpc-id",
            values: ["${data.aws_vpc.default.id}"],
          },
        },
      },
    },
  );
}

function ecsServiceAutoscalingResources(
  service: EcsService,
  resourceName: string,
): Record<string, unknown> {
  const autoscaling = service.config.service.autoscaling;
  if (!autoscaling) {
    return {};
  }

  const policies: Record<string, unknown> = {};

  if (autoscaling.targetCpuUtilization !== undefined) {
    policies[`${resourceName}_cpu`] = ecsTargetTrackingPolicy(
      service,
      resourceName,
      "cpu-autoscaling",
      "ECSServiceAverageCPUUtilization",
      autoscaling.targetCpuUtilization,
    );
  }

  if (autoscaling.targetMemoryUtilization !== undefined) {
    policies[`${resourceName}_memory`] = ecsTargetTrackingPolicy(
      service,
      resourceName,
      "memory-autoscaling",
      "ECSServiceAverageMemoryUtilization",
      autoscaling.targetMemoryUtilization,
    );
  }

  return {
    aws_appautoscaling_target: {
      [resourceName]: {
        max_capacity: autoscaling.maxCount,
        min_capacity: autoscaling.minCount,
        resource_id: `service/\${aws_ecs_cluster.${resourceName}.name}/\${aws_ecs_service.${resourceName}.name}`,
        scalable_dimension: "ecs:service:DesiredCount",
        service_namespace: "ecs",
      },
    },
    aws_appautoscaling_policy: policies,
  };
}

function ecsTargetTrackingPolicy(
  service: EcsService,
  resourceName: string,
  nameSuffix: string,
  metricType: "ECSServiceAverageCPUUtilization" | "ECSServiceAverageMemoryUtilization",
  targetValue: number,
): Record<string, unknown> {
  return {
    name: physicalName(service.metadata, nameSuffix),
    policy_type: "TargetTrackingScaling",
    resource_id: `\${aws_appautoscaling_target.${resourceName}.resource_id}`,
    scalable_dimension: `\${aws_appautoscaling_target.${resourceName}.scalable_dimension}`,
    service_namespace: `\${aws_appautoscaling_target.${resourceName}.service_namespace}`,
    target_tracking_scaling_policy_configuration: {
      predefined_metric_specification: {
        predefined_metric_type: metricType,
      },
      target_value: targetValue,
    },
  };
}

function terraformForApiGateway(
  service: Extract<LoadedService, { metadata: { serviceType: "apigateway" } }>,
  options: TerraformOptions,
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
    options,
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
  options: TerraformOptions,
): ResolvedApiGatewayRoute {
  const target = route.targets?.[options.target ?? "aws"] ?? route.target;
  return { ...route, resolvedTarget: target };
}

function apiGatewayStageTagConfig(
  metadata: ServiceMetadata,
  options: TerraformOptions,
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
  options: TerraformOptions,
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
  options: TerraformOptions,
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
            ),
          },
        ];
      }),
    ),
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
  options: TerraformOptions,
): string {
  if (route.resolvedTarget.type === "http_proxy") {
    return route.resolvedTarget.uri;
  }

  if (route.resolvedTarget.type === "ecs") {
    const resourceName = ecsResourceNameForService(route.resolvedTarget.service, options);
    return `http://\${data.aws_lb.${resourceName}.dns_name}${apiGatewayIntegrationPath(route.path)}`;
  }

  const lambdaName = lambdaNameForService(route.resolvedTarget.service, options);

  const region = regionForTarget(options.target ?? "aws");

  return `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${region}:*:function:${lambdaName}/invocations`;
}

function ecsResourceNameForService(serviceName: string, options: TerraformOptions): string {
  serviceNameFor(serviceName, options, "apigateway route references unknown ECS service");
  return terraformName(serviceName);
}

function targetGroupNamePrefix(resourceName: string): string {
  return `${resourceName.replace(/_/g, "").slice(0, 5)}-`;
}

function serviceNameFor(serviceName: string, options: TerraformOptions, message: string): string {
  const configuredName = options.serviceNames?.[serviceName];
  if (configuredName) {
    return configuredName;
  }

  throw new Error(`${message} ${serviceName}`);
}

function apiGatewayIntegrationPath(routePath: string): string {
  return routePath.replace("{proxy+}", "{proxy}");
}

function lambdaNameForService(serviceName: string, options: TerraformOptions): string {
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

function tableNameForService(serviceName: string, options: TerraformOptions): string {
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

function baseTerraform(
  metadata: ServiceMetadata,
  options: TerraformOptions,
  resource: Record<string, unknown>,
  data?: Record<string, unknown>,
): TerraformJson {
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
      applicationautoscaling: "http://localhost:4566",
      apigateway: "http://localhost:4566",
      apigatewayv2: "http://localhost:4566",
      dynamodb: "http://localhost:4566",
      ec2: "http://localhost:4566",
      ecs: "http://localhost:4566",
      elbv2: "http://localhost:4566",
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
  return [
    metadata.env,
    metadata.venture,
    metadata.vpc,
    metadata.securityZone,
    metadata.serviceName,
    suffix,
  ]
    .filter(Boolean)
    .join("-");
}

function terraformName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}
