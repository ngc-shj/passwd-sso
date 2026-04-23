#!/usr/bin/env node
/**
 * CI guard: validate vitest.config.ts coverage paths.
 *
 * Usage:
 *   node scripts/check-vitest-coverage-include.mjs [--enforce-rename-parity]
 *
 * --enforce-rename-parity  When set, also check that every new coverage.include
 *                          entry and threshold key added vs main corresponds to
 *                          a git mv rename in the same PR.
 *
 * Checks:
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

// PR 2: moved from scripts/ to scripts/checks/ — bump one extra level up.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const enforceRenameParity = process.argv.includes("--enforce-rename-parity");

// ---------------------------------------------------------------------------
// Extract coverage.include and coverage.thresholds from vitest.config.ts
// using a regex-based parser (the config is stable in structure).
//
// Strategy: locate the coverage: { ... } block first, then parse its
// include array and thresholds object. This avoids confusing test.include
// with coverage.include.
// ---------------------------------------------------------------------------
function readVitestConfig(source) {
  const includes = [];
  const thresholds = {};

  // Locate coverage: { ... } block by finding "coverage:" and then
  // bracket-counting to extract the full object body.
  const coverageStart = source.indexOf("coverage:");
  if (coverageStart === -1) return { includes, thresholds };

  let depth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;
  for (let i = coverageStart; i < source.length; i++) {
    if (source[i] === "{") {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  if (bodyStart === -1 || bodyEnd === -1) return { includes, thresholds };

  const coverageBody = source.slice(bodyStart, bodyEnd);

  // Extract include: [ ... ] within coverage body (first occurrence only)
  const includeMatch = coverageBody.match(/\binclude:\s*\[([\s\S]*?)\]/);
  if (includeMatch) {
    const block = includeMatch[1];
    const entryRe = /["']([^"']+)["']/g;
    let m;
    while ((m = entryRe.exec(block)) !== null) {
      includes.push(m[1]);
    }
  }

  // Extract thresholds: { ... } within coverage body
  const threshIdx = coverageBody.indexOf("thresholds:");
  if (threshIdx !== -1) {
    let td = 0;
    let ts = -1;
    let te = -1;
    for (let i = threshIdx; i < coverageBody.length; i++) {
      if (coverageBody[i] === "{") {
        if (td === 0) ts = i + 1;
        td++;
      } else if (coverageBody[i] === "}") {
        td--;
        if (td === 0) { te = i; break; }
      }
    }
    if (ts !== -1 && te !== -1) {
      const block = coverageBody.slice(ts, te);
      // Path-keyed entries: "src/lib/foo.ts": { lines: 80 }
      const pathKeyRe = /"([^"]+)":\s*\{([^}]*)\}/g;
      let m;
      while ((m = pathKeyRe.exec(block)) !== null) {
        thresholds[m[1]] = m[2].trim();
      }
      // Global numeric thresholds: lines: 60
      const globalKeyRe = /^\s*(lines|branches|functions|statements):\s*(\d+)/gm;
      while ((m = globalKeyRe.exec(block)) !== null) {
        thresholds[m[1]] = m[2];
      }
    }
  }

  return { includes, thresholds };
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

// Global threshold keys (not file paths)
const GLOBAL_THRESHOLD_KEYS = new Set(["lines", "branches", "functions", "statements"]);

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

const { includes, thresholds } = readVitestConfig(vitestSource);

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

// Check 2: coverage.thresholds file-path keys must exist
for (const [key] of Object.entries(thresholds)) {
  if (GLOBAL_THRESHOLD_KEYS.has(key)) {
    resolvedThresholds++;
    continue;
  }
  // Treat as file path
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
  const { includes: mainIncludes, thresholds: mainThresholds } = readVitestConfig(mainSource);
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
