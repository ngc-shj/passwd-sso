#!/usr/bin/env node
/**
 * CI guard: an `overrides` block must decide which override applies to a given
 * dependency edge without depending on JSON key order.
 *
 * npm matches an override key `pkg@<range>` against the **range the depending
 * package asks for**, not against a resolved version, and takes the first key
 * whose range intersects that request — in JSON key order, silently. Two things
 * therefore break order-independence, and the guard checks both:
 *
 *   1. Two keys for the same package whose ranges intersect. Ambiguous for any
 *      edge that reaches them.
 *   2. Two keys that are disjoint from each other, but which a single edge's
 *      requested range straddles. Demonstrated (npm 11.17.0): with
 *      `{"brace-expansion@1": "1.1.17", "brace-expansion@2": "2.1.3"}` — disjoint
 *      keys — a parent asking for `>=1 <3` resolves 1.1.17 in that key order and
 *      2.1.3 reversed. Checking the keys against each other alone misses this,
 *      which is what an earlier revision of this guard did.
 *
 * A CVE fix written beside a stale key can therefore resolve to the vulnerable
 * version while looking correct, with exit 0 and no diagnostic from npm.
 *
 * The predicate is delegated to `semver` — the library npm resolves with —
 * rather than reimplemented. Three review rounds of
 * docs/security/dependency-cve-response.md each shipped a hand-written
 * "selector form -> version interval" table and each was falsified by a form the
 * previous round had not enumerated. A table is a second range parser standing in
 * for npm's; do not reintroduce one.
 *
 * Reads package.json / package-lock.json only. No network, no @prisma/client, no
 * ts-morph — safe in the generate-free static-checks job.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import semver from "semver";

/**
 * Used only when `git ls-files` is unavailable (e.g. a source tarball).
 * Exported so a caller for which a silent fallback is a REFUSAL rather than a
 * degraded pass can tell the two apart by reference identity — `discoverManifests`
 * returns this exact array object on the fallback path and a fresh array
 * otherwise, which a content comparison cannot distinguish.
 */
export const FALLBACK_MANIFESTS = ["package.json", "cli/package.json", "extension/package.json"];

/**
 * The npm dependency fields a `$ref` override value (`"$rollup"`) can resolve
 * against. Exported because the staleness gate resolves the same refs — two
 * copies of this list would let one gate see a `$ref` the other does not.
 */
export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/**
 * Every tracked package.json, so a workspace added later is covered without
 * anyone remembering to extend a list here. `git ls-files` excludes
 * node_modules by construction. Falls back to the known set outside a git
 * checkout; returning an empty set would make the guard vacuously green, so
 * that case falls back rather than passing.
 */
export function discoverManifests() {
  try {
    const tracked = execFileSync("git", ["ls-files", "-z", "package.json", "*/package.json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
    if (tracked.length > 0) return tracked;
  } catch {
    // not a git checkout, or git is absent
  }
  return FALLBACK_MANIFESTS;
}

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
 * JSON.parse never produces a Date, RegExp, Map or class instance — only plain
 * objects, arrays and primitives — but an array must still be told apart from a
 * scope: npm treats `{"pkg": []}` as a broken override, not a nested one, and
 * `Object.entries` on an array yields numeric-index keys that are not overrides
 * keys at all.
 */
export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Group one overrides object's keys by package name.
 * Nested overrides (`{"parent": {"child": "1.2.3"}}`) are a separate scope — the
 * same package under two different parents cannot collide — so each object is
 * walked on its own and reported under its own `scopePath`. The key that opened
 * a nested scope is threaded down as `parentKey`, and `parentName` is derived
 * from it via `splitOverrideKey` — never by parsing `scopePath` back apart,
 * which would read `{"pkg@1": {...}}`'s child as belonging to `pkg@1` rather
 * than `pkg`. Both are null at the top level.
 *
 * Every entry — `byPackage`, `unparseable`, and a `"."` self-pin — carries the
 * raw override value as `pin`, not just its range/selector, so a caller judging
 * staleness can see what the key actually pins.
 *
 * A selector semver cannot parse is NOT skipped. npm errors on such a key only
 * when it actually evaluates it: `{"pkg@latest": "x"}` fails the install, but
 * `{"pkg": "y", "pkg@latest": "x"}` exits 0 with the bad key silently ignored
 * (verified, npm 11.17.0). Silently skipping it here would inherit that
 * order-dependence, so it is reported.
 */
export function collectScopes(overrides, scopePath = "overrides", into = [], depth = 0, parentKey = null) {
  const byPackage = new Map();
  const unparseable = [];
  const selfPins = [];

  for (const [key, value] of Object.entries(overrides ?? {})) {
    // "." addresses the parent package itself, not a dependency of it, so it
    // must never reach byPackage — this file's own overlap arithmetic pins that
    // exclusion at `check-override-key-disjointness.test.mjs:116`. It still
    // carries its pin, for a caller that judges the parent package's staleness.
    if (key === ".") {
      selfPins.push({ key, pin: value });
      continue;
    }
    // Only a plain object opens a nested scope. An array (or any other
    // non-plain-object value) is left as a pin below, not recursed into — the
    // previous, looser `typeof value === "object"` test recursed into `[]` too,
    // producing an empty child scope alongside this key's own pin entry: one
    // key, two rows.
    if (isPlainObject(value)) {
      collectScopes(value, `${scopePath} > ${key}`, into, depth + 1, key);
    }
    const { name, range } = splitOverrideKey(key);
    if (!semver.validRange(range)) {
      unparseable.push({ key, range, pin: value });
      continue;
    }
    if (!byPackage.has(name)) byPackage.set(name, []);
    byPackage.get(name).push({ key, range, pin: value });
  }

  // `depth` is carried explicitly rather than inferred from position: the walk
  // recurses inside the loop and pushes the current scope after it, so the array
  // is post-order and `into[0]` is the FIRST NESTED scope whenever one exists.
  // An earlier revision took `into[0]` as the top level and therefore skipped the
  // whole top-level edge check on any manifest with a nested override —
  // `extension/package.json` has one.
  into.push({
    scopePath,
    byPackage,
    unparseable,
    selfPins,
    depth,
    parentKey,
    parentName: parentKey ? splitOverrideKey(parentKey).name : null,
  });
  return into;
}

/** The one scope npm applies to every edge in the tree. */
export function topLevelScope(scopes) {
  return scopes.find((s) => s.depth === 0);
}

/** Keys for one package whose ranges intersect each other (hazard 1). */
export function findOverlappingKeys(overrides, scopePath = "overrides") {
  const violations = [];
  for (const scope of collectScopes(overrides, scopePath)) {
    for (const { key, range } of scope.unparseable) {
      violations.push(
        `${scope.scopePath}: '${key}' has a selector semver cannot parse ('${range}') — npm ignores such a key silently when an earlier key already matched, so its effect depends on key order`,
      );
    }
    for (const [name, entries] of scope.byPackage) {
      // A nested scope governs only edges beneath its parent, and the lockfile
      // does not record which scope produced a given edge — so the edge check
      // below cannot cover it. Two selectors for one package inside a nested
      // scope are therefore undecidable here, and undecidable means red.
      if (scope.depth > 0 && entries.length > 1) {
        violations.push(
          `${scope.scopePath}: ${name} has ${entries.length} selectors (${entries
            .map((e) => `'${e.key}'`)
            .join(", ")}) inside a nested scope — a dependency range spanning two of them would resolve by key order, and nested scopes cannot be edge-checked against the lockfile. Use one selector per package here`,
        );
        continue;
      }
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          if (semver.intersects(entries[i].range, entries[j].range)) {
            violations.push(
              `${scope.scopePath}: '${entries[i].key}' and '${entries[j].key}' both select versions of ${name} — npm picks by key order, silently`,
            );
          }
        }
      }
    }
  }
  return violations;
}

