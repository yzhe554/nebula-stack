import { baseTerraform, tagsFor, type TerraformJson } from "../../terraform/base";
import { physicalName, terraformName } from "../../terraform/naming";
import type { TerraformContext } from "../../terraform/context";
import type { LoadedService } from "../../types";

export type DynamoDbService = Extract<LoadedService, { metadata: { serviceType: "dynamodb" } }>;

export function terraformForDynamoDb(
  service: DynamoDbService,
  context: TerraformContext,
): TerraformJson {
  const resourceName = terraformName(service.metadata.serviceName);
  const attributes = [service.config.hashKey, service.config.rangeKey].filter(Boolean);

  return baseTerraform(service.metadata, context.target ?? "aws", {
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
