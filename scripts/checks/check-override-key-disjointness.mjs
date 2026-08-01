#!/usr/bin/env node
/**
 * CI guard: within one `overrides` scope, no two keys for the same package may
 * select overlapping version ranges.
 *
 * npm resolves overlapping override keys by **silent first-match in JSON key
 * order** — no warning, no error, and the winner flips if someone reorders the
 * block. A CVE fix written as a second key beside a stale one therefore resolves
 * to the vulnerable version while looking correct:
 *
 *   {"brace-expansion@1": "1.1.16", "brace-expansion@>=1.0.0 <1.1.17": "^1.1.17"}
 *     -> resolves 1.1.16, the vulnerable version. Exit 0. No diagnostic.
 *
 * This guard exists because three successive review rounds falsified a
 * hand-written "selector form -> version interval" table in
 * docs/security/dependency-cve-response.md: each round added the form the
 * previous one missed (inclusive upper bounds, bare-major selectors, then `*`,
 * hyphen ranges, `~`, exact pins, prerelease bounds). A table is a second range
 * parser standing in for npm's, and it disagrees on whichever spelling nobody
 * enumerated. So the predicate is delegated to `semver` — the library npm
 * resolves with — rather than reimplemented.
 *
 * Reads package.json files only. No network, no @prisma/client, no ts-morph —
 * safe in the generate-free static-checks job.
 */
import { readFileSync } from "node:fs";
import semver from "semver";

const DEFAULT_MANIFESTS = ["package.json", "cli/package.json", "extension/package.json"];

/**
 * Split an overrides key into package name and selector.
 * `lastIndexOf` (not `indexOf`) so scoped names survive: `@scope/pkg@1` splits
 * at the second `@`, and a bare `@scope/pkg` has its only `@` at index 0, which
 * the `> 0` test correctly reads as "no selector".
 * A key with no selector matches every version, so its range is `*`.
 */
export function splitOverrideKey(key) {
  const at = key.lastIndexOf("@");
  return at > 0 ? { name: key.slice(0, at), range: key.slice(at + 1) } : { name: key, range: "*" };
}

/**
 * Every intersecting key pair within a single overrides object.
 *
 * Nested overrides (`{"parent": {"child": "1.2.3"}}`) are a separate scope —
 * the same package under two different parents cannot collide — so each object
 * is walked on its own. `scopePath` names the scope in the violation message.
 */
export function findOverlappingKeys(overrides, scopePath = "overrides") {
  const violations = [];
  const byPackage = new Map();

  for (const [key, value] of Object.entries(overrides ?? {})) {
    // "." addresses the parent package itself, not a dependency of it.
    if (key === ".") continue;
    if (value !== null && typeof value === "object") {
      violations.push(...findOverlappingKeys(value, `${scopePath} > ${key}`));
    }
    const { name, range } = splitOverrideKey(key);
    if (!semver.validRange(range)) continue; // e.g. `pkg@latest` — npm rejects it loudly
    if (!byPackage.has(name)) byPackage.set(name, []);
    byPackage.get(name).push({ key, range });
  }

  for (const [name, entries] of byPackage) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (semver.intersects(entries[i].range, entries[j].range)) {
          violations.push(
            `${scopePath}: '${entries[i].key}' and '${entries[j].key}' both select versions of ${name} — npm picks by key order, silently`,
          );
        }
      }
    }
  }
  return violations;
}

function main(manifests = DEFAULT_MANIFESTS) {
  const violations = [];
  for (const path of manifests) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    violations.push(...findOverlappingKeys(pkg.overrides, `${path} overrides`));
  }

  if (violations.length > 0) {
    console.error("override key disjointness guard failed:");
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "\nSee docs/security/dependency-cve-response.md Step 4 — merge the overlapping keys, or narrow one so the ranges do not intersect.",
    );
    process.exit(1);
  }
  console.log("override key disjointness guard passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.length > 2 ? process.argv.slice(2) : undefined);
}
