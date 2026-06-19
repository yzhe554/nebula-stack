import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { validateServiceNetworkZones } from "./network-zones.js";
import { dynamoDbSchema, lambdaSchema } from "./schemas.js";
import type { LoadedService, ServiceMetadata, ServiceType } from "./types.js";

const supportedServiceTypes = new Set<ServiceType>(["lambda", "dynamodb"]);

export type DiscoverOptions = {
  env: string;
  venture?: string;
  services?: string[];
  servicesRoot?: string;
  platformRoot?: string;
};

export async function discoverServices(options: DiscoverOptions): Promise<LoadedService[]> {
  const servicesRoot = options.servicesRoot ?? "services";
  const envRoot = options.venture
    ? path.join(servicesRoot, options.env, options.venture)
    : path.join(servicesRoot, options.env);
  const files = await listYamlFiles(envRoot);
  const selected = new Set(options.services ?? []);
  const loaded = await Promise.all(files.map((filePath) => loadService(filePath, servicesRoot)));
  const filtered = selected.size === 0
    ? loaded
    : loaded.filter((service) => selected.has(service.metadata.serviceName));

  if (selected.size > 0) {
    const found = new Set(filtered.map((service) => service.metadata.serviceName));
    const missing = [...selected].filter((serviceName) => !found.has(serviceName));

    if (missing.length > 0) {
      const scope = options.venture ? `${options.env}/${options.venture}` : options.env;
      throw new Error(`Selected services were not found in ${scope}: ${missing.join(", ")}`);
    }
  }

  assertUniqueServiceNames(filtered, options.env, options.venture);
  await validateServiceNetworkZones(filtered.map((service) => service.metadata), servicesRoot);

  return filtered.sort((left, right) => left.metadata.serviceName.localeCompare(right.metadata.serviceName));
}

async function listYamlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listYamlFiles(entryPath);
    }

    if (entry.isFile() && entry.name !== "network.yaml" && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      return [entryPath];
    }

    return [];
  }));

  return nested.flat();
}

async function loadService(filePath: string, servicesRoot: string): Promise<LoadedService> {
  const metadata = parseServicePath(filePath, servicesRoot);
  const raw = parse(await readFile(filePath, "utf8"));

  if (metadata.serviceType === "lambda") {
    return {
      metadata: { ...metadata, serviceType: "lambda" },
      config: lambdaSchema.parse(raw),
    };
  }

  return {
    metadata: { ...metadata, serviceType: "dynamodb" },
    config: dynamoDbSchema.parse(raw),
  };
}

function parseServicePath(filePath: string, servicesRoot: string): ServiceMetadata {
  const relative = path.relative(servicesRoot, filePath);
  const parts = relative.split(path.sep);

  if (parts.length !== 5) {
    throw new Error(`Service file must match services/<env>/<venture>/<vpc>/<security-zone>/<service-name>.<service-type>.yaml: ${filePath}`);
  }

  const [env, venture, vpc, securityZone, fileName] = parts;
  const match = fileName.match(/^(.+)\.(lambda|dynamodb)\.ya?ml$/);

  if (!match) {
    throw new Error(`Unsupported service file name: ${filePath}`);
  }

  const [, serviceName, serviceType] = match;

  if (!supportedServiceTypes.has(serviceType as ServiceType)) {
    throw new Error(`Unsupported service type in ${filePath}: ${serviceType}`);
  }

  return {
    env,
    venture,
    vpc,
    securityZone,
    serviceName,
    serviceType: serviceType as ServiceType,
    sourcePath: filePath,
  };
}

function assertUniqueServiceNames(services: LoadedService[], env: string, venture?: string): void {
  const seen = new Map<string, string>();
  const scope = venture ? `${env}/${venture}` : env;

  for (const service of services) {
    const previous = seen.get(service.metadata.serviceName);

    if (previous) {
      throw new Error(`Duplicate service name in ${scope}: ${service.metadata.serviceName} (${previous}, ${service.metadata.sourcePath})`);
    }

    seen.set(service.metadata.serviceName, service.metadata.sourcePath);
  }
}
