import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { discoverServices } from "./service-discovery";
import { generatedDirectoryForService } from "./generated-paths";
import { terraformForService, type DeployTarget } from "./terraform";
import { validateServiceReferences } from "./validate";
import type { LoadedService } from "./types";

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const servicesRoot = path.join(repoRoot, "infra/services");

if (!args.env) {
  throw new Error("Missing required --env <env> argument");
}

const services = await discoverServices({
  env: args.env,
  venture: args.venture,
  services: args.services,
  servicesRoot,
});
const scopedServices = await discoverServices({
  env: args.env,
  venture: args.venture,
  servicesRoot,
});
validateServiceReferences(scopedServices);
const serviceNames = serviceNamesFor(scopedServices);
const serviceContainerPorts = serviceContainerPortsFor(scopedServices);
const target = args.target ?? "aws";

for (const service of services) {
  const outputDirectory = generatedDirectoryForService(service.metadata, target);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "main.tf.json"),
    `${JSON.stringify(terraformForService(service, { target, moduleDirectory: outputDirectory, serviceNames, serviceContainerPorts }), null, 2)}\n`,
    "utf8",
  );
  console.log(
    `Generated ${path.relative(repoRoot, outputDirectory)}/main.tf.json from ${path.relative(repoRoot, service.metadata.sourcePath)}`,
  );
}

function serviceContainerPortsFor(
  loadedServices: Awaited<ReturnType<typeof discoverServices>>,
): Record<string, number> {
  return Object.fromEntries(
    loadedServices
      .filter(isEcsService)
      .map((service) => [service.metadata.serviceName, service.config.service.containerPort]),
  );
}

function isEcsService(
  service: LoadedService,
): service is Extract<LoadedService, { metadata: { serviceType: "ecs" } }> {
  return service.metadata.serviceType === "ecs";
}

function serviceNamesFor(
  loadedServices: Awaited<ReturnType<typeof discoverServices>>,
): Record<string, string> {
  return Object.fromEntries(
    loadedServices
      .filter(
        (service) =>
          service.metadata.serviceType === "dynamodb" ||
          service.metadata.serviceType === "lambda" ||
          service.metadata.serviceType === "ecs",
      )
      .map((service) => [service.metadata.serviceName, physicalName(service.metadata)]),
  );
}

function physicalName(metadata: {
  env: string;
  venture: string;
  vpc: string;
  securityZone: string;
  serviceName: string;
}): string {
  return [
    metadata.env,
    metadata.venture,
    metadata.vpc,
    metadata.securityZone,
    metadata.serviceName,
  ].join("-");
}

function parseArgs(argv: string[]): {
  env?: string;
  venture?: string;
  target?: DeployTarget;
  services?: string[];
} {
  const parsed: { env?: string; venture?: string; target?: DeployTarget; services?: string[] } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--env") {
      parsed.env = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--venture") {
      parsed.venture = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--target") {
      parsed.target = parseTarget(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--services") {
      parsed.services = argv[index + 1]
        .split(",")
        .map((service) => service.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function parseTarget(value: string): DeployTarget {
  if (value === "aws" || value === "floci") {
    return value;
  }

  throw new Error(`Unsupported target: ${value}`);
}
