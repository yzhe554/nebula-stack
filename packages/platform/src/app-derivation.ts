import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type AppNames = {
  base: string;
  dir: string;
  packageName: string;
  dockerfile: string;
};

export function deriveAppNames(serviceName: string): AppNames {
  const base = serviceName.endsWith("-app") ? serviceName.slice(0, -"-app".length) : serviceName;
  return { base, dir: `apps/${base}`, packageName: `@repo/${base}`, dockerfile: "apps/Dockerfile" };
}

const pkgNameSchema = z.object({ name: z.string().optional() });

export function validateAppExists(app: AppNames, repoRoot: string): void {
  const dir = path.join(repoRoot, app.dir);
  if (!existsSync(dir)) {
    throw new Error(`Derived app directory not found for ${app.packageName}: ${app.dir}`);
  }
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`Derived app has no package.json: ${app.dir}/package.json`);
  }
  const name = pkgNameSchema.parse(JSON.parse(readFileSync(pkgPath, "utf8"))).name;
  if (name !== app.packageName) {
    throw new Error(
      `Derived app package name mismatch: expected ${app.packageName}, found ${typeof name === "string" ? name : "<none>"} in ${app.dir}/package.json`,
    );
  }
}
