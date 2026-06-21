// packages/platform/src/terraform/naming.ts
import type { ServiceMetadata } from "../types";

export function physicalName(metadata: ServiceMetadata, suffix?: string): string {
  return [
    metadata.env,
    metadata.venture,
    metadata.vpc,
    metadata.securityZone,
    metadata.serviceName,
    suffix,
  ]
    .filter(Boolean)
    .join("-");
}

export function terraformName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function truncateName(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength);
}

export function ecsLoadBalancerName(metadata: ServiceMetadata): string {
  return truncateName(physicalName(metadata), 32);
}

export function targetGroupNamePrefix(resourceName: string): string {
  return `${resourceName.replace(/_/g, "").slice(0, 5)}-`;
}
