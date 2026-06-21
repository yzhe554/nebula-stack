import { networkPolicySchema } from "../../../schemas/network.schema";
import type { ServiceTypePlugin } from "../service-type";
import type { LoadedService } from "../../types";
import { terraformForNetwork } from "./terraform";

type NetworkService = Extract<LoadedService, { metadata: { serviceType: "network" } }>;

function isNetworkService(service: LoadedService): service is NetworkService {
  return service.metadata.serviceType === "network";
}

export const networkPlugin: ServiceTypePlugin = {
  type: "network",
  fileSuffix: "network",
  schema: networkPolicySchema,
  jsonSchemaMetadata: {
    fileName: "network.schema.json",
    title: "Platform Network",
    description: "AWS-first IPv4 network intent for one env/venture/VPC.",
  },
  deployPriority: -1,
  toTerraform: (service, context) => {
    if (!isNetworkService(service)) {
      throw new Error(
        `networkPlugin received non-network service: ${service.metadata.serviceType}`,
      );
    }
    return terraformForNetwork(service, context);
  },
};
