#!/usr/bin/env node
/**
 * CI guard (E): every runtime dependency of every npm workspace MUST be
 * classified in scripts/checks/crypto-auth-deps-manifest.json as either a
 * crypto/auth `packages` member OR an `excluded` support dep. A dependency in
 * neither is unclassified — the exact hole the ts-morph reconciliation test
 * leaves open when a dep is added outside the CODE roots with a name that misses
 * the crypto name-heuristic (e.g. `better-auth`).
 *
 * This lives in a standalone .mjs guard (not only the vitest reconciliation
 * test) BECAUSE the vitest test rides the `app-ci` job, which the ci.yml
 * paths-filter runs only on `app || ci` — a PR touching ONLY cli/package.json or
 * extension/package.json would enable just the `cli`/`extension` filter and skip
 * the classification check. This guard is wired into scripts/pre-pr.sh, which the
 * `static-checks` job runs UNCONDITIONALLY on every PR, so the completeness gate
 * fires regardless of which workspace's deps changed.
 *
 * Filesystem + JSON only (no @prisma/client, no ts-morph) — safe in the
 * generate-free static-checks job. The richer AST checks (A/C/detectedBy) stay
 * in the vitest test.
 */
import { readFileSync } from "node:fs";

const MANIFEST_PATH = "scripts/checks/crypto-auth-deps-manifest.json";
const WORKSPACE_PACKAGE_JSON = {
  root: "package.json",
  cli: "cli/package.json",
  extension: "extension/package.json",
};

/** Real package name for a manifest key (composite keys carry it in `package`). */
function entryPackage(key, entry) {
  return entry.package ?? key;
}

/** Runtime deps of a workspace not present in the manifest's packages union excluded. */
export function computeUnclassifiedDeps(deps, classified) {
  return deps.filter((d) => !classified.has(d)).sort();
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const violations = [];
  for (const [workspace, pkgPath] of Object.entries(WORKSPACE_PACKAGE_JSON)) {
    const classified = new Set();
    for (const [key, entry] of Object.entries(manifest.packages)) {
      if (entry.workspace === workspace) classified.add(entryPackage(key, entry));
    }
    for (const [key, entry] of Object.entries(manifest.excluded)) {
      if (entry.workspace === workspace) classified.add(entryPackage(key, entry));
    }
    const deps = Object.keys(JSON.parse(readFileSync(pkgPath, "utf8")).dependencies ?? {});
    for (const dep of computeUnclassifiedDeps(deps, classified)) {
      violations.push(
        `${workspace} (${pkgPath}): '${dep}' is unclassified — add it to packages (crypto/auth) or excluded (support dep) in ${MANIFEST_PATH}`,
      );
    }
  }
  if (violations.length > 0) {
    console.error("crypto/auth deps classification-completeness guard failed:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log("crypto/auth deps classification-completeness guard passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
