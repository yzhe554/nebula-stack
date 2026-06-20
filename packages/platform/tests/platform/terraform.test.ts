import { describe, expect, test } from "vitest";
import { generatedDirectoryForService } from "../../src/generated-paths";
import { terraformForService } from "../../src/terraform";
import type { LoadedService } from "../../src/types";

describe("terraformForService", () => {
  test("generates Terraform beside the source service folder", () => {
    expect(generatedDirectoryForService({
      env: "dev",
      venture: "venture",
      vpc: "core",
      securityZone: "internal",
      serviceName: "payment-api",
      serviceType: "lambda",
      sourcePath: "infra/services/dev/venture/core/internal/payment-api.lambda.yaml",
    }, "floci")).toBe("infra/services/dev/venture/core/internal/__generated__/floci/payment-api");
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

    const terraform = terraformForService(service, { target: "aws" }) as any;
    const table = terraform.resource.aws_dynamodb_table.customer_records;

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

    const terraform = terraformForService(service, {
      target: "aws",
      moduleDirectory: "infra/services/dev/venture/core/internal/__generated__/aws/payment-api",
      serviceNames: {
        "customer-records": "dev-venture-core-managed-customer-records",
      },
    }) as any;
    const fn = terraform.resource.aws_lambda_function.payment_api;
    const logGroup = terraform.resource.aws_cloudwatch_log_group.payment_api;

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
    expect(fn.source_code_hash).toBe('${filebase64sha256("../../../../../../../../../apps/payment-api/dist/payment-api.zip")}');
    expect(logGroup).toMatchObject({
      name: "/aws/lambda/dev-venture-core-internal-payment-api",
      retention_in_days: 7,
    });
    const policy = terraform.resource.aws_iam_role_policy.payment_api_dynamodb_access;
    expect(policy.role).toBe("${aws_iam_role.payment_api_lambda_role.id}");
    expect(JSON.parse(policy.policy)).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["dynamodb:PutItem", "dynamodb:GetItem"],
          Resource: "arn:aws:dynamodb:ap-southeast-2:*:table/dev-venture-core-managed-customer-records",
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

  test("generates Floci provider endpoints for local AWS emulation", () => {
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

    const terraform = terraformForService(service, { target: "floci" }) as any;

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
        s3: "http://localhost:4566",
        sts: "http://localhost:4566",
      },
    });
  });

  test("generates HTTP API Gateway routes for HTTP proxy and Lambda targets", () => {
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
        description: "Docs and API gateway",
        routes: [
          {
            path: "/",
            method: "ANY",
            target: { type: "http_proxy", uri: "http://host.docker.internal:3001/" },
          },
          {
            path: "/{proxy+}",
            method: "ANY",
            target: { type: "http_proxy", uri: "http://host.docker.internal:3001/{proxy}" },
          },
          {
            path: "/api/payments",
            method: "POST",
            target: { type: "lambda", service: "payment-api" },
          },
        ],
      },
    };

    const terraform = terraformForService(service, {
      target: "floci",
      serviceNames: {
        "payment-api": "dev-venture-core-internal-payment-api",
      },
    }) as any;

    expect(terraform.resource.aws_apigatewayv2_api.docs).toMatchObject({
      name: "dev-venture-core-public-docs",
      protocol_type: "HTTP",
    });
    expect(terraform.resource.aws_apigatewayv2_stage.docs_default.lifecycle).toEqual({
      ignore_changes: ["tags", "tags_all"],
    });
    expect(terraform.resource.aws_apigatewayv2_stage.docs_default.tags).toBeUndefined();
    expect(terraform.resource.aws_apigatewayv2_integration.docs_http_proxy_proxy).toMatchObject({
      api_id: "${aws_apigatewayv2_api.docs.id}",
      integration_type: "HTTP_PROXY",
      integration_uri: "http://host.docker.internal:3001/{proxy}",
      integration_method: "ANY",
    });
    expect(terraform.resource.aws_apigatewayv2_integration.docs_http_proxy_root).toMatchObject({
      api_id: "${aws_apigatewayv2_api.docs.id}",
      integration_type: "HTTP_PROXY",
      integration_uri: "http://host.docker.internal:3001/",
      integration_method: "ANY",
    });
    expect(terraform.resource.aws_apigatewayv2_integration.docs_lambda_api_payments).toMatchObject({
      api_id: "${aws_apigatewayv2_api.docs.id}",
      integration_type: "AWS_PROXY",
      integration_uri: "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:*:function:dev-venture-core-internal-payment-api/invocations",
      payload_format_version: "2.0",
    });
    expect(terraform.resource.aws_apigatewayv2_route.docs_http_proxy_proxy.route_key).toBe("ANY /{proxy+}");
    expect(terraform.resource.aws_apigatewayv2_route.docs_http_proxy_root.route_key).toBe("ANY /");
    expect(terraform.resource.aws_apigatewayv2_route.docs_lambda_api_payments.route_key).toBe("POST /api/payments");
    expect(terraform.resource.aws_lambda_permission.docs_lambda_api_payments).toMatchObject({
      action: "lambda:InvokeFunction",
      function_name: "dev-venture-core-internal-payment-api",
      principal: "apigateway.amazonaws.com",
      source_arn: "${aws_apigatewayv2_api.docs.execution_arn}/*/*",
    });

    const awsTerraform = terraformForService(service, {
      target: "aws",
      serviceNames: {
        "payment-api": "dev-venture-core-internal-payment-api",
      },
    }) as any;

    expect(awsTerraform.resource.aws_apigatewayv2_stage.docs_default.lifecycle).toBeUndefined();
    expect(awsTerraform.resource.aws_apigatewayv2_stage.docs_default.tags).toMatchObject({
      Environment: "dev",
      ServiceName: "docs",
      ServiceType: "apigateway",
    });
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

    const terraform = terraformForService(service, {
      target: "floci",
      serviceNames: {
        "customer-records": "dev-venture-core-managed-customer-records",
      },
    }) as any;

    expect(terraform.resource.aws_lambda_function.payment_api.environment.variables).toEqual({
      TABLE_NAME: "dev-venture-core-managed-customer-records",
      AWS_ENDPOINT_URL: "http://localhost.floci.io:4566",
    });
  });
});
