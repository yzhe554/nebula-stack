import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadServiceManifest, type ServiceManifestEntry } from "../registry.js";
import * as aws from "./aws.js";
import { scrubbedEnv } from "./floci-env.js";
import { runFlociUrl } from "./url.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function gatewayPathFor(apiId: string): string {
  return `/execute-api/${apiId}/$default`;
}

export function dockerBuildArgsFor(entry: ServiceManifestEntry): {
  APP_NAME: string;
  PORT: number;
} {
  if (!entry.app || !entry.ecs) {
    throw new Error(`${entry.metadata.serviceName} is not an app-backed ecs service`);
  }
  return { APP_NAME: entry.app.base, PORT: entry.ecs.containerPort };
}

/**
 * Returns the list of service names that must be deployed before `entry`.
 *
 * Pass the full `manifest` to also include any DynamoDB tables referenced by
 * invoked Lambda services (used at deploy time). When `manifest` is omitted the
 * function falls back to lambda service names only (sufficient for test
 * assertions that don't need DynamoDB expansion).
 */
export function prerequisiteServices(
  entry: ServiceManifestEntry,
  manifest: ServiceManifestEntry[] = [],
): string[] {
  const prereqs: string[] = ["network"];
  const config = entry.service.config;

  if (
    entry.metadata.serviceType === "ecs" &&
    "permissions" in config &&
    config.permissions !== undefined &&
    "lambda" in config.permissions &&
    Array.isArray(config.permissions.lambda)
  ) {
    for (const p of config.permissions.lambda) {
      prereqs.push(p.service);

      // If we have the full manifest, also include the lambda's DynamoDB deps
      if (manifest.length > 0) {
        const lambdaEntry = manifest.find(
          (e) => e.metadata.serviceName === p.service && e.metadata.serviceType === "lambda",
        );
        if (lambdaEntry) {
          const lambdaConfig = lambdaEntry.service.config;
          if (
            "permissions" in lambdaConfig &&
            lambdaConfig.permissions !== undefined &&
            "dynamodb" in lambdaConfig.permissions &&
            Array.isArray(lambdaConfig.permissions.dynamodb)
          ) {
            for (const d of lambdaConfig.permissions.dynamodb) {
              if (typeof d.service === "string") {
                prereqs.push(d.service);
              }
            }
          }
        }
      }
    }
  }

  return prereqs;
}

// ---------------------------------------------------------------------------
// Spawn helpers
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

function platformDeploy(services: string[], imageTags: Record<string, string> = {}): void {
  pnpm([
    "platform:deploy",
    "--",
    "--env",
    "dev",
    "--venture",
    "venture",
    "--target",
    "floci",
    "--services",
    services.join(","),
    ...Object.entries(imageTags).flatMap(([service, tag]) => ["--image-tag", `${service}=${tag}`]),
  ]);
}

// Deterministic content tag from the app's BUILD INPUTS (not the built image,
// which is non-reproducible). Inputs: the git tree hash of the app source dir
// (git already excludes .next/node_modules), the shared Dockerfile's tree hash,
// and the gateway-path build arg (baked into Next assets). Same inputs → same
// tag → no ECS task-def churn on a no-op redeploy; any real change → new tag.
export function sourceHashTag(appBase: string, gatewayPath: string): string {
  const appTree = gitHashObject(`apps/${appBase}`);
  const dockerfileTree = gitHashObject("apps/Dockerfile");
  const digest = createHash("sha256")
    .update(`${appTree}\n${dockerfileTree}\n${gatewayPath}\n`)
    .digest("hex");
  return digest.slice(0, 12);
}

// `git hash-object` / tree hash for a path, capturing both tracked content and
// (via --others) untracked-but-not-ignored files, so local edits are reflected.
function gitHashObject(relativePath: string): string {
  // List files git would see under the path (tracked + untracked, excluding
  // ignored like .next/node_modules), then hash the concatenation of their
  // per-file object hashes. Deterministic for identical content.
  const list = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", relativePath],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (list.status !== 0) {
    throw new Error(`git ls-files failed for ${relativePath}: ${list.stderr ?? ""}`);
  }
  const files = (list.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();

  const hash = createHash("sha256");
  for (const file of files) {
    const obj = spawnSync("git", ["hash-object", file], { cwd: REPO_ROOT, encoding: "utf8" });
    if (obj.status !== 0) {
      throw new Error(`git hash-object failed for ${file}: ${obj.stderr ?? ""}`);
    }
    hash.update(`${file}:${(obj.stdout ?? "").trim()}\n`);
  }
  return hash.digest("hex");
}

