import { z } from "zod";

export const apiGatewayRouteMethodValues = [
  "ANY",
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
] as const;

const httpProxyTargetSchema = z.object({
  type: z.literal("http_proxy"),
  uri: z.string().url(),
});

const lambdaTargetSchema = z.object({
  type: z.literal("lambda"),
  service: z.string().min(1),
});

const ecsTargetSchema = z.object({
  type: z.literal("ecs"),
  service: z.string().min(1),
});

const routeTargetSchema = z.discriminatedUnion("type", [
  httpProxyTargetSchema,
  lambdaTargetSchema,
  ecsTargetSchema,
]);

export const apiGatewayRouteSchema = z.object({
  path: z.string().min(1).startsWith("/"),
  method: z.enum(apiGatewayRouteMethodValues),
  target: routeTargetSchema,
  targets: z
    .object({
      floci: routeTargetSchema.optional(),
      aws: routeTargetSchema.optional(),
    })
    .strict()
    .optional(),
});

export const apiGatewayCertificateSchema = z
  .union([
    z
      .object({
        arn: z
          .string()
          .min(1)
          .describe("Explicit ACM certificate ARN for this API Gateway custom domain."),
      })
      .strict(),
    z
      .object({
        lookupDomain: z
          .string()
          .min(1)
          .describe(
            "Domain name to use when looking up an ISSUED ACM certificate, such as *.dev.example.com.",
          ),
      })
      .strict(),
  ])
  .describe(
    "ACM certificate config for AWS API Gateway custom domains. Use arn for explicit references or lookupDomain to find an existing issued certificate.",
  );

export const apiGatewayTargetDomainSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        "Full custom domain name for this API Gateway, such as app.dev.example.com. Terraform maps this domain to the HTTP API.",
      ),
    zoneName: z
      .string()
      .min(1)
      .describe(
        "Existing Route 53 hosted zone name that owns the domain record, such as dev.example.com. AWS deployments look up this zone; Floci deployments create it locally.",
      ),
    certificate: apiGatewayCertificateSchema.optional(),
  })
  .strict();

export const apiGatewayDomainSchema = z
  .object({
    floci: apiGatewayTargetDomainSchema
      .optional()
      .describe("Local Floci custom domain and Route 53 settings."),
    aws: apiGatewayTargetDomainSchema
      .optional()
      .describe("AWS custom domain and Route 53 settings."),
  })
  .strict()
  .refine((domain) => domain.floci || domain.aws, {
    message: "At least one of domain.floci or domain.aws is required",
  });

export const apiGatewaySchema = z
  .object({
    description: z
      .string()
      .min(1)
      .optional()
      .describe("Human-readable description for the generated HTTP API."),
    domain: apiGatewayDomainSchema
      .optional()
      .describe(
        "Optional custom domain and Route 53 settings for exposing this API Gateway with a human-readable hostname.",
      ),
    routes: z
      .array(apiGatewayRouteSchema)
      .min(1)
      .describe("HTTP API routes and their integration targets."),
  })
  .strict();
