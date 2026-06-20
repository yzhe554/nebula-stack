import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { platformJsonSchemas } from "./schema-json";

export async function syncJsonSchemas(outputDirectory = "schemas"): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });

  await Promise.all(Object.entries(platformJsonSchemas).map(async ([fileName, schemaFactory]) => {
    await writeFile(
      path.join(outputDirectory, fileName),
      `${JSON.stringify(schemaFactory(), null, 2)}\n`,
      "utf8",
    );
  }));
}

async function main(): Promise<void> {
  const outputDirectory = process.argv[2] ?? "schemas";
  await syncJsonSchemas(outputDirectory);
  console.log(`Synced JSON schemas to ${outputDirectory}`);
}

const isCliEntry = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;

if (isCliEntry) {
  await main();
}
