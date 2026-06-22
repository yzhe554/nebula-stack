import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadServiceManifest, type ServiceManifestEntry } from "../registry.js";
import { physicalName } from "../terraform/naming.js";
import { generatedDirectoryForService } from "../generated-paths.js";
import * as aws from "./aws.js";
import { scrubbedEnv } from "./floci-env.js";

// ---------------------------------------------------------------------------
// ResetPlan — pure, side-effect-free data type
// ---------------------------------------------------------------------------

export type ResetPlan = {
  // NOTE: API Gateways are intentionally NOT in this plan — see the comment in
  // planResetTargets. They are preserved across resets so the Floci-assigned
  // api id stays stable.
  ecs: Array<{
    cluster: string;
    service: string;
    albName: string;
    targetGroupPrefix: string;
  }>;
  lambdas: Array<{
    functionName: string;
    roleName: string;
    logGroup: string;
    securityGroupName: string;
    inlineDynamoPolicy?: string;
  }>;
  ecsTaskRoles: Array<{
    roleName: string;
    inlinePolicy: string;
  }>;
  stateDirsToRemove: string[];
};

// ---------------------------------------------------------------------------
// Type guards — no `as T` casts
// ---------------------------------------------------------------------------

function isLambdaEntry(entry: ServiceManifestEntry): entry is ServiceManifestEntry & {
  metadata: ServiceManifestEntry["metadata"] & { serviceType: "lambda" };
} {
  return entry.metadata.serviceType === "lambda";
}

function isEcsEntry(entry: ServiceManifestEntry): entry is ServiceManifestEntry & {
  metadata: ServiceManifestEntry["metadata"] & { serviceType: "ecs" };
  ecs: NonNullable<ServiceManifestEntry["ecs"]>;
} {
  return entry.metadata.serviceType === "ecs" && entry.ecs !== undefined;
}

// ---------------------------------------------------------------------------
// planResetTargets — pure planner, no side effects
// ---------------------------------------------------------------------------

export function planResetTargets(manifest: ServiceManifestEntry[]): ResetPlan {
  const plan: ResetPlan = {
    ecs: [],
    lambdas: [],
    ecsTaskRoles: [],
    stateDirsToRemove: [],
  };

  for (const entry of manifest) {
    const { metadata } = entry;

    // Network is never torn down — it is shared infra that persists across
    // redeploys (idempotent re-apply).
    if (metadata.serviceType === "network") continue;

    // API Gateways are NOT torn down either. Floci assigns a random api id on
    // every create, so deleting + recreating a gateway would mint a new id each
    // redeploy. The Next.js apps bake that id into their asset prefix at build
    // time, so a changed id breaks already-built containers (assets 404 → router
    // retries). Keeping the gateway (and its Terraform state) means
    // `terraform apply` re-uses the existing id, so URLs stay stable across
    // redeploys. The gateway is cheap to leave running.
    if (metadata.serviceType === "apigateway") continue;

    // Track state dirs for every torn-down (non-network, non-gateway) service.
    plan.stateDirsToRemove.push(generatedDirectoryForService(metadata, "floci"));

    if (isEcsEntry(entry)) {
      plan.ecs.push({
        cluster: entry.ecs.clusterName,
        service: entry.ecs.clusterName,
        albName: entry.ecs.albName,
        targetGroupPrefix: entry.ecs.targetGroupPrefix,
      });

      // Task role only if service invokes lambda
      const config = entry.service.config;
      if (
        "permissions" in config &&
        config.permissions !== undefined &&
        "lambda" in config.permissions &&
        Array.isArray(config.permissions.lambda) &&
        config.permissions.lambda.length > 0
      ) {
        plan.ecsTaskRoles.push({
          roleName: physicalName(metadata, "task-role"),
          inlinePolicy: physicalName(metadata, "lambda-invoke"),
        });
      }
      continue;
    }

    if (isLambdaEntry(entry)) {
      const config = entry.service.config;
      const hasDynamo =
        "permissions" in config &&
        config.permissions !== undefined &&
        "dynamodb" in config.permissions &&
        Array.isArray(config.permissions.dynamodb) &&
        config.permissions.dynamodb.length > 0;

      plan.lambdas.push({
        functionName: entry.physicalName,
        roleName: physicalName(metadata, "lambda-role"),
        logGroup: `/aws/lambda/${entry.physicalName}`,
        securityGroupName: physicalName(metadata, "sg"),
        ...(hasDynamo ? { inlineDynamoPolicy: physicalName(metadata, "dynamodb-access") } : {}),
      });
      continue;
    }

    // dynamodb — not torn down in TS (handled by floci-ddb-reset.sh), no-op here
  }

  return plan;
}

// ---------------------------------------------------------------------------
// runFlociReset — imperative, calls AWS and spawns DDB reset script
// ---------------------------------------------------------------------------

const BASIC_EXEC = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
const VPC_ACCESS = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole";

export async function runFlociReset(): Promise<void> {
  if (!(await aws.flociReachable())) {
    console.error("Floci not reachable at http://localhost:4566 — run pnpm floci:up");
    process.exit(1);
  }

  const servicesRoot = path.resolve(import.meta.dirname, "../../../../infra/services");

  const manifest = await loadServiceManifest({
    env: "dev",
    venture: "venture",
    servicesRoot,
  });

  const plan = planResetTargets(manifest);

  // NOTE: API Gateways are intentionally preserved (see planResetTargets) so the
  // Floci-assigned api id stays stable across redeploys.

  console.log("Deleting ECS clusters, services, ALBs, target groups...");
  for (const e of plan.ecs) {
    await aws.deleteEcsService(e.cluster, e.service);
    await aws.deleteEcsCluster(e.cluster);
    await aws.deleteAlbByName(e.albName);
    await aws.deleteTargetGroupsByPrefix(e.targetGroupPrefix);
  }

  console.log("Deleting Lambda functions, roles, log groups, security groups...");
  for (const l of plan.lambdas) {
    await aws.detachRolePolicy(l.roleName, BASIC_EXEC);
    await aws.detachRolePolicy(l.roleName, VPC_ACCESS);
    if (l.inlineDynamoPolicy !== undefined) {
      await aws.deleteRolePolicy(l.roleName, l.inlineDynamoPolicy);
    }
    await aws.deleteRole(l.roleName);
    await aws.deleteLambda(l.functionName);
    await aws.deleteLogGroup(l.logGroup);
    await aws.deleteSecurityGroupByName(l.securityGroupName);
  }

  console.log("Deleting ECS task roles...");
  for (const r of plan.ecsTaskRoles) {
    await aws.deleteRolePolicy(r.roleName, r.inlinePolicy);
    await aws.deleteRole(r.roleName);
  }

  console.log("Resetting DynamoDB tables...");
  spawnSync("bash", [path.resolve(import.meta.dirname, "../../scripts/floci-ddb-reset.sh")], {
    stdio: "inherit",
    env: scrubbedEnv(),
  });

  console.log("Removing generated Floci state directories...");
  for (const dir of plan.stateDirsToRemove) {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("Reset complete.");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isCliEntry =
  process.argv[1] !== undefined
    ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
    : false;

if (isCliEntry) {
  await runFlociReset();
}
