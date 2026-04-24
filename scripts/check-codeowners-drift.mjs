#!/usr/bin/env node
/**
 * CI guard: verify every must-have-owner path has matching CODEOWNERS coverage.
 *
 * Roster = list of globs enumerating files-that-must-have-owners.
 * Rule:   every file in the working tree matching any roster glob MUST match
 *         at least one CODEOWNERS rule.
 *
 * Semantics: a roster glob matching zero files is a trivial PASS (S19 Round 4).
 *            Only files present without a matching CODEOWNERS rule fail.
 *
 * Usage:
 *   node scripts/check-codeowners-drift.mjs
 *
 * Exit 0 = OK, Exit 1 = drift detected.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Must-have-owner roster (S10 expanded + S18 + S14).
// Uses POSIX-style glob patterns; evaluated via toRegex().
// ---------------------------------------------------------------------------
/** @type {ReadonlyArray<string>} */
const ROSTER_GLOBS = [
  // Security-sensitive src directories (existing CODEOWNERS-gated).
  "src/lib/auth/**",
  "src/lib/crypto/**",
  "src/lib/audit/**",
  "src/lib/tenant-rls.ts",
  "src/lib/tenant-context.ts",
  "src/lib/tenant/**",
  "src/lib/constants/auth/**",

  // Refactor-tool orchestrator + guards (stay at scripts/ root).
  "scripts/pre-pr.sh",
  "scripts/move-and-rewrite-imports.mjs",
  "scripts/verify-move-only-diff.mjs",
  "scripts/verify-allowlist-rename-only.mjs",
  "scripts/refactor-phase-verify.mjs",
  "scripts/check-codeowners-drift.mjs",
  "scripts/check-blame-ignore-revs.mjs",

  // Env allowlist governance (Step 8, SEC-4).
  "scripts/env-allowlist.ts",

  // Check scripts (pre-PR-2 at scripts/ root; post-PR-2 at scripts/checks/).
  // Both globs listed. Whichever matches files on disk is the authoritative one.
  "scripts/check-*.mjs",
  "scripts/checks/**",

  // CI + repo-governance files.
  ".github/workflows/**",
  ".github/CODEOWNERS",
  ".git-blame-ignore-revs",
  ".trivyignore",
];

// ---------------------------------------------------------------------------
// POSIX-glob → RegExp (gitignore-like, limited subset).
// Handles: `*` (not crossing `/`), `**` (any depth), `?` (single char).
// ---------------------------------------------------------------------------
function globToRegex(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` consumes any characters including `/`; optionally also eat the
        // following `/` so `a/**/b` matches `a/b`.
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

// ---------------------------------------------------------------------------
// CODEOWNERS parser — produces an array of { re, owners }.
// Only rules with at least one owner are returned.
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} OwnerRule
 * @property {RegExp} re
 * @property {string[]} owners
 * @property {string} raw
 */

/** @returns {OwnerRule[]} */
function parseCodeowners(content) {
  /** @type {OwnerRule[]} */
  const rules = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.replace(/#.*$/, "").trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const pattern = parts[0];
    const owners = parts.slice(1).filter((s) => s.startsWith("@"));
    if (owners.length === 0) continue;

    // Normalize pattern: a leading `/` anchors to repo root; otherwise any
    // path-component match is allowed. A trailing `/` matches directories.
    let glob = pattern;
    if (glob.startsWith("/")) glob = glob.slice(1);
    // Trailing `/` → match directory contents.
    if (glob.endsWith("/")) glob = glob + "**";
    rules.push({ re: globToRegex(glob), owners, raw: pattern });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Walk the working tree and collect every file relative to ROOT.
// Skips node_modules, .git, dist, .next, build artifacts, etc.
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "coverage",
  "test-results",
  ".claude",
]);

function walkFiles(dir, rel, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, out);
    } else if (entry.isFile()) {
      out.push(rel ? `${rel}/${entry.name}` : entry.name);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export function checkDrift({ rosterGlobs = ROSTER_GLOBS, repoRoot = ROOT } = {}) {
  const codeownersPath = resolve(repoRoot, ".github/CODEOWNERS");
  let codeownersContent = "";
  try {
    codeownersContent = readFileSync(codeownersPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ok: false, errors: [`.github/CODEOWNERS not found at ${codeownersPath}`] };
    }
    throw err;
  }
  const rules = parseCodeowners(codeownersContent);
  const rosterREs = rosterGlobs.map((g) => ({ glob: g, re: globToRegex(g) }));

  /** @type {string[]} */
  const allFiles = [];
  walkFiles(repoRoot, "", allFiles);

  /** @type {string[]} */
  const uncovered = [];
  for (const file of allFiles) {
    const inRoster = rosterREs.some((r) => r.re.test(file));
    if (!inRoster) continue;
    const hasOwner = rules.some((rule) => rule.re.test(file));
    if (!hasOwner) uncovered.push(file);
  }
  return { ok: uncovered.length === 0, uncovered };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, uncovered, errors } = checkDrift();
  if (errors && errors.length > 0) {
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  if (!ok) {
    console.error("check-codeowners-drift FAILED:");
    for (const file of uncovered) {
      console.error(`  no matching CODEOWNERS rule: ${file}`);
    }
    process.exit(1);
  }
  console.log(
    `check-codeowners-drift OK: all roster paths have matching CODEOWNERS rules.`
  );
}

// Exports for testing.
export { globToRegex, parseCodeowners, ROSTER_GLOBS };
