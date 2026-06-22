// Parse repeated `--image-tag <serviceName>=<tag>` CLI values into a map.
// Set at deploy time to a content hash so the ECS task definition changes only
// when the image content changes.
export function parseImageTagOverrides(values: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const value of values) {
    const separatorIndex = value.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`Invalid --image-tag, expected <service>=<tag>: ${value}`);
    }
    overrides[value.slice(0, separatorIndex)] = value.slice(separatorIndex + 1);
  }
  return overrides;
}
