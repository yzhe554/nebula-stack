import { createServiceTypeRegistry } from "./service-type";
import { dynamoDbPlugin } from "./dynamodb";
import { lambdaPlugin } from "./lambda";
import { apiGatewayPlugin } from "./apigateway";
import { ecsPlugin } from "./ecs";

export const serviceTypeRegistry = createServiceTypeRegistry([
  dynamoDbPlugin,
  lambdaPlugin,
  apiGatewayPlugin,
  ecsPlugin,
]);

export { createServiceTypeRegistry } from "./service-type";
export type { ServiceTypePlugin, ServiceTypeRegistry } from "./service-type";
