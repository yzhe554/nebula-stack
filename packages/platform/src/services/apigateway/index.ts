import { apiGatewaySchema } from "../../../schemas/apigateway.schema";
import type { ServiceTypePlugin } from "../service-type";
import type { LoadedService } from "../../types";
import { terraformForApiGateway, type ApiGatewayService } from "./terraform";

function isApiGatewayService(service: LoadedService): service is ApiGatewayService {
  return service.metadata.serviceType === "apigateway";
}

export const apiGatewayPlugin: ServiceTypePlugin = {
  type: "apigateway",
  fileSuffix: "apigateway",
  schema: apiGatewaySchema,
  jsonSchemaMetadata: {
    fileName: "apigateway.schema.json",
    title: "Platform API Gateway Service",
    description: "YAML schema for AWS API Gateway HTTP APIs deployed by the platform.",
  },
  deployPriority: 3,
  validateReferences: (service, services) => {
    if (!isApiGatewayService(service)) {
      return [`apiGatewayPlugin received non-apigateway service: ${service.metadata.serviceType}`];
    }

    const servicesByType = {
      ecs: new Set(
        services
          .filter((candidate) => candidate.metadata.serviceType === "ecs")
          .map((candidate) => candidate.metadata.serviceName),
      ),
      lambda: new Set(
        services
          .filter((candidate) => candidate.metadata.serviceType === "lambda")
          .map((candidate) => candidate.metadata.serviceName),
      ),
    };

    return service.config.routes.flatMap((route, routeIndex) =>
      apiGatewayRouteTargets(route).flatMap(({ path, target }) => {
        if (target.type !== "ecs" && target.type !== "lambda") {
          return [];
        }

        if (servicesByType[target.type].has(target.service)) {
          return [];
        }

        const label = target.type === "ecs" ? "ECS" : "Lambda";
        return [
          `routes[${routeIndex}].${path}.service references unknown ${label} service ${target.service} (${service.metadata.sourcePath})`,
        ];
      }),
    );
  },
  toTerraform: (service, context) => {
    if (!isApiGatewayService(service)) {
      throw new Error(
        `apiGatewayPlugin received non-apigateway service: ${service.metadata.serviceType}`,
      );
    }
    return terraformForApiGateway(service, context);
  },
};

function apiGatewayRouteTargets(
  route: ApiGatewayService["config"]["routes"][number],
): Array<{ path: string; target: ApiGatewayService["config"]["routes"][number]["target"] }> {
  return [
    { path: "target", target: route.target },
    ...Object.entries(route.targets ?? {}).map(([deployTarget, target]) => ({
      path: `targets.${deployTarget}`,
      target,
    })),
  ];
}
