import type { ServiceMetadata } from "../types";

export function vpcNameTag(metadata: ServiceMetadata): string {
  return `${metadata.env}-${metadata.venture}-${metadata.vpc}-vpc`;
}

export function vpcDataSourcesForZone(
  metadata: ServiceMetadata,
  zone: string,
): Record<string, unknown> {
  return {
    aws_vpc: {
      selected: { filter: { name: "tag:Name", values: [vpcNameTag(metadata)] } },
    },
    aws_subnets: {
      selected: {
        filter: [
          { name: "vpc-id", values: ["${data.aws_vpc.selected.id}"] },
          { name: "tag:Zone", values: [zone] },
        ],
      },
    },
  };
}

export function vpcDataSources(metadata: ServiceMetadata): Record<string, unknown> {
  return vpcDataSourcesForZone(metadata, metadata.securityZone);
}
