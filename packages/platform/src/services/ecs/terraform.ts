import {
  baseTerraform,
  flociEcsEndpointUrl,
  regionForTarget,
  tagsFor,
  type TerraformJson,
} from "../../terraform/base";
import {
  ecsLoadBalancerName,
  physicalName,
  targetGroupNamePrefix,
  terraformName,
} from "../../terraform/naming";
import { vpcDataSources } from "../../terraform/vpc-lookup";
import type { TerraformContext } from "../../terraform/context";
import type { LoadedService } from "../../types";

function serviceNameFor(serviceName: string, options: TerraformContext, message: string): string {
  const configuredName = options.serviceNames?.[serviceName];
  if (configuredName) {
    return configuredName;
  }
  throw new Error(`${message} ${serviceName}`);
}

function functionNameEnvKey(serviceName: string): string {
  return `${serviceName.toUpperCase().replace(/-/g, "_")}_FUNCTION_NAME`;
}

// Container environment for an ECS task: the target Lambda function names (so the
// app's SDK knows what to invoke) plus, on the Floci target, the local AWS
// endpoint + test credentials so the in-container AWS SDK reaches Floci (mirrors
// the lambda emitter's AWS_ENDPOINT_URL injection). Returns undefined when there
// is nothing to inject, so services without lambda permissions stay byte-identical.
function containerEnvironmentFor(
  service: EcsService,
  options: TerraformContext,
): Array<{ name: string; value: string }> | undefined {
  const lambdaPermissions = service.config.permissions?.lambda ?? [];
  if (lambdaPermissions.length === 0) {
    return undefined;
  }

  const env = lambdaPermissions.map((permission) => ({
    name: functionNameEnvKey(permission.service),
    value: serviceNameFor(
      permission.service,
      options,
      "permissions.lambda references unknown Lambda service",
    ),
  }));

  if (options.target === "floci") {
    env.push(
      { name: "AWS_ENDPOINT_URL", value: flociEcsEndpointUrl },
      { name: "AWS_REGION", value: regionForTarget("floci") },
      { name: "AWS_ACCESS_KEY_ID", value: "test" },
      { name: "AWS_SECRET_ACCESS_KEY", value: "test" },
    );
  }

  return env;
}

export type EcsService = Extract<LoadedService, { metadata: { serviceType: "ecs" } }>;

export function terraformForEcs(service: EcsService, options: TerraformContext): TerraformJson {
  const resourceName = terraformName(service.metadata.serviceName);

  if (options.target === "floci") {
    return flociEcsResources(service, resourceName, options);
  }

  if (service.config.cluster.capacity === "fargate") {
    return awsFargateEcsResources(service, resourceName, options);
  }

  return awsEc2EcsResources(service, resourceName, options);
}

function awsEc2EcsResources(
  service: EcsService,
  resourceName: string,
  options: TerraformContext,
): TerraformJson {
  const physicalServiceName = physicalName(service.metadata);
  const loadBalancerName = ecsLoadBalancerName(service.metadata);
  const roleName = `${resourceName}_task_execution_role`;
  const instanceRoleName = `${resourceName}_instance_role`;
  const taskRoleName = `${resourceName}_task_role`;
  const desiredCapacity = service.config.cluster.desiredCapacity ?? 1;
  const instanceType = service.config.cluster.instanceType ?? "t3.micro";
  const lambdaPermissions = service.config.permissions?.lambda;
  const hasLambdaPermissions = lambdaPermissions !== undefined && lambdaPermissions.length > 0;

  const containerEnvironment = containerEnvironmentFor(service, options);

  const taskRoleResources = hasLambdaPermissions
    ? {
        aws_iam_role_policy: {
          [`${resourceName}_lambda_invoke`]: {
            name: physicalName(service.metadata, "lambda-invoke"),
            role: `\${aws_iam_role.${taskRoleName}.id}`,
            policy: JSON.stringify({
              Version: "2012-10-17",
              Statement: lambdaPermissions.map((p) => ({
                Effect: "Allow",
                Action: p.actions,
                Resource: `arn:aws:lambda:${regionForTarget(options.target ?? "aws")}:*:function:${serviceNameFor(p.service, options, "permissions.lambda references unknown Lambda service")}`,
              })),
            }),
          },
        },
      }
    : {};

  return baseTerraform(
    service.metadata,
    options.target ?? "aws",
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
        ...(hasLambdaPermissions
          ? {
              [taskRoleName]: {
                name: physicalName(service.metadata, "task-role"),
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
            }
          : {}),
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
      ...taskRoleResources,
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
          ...(hasLambdaPermissions
            ? { task_role_arn: `\${aws_iam_role.${taskRoleName}.arn}` }
            : {}),
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
              ...(containerEnvironment !== undefined ? { environment: containerEnvironment } : {}),
            },
          ]),
        },
      },
      aws_lb: {
        [resourceName]: {
          name: loadBalancerName,
          load_balancer_type: "application",
          internal: service.metadata.securityZone !== "public",
          subnets: "${data.aws_subnets.selected.ids}",
          security_groups: [`\${aws_security_group.${resourceName}.id}`],
          tags: tagsFor(service.metadata),
        },
      },
      aws_lb_target_group: {
        [resourceName]: {
          name: loadBalancerName,
          port: service.config.service.containerPort,
          protocol: "HTTP",
          target_type: "instance",
          vpc_id: "${data.aws_vpc.selected.id}",
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
          vpc_zone_identifier: "${data.aws_subnets.selected.ids}",
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
          vpc_id: "${data.aws_vpc.selected.id}",
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
      ...vpcDataSources(service.metadata),
      aws_ssm_parameter: {
        ecs_optimized_ami: {
          name: "/aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id",
        },
      },
    },
  );
}

