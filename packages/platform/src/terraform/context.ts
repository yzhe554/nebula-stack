// packages/platform/src/terraform/context.ts
import type { DeployTarget } from "./base";
import type { AwsEndpointService } from "../services/network/endpoints";

export type TerraformContext = {
  target?: DeployTarget;
  moduleDirectory?: string;
  serviceNames?: Record<string, string>;
  /** Required for Floci API Gateway routes that target ECS services. */
  serviceContainerPorts?: Record<string, number>;
  domainCertificateArns?: Record<string, string>;
  /** AWS services that in-VPC code must reach privately; the network module turns these into VPC endpoints. */
  requiredAwsEndpoints?: AwsEndpointService[];
};

export type TerraformContextWithServiceContainerPorts = TerraformContext & {
  serviceContainerPorts: Record<string, number>;
};

export function requireServiceContainerPorts(
  context: TerraformContext,
  message: string,
): TerraformContextWithServiceContainerPorts {
  const { serviceContainerPorts } = context;
  if (serviceContainerPorts) {
    return { ...context, serviceContainerPorts };
  }

  throw new Error(message);
}
