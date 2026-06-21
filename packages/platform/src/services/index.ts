import { createServiceTypeRegistry } from "./service-type";
import { networkPlugin } from "./network";
import { dynamoDbPlugin } from "./dynamodb";
import { lambdaPlugin } from "./lambda";
import { apiGatewayPlugin } from "./apigateway";
import { ecsPlugin } from "./ecs";

export const serviceTypeRegistry = createServiceTypeRegistry([
  networkPlugin,
  dynamoDbPlugin,
  lambdaPlugin,
  apiGatewayPlugin,
  ecsPlugin,
]);

export { createServiceTypeRegistry } from "./service-type";
export type { ServiceTypePlugin, ServiceTypeRegistry } from "./service-type";
