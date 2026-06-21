import { dynamoDbSchema } from "../../../schemas/dynamodb.schema";
import type { ServiceTypePlugin } from "../service-type";
import type { LoadedService } from "../../types";
import { terraformForDynamoDb, type DynamoDbService } from "./terraform";

function isDynamoDbService(service: LoadedService): service is DynamoDbService {
  return service.metadata.serviceType === "dynamodb";
}

export const dynamoDbPlugin: ServiceTypePlugin = {
  type: "dynamodb",
  fileSuffix: "dynamodb",
  schema: dynamoDbSchema,
  jsonSchemaMetadata: {
    fileName: "dynamodb.schema.json",
    title: "Platform DynamoDB Service",
    description: "YAML schema for AWS DynamoDB tables deployed by the platform.",
  },
  deployPriority: 0,
  toTerraform: (service, context) => {
    if (!isDynamoDbService(service)) {
      throw new Error(
        `dynamoDbPlugin received non-dynamodb service: ${service.metadata.serviceType}`,
      );
    }
    return terraformForDynamoDb(service, context);
  },
};
