#!/usr/bin/env node
/**
 * Meta-orchestrator: runs all check-*.mjs and verify-*.mjs scripts against
 * the current tree. Intended for merge-queue CI on refactor/* branches.
 *
 * Usage:
 *   node scripts/refactor-phase-verify.mjs [--force] [--verbose]
 *
 * --force    Run even when not on a refactor/* branch.
 * --verbose  Print each command before running it.
 *
 * Stale-branch guard:
 *   Reads expected base SHA from env var EXPECTED_MAIN_SHA or the file
 *   .refactor-phase-verify-baseline (one-line SHA).
 *   If the file is absent and EXPECTED_MAIN_SHA is unset (first run),
 *   the current origin/main SHA is recorded as the baseline and the check
 *   passes. On subsequent runs the recorded SHA is compared.
 *
 * Exit 0 = all OK, Exit 1 = any failure.
 */

import { spawnSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BASELINE_FILE = ".refactor-phase-verify-baseline";

/** @returns {string} current branch name */
function currentBranch() {
  return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
}

/** @returns {string} SHA of origin/main after fetch */
function fetchOriginMainSha() {
  spawnSync("git", ["fetch", "origin", "main", "--no-tags"], { stdio: "inherit" });
  return execSync("git rev-parse origin/main", { encoding: "utf8" }).trim();
}

/**
 * @param {string} label
 * @param {string[]} cmd
 * @param {boolean} verbose
 * @returns {{ ok: boolean; ms: number }}
 */
function runScript(label, cmd, verbose) {
  if (verbose) {
    console.log(`\n  $ ${cmd.join(" ")}`);
  }
  const start = Date.now();
  const result = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  const ms = Date.now() - start;
  const ok = result.status === 0 && result.error == null;
  return { ok, ms };
}

const args = process.argv.slice(2);
const forceFlag = args.includes("--force");
const verboseFlag = args.includes("--verbose");

// Branch guard
const currentBranchName = currentBranch();
if (!forceFlag && !/^refactor\//.test(currentBranchName)) {
  console.log("Not on refactor branch — skipping refactor-phase-verify.");
  process.exit(0);
}

// Stale-branch guard
const originSha = fetchOriginMainSha();
const envSha = process.env["EXPECTED_MAIN_SHA"] ?? "";
let expectedSha = envSha;

// Read the baseline directly and fall through to first-run on ENOENT.
// Avoids the TOCTOU race between existsSync() and readFileSync()
// (CodeQL: js/file-system-race).
if (!expectedSha) {
  try {
    expectedSha = readFileSync(BASELINE_FILE, "utf8").trim();
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // First run: record current SHA as baseline
    writeFileSync(BASELINE_FILE, originSha + "\n", "utf8");
    console.log(`refactor-phase-verify: baseline recorded (${originSha}).`);
    expectedSha = originSha;
  }
}

if (originSha !== expectedSha) {
  console.error(
    `Branch is stale vs origin/main.\n` +
      `  expected: ${expectedSha}\n` +
      `  current:  ${originSha}\n` +
      `Rebase and re-run.`
  );
  process.exit(1);
}

// Parallel-branch guard: fail if another refactor/* PR is open.
function checkParallelRefactorBranches() {
  try {
    const output = execSync(
      "gh pr list --state open --json headRefName --jq '.[].headRefName'",
      { encoding: "utf8" }
    );
    const openBranches = output.split("\n").filter((b) => b.startsWith("refactor/"));
    const currentBranch = currentBranchName;
    const others = openBranches.filter((b) => b !== currentBranch);
    if (others.length > 0) {
      console.error(
        `Parallel refactor branches detected (must be serialized):\n  ${others.join("\n  ")}\n` +
          `Current: ${currentBranch}. Merge or close other refactor/* PRs first.`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      `Warning: could not check parallel refactor branches via \`gh pr list\`: ${err.message}`
    );
    console.warn(`  Proceeding anyway — verify manually that no other refactor/* PRs are open.`);
    return true; // Don't block if gh is unavailable
  }
}

if (!checkParallelRefactorBranches()) {
  process.exit(1);
}

// Script definitions
/** @type {Array<{ label: string; cmd: string[] }>} */
const scripts = [
  { label: "check-team-auth-rls",                cmd: ["node", "scripts/checks/check-team-auth-rls.mjs"] },
  { label: "check-bypass-rls",                   cmd: ["node", "scripts/checks/check-bypass-rls.mjs"] },
  { label: "check-crypto-domains",               cmd: ["node", "scripts/checks/check-crypto-domains.mjs"] },
  { label: "check-migration-drift",              cmd: ["node", "scripts/checks/check-migration-drift.mjs"] },
  { label: "verify-allowlist-rename-only",       cmd: ["node", "scripts/verify-allowlist-rename-only.mjs"] },
  // Scope to src/** only: scripts/checks/* moves legitimately bump ROOT path
  // derivation (+1 level) which verify-move-only-diff cannot distinguish from
  // business-logic drift. Src code changes remain fully guarded.
  { label: "verify-move-only-diff",              cmd: ["node", "scripts/verify-move-only-diff.mjs", "--glob", "src/**"] },
  { label: "check-vitest-coverage-include",      cmd: ["node", "scripts/checks/check-vitest-coverage-include.mjs", "--enforce-rename-parity"] },
  { label: "check-doc-paths",                    cmd: ["node", "scripts/checks/check-doc-paths.mjs"] },
  { label: "check-mjs-imports",                  cmd: ["node", "scripts/checks/check-mjs-imports.mjs"] },
  { label: "check-dynamic-import-specifiers (src/lib)",        cmd: ["node", "scripts/checks/check-dynamic-import-specifiers.mjs", "--old-prefix", "src/lib"] },
  { label: "check-dynamic-import-specifiers (src/hooks)",      cmd: ["node", "scripts/checks/check-dynamic-import-specifiers.mjs", "--old-prefix", "src/hooks"] },
  { label: "check-dynamic-import-specifiers (src/components/passwords)", cmd: ["node", "scripts/checks/check-dynamic-import-specifiers.mjs", "--old-prefix", "src/components/passwords"] },
  { label: "check-dynamic-import-specifiers (src/components/settings)",  cmd: ["node", "scripts/checks/check-dynamic-import-specifiers.mjs", "--old-prefix", "src/components/settings"] },
  { label: "check-dynamic-import-specifiers (src/components/team)",      cmd: ["node", "scripts/checks/check-dynamic-import-specifiers.mjs", "--old-prefix", "src/components/team"] },
  { label: "check-codeowners-drift",             cmd: ["node", "scripts/check-codeowners-drift.mjs"] },
  { label: "check-blame-ignore-revs",            cmd: ["node", "scripts/check-blame-ignore-revs.mjs"] },
];

console.log(`\n${"═".repeat(50)}`);
console.log(`refactor-phase-verify — ${scripts.length} scripts`);
console.log(`${"═".repeat(50)}\n`);

/** @type {Array<{ label: string; ok: boolean; ms: number }>} */
const results = [];

for (const { label, cmd } of scripts) {
  console.log(`▸ ${label}`);
  const { ok, ms } = runScript(label, cmd, verboseFlag);
  results.push({ label, ok, ms });
  if (!ok) {
    console.error(`\n✗ ${label} FAILED — halting.\n`);
    break;
  }
  console.log(`  ✓ ${label} (${ms}ms)\n`);
}

// Summary table
console.log(`${"─".repeat(70)}`);
console.log(`${"SCRIPT".padEnd(55)} ${"STATUS".padEnd(8)} TIME`);
console.log(`${"─".repeat(70)}`);
for (const { label, ok, ms } of results) {
  const status = ok ? "PASS" : "FAIL";
  console.log(`${label.padEnd(55)} ${status.padEnd(8)} ${ms}ms`);
}
// If we halted early, list not-run scripts
const ran = new Set(results.map((r) => r.label));
for (const { label } of scripts) {
  if (!ran.has(label)) {
    console.log(`${label.padEnd(55)} ${"SKIP".padEnd(8)} -`);
  }
}
console.log(`${"─".repeat(70)}`);

const passed = results.filter((r) => r.ok).length;
const total = scripts.length;
const anyFailed = results.some((r) => !r.ok);

if (anyFailed) {
  console.error(`\n✗ refactor-phase-verify FAILED: ${passed}/${total} scripts passed.\n`);
  process.exit(1);
}

console.log(`\n✓ refactor-phase-verify OK: ${passed}/${total} scripts passed.\n`);
process.exit(0);
