import path from "node:path";
import type { DeployTarget } from "./terraform";
import type { ServiceMetadata } from "./types";

export function generatedDirectoryForService(
  metadata: ServiceMetadata,
  target: DeployTarget,
): string {
  return path.join(
    path.dirname(metadata.sourcePath),
    "__generated__",
    target,
    metadata.serviceName,
  );
}
