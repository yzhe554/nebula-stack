// packages/platform/src/terraform/base.ts
import type { ServiceMetadata } from "../types";

export type TerraformJson = Record<string, unknown>;
export type DeployTarget = "aws" | "floci";

export const flociEndpointUrl = "http://localhost.floci.io:4566";
const awsRegion = "ap-southeast-2";
const flociRegion = "us-east-1";

export function baseTerraform(
  metadata: ServiceMetadata,
  target: DeployTarget,
  resource: Record<string, unknown>,
  data?: Record<string, unknown>,
): TerraformJson {
  return {
    terraform: {
      required_version: ">= 1.15.6",
      required_providers: {
        aws: { source: "hashicorp/aws", version: "~> 6.51" },
      },
    },
    provider: { aws: providerConfig(metadata, target) },
    ...(data ? { data } : {}),
    resource,
  };
}

export function providerConfig(
  metadata: ServiceMetadata,
  target: DeployTarget,
): Record<string, unknown> {
  const base = {
    region: regionForTarget(target),
    default_tags: { tags: tagsFor(metadata) },
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

export function regionForTarget(target: DeployTarget): string {
  return target === "floci" ? flociRegion : awsRegion;
}

export function tagsFor(metadata: ServiceMetadata): Record<string, string> {
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