/**
 * Dependency edges whose requested range reaches more than one override key
 * (hazard 2). `lockfilePackages` is a lockfile's `packages` map; each entry's
 * dependency fields hold the range that package asks for.
 *
 * Only the top-level overrides scope is considered: npm applies a nested scope
 * to edges under its parent, and the lockfile does not record which override
 * scope produced a given edge, so pairing them would be guesswork.
 */
export function findAmbiguousEdges(overrides, lockfilePackages, label = "package-lock.json") {
  const topScope = topLevelScope(collectScopes(overrides));
  const violations = [];
  if (!topScope) return violations;

  for (const [path, meta] of Object.entries(lockfilePackages ?? {})) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dep, requested] of Object.entries(meta?.[field] ?? {})) {
        const keys = topScope.byPackage.get(dep);
        if (!keys || keys.length < 2) continue;

        // A spec semver cannot compare is not evidence of safety. npm reduces
        // `npm:pkg@>=1 <3` to the range `>=1 <3` and applies the overrides to it
        // order-dependently (verified, npm 11.17.0) — semver.validRange returns
        // null for the same string. Rather than reimplement npm's spec parser,
        // an undecidable spec on a package that has more than one key is
        // reported. Today that is zero noise: of 4374 edges across the three
        // lockfiles exactly one is non-semver, and its package has no overrides.
        // If a real alias edge ever lands on a multi-key package, parsing it with
        // `npm-package-arg` is the upgrade path.
        if (!semver.validRange(requested)) {
          violations.push(
            `${label}: '${path || "<root>"}' asks for ${dep}@'${requested}', which semver cannot compare, while ${dep} has ${keys.length} override keys — cannot prove npm resolves it independently of key order`,
          );
          continue;
        }

        const reached = keys.filter((k) => semver.intersects(k.range, requested));
        if (reached.length > 1) {
          violations.push(
            `${label}: '${path || "<root>"}' asks for ${dep}@'${requested}', which reaches ${reached
              .map((k) => `'${k.key}'`)
              .join(" and ")} — the keys do not overlap each other, but this edge straddles them, so npm picks by key order`,
          );
        }
      }
    }
  }
  return violations;
}

function lockfileFor(manifestPath) {
  return manifestPath.replace(/package\.json$/, "package-lock.json");
}

function main(manifests = discoverManifests()) {
  const violations = [];

  for (const manifestPath of manifests) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    if (!pkg.overrides) continue;

    violations.push(...findOverlappingKeys(pkg.overrides, `${manifestPath} overrides`));

    const lockPath = lockfileFor(manifestPath);
    let lock;
    try {
      lock = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // An overrides block with no lockfile cannot be checked for hazard 2.
      // Report rather than pass: a green here would claim a guarantee not verified.
      violations.push(
        `${manifestPath} declares overrides but ${lockPath} is missing — cannot verify that no dependency edge straddles two keys`,
      );
      continue;
    }
    violations.push(...findAmbiguousEdges(pkg.overrides, lock.packages, lockPath));
  }

  if (violations.length > 0) {
    console.error("override key disjointness guard failed:");
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "\nSee docs/security/dependency-cve-response.md Step 4 — merge the overlapping keys, or narrow one so no dependency range reaches both.",
    );
    process.exit(1);
  }
  console.log(`override key disjointness guard passed (${manifests.length} manifest(s)).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.length > 2 ? process.argv.slice(2) : undefined);
}
