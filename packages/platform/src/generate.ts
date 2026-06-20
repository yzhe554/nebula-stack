import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { discoverServices } from "./service-discovery.js";
import { terraformForService, type DeployTarget } from "./terraform.js";
import { validateServiceReferences } from "./validate.js";

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const servicesRoot = path.join(repoRoot, "infra/services");

if (!args.env) {
  throw new Error("Missing required --env <env> argument");
}

const services = await discoverServices({ env: args.env, venture: args.venture, services: args.services, servicesRoot });
const scopedServices = await discoverServices({ env: args.env, venture: args.venture, servicesRoot });
validateServiceReferences(scopedServices);
const serviceNames = serviceNamesFor(scopedServices);
const target = args.target ?? "aws";

for (const service of services) {
  const outputDirectory = path.join(repoRoot, "__generated__", target, service.metadata.env, service.metadata.venture, service.metadata.serviceName);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "main.tf.json"),
    `${JSON.stringify(terraformForService(service, { target, serviceNames }), null, 2)}\n`,
    "utf8",
  );
  console.log(`Generated ${path.relative(repoRoot, outputDirectory)}/main.tf.json from ${path.relative(repoRoot, service.metadata.sourcePath)}`);
}

function serviceNamesFor(services: Awaited<ReturnType<typeof discoverServices>>): Record<string, string> {
  return Object.fromEntries(
    services
      .filter((service) => service.metadata.serviceType === "dynamodb")
      .map((service) => [service.metadata.serviceName, physicalName(service.metadata)]),
  );
}

function physicalName(metadata: { env: string; venture: string; vpc: string; securityZone: string; serviceName: string }): string {
  return [metadata.env, metadata.venture, metadata.vpc, metadata.securityZone, metadata.serviceName].join("-");
}

function parseArgs(argv: string[]): { env?: string; venture?: string; target?: DeployTarget; services?: string[] } {
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
