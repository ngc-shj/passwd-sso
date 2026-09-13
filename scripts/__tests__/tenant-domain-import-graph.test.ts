import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * `scripts/tenant-domain.ts` runs on MIGRATION_DATABASE_URL alone. `src/lib/prisma.ts`
 * builds the application pool when it is imported and throws without DATABASE_URL,
 * so a runtime import that reaches it breaks every command on an operator host —
 * and `realign` (round-7 F-R7-2) is the command that most needed the modules which
 * import it. This walks the file's runtime import graph and fails on any path to
 * the singleton.
 */
const REPO = join(__dirname, "..", "..");
const SINGLETON = join(REPO, "src", "lib", "prisma.ts");

function resolveSpecifier(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(REPO, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every runtime import specifier in `source`: static (not `import type`), re-exports, side-effect and dynamic imports. */
function runtimeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+"([^"]+)"/gm)) specs.push(m[1]);
  for (const m of source.matchAll(/^\s*import\s+"([^"]+)"/gm)) specs.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) specs.push(m[1]);
  return specs;
}

function pathsToSingleton(entry: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveSpecifier(spec, file);
      if (!target) continue;
      if (target === SINGLETON) {
        found.push([...chain, file, target].map((f) => relative(REPO, f)).join(" -> "));
        continue;
      }
      walk(target, [...chain, file]);
    }
  };
  walk(entry, []);
  return found;
}

describe("scripts/tenant-domain.ts import graph", () => {
  it("never reaches the application's Prisma singleton at runtime", () => {
    expect(pathsToSingleton(join(REPO, "scripts", "tenant-domain.ts"))).toEqual([]);
  });

  it("does see the singleton through a module that imports it (control)", () => {
    // Without this, a walker that resolved nothing would pass the cell above.
    expect(pathsToSingleton(join(REPO, "src", "lib", "tenant", "tenant-realignment.ts"))).not.toEqual([]);
  });
});
