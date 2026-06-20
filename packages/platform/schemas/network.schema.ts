import { z } from "zod";

export const networkAwsServiceValues = ["dynamodb", "kms", "lambda", "logs", "s3", "sts"] as const;
export const awsEndpointTypeValues = ["gateway", "interface"] as const;

export const ipv4CidrPattern = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

export const networkFlowSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    ports: z.array(z.number().int().min(1).max(65535)).min(1).optional(),
    services: z.array(z.enum(networkAwsServiceValues)).min(1).optional(),
  })
  .refine((flow) => Boolean(flow.ports || flow.services), {
    message: "Either ports or services must be configured",
  });

export const networkZoneSchema = z.object({
  description: z.string().min(1),
  subnets: z.array(z.string().regex(ipv4CidrPattern)).min(1),
});

export const awsEndpointSchema = z.object({
  type: z.enum(awsEndpointTypeValues),
  serviceName: z.string().min(1),
  routeTableZoneNames: z.array(z.string().min(1)).min(1).optional(),
  policy: z.literal("default"),
});

export const networkPolicySchema = z
  .object({
    cidrs: z.object({
      ipv4: z.object({
        vpc: z.string().regex(ipv4CidrPattern),
      }),
    }),
    zones: z.record(z.string(), networkZoneSchema),
    flows: z.array(networkFlowSchema),
    awsEndpoints: z.record(z.string(), awsEndpointSchema).default({}),
  })
  .superRefine((policy, context) => {
    const dynamoDbFlow = policy.flows.some(
      (flow) => flow.to === "aws" && flow.services?.includes("dynamodb"),
    );

    if (!dynamoDbFlow) {
      return;
    }

    const endpoint = policy.awsEndpoints.dynamodb;

    if (!endpoint) {
      context.addIssue({
        code: "custom",
        path: ["awsEndpoints", "dynamodb"],
        message: "awsEndpoints.dynamodb is required when a flow uses the dynamodb AWS service",
      });
      return;
    }

    if (endpoint.type !== "gateway") {
      context.addIssue({
        code: "custom",
        path: ["awsEndpoints", "dynamodb", "type"],
        message: "awsEndpoints.dynamodb.type must be gateway",
      });
    }

    if (!endpoint.routeTableZoneNames?.length) {
      context.addIssue({
        code: "custom",
        path: ["awsEndpoints", "dynamodb", "routeTableZoneNames"],
        message: "awsEndpoints.dynamodb.routeTableZoneNames must list at least one zone",
      });
      return;
    }

    for (const zoneName of endpoint.routeTableZoneNames) {
      if (!policy.zones[zoneName]) {
        context.addIssue({
          code: "custom",
          path: ["awsEndpoints", "dynamodb", "routeTableZoneNames"],
          message: `awsEndpoints.dynamodb.routeTableZoneNames references unknown zone ${zoneName}`,
        });
      }
    }
  });
