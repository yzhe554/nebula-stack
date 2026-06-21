import { lambdaSchema } from "../../../schemas/lambda.schema";
import type { ServiceTypePlugin } from "../service-type";
import type { LoadedService } from "../../types";
import { terraformForLambda, type LambdaService } from "./terraform";

function isLambdaService(service: LoadedService): service is LambdaService {
  return service.metadata.serviceType === "lambda";
}

export const lambdaPlugin: ServiceTypePlugin = {
  type: "lambda",
  fileSuffix: "lambda",
  schema: lambdaSchema,
  jsonSchemaMetadata: {
    fileName: "lambda.schema.json",
    title: "Platform Lambda Service",
    description: "YAML schema for AWS Lambda services deployed by the platform.",
  },
  deployPriority: 1,
  validateReferences: (service, services) => {
    if (!isLambdaService(service)) {
      return [`lambdaPlugin received non-lambda service: ${service.metadata.serviceType}`];
    }

    const dynamoDbServices = new Set(
      services
        .filter((candidate) => candidate.metadata.serviceType === "dynamodb")
        .map((candidate) => candidate.metadata.serviceName),
    );

    return service.config.permissions.dynamodb.flatMap((permission, index) =>
      dynamoDbServices.has(permission.service)
        ? []
        : [
            `permissions.dynamodb[${index}].service references unknown DynamoDB service ${permission.service} (${service.metadata.sourcePath})`,
          ],
    );
  },
  toTerraform: (service, context) => {
    if (!isLambdaService(service)) {
      throw new Error(`lambdaPlugin received non-lambda service: ${service.metadata.serviceType}`);
    }
    return terraformForLambda(service, context);
  },
};
