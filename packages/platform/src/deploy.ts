import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { generatedDirectoryForService } from "./generated-paths";
import { discoverServices } from "./service-discovery";
import { serviceTypeRegistry } from "./services";

import type { DeployTarget } from "./terraform";

const args = parseArgs(process.argv.slice(2));

if (!args.env) {
  throw new Error("Missing required --env <env> argument");
}

if (!args.venture) {
  throw new Error("Missing required --venture <venture> argument");
}

const target = args.target ?? "aws";
const servicesRoot = path.join(repoRoot(), "infra/services");

run(
  "pnpm",
  [
    "platform:generate",
    "--",
    "--env",
    args.env,
    "--venture",
    args.venture,
    "--target",
    target,
    ...(args.services.length > 0 ? ["--services", args.services.join(",")] : []),
    ...args.imageTags.flatMap((imageTag) => ["--image-tag", imageTag]),
  ],
  repoRoot(),
);

const services = await discoverServices({
  env: args.env,
  venture: args.venture,
  services: args.services,
  servicesRoot,
});

for (const service of [...services].sort(compareDeployOrder)) {
  const cwd = generatedDirectoryForService(service.metadata, target);
  run("terraform", ["init"], cwd);
  applyWithRetry(cwd, target);
}

// Floci (LocalStack) intermittently fails the read-back of freshly-created
// resources — notably the AWSLambdaVPCAccessExecutionRole policy attachment,
// which errors with "empty result" even though it was created. A plain re-plan
// + re-apply succeeds. Retry only on this transient signature for the floci
// target; never mask real errors or retry on aws.
function applyWithRetry(cwd: string, deployTarget: DeployTarget): void {
  const maxAttempts = deployTarget === "floci" ? 3 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    run("terraform", ["plan", "-out=tfplan"], cwd);
    const result = runCapturing("terraform", ["apply", "tfplan"], cwd);

    if (result.status === 0) {
      return;
    }

    const transient = isTransientFlociError(result.output);
    if (attempt < maxAttempts && transient) {
      console.warn(
        `terraform apply hit a transient Floci error in ${cwd} (attempt ${attempt}/${maxAttempts}); re-planning and retrying.`,
      );
      continue;
    }

    throw new Error(`Command failed: terraform apply tfplan in ${cwd}`);
  }
}

function isTransientFlociError(output: string): boolean {
  return /empty result|ResourceNotFoundException|reading IAM Role Policy Attachment/i.test(output);
}

function compareDeployOrder(
  left: Awaited<ReturnType<typeof discoverServices>>[number],
  right: Awaited<ReturnType<typeof discoverServices>>[number],
): number {
  return (
    serviceTypeRegistry.get(left.metadata.serviceType).deployPriority -
      serviceTypeRegistry.get(right.metadata.serviceType).deployPriority ||
    left.metadata.serviceName.localeCompare(right.metadata.serviceName)
  );
}

function repoRoot(): string {
  return path.resolve(import.meta.dirname, "../../..");
}

function parseArgs(argv: string[]): {
  env?: string;
  venture?: string;
  target?: DeployTarget;
  services: string[];
  imageTags: string[];
} {
  const parsed: {
    env?: string;
    venture?: string;
    target?: DeployTarget;
    services: string[];
    imageTags: string[];
  } = {
    services: [],
    imageTags: [],
  };

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

    if (arg === "--image-tag") {
      parsed.imageTags.push(argv[index + 1]);
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

function run(command: string, commandArgs: string[], cwd: string): void {
  console.log(`Running: ${command} ${commandArgs.join(" ")} in ${cwd}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    env: localEnvironment(),
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${commandArgs.join(" ")}`);
  }
}

// Like run(), but captures combined stdout/stderr (while still echoing it) and
// returns the status + output instead of throwing, so callers can inspect the
// failure (e.g. to detect transient Floci errors worth retrying).
function runCapturing(
  command: string,
  commandArgs: string[],
  cwd: string,
): { status: number; output: string } {
  console.log(`Running: ${command} ${commandArgs.join(" ")} in ${cwd}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    env: localEnvironment(),
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);

  return { status: result.status ?? 1, output };
}

function localEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...readDotEnvLocal(),
  };
}

function readDotEnvLocal(): NodeJS.ProcessEnv {
  const envPath = path.join(repoRoot(), ".env.local");

  try {
    return Object.fromEntries(
      readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const separatorIndex = line.indexOf("=");
          return separatorIndex === -1
            ? [line, ""]
            : [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
        }),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}
