import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadServiceManifest, type ServiceManifestEntry } from "../registry.js";
import { generatedDirectoryForService } from "../generated-paths.js";
import * as aws from "./aws.js";
import { FLOCI_ENDPOINT } from "./floci-env.js";

// ---------------------------------------------------------------------------
// Pure data type
// ---------------------------------------------------------------------------

export type ServiceUrlRow = {
  serviceName: string;
  basePath: string;
  gatewayId: string | undefined;
  albDns: string | undefined;
  containerHost: string;
  containerPort: number;
};

// ---------------------------------------------------------------------------
// Pure function — no side effects
// ---------------------------------------------------------------------------

export function buildServiceUrls(rows: ServiceUrlRow[]): string[] {
  const lines: string[] = [];
  for (const r of rows) {
    lines.push(`# ${r.serviceName}`);
    if (r.gatewayId) {
      lines.push(
        `Via API Gateway: ${FLOCI_ENDPOINT}/execute-api/${r.gatewayId}/$default${r.basePath}`,
      );
    } else {
      lines.push(`Via API Gateway: Not deployed`);
    }
    if (r.albDns) lines.push(`Via ALB (in-network): http://${r.albDns}${r.basePath}`);
    lines.push(
      `Container direct (in-network): http://${r.containerHost}:${r.containerPort}${r.basePath}`,
    );
    lines.push("");
  }
  lines.push("# Payment API");
  lines.push("Invoked privately via the AWS SDK from the payments app (no public API Gateway).");
  return lines;
}

// ---------------------------------------------------------------------------
// tfstate parsing — no `as` casts, all guarded with `in` / typeof
// ---------------------------------------------------------------------------

function extractAlbDnsFromTfstate(tfstatePath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(tfstatePath, "utf8");
  } catch {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (!("resources" in parsed)) return undefined;
  const { resources } = parsed;
  if (!Array.isArray(resources)) return undefined;
  for (const resource of resources) {
    if (typeof resource !== "object" || resource === null) continue;
    if (!("type" in resource) || resource.type !== "aws_lb") continue;
    if (!("instances" in resource)) continue;
    const { instances } = resource;
    if (!Array.isArray(instances)) continue;
    for (const instance of instances) {
      if (typeof instance !== "object" || instance === null) continue;
      if (!("attributes" in instance)) continue;
      const { attributes } = instance;
      if (typeof attributes !== "object" || attributes === null) continue;
      if (!("dns_name" in attributes)) continue;
      const dns = attributes.dns_name;
      if (typeof dns === "string") return dns;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// basePath extraction: take the first route's path, strip trailing /{proxy+}
// ---------------------------------------------------------------------------

function basePathFromEntry(entry: ServiceManifestEntry): string {
  const config = entry.service.config;
  if (!("routes" in config) || !Array.isArray(config.routes) || config.routes.length === 0) {
    return "/";
  }
  const firstPath: unknown = config.routes[0].path;
  if (typeof firstPath !== "string") return "/";
  return firstPath.replace(/\/\{proxy\+\}$/, "");
}

// ---------------------------------------------------------------------------
// Imperative runner
// ---------------------------------------------------------------------------

const servicesRoot = path.resolve(import.meta.dirname, "../../../../infra/services");

export async function runFlociUrl(): Promise<void> {
  const manifest = await loadServiceManifest({
    env: "dev",
    venture: "venture",
    servicesRoot,
  });

  const rows: ServiceUrlRow[] = [];

  for (const entry of manifest) {
    if (!entry.ecs || !entry.frontedByGateway) continue;

    // Resolve gateway id
    const gatewayId = await aws.getApiIdByName(entry.frontedByGateway.physicalName);

    // Resolve ALB dns from floci tfstate
    const tfstatePath = path.join(
      generatedDirectoryForService(entry.metadata, "floci"),
      "terraform.tfstate",
    );
    const albDns = extractAlbDnsFromTfstate(tfstatePath);

    // Resolve basePath from the gateway entry
    const gatewayEntry = manifest.find(
      (e) => e.metadata.serviceName === entry.frontedByGateway?.serviceName,
    );
    const basePath = gatewayEntry ? basePathFromEntry(gatewayEntry) : "/";

    const containerHost = `${entry.ecs.clusterName}.floci.localhost`;
    const containerPort = entry.ecs.containerPort;

    rows.push({
      serviceName: entry.metadata.serviceName,
      basePath,
      gatewayId,
      albDns,
      containerHost,
      containerPort,
    });
  }

  console.log(buildServiceUrls(rows).join("\n"));
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isCliEntry =
  process.argv[1] !== undefined
    ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
    : false;

if (isCliEntry) {
  await runFlociUrl();
}
