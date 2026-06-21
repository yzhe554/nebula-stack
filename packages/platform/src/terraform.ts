import type { LoadedService } from "./types";
import type { TerraformJson } from "./terraform/base";
import type { TerraformContext } from "./terraform/context";
import { serviceTypeRegistry } from "./services";

export type { TerraformJson, DeployTarget } from "./terraform/base";

export type TerraformOptions = TerraformContext;

export function terraformForService(
  service: LoadedService,
  options: TerraformOptions = {},
): TerraformJson {
  return serviceTypeRegistry.get(service.metadata.serviceType).toTerraform(service, options);
}
