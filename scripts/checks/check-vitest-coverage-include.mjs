#!/usr/bin/env node
/**
 * CI guard: validate vitest.config.ts coverage paths.
 *
 * Usage:
 *   node scripts/checks/check-vitest-coverage-include.mjs [--enforce-rename-parity]
 *
 * --enforce-rename-parity  When set, also check that every new coverage.include
 *                          entry and threshold key added vs main corresponds to
 *                          a git mv rename in the same PR.
 *
 * Checks:
 *   0. coverage.include and coverage.thresholds parse to non-empty literals
 *      (VITEST_COVERAGE_* tokens otherwise).
 *   1. Every coverage.include glob/path resolves to >= 1 file on disk.
 *   2. Every coverage.thresholds key that is a file path (not a global key like
 *      "lines") must exist on disk.
 *   3. (--enforce-rename-parity) New includes/threshold keys must be rename pairs.
 *
 * Exit 0 = OK, Exit 1 = failure.
 */

import { execSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";

// PR 2: moved from scripts/ to scripts/checks/ — bump one extra level up.
// VITEST_COVERAGE_INCLUDE_ROOT overrides the root (self-test fixtures only).
const ROOT =
  process.env.VITEST_COVERAGE_INCLUDE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The override exists for the self-test; left set in CI it would silently
// point the gate at another tree.
if (
  process.env.CI === "true" &&
  process.env.VITEST_COVERAGE_INCLUDE_ROOT &&
  process.env.VITEST_COVERAGE_INCLUDE_FIXTURE_MODE !== "1"
) {
  console.error(
    "check-vitest-coverage-include: VITEST_COVERAGE_INCLUDE_ROOT must not be set in CI. " +
      "Set VITEST_COVERAGE_INCLUDE_FIXTURE_MODE=1 only from the self-test.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const enforceRenameParity = process.argv.includes("--enforce-rename-parity");

// ---------------------------------------------------------------------------
// Extract coverage.include and coverage.thresholds from vitest.config.ts with
// the TypeScript parser. Only literal shapes are read — a string array for
// include, an object literal (optionally one arm of a conditional, as in
// `isCoverageShard ? undefined : { ... }`) for thresholds. Anything else
// throws a VITEST_COVERAGE_* token: a list the parser cannot read would
// otherwise check nothing and pass.
// ---------------------------------------------------------------------------
function propertyName(prop) {
  const { name } = prop;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function findProperty(obj, key) {
  return obj.properties.find((p) => ts.isPropertyAssignment(p) && propertyName(p) === key);
}

function readVitestConfig(source) {
  const sf = ts.createSourceFile("vitest.config.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const coverageBlocks = [];
  (function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node) === "coverage" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      coverageBlocks.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  })(sf);
  if (coverageBlocks.length === 0) {
    throw new Error("VITEST_COVERAGE_BLOCK_MISSING: no `coverage: { ... }` object literal");
  }
  if (coverageBlocks.length > 1) {
    throw new Error(`VITEST_COVERAGE_BLOCK_AMBIGUOUS: ${coverageBlocks.length} \`coverage: { ... }\` object literals`);
  }
  const coverage = coverageBlocks[0];

  const includeProp = findProperty(coverage, "include");
  if (!includeProp) throw new Error("VITEST_COVERAGE_INCLUDE_MISSING: coverage has no include");
  if (!ts.isArrayLiteralExpression(includeProp.initializer)) {
    throw new Error("VITEST_COVERAGE_INCLUDE_UNPARSEABLE: coverage.include is not an array literal");
  }
  const includes = includeProp.initializer.elements.map((el) => {
    if (!ts.isStringLiteral(el) && !ts.isNoSubstitutionTemplateLiteral(el)) {
      throw new Error(`VITEST_COVERAGE_INCLUDE_UNPARSEABLE: entry \`${el.getText(sf)}\` is not a string literal`);
    }
    return el.text;
  });
  if (includes.length === 0) throw new Error("VITEST_COVERAGE_INCLUDE_EMPTY: coverage.include is empty");

  const thresholdsProp = findProperty(coverage, "thresholds");
  if (!thresholdsProp) throw new Error("VITEST_COVERAGE_THRESHOLDS_MISSING: coverage has no thresholds");
  let thresholdsObj = thresholdsProp.initializer;
  if (ts.isConditionalExpression(thresholdsObj)) {
    const arms = [thresholdsObj.whenTrue, thresholdsObj.whenFalse].filter(ts.isObjectLiteralExpression);
    thresholdsObj = arms.length === 1 ? arms[0] : thresholdsObj;
  }
  if (!ts.isObjectLiteralExpression(thresholdsObj)) {
    throw new Error("VITEST_COVERAGE_THRESHOLDS_UNPARSEABLE: coverage.thresholds is not an object literal");
  }
  const thresholds = {};
  for (const prop of thresholdsObj.properties) {
    const key = ts.isPropertyAssignment(prop) ? propertyName(prop) : undefined;
    if (key === undefined) {
      throw new Error(`VITEST_COVERAGE_THRESHOLDS_UNPARSEABLE: entry \`${prop.getText(sf)}\` has no literal key`);
    }
    thresholds[key] = prop.initializer.getText(sf);
  }
  if (Object.keys(thresholds).length === 0) {
    throw new Error("VITEST_COVERAGE_THRESHOLDS_EMPTY: coverage.thresholds has no keys");
  }

  return { includes, thresholds };
}

function readVitestConfigOrExit(source, label) {
  try {
    return readVitestConfig(source);
  } catch (err) {
    console.error(`[check-vitest-coverage-include] FAILED (${label}):`);
    console.error(`  - ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Glob resolution (supports *, **, and {a,b} brace expansion)
// ---------------------------------------------------------------------------

/**
 * Expand brace patterns like {ts,tsx} into multiple patterns.
 * Only handles simple comma-separated alternatives (no nesting).
 */
function expandBraces(pattern) {
  const braceMatch = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (!braceMatch) return [pattern];
  const [, pre, inner, post] = braceMatch;
  return inner.split(",").map((alt) => `${pre}${alt.trim()}${post}`);
}

function globToRegex(pattern) {
  // Replace **/ with a token that matches zero or more path segments (with trailing /).
  // Replace /** at end with a token that matches any suffix including none.
  // Then replace remaining ** and * with appropriate patterns.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "__DSTAR_SLASH__")   // **/ -> zero-or-more-segments/
    .replace(/\/\*\*/g, "__SLASH_DSTAR__")   // /** -> /any-suffix
    .replace(/\*\*/g, "__DSTAR__")           // remaining **
    .replace(/\*/g, "[^/]*")
    .replace(/__DSTAR_SLASH__/g, "(.+/)?")  // **/ matches "" or "foo/bar/"
    .replace(/__SLASH_DSTAR__/g, "(/.*)?")  // /** matches "" or "/foo/bar"
    .replace(/__DSTAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function resolveGlob(pattern) {
  // Expand brace alternatives first
  const expanded = expandBraces(pattern);
  if (expanded.length > 1) {
    const all = [];
    for (const p of expanded) all.push(...resolveGlob(p));
    return all;
  }

  const re = globToRegex(pattern);
  const matches = [];
  function walk(dir, rel) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relPath);
      } else if (re.test(relPath)) {
        matches.push(relPath);
      }
    }
  }
  // Determine base directory from pattern (up to first wildcard or brace)
  const parts = pattern.split("/");
  let baseIdx = parts.findIndex((p) => p.includes("*") || p.includes("?") || p.includes("{"));
  if (baseIdx === -1) baseIdx = parts.length - 1;
  const baseDir = parts.slice(0, baseIdx).join("/") || ".";
  walk(resolve(ROOT, baseDir), baseDir === "." ? "" : baseDir);
  return matches;
}

// Threshold keys that configure the run rather than name files (vitest's
// resolveThresholds skips the same set).
const GLOBAL_THRESHOLD_KEYS = new Set(["lines", "branches", "functions", "statements", "perFile", "autoUpdate", "100"]);

// ---------------------------------------------------------------------------
// Read vitest.config.ts
// ---------------------------------------------------------------------------
let vitestSource = "";
try {
  const { readFileSync } = await import("node:fs");
  vitestSource = readFileSync(resolve(ROOT, "vitest.config.ts"), "utf8");
} catch (e) {
  console.error(`Cannot read vitest.config.ts: ${String(e)}`);
  process.exit(1);
}

const { includes, thresholds } = readVitestConfigOrExit(vitestSource, "vitest.config.ts");

const errors = [];
let resolvedIncludes = 0;
let resolvedThresholds = 0;

// Check 1: coverage.include entries resolve to >= 1 file
for (const entry of includes) {
  if (entry.includes("*") || entry.includes("?")) {
    const matches = resolveGlob(entry);
    if (matches.length === 0) {
      errors.push(`coverage.include glob "${entry}" matches no files`);
    } else {
      resolvedIncludes++;
    }
  } else {
    if (!existsSync(resolve(ROOT, entry))) {
      errors.push(`coverage.include path "${entry}" does not exist`);
    } else {
      resolvedIncludes++;
    }
  }
}

// Check 2: coverage.thresholds path keys must exist; glob keys must match a file
for (const [key] of Object.entries(thresholds)) {
  if (GLOBAL_THRESHOLD_KEYS.has(key)) {
    resolvedThresholds++;
    continue;
  }
  if (key.includes("*")) {
    if (resolveGlob(key).length === 0) {
      errors.push(`coverage.thresholds glob "${key}" matches no files`);
    } else {
      resolvedThresholds++;
    }
    continue;
  }
  if (!existsSync(resolve(ROOT, key))) {
    errors.push(`coverage.thresholds key "${key}" is a file path that does not exist`);
  } else {
    resolvedThresholds++;
  }
}

// Check 3: rename parity (optional)
let renameCount = 0;
if (enforceRenameParity) {
  let mainSource = "";
  try {
    mainSource = execSync("git show main:vitest.config.ts", { encoding: "utf8" });
  } catch {
    console.error("Cannot read main:vitest.config.ts for rename parity check");
    process.exit(1);
  }
  const { includes: mainIncludes, thresholds: mainThresholds } = readVitestConfigOrExit(mainSource, "main:vitest.config.ts");
  const mainIncludeSet = new Set(mainIncludes);
  const currentIncludeSet = new Set(includes);
  const addedIncludes = [...currentIncludeSet].filter((e) => !mainIncludeSet.has(e));
  const removedIncludes = [...mainIncludeSet].filter((e) => !currentIncludeSet.has(e));

  // Get git renames
  let nameStatusOut = "";
  try {
    // Use `-M main` (not `main...HEAD`) so uncommitted renames in the working
    // tree are visible to the pre-commit gate. Equivalent on CI.
    nameStatusOut = execSync("git diff --name-status -M main", { encoding: "utf8" });
  } catch {
    nameStatusOut = "";
  }
  const renames = new Map();
  for (const line of nameStatusOut.split("\n")) {
    const parts = line.split("\t");
    // Accept both R (rename) and C (copy-rename under diff.renames=copies)
    if (parts.length === 3 && (parts[0].startsWith("R") || parts[0].startsWith("C"))) {
      renames.set(parts[1], parts[2]);
    }
  }

  const usedRemoved = new Set();
  for (const added of addedIncludes) {
    // For each added glob/path, find a removed entry and a git mv
    const matchedRemoved = removedIncludes.find((r) => !usedRemoved.has(r) && renames.get(r) === added);
    if (!matchedRemoved) {
      errors.push(
        `coverage.include "${added}" was added without a corresponding git mv rename from a removed entry`
      );
    } else {
      usedRemoved.add(matchedRemoved);
      renameCount++;
    }
  }

  // Same for threshold keys (non-global only)
  const mainPathThresholds = Object.keys(mainThresholds).filter((k) => !GLOBAL_THRESHOLD_KEYS.has(k));
  const currentPathThresholds = Object.keys(thresholds).filter((k) => !GLOBAL_THRESHOLD_KEYS.has(k));
  const addedTh = currentPathThresholds.filter((k) => !mainPathThresholds.includes(k));
  const removedTh = mainPathThresholds.filter((k) => !currentPathThresholds.includes(k));

  for (const added of addedTh) {
    const matchedRemoved = removedTh.find((r) => renames.get(r) === added);
    if (!matchedRemoved) {
      errors.push(
        `coverage.thresholds key "${added}" was added without a corresponding git mv rename`
      );
    } else {
      renameCount++;
    }
  }
}

if (errors.length > 0) {
  console.error("[check-vitest-coverage-include] FAILED:");
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

const parityMsg = enforceRenameParity ? `, ${renameCount} renames validated` : "";
console.log(
  `vitest.config.ts OK: ${resolvedIncludes} includes resolved, ${resolvedThresholds} thresholds keyed${parityMsg}.`
);
