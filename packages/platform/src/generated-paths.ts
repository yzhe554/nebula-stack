import path from "node:path";
import type { DeployTarget } from "./terraform.js";
import type { ServiceMetadata } from "./types.js";

export function generatedDirectoryForService(metadata: ServiceMetadata, target: DeployTarget): string {
  return path.join(
    path.dirname(metadata.sourcePath),
    "__generated__",
    target,
    metadata.serviceName,
  );
}
