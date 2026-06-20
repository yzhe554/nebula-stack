import { z } from "zod";

export const apiGatewayRouteMethodValues = ["ANY", "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

const httpProxyTargetSchema = z.object({
  type: z.literal("http_proxy"),
  uri: z.string().url(),
});

const lambdaTargetSchema = z.object({
  type: z.literal("lambda"),
  service: z.string().min(1),
});

export const apiGatewayRouteSchema = z.object({
  path: z.string().min(1).startsWith("/"),
  method: z.enum(apiGatewayRouteMethodValues),
  target: z.discriminatedUnion("type", [httpProxyTargetSchema, lambdaTargetSchema]),
});

export const apiGatewaySchema = z.object({
  description: z.string().min(1).optional(),
  routes: z.array(apiGatewayRouteSchema).min(1),
}).strict();
