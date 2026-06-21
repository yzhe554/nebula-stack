// packages/platform/src/terraform/context.ts
import type { DeployTarget } from "./base";

export type TerraformContext = {
  target?: DeployTarget;
  moduleDirectory?: string;
  serviceNames?: Record<string, string>;
  /** Required for Floci API Gateway routes that target ECS services. */
  serviceContainerPorts?: Record<string, number>;
  domainCertificateArns?: Record<string, string>;
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