function retagImage(sourceRef: string, targetRef: string): void {
  const result = spawnSync("docker", ["tag", sourceRef, targetRef], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`docker tag ${sourceRef} ${targetRef} failed`);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap check: is the image already present locally?
// ---------------------------------------------------------------------------

function imageExistsLocally(imageRef: string): boolean {
  const result = spawnSync("docker", ["image", "inspect", imageRef], {
    stdio: "pipe",
  });
  return result.status === 0;
}

// The container image ref is declared in the ECS service's YAML
// (image.repository:tag, e.g. "nebula-payments:local") — NOT the cluster name.
// This is what `<app>:docker:build` tags, so it's what we check to decide
// whether the cold-deploy bootstrap build can be skipped.
function imageRefFor(entry: ServiceManifestEntry): string {
  const config = entry.service.config;
  if (entry.metadata.serviceType === "ecs" && "image" in config) {
    return `${config.image.repository}:${config.image.tag}`;
  }
  throw new Error(`${entry.metadata.serviceName} has no ecs image config`);
}

// ---------------------------------------------------------------------------
// Imperative deploy runner
// ---------------------------------------------------------------------------

const servicesRoot = path.resolve(import.meta.dirname, "../../../../infra/services");

export async function runFlociDeploy(serviceName: string): Promise<void> {
  const manifest = await loadServiceManifest({
    env: "dev",
    venture: "venture",
    servicesRoot,
  });

  const entry = manifest.find((e) => e.metadata.serviceName === serviceName);
  if (!entry) throw new Error(`Service not found in manifest: ${serviceName}`);
  if (!entry.app) throw new Error(`Service ${serviceName} has no app metadata`);
  if (!entry.ecs) throw new Error(`Service ${serviceName} has no ecs metadata`);
  if (!entry.frontedByGateway)
    throw new Error(`Service ${serviceName} is not fronted by a gateway`);

  // Step 1 — Deploy prerequisites (network + lambdas + their DynamoDB tables)
  const prereqs = prerequisiteServices(entry, manifest);

  // Package any lambda prerequisites before deploying them
  for (const lambdaName of prereqs.filter((p) => p !== "network")) {
    const lambdaEntry = manifest.find(
      (e) => e.metadata.serviceName === lambdaName && e.metadata.serviceType === "lambda",
    );
    if (lambdaEntry) {
      // Attempt to package. For payment-api (the only lambda so far) this runs
      // `pnpm app:payment-api:package`. Tolerate absence gracefully — if it
      // fails the user will see the error from pnpm.
      pnpm([`app:${lambdaName}:package`]);
    }
  }

  platformDeploy(prereqs);

  // Step 2 — Resolve gateway id; bootstrap if not yet deployed
  let gatewayId = await aws.getApiIdByName(entry.frontedByGateway.physicalName);

  if (!gatewayId) {
    // Cold deploy: the gateway doesn't exist yet. We must stand up the ECS app
    // first (ALB dependency), then create the gateway.
    //
    // Skip the build if the image is already present to save time (warm cold).
    if (!imageExistsLocally(imageRefFor(entry))) {
      // Build the app without a gateway path (placeholder image)
      pnpm([`${entry.app.base}:build`]);
      pnpm([`${entry.app.base}:docker:build`]);
    }

    // Deploy the ECS app (creates the ALB) then the gateway
    platformDeploy([serviceName]);
    platformDeploy([entry.frontedByGateway.serviceName]);

    gatewayId = await aws.getApiIdByName(entry.frontedByGateway.physicalName);
  }

  if (!gatewayId) {
    throw new Error("Gateway id not found after bootstrap");
  }

  // Step 3 — Content-address the image from DETERMINISTIC build inputs (app
  // source + Dockerfile + the gateway-path build arg), computed BEFORE the
  // build. `next build` output is not byte-reproducible (it embeds build ids),
  // so hashing the built image would change every time; hashing the inputs
  // means an unchanged app produces the same tag → no ECS task-def churn on a
  // no-op redeploy. A real source change changes the tag → ECS redeploys.
  const gatewayPath = gatewayPathFor(gatewayId);
  const hash = sourceHashTag(entry.app.base, gatewayPath);
  const baseImageRef = imageRefFor(entry);
  const repository = baseImageRef.split(":")[0];

  // Step 4 — Real build with the correct gateway path baked in, then tag the
  // built image with the deterministic source hash.
  pnpm([`${entry.app.base}:build`], { NEXT_PUBLIC_GATEWAY_PATH: gatewayPath });
  pnpm([`${entry.app.base}:docker:build`]);
  retagImage(baseImageRef, `${repository}:${hash}`);

  // Step 5 — Deploy the app + gateway together, with the hashed image tag.
  platformDeploy([serviceName, entry.frontedByGateway.serviceName], { [serviceName]: hash });

  // Step 6 — Always print the full URL summary for every service (resolves live
  // gateway ids + ALB DNS), the same output as `pnpm floci:url`. Showing every
  // service (not just the one deployed) makes the running stack visible after
  // each deploy.
  await runFlociUrl();
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
    console.error("usage: floci-deploy <service>");
    process.exit(1);
  }
  await runFlociDeploy(serviceName);
}
