#!/usr/bin/env node
/**
 * Runs eslint.extension.config.mjs over the extension tree and fails closed on the
 * cases ESLint's own exit code does not cover.
 *
 * ESLint reports a lint error with exit 1 and a missing CLI path argument with exit
 * 2 — but a `files` glob that stops matching (a directory rename, a typo, a future
 * edit that drops the `extension/public` branch) produces **exit 0 with no output**
 * while real violations go unreported. Verified: mistyping `extension/src/**` to
 * `extensionx/src/**` greened the gate with four real violations in the tree. A gate
 * that is silent when it scanned nothing is indistinguishable from a gate that
 * scanned everything and found nothing, so the count is asserted here.
 *
 * `--max-warnings=0` matters independently: a file outside the config's base path is
 * reported as a *warning* with exit 0, so a cwd change would otherwise turn this
 * into a silent pass.
 *
 * Diagnostics (each fails closed with a distinct, greppable identifier):
 *   EMPTY_SCAN        — fewer than MIN_LINTED_FILES source files were linted
 *   MISSING_COVERAGE  — a required file was not among those linted
 *   LINT_ERRORS       — eslint reported problems
 *
 * EXT_LINT_CONFIG / EXT_LINT_TARGETS override the config and scan targets
 * (self-test only; scripts/__tests__/lint-extension.test.mjs).
 *
 * Run: node scripts/checks/lint-extension.mjs
 */

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CONFIG = process.env.EXT_LINT_CONFIG || "eslint.extension.config.mjs";
const TARGETS = (process.env.EXT_LINT_TARGETS || "extension/src extension/public")
  .split(/\s+/)
  .filter(Boolean);

// 62 production files today. The floor tolerates ordinary churn while catching a
// glob that has stopped matching — the failure this wrapper exists for.
const MIN_LINTED_FILES = 50;

// One representative file per `files` branch. Presence in the report is NOT enough:
// ESLint 9 matches .js files under an implicit default config, so a file dropped
// from our `files` globs still appears in the results with zero rules applied.
// Coverage is therefore checked with --print-config, which reports the RESOLVED
// rule set for that path.
//
// offscreen.js is the file the extension/public branch exists for: it receives the
// cleartext password (clipboard.ts:36-43 <- background/index.ts
// copyToClipboard(blob.password)).
const REQUIRED_COVERAGE = [
  "extension/public/offscreen.js",
  "extension/src/background/index.ts",
];

const REQUIRED_RULES = ["no-console", "no-restricted-syntax"];

function resolvedRules(filePath) {
  const r = spawnSync(
    "node",
    ["node_modules/eslint/bin/eslint.js", "--config", CONFIG, "--print-config", filePath],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout).rules ?? {};
  } catch {
    return null;
  }
}

/** ESLint reports a rule severity as the number 2 or the string "error". */
function isError(entry) {
  const severity = Array.isArray(entry) ? entry[0] : entry;
  return severity === 2 || severity === "error";
}

const eslint = spawnSync(
  "node",
  [
    "node_modules/eslint/bin/eslint.js",
    "--config",
    CONFIG,
    "--max-warnings=0",
    "--format",
    "json",
    ...TARGETS,
  ],
  { cwd: REPO_ROOT, encoding: "utf8" },
);

if (eslint.error) {
  console.error(`LINT_SPAWN_FAILED: ${eslint.error.message}`);
  process.exit(1);
}

let results;
try {
  results = JSON.parse(eslint.stdout);
} catch {
  // No parseable JSON means eslint died before producing a report (bad config,
  // missing path argument). Surface its own diagnostics rather than a parse error.
  console.error("LINT_NO_REPORT: eslint produced no JSON report");
  console.error(eslint.stdout.trim() || "(no stdout)");
  console.error(eslint.stderr.trim() || "(no stderr)");
  process.exit(1);
}

const linted = results.map((r) => r.filePath.replace(`${REPO_ROOT}/`, ""));
const failures = [];

if (linted.length < MIN_LINTED_FILES) {
  failures.push(
    `EMPTY_SCAN: linted ${linted.length} files under [${TARGETS.join(", ")}], ` +
      `expected at least ${MIN_LINTED_FILES} (did a files glob stop matching?)`,
  );
}

for (const required of REQUIRED_COVERAGE) {
  if (!linted.includes(required)) {
    failures.push(`MISSING_COVERAGE: ${required} was not linted`);
    continue;
  }
  const rules = resolvedRules(required);
  if (rules === null) {
    failures.push(`MISSING_COVERAGE: ${required} — could not resolve its config`);
    continue;
  }
  const missing = REQUIRED_RULES.filter((name) => !isError(rules[name]));
  if (missing.length > 0) {
    failures.push(
      `MISSING_COVERAGE: ${required} is matched by no rule-bearing config entry ` +
        `(${missing.join(", ")} not set to error) — did a files glob stop covering it?`,
    );
  }
}

const problems = results.flatMap((r) =>
  r.messages.map((m) => ({
    file: r.filePath.replace(`${REPO_ROOT}/`, ""),
    line: m.line,
    rule: m.ruleId ?? "(directive)",
    message: m.message,
  })),
);

if (problems.length > 0) {
  failures.push(`LINT_ERRORS: ${problems.length} problem(s)`);
  for (const p of problems) {
    failures.push(`  ${p.file}:${p.line}  ${p.rule}  ${p.message}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  `lint-extension: ${linted.length} files linted under [${TARGETS.join(", ")}], no console references outside the sanctioned sinks.`,
);
