import path from "node:path";
import { discoverServices, type DiscoverOptions } from "./service-discovery";
import { ecsLoadBalancerName, physicalName, targetGroupNamePrefix, terraformName } from "./terraform/naming";
import type { ApiGatewayRoute, LoadedService } from "./types";
import { deriveAppNames, validateAppExists, type AppNames } from "./app-derivation";

export type EcsNames = {
  clusterName: string;
  albName: string;
  targetGroupPrefix: string;
  containerPort: number;
};

export type GatewayFronting = {
  serviceName: string;
  physicalName: string;
};

export type AppMetadata = AppNames & { devPort?: number };

export type ServiceManifestEntry = {
  service: LoadedService;
  metadata: LoadedService["metadata"];
  physicalName: string;
  ecs?: EcsNames;
  frontedByGateway?: GatewayFronting;
  app?: AppMetadata;
};

type ApiGatewayService = Extract<LoadedService, { metadata: { serviceType: "apigateway" } }>;
type EcsService = Extract<LoadedService, { metadata: { serviceType: "ecs" } }>;

function isApiGatewayService(service: LoadedService): service is ApiGatewayService {
  return service.metadata.serviceType === "apigateway";
}

function isEcsService(service: LoadedService): service is EcsService {
  return service.metadata.serviceType === "ecs";
}

function targetedServiceNames(route: ApiGatewayRoute): string[] {
  const allTargets = [route.target, ...Object.values(route.targets ?? {})];
  const names: string[] = [];
  for (const target of allTargets) {
    if ((target.type === "ecs" || target.type === "lambda") && "service" in target && target.service !== undefined) {
      names.push(target.service);
    }
  }
  return names;
}

function gatewayFrontingByService(services: LoadedService[]): Map<string, GatewayFronting> {
  const result = new Map<string, GatewayFronting>();
  for (const service of services) {
    if (!isApiGatewayService(service)) continue;
    const fronting: GatewayFronting = {
      serviceName: service.metadata.serviceName,
      physicalName: physicalName(service.metadata),
    };
    for (const route of service.config.routes) {
      for (const name of targetedServiceNames(route)) {
        if (!result.has(name)) {
          result.set(name, fronting);
        }
      }
    }
  }
  return result;
}

function ecsNamesFor(service: EcsService): EcsNames {
  return {
    clusterName: physicalName(service.metadata),
    albName: ecsLoadBalancerName(service.metadata),
    targetGroupPrefix: targetGroupNamePrefix(terraformName(service.metadata.serviceName)),
    containerPort: service.config.service.containerPort,
  };
}

const defaultRepoRoot = path.resolve(import.meta.dirname, "../../..");

function appMetadataFor(service: LoadedService, repoRoot: string): AppMetadata | undefined {
  const type = service.metadata.serviceType;
  if (type !== "ecs" && type !== "lambda") {
    return undefined;
  }
  const names = deriveAppNames(service.metadata.serviceName);
  validateAppExists(names, repoRoot);
  if (isEcsService(service)) {
    return { ...names, devPort: service.config.service.containerPort };
  }
  return names;
}

export function serviceNamesFromManifest(manifest: ServiceManifestEntry[]): Record<string, string> {
  return Object.fromEntries(
    manifest
      .filter((entry) => {
        const t = entry.metadata.serviceType;
        return t === "dynamodb" || t === "lambda" || t === "ecs";
      })
      .map((entry) => [entry.metadata.serviceName, entry.physicalName]),
  );
}

export function serviceContainerPortsFromManifest(manifest: ServiceManifestEntry[]): Record<string, number> {
  return Object.fromEntries(
    manifest
      .filter((entry): entry is ServiceManifestEntry & { ecs: EcsNames } => entry.ecs !== undefined)
      .map((entry) => [entry.metadata.serviceName, entry.ecs.containerPort]),
  );
}

export function buildServiceManifest(services: LoadedService[], repoRoot: string = defaultRepoRoot): ServiceManifestEntry[] {
  const fronting = gatewayFrontingByService(services);
  return services.map((service) => {
    const app = appMetadataFor(service, repoRoot);
    return {
      service,
      metadata: service.metadata,
      physicalName: physicalName(service.metadata),
      ...(isEcsService(service) ? { ecs: ecsNamesFor(service) } : {}),
      ...(fronting.has(service.metadata.serviceName) ? { frontedByGateway: fronting.get(service.metadata.serviceName) } : {}),
      ...(app ? { app } : {}),
    };
  });
}

export async function loadServiceManifest(
  options: DiscoverOptions,
): Promise<ServiceManifestEntry[]> {
  return buildServiceManifest(await discoverServices(options));
}
