import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { networkPolicySchema } from "./schemas";
import type { NetworkPolicy, ServiceMetadata } from "./types";

export type LoadNetworkPolicyOptions = {
  env: string;
  venture: string;
  vpc: string;
  servicesRoot?: string;
};

export async function loadNetworkPolicy(options: LoadNetworkPolicyOptions): Promise<NetworkPolicy> {
  const servicesRoot = options.servicesRoot ?? "infra/services";
  const policyPath = path.join(servicesRoot, options.env, options.venture, options.vpc, "network.yaml");
  const raw = parse(await readFile(policyPath, "utf8"));

  return networkPolicySchema.parse(raw);
}

// Intentionally outside networkPolicySchema: this validates service file placement
// against the matching network.yaml, not the network.yaml document itself.
export async function validateServiceNetworkZones(
  services: ServiceMetadata[],
  servicesRoot = "infra/services",
): Promise<void> {
  const policyCache = new Map<string, NetworkPolicy>();

  for (const service of services) {
    const key = [service.env, service.venture, service.vpc].join("/");
    let policy = policyCache.get(key);

    if (!policy) {
      policy = await loadNetworkPolicy({
        env: service.env,
        venture: service.venture,
        vpc: service.vpc,
        servicesRoot,
      });
      policyCache.set(key, policy);
    }

    if (!policy.zones[service.securityZone]) {
      if (service.serviceType === "dynamodb" && service.securityZone === "managed") {
        validateDynamoDbEndpoint(service, policy);
        continue;
      }

      throw new Error(
        `Security zone ${service.securityZone} is not defined for ${service.env}/${service.venture}/${service.vpc} (${service.sourcePath})`,
      );
    }

    if (service.serviceType === "dynamodb") {
      validateDynamoDbEndpoint(service, policy);
    }
  }
}

function validateDynamoDbEndpoint(service: ServiceMetadata, policy: NetworkPolicy): void {
  const endpoint = policy.awsEndpoints.dynamodb;

  if (endpoint?.type === "gateway" && endpoint.policy === "default" && endpoint.routeTableZoneNames?.length) {
    return;
  }

  throw new Error(
    `DynamoDB service ${service.serviceName} requires awsEndpoints.dynamodb default gateway endpoint (${service.sourcePath})`,
  );
}
