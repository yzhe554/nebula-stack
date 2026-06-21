import type { ZodType } from "zod";
import type { LoadedService, ServiceType } from "../types";
import type { TerraformContext } from "../terraform/context";
import type { TerraformJson } from "../terraform/base";

export type JsonSchemaMetadata = {
  fileName: string;
  title: string;
  description: string;
};

export type ServiceTypePlugin<Config = unknown> = {
  type: ServiceType;
  fileSuffix: string;
  schema: ZodType<Config>;
  jsonSchemaMetadata: JsonSchemaMetadata;
  deployPriority: number;
  validateReferences?(service: LoadedService, services: LoadedService[]): string[];
  toTerraform(service: LoadedService, context: TerraformContext): TerraformJson;
};

export type ServiceTypeRegistry = {
  get(type: ServiceType): ServiceTypePlugin;
  forFileSuffix(suffix: string): ServiceTypePlugin | undefined;
  all(): ServiceTypePlugin[];
};

export function createServiceTypeRegistry(plugins: ServiceTypePlugin[]): ServiceTypeRegistry {
  const byType = new Map<ServiceType, ServiceTypePlugin>();
  const bySuffix = new Map<string, ServiceTypePlugin>();

  for (const plugin of plugins) {
    if (byType.has(plugin.type)) {
      throw new Error(`Duplicate service type plugin registered for ${plugin.type}`);
    }

    if (bySuffix.has(plugin.fileSuffix)) {
      throw new Error(
        `Duplicate service type plugin file suffix registered for ${plugin.fileSuffix}`,
      );
    }

    byType.set(plugin.type, plugin);
    bySuffix.set(plugin.fileSuffix, plugin);
  }

  return {
    get(type) {
      const plugin = byType.get(type);
      if (!plugin) {
        throw new Error(`No plugin registered for service type ${type}`);
      }
      return plugin;
    },
    forFileSuffix(suffix) {
      return bySuffix.get(suffix);
    },
    all() {
      return [...plugins];
    },
  };
}
