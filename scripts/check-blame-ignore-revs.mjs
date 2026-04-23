#!/usr/bin/env node
/**
 * CI guard: verify every SHA in .git-blame-ignore-revs is a refactor move commit.
 *
 * Two-tier rule (Round 4 S16 fix + R100-only refinement):
 *   - Renamed entries (`R<score>\t<old>\t<new>`): score MUST equal 100.
 *   - Modified / Added / Deleted entries: allowed ONLY if path matches
 *     ALLOWED_MA_PATHS (refactor-tool-adjacent + import-rewrite consumers).
 *   - Each commit MUST have >= 1 R100 entry.
 *
 * Validated empirically against PR #392 phase commits (f4dac457, 243cfc0e).
 *
 * Usage:
 *   node scripts/check-blame-ignore-revs.mjs
 *
 * Exit 0 = OK, Exit 1 = violation.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Allowlist for M / A / D entries in move commits.
// Covers: refactor-tool self-updates, phase-config JSON, import rewrites
// across consumers, doc updates, CI workflow path rewrites.
// ---------------------------------------------------------------------------
/** @type {ReadonlyArray<RegExp>} */
const ALLOWED_MA_PATHS = [
  // Script self-updates / allowlist rewrites (pre- and post-PR-2 layout).
  /^scripts\/check-[^/]+\.mjs$/,
  /^scripts\/checks\/[^/]+\.(mjs|sh)$/,
  /^scripts\/verify-[^/]+\.mjs$/,
  /^scripts\/refactor-phase-verify\.mjs$/,
  /^scripts\/move-and-rewrite-imports\.mjs$/,
  /^scripts\/pre-pr\.sh$/,
  // F31: manual-tests consumer imports (existing SHA 243cfc0e).
  /^scripts\/manual-tests\/.+\.ts$/,
  // F31 follow-up: scripts/__tests__/*.test.mjs — test consumer import rewrites
  // (verified against existing SHAs d29020df, 66c5c1db).
  /^scripts\/__tests__\/.+\.(mjs|ts)$/,
  /^scripts\/__tests__\/fixtures\/.+$/,
  // Generic scripts consumers (pre-pr.sh, audit-outbox-worker.ts, etc.).
  /^scripts\/[^/]+\.(sh|mjs|ts)$/,

  // Phase-config JSON added in the same commit as the move.
  /^docs\/archive\/review\/phases\/.+\.json$/,
  // The SHA list itself (move commit appends its own SHA).
  /^\.git-blame-ignore-revs$/,

  // Coverage config and workflow/CODEOWNERS path-filter rewrites.
  /^vitest\.config\.ts$/,
  /^vitest\.integration\.config\.ts$/,
  /^\.github\/workflows\/.+\.yml$/,
  /^\.github\/CODEOWNERS$/,

  // Import-rewrite consumers under src/** (any depth).
  /^src\/[^/]+.*\.(ts|tsx|mjs|js)$/,
  // F31: e2e helpers/tests consumer imports (existing SHA 243cfc0e).
  /^e2e\/.+\.(ts|tsx)$/,

  // Doc rewrites.
  /^CLAUDE\.md$/,
  /^README\.md$/,
  /^README\.ja\.md$/,
  /^CHANGELOG\.md$/,
  /^CONTRIBUTING\.md$/,
  /^docs\/.+\.md$/,
  /^SECURITY\.md$/,

  // Root-level config files touched by codemod path-alias rewrites
  // (Round 4 S20 deferral — included here to avoid PR 2 self-fail on package.json).
  /^proxy\.ts$/,
  /^next\.config\.ts$/,
  /^sentry\..+\.config\.ts$/,
  /^instrumentation-client\.ts$/,
  /^prisma\.config\.ts$/,
  /^postcss\.config\.mjs$/,
  /^eslint\.config\.mjs$/,
  /^package(-lock)?\.json$/,
  /^tsconfig\.json$/,
];

