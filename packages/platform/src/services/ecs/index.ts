import { ecsSchema } from "../../../schemas/ecs.schema";
import type { ServiceTypePlugin } from "../service-type";
import type { LoadedService } from "../../types";
import { terraformForEcs, type EcsService } from "./terraform";

function isEcsService(service: LoadedService): service is EcsService {
  return service.metadata.serviceType === "ecs";
}

export const ecsPlugin: ServiceTypePlugin = {
  type: "ecs",
  fileSuffix: "ecs",
  schema: ecsSchema,
  jsonSchemaMetadata: {
    fileName: "ecs.schema.json",
    title: "Platform ECS Service",
    description: "YAML schema for AWS ECS services deployed by the platform.",
  },
  deployPriority: 2,
  toTerraform: (service, context) => {
    if (!isEcsService(service)) {
      throw new Error(`ecsPlugin received non-ecs service: ${service.metadata.serviceType}`);
    }
    return terraformForEcs(service, context);
  },
};
