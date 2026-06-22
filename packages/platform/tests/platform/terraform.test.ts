import { describe, expect, test } from "vitest";
import { generatedDirectoryForService } from "../../src/generated-paths";
import { terraformForService, type TerraformJson } from "../../src/terraform";
import type { LoadedService } from "../../src/types";

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

function stringProperty(object: TerraformObject, property: string): string {
  const value = object[property];
  expect(value).toBeTypeOf("string");
  return String(value);
}

describe("terraformForService", () => {
  test("generates Terraform beside the source service folder", () => {
    expect(
      generatedDirectoryForService(
        {
          env: "dev",
          venture: "venture",
          vpc: "core",
          securityZone: "internal",
          serviceName: "payment-api",
          serviceType: "lambda",
          sourcePath: "infra/services/dev/venture/core/internal/payment-api.lambda.yaml",
        },
        "floci",
      ),
    ).toBe("infra/services/dev/venture/core/internal/__generated__/floci/payment-api");
  });

  test("generates protected DynamoDB Terraform JSON", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "managed",
        serviceName: "customer-records",
        serviceType: "dynamodb",
        sourcePath: "infra/services/dev/venture/core/managed/customer-records.dynamodb.yaml",
      },
      config: {
        billingMode: "PAY_PER_REQUEST",
        hashKey: { name: "customerId", type: "S" },
        pointInTimeRecovery: true,
      },
    };

    const terraform = terraformResult(terraformForService(service, { target: "aws" }));
    const table = resource(terraform, "aws_dynamodb_table", "customer_records");

    expect(table).toMatchObject({
      name: "dev-venture-core-managed-customer-records",
      billing_mode: "PAY_PER_REQUEST",
      hash_key: "customerId",
      deletion_protection_enabled: true,
      point_in_time_recovery: { enabled: true },
      lifecycle: { prevent_destroy: true },
    });
    expect(table.tags).toMatchObject({
      Environment: "dev",
      Vpc: "core",
      Venture: "venture",
      SecurityZone: "managed",
      ServiceName: "customer-records",
    });
  });

  test("generates ECS Fargate Terraform JSON for a Next.js app", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "public",
        serviceName: "docs-app",
        serviceType: "ecs",
        sourcePath: "infra/services/dev/venture/core/public/docs-app.ecs.yaml",
      },
      config: {
        cluster: { capacity: "fargate" },
        service: {
          desiredCount: 1,
          containerPort: 3001,
          autoscaling: {
            minCount: 1,
            maxCount: 4,
            targetCpuUtilization: 60,
            targetMemoryUtilization: 70,
          },
        },
        task: { cpu: 512, memoryMb: 1024 },
        image: { repository: "nebula-docs", tag: "local" },
        healthCheck: { path: "/docs" },
      },
    };

    const terraform = terraformResult(terraformForService(service, { target: "aws" }));

    expect(resource(terraform, "aws_ecs_task_definition", "docs_app")).toMatchObject({
      family: "dev-venture-core-public-docs-app",
      network_mode: "awsvpc",
      requires_compatibilities: ["FARGATE"],
      cpu: "512",
      memory: "1024",
    });
    expect(resource(terraform, "aws_ecs_service", "docs_app")).toMatchObject({
      name: "dev-venture-core-public-docs-app",
      launch_type: "FARGATE",
      desired_count: 1,
      network_configuration: {
        subnets: "${data.aws_subnets.selected.ids}",
        security_groups: ["${aws_security_group.docs_app.id}"],
        assign_public_ip: true,
      },
      load_balancer: {
        target_group_arn: "${aws_lb_target_group.docs_app.arn}",
        container_name: "docs_app",
        container_port: 3001,
      },
    });
    expect(resource(terraform, "aws_lb_target_group", "docs_app")).toMatchObject({
      name: "dev-venture-core-public-docs-app",
      port: 3001,
      protocol: "HTTP",
      target_type: "ip",
      health_check: {
        path: "/docs",
        protocol: "HTTP",
      },
    });
    expect(resource(terraform, "aws_appautoscaling_target", "docs_app")).toMatchObject({
      max_capacity: 4,
      min_capacity: 1,
      resource_id: "service/${aws_ecs_cluster.docs_app.name}/${aws_ecs_service.docs_app.name}",
      scalable_dimension: "ecs:service:DesiredCount",
      service_namespace: "ecs",
    });
    expect(resource(terraform, "aws_appautoscaling_policy", "docs_app_cpu")).toMatchObject({
      target_tracking_scaling_policy_configuration: {
        predefined_metric_specification: {
          predefined_metric_type: "ECSServiceAverageCPUUtilization",
        },
        target_value: 60,
      },
    });
    expect(resource(terraform, "aws_appautoscaling_policy", "docs_app_memory")).toMatchObject({
      target_tracking_scaling_policy_configuration: {
        predefined_metric_specification: {
          predefined_metric_type: "ECSServiceAverageMemoryUtilization",
        },
        target_value: 70,
      },
    });
    expect(terraform.resource.aws_launch_template).toBeUndefined();
    expect(terraform.resource.aws_autoscaling_group).toBeUndefined();
    expect(terraform.resource.aws_ecs_capacity_provider).toBeUndefined();
    expect(data(terraform, "aws_vpc", "selected")).toEqual({
      filter: { name: "tag:Name", values: ["dev-venture-core-vpc"] },
    });
    expect(data(terraform, "aws_subnets", "selected")).toEqual({
      filter: [
        { name: "vpc-id", values: ["${data.aws_vpc.selected.id}"] },
        { name: "tag:Zone", values: ["public"] },
      ],
    });

    const flociTerraform = terraformResult(terraformForService(service, { target: "floci" }));

    expect(resource(flociTerraform, "aws_ecs_service", "docs_app")).toMatchObject({
      launch_type: "EC2",
      desired_count: 1,
      load_balancer: {
        target_group_arn: "${aws_lb_target_group.docs_app.arn}",
        container_name: "docs_app",
        container_port: 3001,
      },
      depends_on: ["aws_lb_listener.docs_app"],
    });
    expect(resource(flociTerraform, "aws_lb_listener", "docs_app")).toMatchObject({
      port: 3001,
      protocol: "HTTP",
    });
    expect(resource(flociTerraform, "aws_lb_target_group", "docs_app")).toMatchObject({
      name_prefix: "docsa-",
      port: 3001,
      protocol: "HTTP",
      target_type: "ip",
      health_check: {
        path: "/docs",
        protocol: "HTTP",
      },
      lifecycle: {
        create_before_destroy: true,
      },
    });
    expect(flociTerraform.resource.aws_appautoscaling_target).toBeUndefined();
    expect(flociTerraform.resource.aws_appautoscaling_policy).toBeUndefined();
  });

  test("generates ECS EC2 capacity resources when requested", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "public",
        serviceName: "docs-app",
        serviceType: "ecs",
        sourcePath: "infra/services/dev/venture/core/public/docs-app.ecs.yaml",
      },
      config: {
        cluster: { capacity: "ec2", instanceType: "t3.micro", desiredCapacity: 1 },
        service: { desiredCount: 1, containerPort: 3001 },
        task: { cpu: 512, memoryMb: 1024 },
        image: { repository: "nebula-docs", tag: "local" },
        healthCheck: { path: "/docs" },
      },
    };

    const terraform = terraformResult(terraformForService(service, { target: "aws" }));

    expect(resource(terraform, "aws_ecs_task_definition", "docs_app")).toMatchObject({
      network_mode: "bridge",
      requires_compatibilities: ["EC2"],
    });
    expect(resource(terraform, "aws_ecs_service", "docs_app")).toMatchObject({
      launch_type: "EC2",
    });
    expect(resource(terraform, "aws_launch_template", "docs_app")).toMatchObject({
      name_prefix: "dev-venture-core-public-docs-app-",
      instance_type: "t3.micro",
      image_id: "${data.aws_ssm_parameter.ecs_optimized_ami.value}",
    });
    expect(resource(terraform, "aws_autoscaling_group", "docs_app")).toMatchObject({
      desired_capacity: 1,
      min_size: 1,
      max_size: 1,
    });
    expect(data(terraform, "aws_ssm_parameter", "ecs_optimized_ami")).toEqual({
      name: "/aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id",
    });
  });

  test("generates Lambda Terraform JSON from a package path", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "internal",
        serviceName: "payment-api",
        serviceType: "lambda",
        sourcePath: "infra/services/dev/venture/core/internal/payment-api.lambda.yaml",
      },
      config: {
        runtime: "nodejs22.x",
        handler: "index.handler",
        package: "../../../../../../apps/payment-api/dist/payment-api.zip",
        memoryMb: 128,
        timeoutSeconds: 10,
        logRetentionDays: 7,
        environment: {},
        permissions: {
          dynamodb: [
            {
              service: "customer-records",
              actions: ["dynamodb:PutItem", "dynamodb:GetItem"],
            },
          ],
        },
      },
    };

    const terraform = terraformResult(
      terraformForService(service, {
        target: "aws",
        moduleDirectory: "infra/services/dev/venture/core/internal/__generated__/aws/payment-api",
        serviceNames: {
          "customer-records": "dev-venture-core-managed-customer-records",
        },
      }),
    );
    const fn = resource(terraform, "aws_lambda_function", "payment_api");
    const logGroup = resource(terraform, "aws_cloudwatch_log_group", "payment_api");

    expect(fn).toMatchObject({
      function_name: "dev-venture-core-internal-payment-api",
      handler: "index.handler",
      runtime: "nodejs22.x",
      memory_size: 128,
      timeout: 10,
      environment: {
        variables: {
          TABLE_NAME: "dev-venture-core-managed-customer-records",
        },
      },
    });
    expect(fn.filename).toBe("../../../../../../../../../apps/payment-api/dist/payment-api.zip");
    expect(fn.source_code_hash).toBe(
      '${filebase64sha256("../../../../../../../../../apps/payment-api/dist/payment-api.zip")}',
    );
    expect(logGroup).toMatchObject({
      name: "/aws/lambda/dev-venture-core-internal-payment-api",
      retention_in_days: 7,
    });
    const policy = resource(terraform, "aws_iam_role_policy", "payment_api_dynamodb_access");
    expect(policy.role).toBe("${aws_iam_role.payment_api_lambda_role.id}");
    expect(JSON.parse(stringProperty(policy, "policy"))).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["dynamodb:PutItem", "dynamodb:GetItem"],
          Resource:
            "arn:aws:dynamodb:ap-southeast-2:*:table/dev-venture-core-managed-customer-records",
        },
      ],
    });
  });

  test("requires Lambda DynamoDB permissions to resolve through discovered service names", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "internal",
        serviceName: "payment-api",
        serviceType: "lambda",
        sourcePath: "infra/services/dev/venture/core/internal/payment-api.lambda.yaml",
      },
      config: {
        runtime: "nodejs22.x",
        handler: "index.handler",
        package: "../../dist/payment-api.zip",
        memoryMb: 128,
        timeoutSeconds: 10,
        logRetentionDays: 7,
        environment: {},
        permissions: {
          dynamodb: [
            {
              service: "customer-records",
              actions: ["dynamodb:PutItem"],
            },
          ],
        },
      },
    };

    expect(() => terraformForService(service, { target: "aws" })).toThrow(
      "permissions.dynamodb references unknown DynamoDB service customer-records",
    );
  });

  test("generates Floci provider endpoints", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "managed",
        serviceName: "customer-records",
        serviceType: "dynamodb",
        sourcePath: "infra/services/dev/venture/core/managed/customer-records.dynamodb.yaml",
      },
      config: {
        billingMode: "PAY_PER_REQUEST",
        hashKey: { name: "customerId", type: "S" },
        pointInTimeRecovery: true,
      },
    };

    const terraform = terraformResult(terraformForService(service, { target: "floci" }));

    expect(terraform.provider.aws).toMatchObject({
      region: "us-east-1",
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
        lambda: "http://localhost:4566",
        logs: "http://localhost:4566",
        route53: "http://localhost:4566",
        s3: "http://localhost:4566",
        sts: "http://localhost:4566",
      },
    });
  });

  test("generates public docs API Gateway routes with Route53", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "public",
        serviceName: "docs",
        serviceType: "apigateway",
        sourcePath: "infra/services/dev/venture/core/public/docs.apigateway.yaml",
      },
      config: {
        description: "Docs app ingress.",
        domain: {
          floci: {
            name: "app.localhost.floci.io",
            zoneName: "localhost.floci.io",
          },
          aws: {
            name: "app.dev.example.com",
            zoneName: "dev.example.com",
            certificate: {
              lookupDomain: "*.dev.example.com",
            },
          },
        },
        routes: [
          {
            path: "/docs",
            method: "ANY",
            target: { type: "http_proxy", uri: "http://host.docker.internal:3001/docs" },
          },
          {
            path: "/docs/{proxy+}",
            method: "ANY",
            target: { type: "http_proxy", uri: "http://host.docker.internal:3001/docs/{proxy}" },
          },
        ],
      },
    };

    const terraform = terraformResult(terraformForService(service, { target: "floci" }));

    expect(resource(terraform, "aws_apigatewayv2_api", "docs")).toMatchObject({
      name: "dev-venture-core-public-docs",
      protocol_type: "HTTP",
    });
    expect(resource(terraform, "aws_apigatewayv2_stage", "docs_default").lifecycle).toEqual({
      ignore_changes: ["tags", "tags_all"],
    });
    expect(resource(terraform, "aws_apigatewayv2_stage", "docs_default").tags).toBeUndefined();
    expect(
      resource(terraform, "aws_apigatewayv2_integration", "docs_http_proxy_docs_proxy"),
    ).toMatchObject({
      api_id: "${aws_apigatewayv2_api.docs.id}",
      integration_type: "HTTP_PROXY",
      integration_uri: "http://host.docker.internal:3001/docs/{proxy}",
      integration_method: "ANY",
    });
    expect(
      resource(terraform, "aws_apigatewayv2_integration", "docs_http_proxy_docs"),
    ).toMatchObject({
      api_id: "${aws_apigatewayv2_api.docs.id}",
      integration_type: "HTTP_PROXY",
      integration_uri: "http://host.docker.internal:3001/docs",
      integration_method: "ANY",
    });
    expect(
      resource(terraform, "aws_apigatewayv2_route", "docs_http_proxy_docs_proxy").route_key,
    ).toBe("ANY /docs/{proxy+}");
    expect(resource(terraform, "aws_apigatewayv2_route", "docs_http_proxy_docs").route_key).toBe(
      "ANY /docs",
    );
    expect(terraform.resource.aws_lambda_permission).toBeUndefined();
    expect(terraform.resource.aws_apigatewayv2_domain_name).toBeUndefined();
    expect(terraform.resource.aws_apigatewayv2_api_mapping).toBeUndefined();
    expect(terraform.data).toEqual({});
    expect(terraform.resource.aws_route53_zone).toBeUndefined();
    expect(terraform.resource.aws_route53_record).toBeUndefined();

    const awsTerraform = terraformResult(terraformForService(service, { target: "aws" }));

    expect(
      resource(awsTerraform, "aws_apigatewayv2_stage", "docs_default").lifecycle,
    ).toBeUndefined();
    expect(resource(awsTerraform, "aws_apigatewayv2_stage", "docs_default").tags).toMatchObject({
      Environment: "dev",
      ServiceName: "docs",
      ServiceType: "apigateway",
    });
    expect(data(awsTerraform, "aws_route53_zone", "docs")).toEqual({
      name: "dev.example.com",
      private_zone: false,
    });
    expect(data(awsTerraform, "aws_acm_certificate", "docs")).toEqual({
      domain: "*.dev.example.com",
      statuses: ["ISSUED"],
      most_recent: true,
    });
    expect(awsTerraform.resource.aws_route53_zone).toBeUndefined();
    expect(resource(awsTerraform, "aws_route53_record", "docs").name).toBe("app.dev.example.com");
    expect(resource(awsTerraform, "aws_apigatewayv2_domain_name", "docs").domain_name).toBe(
      "app.dev.example.com",
    );
    expect(
      objectProperty(
        resource(awsTerraform, "aws_apigatewayv2_domain_name", "docs"),
        "domain_name_configuration",
      ).certificate_arn,
    ).toBe("${data.aws_acm_certificate.docs.arn}");
  });

  test("generates API Gateway HTTP proxy routes for ECS targets", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "public",
        serviceName: "docs-ingress",
        serviceType: "apigateway",
        sourcePath: "infra/services/dev/venture/core/public/docs-ingress.apigateway.yaml",
      },
      config: {
        description: "Docs ingress",
        routes: [
          {
            path: "/docs",
            method: "ANY",
            target: { type: "ecs", service: "docs-app" },
          },
        ],
      },
    };

    const terraform = terraformResult(
      terraformForService(service, {
        target: "aws",
        serviceNames: {
          "docs-app": "dev-venture-core-public-docs-app",
        },
      }),
    );

    expect(
      resource(terraform, "aws_apigatewayv2_integration", "docs_ingress_ecs_docs"),
    ).toMatchObject({
      api_id: "${aws_apigatewayv2_api.docs_ingress.id}",
      integration_type: "HTTP_PROXY",
      integration_method: "ANY",
      integration_uri: "http://${data.aws_lb.docs_app.dns_name}/docs",
    });
    expect(data(terraform, "aws_lb", "docs_app")).toEqual({
      name: "dev-venture-core-public-docs-app",
    });
    expect(resource(terraform, "aws_apigatewayv2_route", "docs_ingress_ecs_docs")).toMatchObject({
      route_key: "ANY /docs",
    });

    const flociTerraform = terraformResult(
      terraformForService(service, {
        target: "floci",
        serviceNames: {
          "docs-app": "dev-venture-core-public-docs-app",
        },
        serviceContainerPorts: {
          "docs-app": 3001,
        },
      }),
    );

    expect(
      resource(flociTerraform, "aws_apigatewayv2_integration", "docs_ingress_ecs_docs"),
    ).toMatchObject({
      integration_type: "HTTP_PROXY",
      integration_uri: "http://${data.aws_lb.docs_app.dns_name}:3001/docs",
    });
    expect(data(flociTerraform, "aws_lb", "docs_app")).toEqual({
      name: "dev-venture-core-public-docs-app",
    });
  });

  test("requires ECS container ports for Floci API Gateway ECS targets", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "public",
        serviceName: "docs-ingress",
        serviceType: "apigateway",
        sourcePath: "infra/services/dev/venture/core/public/docs-ingress.apigateway.yaml",
      },
      config: {
        description: "Docs ingress",
        routes: [
          {
            path: "/docs",
            method: "ANY",
            target: { type: "ecs", service: "docs-app" },
          },
        ],
      },
    };

    expect(() =>
      terraformForService(service, {
        target: "floci",
        serviceNames: {
          "docs-app": "dev-venture-core-public-docs-app",
        },
      }),
    ).toThrow("apigateway route references ECS service without container port docs-app");
  });

  test("requires an AWS API Gateway domain certificate config", () => {
    const service = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "public",
        serviceName: "docs",
        serviceType: "apigateway",
        sourcePath: "infra/services/dev/venture/core/public/docs.apigateway.yaml",
      },
      config: {
        domain: {
          floci: {
            name: "app.localhost.floci.io",
            zoneName: "localhost.floci.io",
          },
          aws: {
            name: "app.dev.example.com",
            zoneName: "dev.example.com",
          },
        },
        routes: [
          {
            path: "/docs",
            method: "ANY",
            target: { type: "http_proxy", uri: "http://host.docker.internal:3001/docs" },
          },
        ],
      },
    } satisfies LoadedService;

    expect(() =>
      terraformForService(service, {
        target: "aws",
        serviceNames: {
          "payment-api": "dev-venture-core-internal-payment-api",
        },
      }),
    ).toThrow("domain.aws.certificate is required for API Gateway domain app.dev.example.com");
  });

  test("supports explicit AWS API Gateway certificate ARNs", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "public",
        serviceName: "docs",
        serviceType: "apigateway",
        sourcePath: "infra/services/dev/venture/core/public/docs.apigateway.yaml",
      },
      config: {
        domain: {
          aws: {
            name: "app.dev.example.com",
            zoneName: "dev.example.com",
            certificate: {
              arn: "arn:aws:acm:ap-southeast-2:123456789012:certificate/example",
            },
          },
        },
        routes: [
          {
            path: "/docs",
            method: "ANY",
            target: { type: "http_proxy", uri: "http://host.docker.internal:3001/docs" },
          },
        ],
      },
    };

    const terraform = terraformResult(terraformForService(service, { target: "aws" }));

    expect(terraform.data.aws_acm_certificate).toBeUndefined();
    expect(
      objectProperty(
        resource(terraform, "aws_apigatewayv2_domain_name", "docs"),
        "domain_name_configuration",
      ).certificate_arn,
    ).toBe("arn:aws:acm:ap-southeast-2:123456789012:certificate/example");
  });

  test("generates API Gateway without Route53 for internal Lambda ingress", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "internal",
        serviceName: "payment-api-ingress",
        serviceType: "apigateway",
        sourcePath: "infra/services/dev/venture/core/internal/payment-api-ingress.apigateway.yaml",
      },
      config: {
        description: "Payment API internal ingress.",
        routes: [
          {
            path: "/api/payments",
            method: "POST",
            target: { type: "lambda", service: "payment-api" },
          },
        ],
      },
    };

    const terraform = terraformResult(
      terraformForService(service, {
        target: "aws",
        serviceNames: {
          "payment-api": "dev-venture-core-internal-payment-api",
        },
      }),
    );

    expect(resource(terraform, "aws_apigatewayv2_api", "payment_api_ingress")).toMatchObject({
      name: "dev-venture-core-internal-payment-api-ingress",
      protocol_type: "HTTP",
    });
    expect(
      resource(
        terraform,
        "aws_apigatewayv2_integration",
        "payment_api_ingress_lambda_api_payments",
      ),
    ).toMatchObject({
      api_id: "${aws_apigatewayv2_api.payment_api_ingress.id}",
      integration_type: "AWS_PROXY",
      payload_format_version: "2.0",
    });
    expect(
      resource(terraform, "aws_apigatewayv2_route", "payment_api_ingress_lambda_api_payments")
        .route_key,
    ).toBe("POST /api/payments");
    expect(terraform.resource.aws_apigatewayv2_domain_name).toBeUndefined();
    expect(terraform.resource.aws_apigatewayv2_api_mapping).toBeUndefined();
    expect(terraform.resource.aws_route53_record).toBeUndefined();
    expect(terraform.data.aws_route53_zone).toBeUndefined();
  });

  test("dispatches every service type through the registry", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "managed",
        serviceName: "customer-records",
        serviceType: "dynamodb",
        sourcePath: "infra/services/dev/venture/core/managed/customer-records.dynamodb.yaml",
      },
      config: {
        billingMode: "PAY_PER_REQUEST",
        hashKey: { name: "id", type: "S" },
        pointInTimeRecovery: false,
      },
    };
    const dynamo = terraformResult(terraformForService(service, { target: "aws" }));
    expect(Object.keys(dynamo.resource)).toContain("aws_dynamodb_table");
  });

  test("lambda runs in the VPC: vpc_config with the zone subnets + lambda SG + VPC-access policy", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "internal",
        serviceName: "payment-api",
        serviceType: "lambda",
        sourcePath: "infra/services/dev/venture/core/internal/payment-api.lambda.yaml",
      },
      config: {
        runtime: "nodejs22.x",
        handler: "index.handler",
        package: "../x.zip",
        memoryMb: 128,
        timeoutSeconds: 10,
        logRetentionDays: 7,
        environment: {},
        zone: "internal",
        permissions: { dynamodb: [{ service: "customer-records", actions: ["dynamodb:PutItem"] }] },
      },
    };
    const tf = terraformResult(
      terraformForService(service, {
        target: "aws",
        serviceNames: { "customer-records": "dev-venture-core-managed-customer-records" },
      }),
    );
    // vpc_config on the function
    const fn = resource(tf, "aws_lambda_function", "payment_api");
    expect(objectProperty(fn, "vpc_config")).toEqual({
      subnet_ids: "${data.aws_subnets.selected.ids}",
      security_group_ids: ["${aws_security_group.payment_api.id}"],
    });
    // lambda SG in the looked-up VPC
    expect(resource(tf, "aws_security_group", "payment_api")["vpc_id"]).toBe(
      "${data.aws_vpc.selected.id}",
    );
    // separate egress rule (NOT inline)
    expect(resource(tf, "aws_security_group_rule", "payment_api_egress")).toMatchObject({
      type: "egress",
      from_port: 0,
      to_port: 0,
      protocol: "-1",
      cidr_blocks: ["0.0.0.0/0"],
      security_group_id: "${aws_security_group.payment_api.id}",
    });
    // VPC-access managed policy attachment
    expect(
      resource(tf, "aws_iam_role_policy_attachment", "payment_api_vpc_access")["policy_arn"],
    ).toBe("arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole");
    // VPC data sources present
    expect(data(tf, "aws_vpc", "selected")["filter"]).toEqual({
      name: "tag:Name",
      values: ["dev-venture-core-vpc"],
    });
    expect(data(tf, "aws_subnets", "selected")).toBeDefined();
  });

  test("lambda defaults to the internal zone when zone omitted", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "internal",
        serviceName: "payment-api",
        serviceType: "lambda",
        sourcePath: "infra/services/dev/venture/core/internal/payment-api.lambda.yaml",
      },
      config: {
        runtime: "nodejs22.x",
        handler: "index.handler",
        package: "../x.zip",
        memoryMb: 128,
        timeoutSeconds: 10,
        logRetentionDays: 7,
        environment: {},
        permissions: { dynamodb: [] },
      },
    };
    const tf = terraformResult(terraformForService(service, { target: "aws" }));
    // internal zone → subnets present via default
    expect(
      objectProperty(resource(tf, "aws_lambda_function", "payment_api"), "vpc_config")[
        "subnet_ids"
      ],
    ).toBe("${data.aws_subnets.selected.ids}");
  });

  test("ecs permissions.lambda grants InvokeFunction on the target + injects function name env", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "public",
        serviceName: "payments-app",
        serviceType: "ecs",
        sourcePath: "infra/services/dev/venture/core/public/payments-app.ecs.yaml",
      },
      config: {
        cluster: { capacity: "fargate" },
        service: { desiredCount: 1, containerPort: 3002 },
        task: { cpu: 256, memoryMb: 512 },
        image: { repository: "nebula-payments", tag: "local" },
        healthCheck: { path: "/payments" },
        permissions: { lambda: [{ service: "payment-api", actions: ["lambda:InvokeFunction"] }] },
      },
    };
    const tf = terraformResult(
      terraformForService(service, {
        target: "aws",
        serviceNames: { "payment-api": "dev-venture-core-internal-payment-api" },
      }),
    );
    const taskRole = resource(tf, "aws_iam_role", "payments_app_task_role");
    expect(taskRole["name"]).toBe("dev-venture-core-public-payments-app-task-role");
    const policy = resource(tf, "aws_iam_role_policy", "payments_app_lambda_invoke");
    const doc = JSON.parse(stringProperty(policy, "policy"));
    expect(doc.Statement[0].Action).toEqual(["lambda:InvokeFunction"]);
    expect(doc.Statement[0].Resource).toBe(
      "arn:aws:lambda:ap-southeast-2:*:function:dev-venture-core-internal-payment-api",
    );
    const taskDef = resource(tf, "aws_ecs_task_definition", "payments_app");
    expect(taskDef["task_role_arn"]).toBe("${aws_iam_role.payments_app_task_role.arn}");
    const container = JSON.parse(stringProperty(taskDef, "container_definitions"))[0];
    expect(container.environment).toContainEqual({
      name: "PAYMENT_API_FUNCTION_NAME",
      value: "dev-venture-core-internal-payment-api",
    });
  });

  test("ecs permissions.lambda injects Floci AWS endpoint + creds so the task SDK reaches Floci", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "public",
        serviceName: "payments-app",
        serviceType: "ecs",
        sourcePath: "infra/services/dev/venture/core/public/payments-app.ecs.yaml",
      },
      config: {
        cluster: { capacity: "fargate" },
        service: { desiredCount: 1, containerPort: 3002 },
        task: { cpu: 256, memoryMb: 512 },
        image: { repository: "nebula-payments", tag: "local" },
        healthCheck: { path: "/payments" },
        permissions: { lambda: [{ service: "payment-api", actions: ["lambda:InvokeFunction"] }] },
      },
    };
    const tf = terraformResult(
      terraformForService(service, {
        target: "floci",
        serviceNames: { "payment-api": "dev-venture-core-internal-payment-api" },
      }),
    );
    const taskDef = resource(tf, "aws_ecs_task_definition", "payments_app");
    const container = JSON.parse(stringProperty(taskDef, "container_definitions"))[0];
    expect(container.environment).toContainEqual({
      name: "PAYMENT_API_FUNCTION_NAME",
      value: "dev-venture-core-internal-payment-api",
    });
    expect(container.environment).toContainEqual({
      name: "AWS_ENDPOINT_URL",
      value: "http://host.docker.internal:4566",
    });
    expect(container.environment).toContainEqual({ name: "AWS_ACCESS_KEY_ID", value: "test" });
    expect(container.environment).toContainEqual({ name: "AWS_SECRET_ACCESS_KEY", value: "test" });
  });

  test("ecs permissions.lambda on aws does NOT inject Floci creds", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "public",
        serviceName: "payments-app",
        serviceType: "ecs",
        sourcePath: "infra/services/dev/venture/core/public/payments-app.ecs.yaml",
      },
      config: {
        cluster: { capacity: "fargate" },
        service: { desiredCount: 1, containerPort: 3002 },
        task: { cpu: 256, memoryMb: 512 },
        image: { repository: "nebula-payments", tag: "local" },
        healthCheck: { path: "/payments" },
        permissions: { lambda: [{ service: "payment-api", actions: ["lambda:InvokeFunction"] }] },
      },
    };
    const tf = terraformResult(
      terraformForService(service, {
        target: "aws",
        serviceNames: { "payment-api": "dev-venture-core-internal-payment-api" },
      }),
    );
    const taskDef = resource(tf, "aws_ecs_task_definition", "payments_app");
    const container = JSON.parse(stringProperty(taskDef, "container_definitions"))[0];
    expect(container.environment).not.toContainEqual({ name: "AWS_ACCESS_KEY_ID", value: "test" });
    expect(container.environment).not.toContainEqual({
      name: "AWS_ENDPOINT_URL",
      value: "http://host.docker.internal:4566",
    });
  });

  test("ecs without permissions.lambda emits no task role (byte-identical path)", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "public",
        serviceName: "docs-app",
        serviceType: "ecs",
        sourcePath: "infra/services/dev/venture/core/public/docs-app.ecs.yaml",
      },
      config: {
        cluster: { capacity: "fargate" },
        service: { desiredCount: 1, containerPort: 3001 },
        task: { cpu: 256, memoryMb: 512 },
        image: { repository: "nebula-docs", tag: "local" },
        healthCheck: { path: "/docs" },
      },
    };
    const tf = terraformResult(terraformForService(service, { target: "aws" }));
    expect(objectProperty(tf.resource, "aws_iam_role")["docs_app_task_role"]).toBeUndefined();
    expect(resource(tf, "aws_ecs_task_definition", "docs_app")["task_role_arn"]).toBeUndefined();
  });

  test("injects local AWS endpoint URL for Floci Lambda deployments", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "internal",
        serviceName: "payment-api",
        serviceType: "lambda",
        sourcePath: "infra/services/dev/venture/core/internal/payment-api.lambda.yaml",
      },
      config: {
        runtime: "nodejs22.x",
        handler: "index.handler",
        package: "../../dist/payment-api.zip",
        memoryMb: 128,
        timeoutSeconds: 10,
        logRetentionDays: 7,
        environment: {},
        permissions: {
          dynamodb: [
            {
              service: "customer-records",
              actions: ["dynamodb:PutItem"],
            },
          ],
        },
      },
    };

    const terraform = terraformResult(
      terraformForService(service, {
        target: "floci",
        serviceNames: {
          "customer-records": "dev-venture-core-managed-customer-records",
        },
      }),
    );

    const lambda = resource(terraform, "aws_lambda_function", "payment_api");
    const environment = objectProperty(lambda, "environment");
    expect(environment.variables).toEqual({
      TABLE_NAME: "dev-venture-core-managed-customer-records",
      AWS_ENDPOINT_URL: "http://localhost.floci.io:4566",
    });
  });
});
