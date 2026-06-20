import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ZodError } from "zod";
import { loadNetworkPolicy } from "./network-zones.js";
import { dynamoDbSchema, lambdaSchema } from "./schemas.js";
import { discoverServices } from "./service-discovery.js";
import type { LoadedService } from "./types.js";

export type ValidationError = {
  file: string;
  messages: string[];
};

export type ValidationResult = {
  valid: boolean;
  files: string[];
  errors: ValidationError[];
  scopes?: string[];
};

export type ValidateConfigsOptions = {
  env: string;
  venture: string;
  servicesRoot?: string;
};

export async function validateConfigs(options: ValidateConfigsOptions): Promise<ValidationResult> {
  const servicesRoot = options.servicesRoot ?? path.join(repoRoot(), "infra/services");
  const scopeRoot = path.join(servicesRoot, options.env, options.venture);
  const yamlFiles = (await listYamlFiles(scopeRoot)).sort();
  const errors: ValidationError[] = [];

  for (const file of yamlFiles) {
    try {
      await validateYamlFile(file, servicesRoot);
    } catch (error) {
      errors.push({ file: normalizePath(file), messages: messagesForError(error) });
    }
  }

  try {
    const services = await discoverServices({ env: options.env, venture: options.venture, servicesRoot });
    validateServiceReferences(services);
  } catch (error) {
    errors.push({ file: normalizePath(scopeRoot), messages: messagesForError(error) });
  }

  return {
    valid: errors.length === 0,
    files: yamlFiles.map((file) => displayPath(file, servicesRoot)),
    errors,
  };
}

export function validateServiceReferences(services: Awaited<ReturnType<typeof discoverServices>>): void {
  const dynamoDbServices = new Set(
    services
      .filter((service) => service.metadata.serviceType === "dynamodb")
      .map((service) => service.metadata.serviceName),
  );

  for (const service of services) {
    if (!isLambdaService(service)) {
      continue;
    }

    service.config.permissions.dynamodb.forEach((permission, index) => {
      if (!dynamoDbServices.has(permission.service)) {
        throw new Error(`permissions.dynamodb[${index}].service references unknown DynamoDB service ${permission.service} (${service.metadata.sourcePath})`);
      }
    });
  }
}

function isLambdaService(service: LoadedService): service is Extract<LoadedService, { metadata: { serviceType: "lambda" } }> {
  return service.metadata.serviceType === "lambda";
}

export async function validateAllConfigs(options: { servicesRoot?: string } = {}): Promise<ValidationResult> {
  const servicesRoot = options.servicesRoot ?? path.join(repoRoot(), "infra/services");
  const scopes = await discoverScopes(servicesRoot);
  const results = await Promise.all(scopes.map(({ env, venture }) => validateConfigs({ env, venture, servicesRoot })));

  return {
    valid: results.every((result) => result.valid),
    scopes: scopes.map((scope) => `${scope.env}/${scope.venture}`).sort(),
    files: results.flatMap((result) => result.files).sort(),
    errors: results.flatMap((result) => result.errors),
  };
}

async function discoverScopes(servicesRoot: string): Promise<Array<{ env: string; venture: string }>> {
  const envEntries = await readdir(servicesRoot, { withFileTypes: true });
  const scopes: Array<{ env: string; venture: string }> = [];

  for (const envEntry of envEntries) {
    if (!envEntry.isDirectory()) {
      continue;
    }

    const ventureRoot = path.join(servicesRoot, envEntry.name);
    const ventureEntries = await readdir(ventureRoot, { withFileTypes: true });

    for (const ventureEntry of ventureEntries) {
      if (ventureEntry.isDirectory()) {
        scopes.push({ env: envEntry.name, venture: ventureEntry.name });
      }
    }
  }

  return scopes.sort((left, right) => `${left.env}/${left.venture}`.localeCompare(`${right.env}/${right.venture}`));
}

async function validateYamlFile(filePath: string, servicesRoot: string): Promise<void> {
  const raw = parse(await readFile(filePath, "utf8"));
  const fileName = path.basename(filePath);

  if (fileName === "network.yaml") {
    const parts = path.relative(servicesRoot, filePath).split(path.sep);
    if (parts.length !== 4) {
      throw new Error("network.yaml must be located at infra/services/<env>/<venture>/<vpc>/network.yaml");
    }

    const [env, venture, vpc] = parts;
    await loadNetworkPolicy({ env, venture, vpc, servicesRoot });
    return;
  }

  if (fileName.endsWith(".lambda.yaml") || fileName.endsWith(".lambda.yml")) {
    lambdaSchema.parse(raw);
    return;
  }

  if (fileName.endsWith(".dynamodb.yaml") || fileName.endsWith(".dynamodb.yml")) {
    dynamoDbSchema.parse(raw);
    return;
  }

  throw new Error(`Unsupported YAML config file: ${filePath}`);
}

async function listYamlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listYamlFiles(entryPath);
    }

    if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      return [entryPath];
    }

    return [];
  }));

  return nested.flat();
}

function messagesForError(error: unknown): string[] {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
  }

  if (error instanceof Error) {
    return [error.message];
  }

  return [String(error)];
}

function displayPath(filePath: string, servicesRoot: string): string {
  const relative = path.relative(path.dirname(servicesRoot), filePath);

  if (!relative.startsWith("..")) {
    return normalizePath(relative);
  }

  return normalizePath(filePath);
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const [env, venture] = args;

  if (args.length !== 0 && args.length !== 2) {
    console.error("Usage: pnpm platform:validate [env venture]");
    process.exit(1);
  }

  const result = env && venture
    ? await validateConfigs({ env, venture })
    : await validateAllConfigs();

  for (const file of result.files) {
    const fileErrors = result.errors.filter((error) => error.file === file);
    if (fileErrors.length === 0) {
      console.log(`✓ ${file}`);
      continue;
    }

    console.log(`✗ ${file}`);
    for (const error of fileErrors) {
      for (const message of error.messages) {
        console.log(`  ${message}`);
      }
    }
  }

  const scopeErrors = result.errors.filter((error) => !result.files.includes(error.file));
  for (const error of scopeErrors) {
    console.log(`✗ ${error.file}`);
    for (const message of error.messages) {
      console.log(`  ${message}`);
    }
  }

  if (!result.valid) {
    console.error(env && venture ? `Validation failed for ${env}/${venture}.` : "Validation failed.");
    process.exit(1);
  }

  console.log(env && venture
    ? `Validated ${result.files.length} config files for ${env}/${venture}.`
    : `Validated ${result.files.length} config files across ${result.scopes?.length ?? 0} scopes.`);
}

function repoRoot(): string {
  return path.resolve(import.meta.dirname, "../../..");
}

const isCliEntry = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;

if (isCliEntry) {
  await main();
}
