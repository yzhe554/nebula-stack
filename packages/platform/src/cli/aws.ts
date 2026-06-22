import { ApiGatewayV2Client, GetApisCommand } from "@aws-sdk/client-apigatewayv2";
import {
  ECSClient,
  UpdateServiceCommand,
  DeleteServiceCommand,
  DeleteClusterCommand,
  ListClustersCommand,
} from "@aws-sdk/client-ecs";
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeListenersCommand,
  DeleteListenerCommand,
  DeleteLoadBalancerCommand,
  DescribeTargetGroupsCommand,
  DeleteTargetGroupCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { LambdaClient, DeleteFunctionCommand } from "@aws-sdk/client-lambda";
import { CloudWatchLogsClient, DeleteLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  IAMClient,
  DetachRolePolicyCommand,
  DeleteRolePolicyCommand,
  DeleteRoleCommand,
} from "@aws-sdk/client-iam";
import {
  EC2Client,
  DescribeSecurityGroupsCommand,
  DeleteSecurityGroupCommand,
} from "@aws-sdk/client-ec2";
import { flociClientConfig } from "./floci-env.js";

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

const apigw = new ApiGatewayV2Client(flociClientConfig());
const ecs = new ECSClient(flociClientConfig());
const elb = new ElasticLoadBalancingV2Client(flociClientConfig());
const lambda = new LambdaClient(flociClientConfig());
const logs = new CloudWatchLogsClient(flociClientConfig());
const iam = new IAMClient(flociClientConfig());
const ec2 = new EC2Client(flociClientConfig());

// ---------------------------------------------------------------------------
// Shared "not found" predicate — no `as` casts, uses `in` narrowing
// ---------------------------------------------------------------------------

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  const code = "Code" in error && typeof error.Code === "string" ? error.Code : "";
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return /NotFound|NoSuchEntity|ResourceNotFoundException|InvalidGroup\.NotFound|DeleteConflict/.test(
    `${name} ${code} ${message}`,
  );
}

// ---------------------------------------------------------------------------
// API Gateway V2
// ---------------------------------------------------------------------------

export async function getApiIdByName(name: string): Promise<string | undefined> {
  const result = await apigw.send(new GetApisCommand({}));
  return result.Items?.find((i) => i.Name === name)?.ApiId;
}

// ---------------------------------------------------------------------------
// ECS
// ---------------------------------------------------------------------------

export async function deleteEcsService(cluster: string, service: string): Promise<void> {
  try {
    await ecs.send(new UpdateServiceCommand({ cluster, service, desiredCount: 0 }));
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  try {
    await ecs.send(new DeleteServiceCommand({ cluster, service, force: true }));
  } catch (e) {
    if (isNotFound(e)) return;
    throw e;
  }
}

export async function deleteEcsCluster(cluster: string): Promise<void> {
  try {
    await ecs.send(new DeleteClusterCommand({ cluster }));
  } catch (e) {
    if (isNotFound(e)) return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// ELB v2 (ALB / Target Groups)
// ---------------------------------------------------------------------------

export async function deleteAlbByName(name: string): Promise<void> {
  let LoadBalancerArn: string | undefined;
  try {
    const result = await elb.send(new DescribeLoadBalancersCommand({ Names: [name] }));
    LoadBalancerArn = result.LoadBalancers?.[0]?.LoadBalancerArn;
  } catch (e) {
    if (isNotFound(e)) return;
    throw e;
  }
  if (!LoadBalancerArn) return;

  // Delete all listeners first
  try {
    const listenersResult = await elb.send(new DescribeListenersCommand({ LoadBalancerArn }));
    for (const listener of listenersResult.Listeners ?? []) {
      if (listener.ListenerArn) {
        try {
          await elb.send(new DeleteListenerCommand({ ListenerArn: listener.ListenerArn }));
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
      }
    }
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }

  try {
    await elb.send(new DeleteLoadBalancerCommand({ LoadBalancerArn }));
  } catch (e) {
    if (isNotFound(e)) return;
    throw e;
  }
}

export async function deleteTargetGroupsByPrefix(prefix: string): Promise<void> {
  let arns: string[] = [];
  try {
    const result = await elb.send(new DescribeTargetGroupsCommand({}));
    arns = (result.TargetGroups ?? [])
      .filter((tg) => tg.TargetGroupName?.startsWith(prefix))
      .map((tg) => tg.TargetGroupArn)
      .filter((arn): arn is string => typeof arn === "string");
  } catch (e) {
    if (isNotFound(e)) return;
    throw e;
  }
  for (const TargetGroupArn of arns) {
    try {
      await elb.send(new DeleteTargetGroupCommand({ TargetGroupArn }));
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Lambda
// ---------------------------------------------------------------------------

export async function deleteLambda(name: string): Promise<void> {
  try {
    await lambda.send(new DeleteFunctionCommand({ FunctionName: name }));
  } catch (e) {
    if (isNotFound(e)) return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// CloudWatch Logs
// ---------------------------------------------------------------------------

export async function deleteLogGroup(name: string): Promise<void> {
  try {
    await logs.send(new DeleteLogGroupCommand({ logGroupName: name }));
  } catch (e) {
    if (isNotFound(e)) return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// IAM
// ---------------------------------------------------------------------------

export async function detachRolePolicy(roleName: string, policyArn: string): Promise<void> {
  try {
    await iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }));
  } catch (e) {
    if (isNotFound(e)) return;
    throw e;
  }
}

export async function deleteRolePolicy(roleName: string, policyName: string): Promise<void> {
  try {
    await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }));
  } catch (e) {
    if (isNotFound(e)) return;
    throw e;
  }
}

export async function deleteRole(roleName: string): Promise<void> {
  try {
    await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
  } catch (e) {
    if (isNotFound(e)) return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// EC2 (Security Groups)
// ---------------------------------------------------------------------------

export async function deleteSecurityGroupByName(name: string): Promise<void> {
  let GroupId: string | undefined;
  try {
    const result = await ec2.send(
      new DescribeSecurityGroupsCommand({
        Filters: [{ Name: "group-name", Values: [name] }],
      }),
    );
    GroupId = result.SecurityGroups?.[0]?.GroupId;
  } catch (e) {
    if (isNotFound(e)) return;
    throw e;
  }
  if (!GroupId) return;
  try {
    await ec2.send(new DeleteSecurityGroupCommand({ GroupId }));
  } catch (e) {
    if (isNotFound(e)) return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export async function flociReachable(): Promise<boolean> {
  try {
    await ecs.send(new ListClustersCommand({}));
    return true;
  } catch {
    return false;
  }
}