function flociEcsResources(
  service: EcsService,
  resourceName: string,
  options: TerraformContext,
): TerraformJson {
  const physicalServiceName = physicalName(service.metadata);
  const loadBalancerName = ecsLoadBalancerName(service.metadata);
  const taskRoleName = `${resourceName}_task_role`;
  const lambdaPermissions = service.config.permissions?.lambda;
  const hasLambdaPermissions = lambdaPermissions !== undefined && lambdaPermissions.length > 0;

  const containerEnvironment = containerEnvironmentFor(service, options);

  const taskRoleResources = hasLambdaPermissions
    ? {
        aws_iam_role: {
          [taskRoleName]: {
            name: physicalName(service.metadata, "task-role"),
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
        aws_iam_role_policy: {
          [`${resourceName}_lambda_invoke`]: {
            name: physicalName(service.metadata, "lambda-invoke"),
            role: `\${aws_iam_role.${taskRoleName}.id}`,
            policy: JSON.stringify({
              Version: "2012-10-17",
              Statement: lambdaPermissions.map((p) => ({
                Effect: "Allow",
                Action: p.actions,
                Resource: `arn:aws:lambda:${regionForTarget("floci")}:*:function:${serviceNameFor(p.service, options, "permissions.lambda references unknown Lambda service")}`,
              })),
            }),
          },
        },
      }
    : {};

  return baseTerraform(
    service.metadata,
    "floci",
    {
      aws_ecs_cluster: {
        [resourceName]: {
          name: physicalServiceName,
          tags: tagsFor(service.metadata),
        },
      },
      ...taskRoleResources,
      aws_ecs_task_definition: {
        [resourceName]: {
          family: physicalServiceName,
          network_mode: "bridge",
          requires_compatibilities: ["EC2"],
          cpu: String(service.config.task.cpu),
          memory: String(service.config.task.memoryMb),
          ...(hasLambdaPermissions
            ? { task_role_arn: `\${aws_iam_role.${taskRoleName}.arn}` }
            : {}),
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
              ...(containerEnvironment !== undefined ? { environment: containerEnvironment } : {}),
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
          name: loadBalancerName,
          load_balancer_type: "application",
          internal: false,
          subnets: "${data.aws_subnets.selected.ids}",
          tags: tagsFor(service.metadata),
        },
      },
      aws_lb_target_group: {
        [resourceName]: {
          name_prefix: targetGroupNamePrefix(resourceName),
          port: service.config.service.containerPort,
          protocol: "HTTP",
          target_type: "ip",
          vpc_id: "${data.aws_vpc.selected.id}",
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
          port: service.config.service.containerPort,
          protocol: "HTTP",
          default_action: {
            type: "forward",
            target_group_arn: `\${aws_lb_target_group.${resourceName}.arn}`,
          },
        },
      },
    },
    {
      ...vpcDataSources(service.metadata),
    },
  );
}

function awsFargateEcsResources(
  service: EcsService,
  resourceName: string,
  options: TerraformContext,
): TerraformJson {
  const physicalServiceName = physicalName(service.metadata);
  const roleName = `${resourceName}_task_execution_role`;
  const taskRoleName = `${resourceName}_task_role`;
  const lambdaPermissions = service.config.permissions?.lambda;
  const hasLambdaPermissions = lambdaPermissions !== undefined && lambdaPermissions.length > 0;

  const containerEnvironment = containerEnvironmentFor(service, options);

  const taskRoleResources = hasLambdaPermissions
    ? {
        aws_iam_role_policy: {
          [`${resourceName}_lambda_invoke`]: {
            name: physicalName(service.metadata, "lambda-invoke"),
            role: `\${aws_iam_role.${taskRoleName}.id}`,
            policy: JSON.stringify({
              Version: "2012-10-17",
              Statement: lambdaPermissions.map((p) => ({
                Effect: "Allow",
                Action: p.actions,
                Resource: `arn:aws:lambda:${regionForTarget(options.target ?? "aws")}:*:function:${serviceNameFor(p.service, options, "permissions.lambda references unknown Lambda service")}`,
              })),
            }),
          },
        },
      }
    : {};

  return baseTerraform(
    service.metadata,
    options.target ?? "aws",
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
        ...(hasLambdaPermissions
          ? {
              [taskRoleName]: {
                name: physicalName(service.metadata, "task-role"),
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
            }
          : {}),
      },
      aws_iam_role_policy_attachment: {
        [`${roleName}_execution`]: {
          role: `\${aws_iam_role.${roleName}.name}`,
          policy_arn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
        },
      },
      ...taskRoleResources,
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
          ...(hasLambdaPermissions
            ? { task_role_arn: `\${aws_iam_role.${taskRoleName}.arn}` }
            : {}),
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
              ...(containerEnvironment !== undefined ? { environment: containerEnvironment } : {}),
            },
          ]),
        },
      },
      aws_lb: {
        [resourceName]: {
          name: physicalServiceName,
          load_balancer_type: "application",
          internal: service.metadata.securityZone !== "public",
          subnets: "${data.aws_subnets.selected.ids}",
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
          vpc_id: "${data.aws_vpc.selected.id}",
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
            subnets: "${data.aws_subnets.selected.ids}",
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
          vpc_id: "${data.aws_vpc.selected.id}",
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
      ...vpcDataSources(service.metadata),
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