// ---------------------------------------------------------------------------
// Parse .git-blame-ignore-revs: lines of `<sha> [# comment]`.
// ---------------------------------------------------------------------------
export function parseIgnoreRevs(content) {
  /** @type {Array<{sha: string, comment: string}>} */
  const entries = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([0-9a-f]{7,40})(?:\s+#(.*))?$/i);
    if (!match) continue;
    entries.push({ sha: match[1], comment: (match[2] || "").trim() });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Parse `git show --name-status -M100% <sha>` output.
// Output format per changed file (tab-separated):
//   M\t<path>
//   A\t<path>
//   D\t<path>
//   R<score>\t<old>\t<new>   # e.g. R100, R095
//   C<score>\t<old>\t<new>   # copy (treat same as rename for this check)
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} FileStatus
 * @property {"R" | "M" | "A" | "D" | "C"} kind
 * @property {number|null} score  // only for R/C
 * @property {string} path        // for R/C this is the NEW path
 * @property {string|null} oldPath  // for R/C
 */

/** @returns {FileStatus[]} */
export function parseNameStatus(output) {
  /** @type {FileStatus[]} */
  const entries = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parts = line.split("\t");
    const status = parts[0];
    if (!status) continue;
    if (/^[RC](\d{1,3})$/.test(status)) {
      const kind = status[0];
      const score = parseInt(status.slice(1), 10);
      const oldPath = parts[1];
      const path = parts[2];
      if (oldPath && path) {
        entries.push({
          kind: /** @type {"R" | "C"} */ (kind),
          score,
          path,
          oldPath,
        });
      }
    } else if (/^[MAD]$/.test(status)) {
      const path = parts[1];
      if (path) {
        entries.push({
          kind: /** @type {"M" | "A" | "D"} */ (status),
          score: null,
          path,
          oldPath: null,
        });
      }
    }
    // Ignore unknown statuses (e.g., T, U, X) — not expected in move commits.
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Apply the two-tier rule to a parsed entry list.
// Returns { ok: boolean, violations: string[] }.
// ---------------------------------------------------------------------------
export function evaluateCommit(sha, entries, allowedPaths = ALLOWED_MA_PATHS) {
  /** @type {string[]} */
  const violations = [];
  let r100Count = 0;
  for (const e of entries) {
    if (e.kind === "R" || e.kind === "C") {
      if (e.score !== 100) {
        violations.push(
          `${sha}: ${e.kind}${e.score} (must be 100): ${e.oldPath} -> ${e.path}`
        );
      } else {
        r100Count++;
      }
    } else {
      // M / A / D — allowlist only.
      const matched = allowedPaths.some((re) => re.test(e.path));
      if (!matched) {
        violations.push(`${sha}: ${e.kind} ${e.path} (not in ALLOWED_MA_PATHS)`);
      }
    }
  }
  if (r100Count === 0) {
    violations.push(`${sha}: zero R100 rename entries (must have >= 1)`);
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
/**
 * @param {Object} [options]
 * @param {string} [options.repoRoot]
 * @param {(sha: string) => string} [options.runGitShow] for tests
 */
export function checkBlameIgnoreRevs({ repoRoot = ROOT, runGitShow } = {}) {
  const ignoreRevsPath = resolve(repoRoot, ".git-blame-ignore-revs");
  if (!existsSync(ignoreRevsPath)) {
    return { ok: false, violations: [`.git-blame-ignore-revs not found`] };
  }
  const content = readFileSync(ignoreRevsPath, "utf8");
  const entries = parseIgnoreRevs(content);
  if (entries.length === 0) {
    // Empty list is vacuously OK.
    return { ok: true, violations: [], checked: 0 };
  }

  const doGitShow =
    runGitShow ??
    ((sha) =>
      execFileSync(
        "git",
        ["show", "--name-status", "-M100%", "--format=", sha],
        { cwd: repoRoot, encoding: "utf8" }
      ));

  /** @type {string[]} */
  const allViolations = [];
  let checked = 0;
  for (const { sha } of entries) {
    let output;
    try {
      output = doGitShow(sha);
    } catch (err) {
      allViolations.push(
        `${sha}: git show failed (commit may not be reachable): ${err.message}`
      );
      continue;
    }
    const parsed = parseNameStatus(output);
    const { violations } = evaluateCommit(sha, parsed);
    allViolations.push(...violations);
    checked++;
  }

  return { ok: allViolations.length === 0, violations: allViolations, checked };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, violations, checked } = checkBlameIgnoreRevs();
  if (!ok) {
    console.error("check-blame-ignore-revs FAILED:");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log(`check-blame-ignore-revs OK: ${checked} SHAs validated (R100-only renames + allowlisted M/A/D).`);
}

export { ALLOWED_MA_PATHS };
