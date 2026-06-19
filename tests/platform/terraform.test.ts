import { describe, expect, test } from "vitest";
import { terraformForService } from "../../src/platform/terraform.js";
import type { LoadedService } from "../../src/platform/types.js";

describe("terraformForService", () => {
  test("generates protected DynamoDB Terraform JSON", () => {
    const service: LoadedService = {
      metadata: {
        env: "dev",
        venture: "venture",
        vpc: "core",
        securityZone: "restricted",
        serviceName: "customer-records",
        serviceType: "dynamodb",
        sourcePath: "services/dev/venture/core/restricted/customer-records.dynamodb.yaml",
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
      name: "dev-venture-core-restricted-customer-records",
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
      SecurityZone: "restricted",
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
        sourcePath: "services/dev/venture/core/internal/payment-api.lambda.yaml",
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
              actions: ["dynamodb:PutItem", "dynamodb:GetItem"],
            },
          ],
        },
      },
    };

    const terraform = terraformForService(service, {
      target: "aws",
      serviceNames: {
        "customer-records": "dev-venture-core-restricted-customer-records",
      },
    }) as any;
    const fn = terraform.resource.aws_lambda_function.payment_api;
    const logGroup = terraform.resource.aws_cloudwatch_log_group.payment_api;

    expect(fn).toMatchObject({
      function_name: "dev-venture-core-internal-payment-api",
      filename: "../../dist/payment-api.zip",
      handler: "index.handler",
      runtime: "nodejs22.x",
      memory_size: 128,
      timeout: 10,
      environment: {
        variables: {
          TABLE_NAME: "dev-venture-core-restricted-customer-records",
        },
      },
    });
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
          Resource: "arn:aws:dynamodb:ap-southeast-2:*:table/dev-venture-core-restricted-customer-records",
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
        sourcePath: "services/dev/venture/core/internal/payment-api.lambda.yaml",
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
        securityZone: "restricted",
        serviceName: "customer-records",
        serviceType: "dynamodb",
        sourcePath: "services/dev/venture/core/restricted/customer-records.dynamodb.yaml",
      },
      config: {
        billingMode: "PAY_PER_REQUEST",
        hashKey: { name: "customerId", type: "S" },
        pointInTimeRecovery: true,
      },
    };

    const terraform = terraformForService(service, { target: "floci" }) as any;

    expect(terraform.provider.aws).toMatchObject({
      region: "ap-southeast-2",
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
        sourcePath: "services/dev/venture/core/internal/payment-api.lambda.yaml",
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
        "customer-records": "dev-venture-core-restricted-customer-records",
      },
    }) as any;

    expect(terraform.resource.aws_lambda_function.payment_api.environment.variables).toEqual({
      TABLE_NAME: "dev-venture-core-restricted-customer-records",
      AWS_ENDPOINT_URL: "http://localhost.floci.io:4566",
    });
  });
});
