import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadServiceManifest } from "../registry.js";
import * as aws from "./aws.js";
import { scrubbedEnv } from "./floci-env.js";
import { gatewayPathFor } from "./deploy.js";

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

function pnpm(args: string[], extraEnv: Record<string, string> = {}): void {
  const result = spawnSync("pnpm", args, {
    stdio: "inherit",
    cwd: REPO_ROOT,
    env: { ...scrubbedEnv(), ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(" ")} failed`);
  }
}

// ---------------------------------------------------------------------------
// Imperative dev runner
// ---------------------------------------------------------------------------

const servicesRoot = path.resolve(import.meta.dirname, "../../../../infra/services");

export async function runFlociDev(serviceName: string): Promise<void> {
  const manifest = await loadServiceManifest({
    env: "dev",
    venture: "venture",
    servicesRoot,
  });

  const entry = manifest.find((e) => e.metadata.serviceName === serviceName);
  if (!entry) throw new Error(`Service not found in manifest: ${serviceName}`);
  if (!entry.app) throw new Error(`Service ${serviceName} has no app metadata`);
  if (!entry.frontedByGateway) {
    throw new Error(`Service ${serviceName} is not fronted by a gateway`);
  }

  const gatewayId = await aws.getApiIdByName(entry.frontedByGateway.physicalName);
  const gatewayPath = gatewayId ? gatewayPathFor(gatewayId) : "";

  pnpm(["--filter", entry.app.packageName, "dev"], { NEXT_PUBLIC_GATEWAY_PATH: gatewayPath });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isCliEntry =
  process.argv[1] !== undefined
    ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
    : false;

if (isCliEntry) {
  const serviceName = process.argv
    .slice(2)
    .filter((a) => a !== "--")
    .at(-1);
  if (!serviceName) {
    console.error("usage: floci-dev <service>");
    process.exit(1);
  }
  await runFlociDev(serviceName);
}
