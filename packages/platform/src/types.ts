export type ServiceType = "lambda" | "dynamodb" | "apigateway";

export type ServiceMetadata = {
  env: string;
  venture: string;
  vpc: string;
  securityZone: string;
  serviceName: string;
  serviceType: ServiceType;
  sourcePath: string;
};

export type LambdaConfig = {
  runtime: string;
  handler: string;
  package: string;
  memoryMb: number;
  timeoutSeconds: number;
  logRetentionDays: number;
  environment: Record<string, string>;
  permissions: {
    dynamodb: DynamoDbPermission[];
  };
};

export type DynamoDbPermission = {
  service: string;
  actions: Array<
    | "dynamodb:PutItem"
    | "dynamodb:GetItem"
    | "dynamodb:UpdateItem"
    | "dynamodb:DeleteItem"
    | "dynamodb:Query"
    | "dynamodb:Scan"
  >;
};

export type DynamoDbAttributeType = "S" | "N" | "B";

export type DynamoDbConfig = {
  billingMode: "PAY_PER_REQUEST";
  hashKey: {
    name: string;
    type: DynamoDbAttributeType;
  };
  rangeKey?: {
    name: string;
    type: DynamoDbAttributeType;
  };
  pointInTimeRecovery: boolean;
};

export type ApiGatewayConfig = {
  description?: string;
  domain?: ApiGatewayDomain;
  routes: ApiGatewayRoute[];
};

export type ApiGatewayDomain = {
  floci?: ApiGatewayTargetDomain;
  aws?: ApiGatewayTargetDomain;
};

export type ApiGatewayTargetDomain = {
  name: string;
  zoneName: string;
  certificate?: ApiGatewayCertificate;
};

export type ApiGatewayCertificate = { arn: string } | { lookupDomain: string };

export type ApiGatewayRoute = {
  path: string;
  method: "ANY" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
  target: { type: "http_proxy"; uri: string } | { type: "lambda"; service: string };
};

export type LoadedService =
  | {
      metadata: ServiceMetadata & { serviceType: "lambda" };
      config: LambdaConfig;
    }
  | {
      metadata: ServiceMetadata & { serviceType: "dynamodb" };
      config: DynamoDbConfig;
    }
  | {
      metadata: ServiceMetadata & { serviceType: "apigateway" };
      config: ApiGatewayConfig;
    };

export type NetworkFlow = {
  from: string;
  to: string;
  ports?: number[];
  services?: string[];
};

export type NetworkZone = {
  description: string;
  subnets: string[];
};

export type NetworkPolicy = {
  cidrs: {
    ipv4: {
      vpc: string;
    };
  };
  zones: Record<string, NetworkZone>;
  flows: NetworkFlow[];
  awsEndpoints: Record<string, AwsEndpoint>;
};

export type AwsEndpoint = {
  type: "gateway" | "interface";
  serviceName: string;
  routeTableZoneNames?: string[];
  policy: "default";
};
