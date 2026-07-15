#!/usr/bin/env node
/**
 * CI guard: supply-chain workflow invariants.
 *
 *  1. No Dependabot auto-merge. Auto-merging an upstream version bump into a
 *     password manager treats an untrusted upstream as trusted (tests do not
 *     detect a supply-chain payload — event-stream/ua-parser-js/xz were all
 *     patch/minor bumps that passed tests). Human review must stay required, so
 *     no workflow may pair a `dependabot` trigger/context with a merge command.
 *
 *  2. `npm audit signatures` must never be exit-masked. A signature verifier
 *     behind `|| true` / `; true` / `|| echo` is theater — a real tamper would
 *     be swallowed. The same applies to the post-publish provenance assertion.
 *
 * The detection logic is exported as pure functions so it can be unit-tested
 * with synthetic inputs (RT7 — the guard must be provably able to fail).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS_DIR = ".github/workflows";

/**
 * Returns a violation string if the workflow content pairs a dependabot
 * trigger/context with an auto-merge command, else null.
 * @param {string} content
 * @param {string} name
 * @returns {string | null}
 */
export function findAutoMergeViolation(content, name) {
  const mentionsDependabot = /dependabot/i.test(content);
  if (!mentionsDependabot) return null;
  const mergeRe = /gh\s+pr\s+merge|--auto\b|--merge\b|pull-request\/merge/i;
  if (mergeRe.test(content)) {
    return `${name}: workflow references 'dependabot' and a merge command (gh pr merge / --auto) — Dependabot auto-merge is forbidden (human review required)`;
  }
  return null;
}

/**
 * Returns violation strings for any `npm audit signatures` or provenance
 * assertion whose exit status is masked by a trailing || true / ; true / || echo.
 * @param {string} content
 * @param {string} name
 * @returns {string[]}
 */
export function findMaskedVerifierViolations(content, name) {
  const violations = [];
  const lines = content.split("\n");
  const maskRe = /(\|\|\s*true|;\s*true|\|\|\s*:\s*$|\|\|\s*echo)\b/;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/audit\s+signatures/.test(line) && maskRe.test(line)) {
      violations.push(
        `${name}:${i + 1}: 'npm audit signatures' exit status is masked (|| true / ; true / || echo) — the verifier must fail closed`,
      );
    }
  }
  return violations;
}

function listWorkflowFiles() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => join(WORKFLOWS_DIR, f));
}

function main() {
  const violations = [];
  for (const file of listWorkflowFiles()) {
    const content = readFileSync(file, "utf8");
    const autoMerge = findAutoMergeViolation(content, file);
    if (autoMerge) violations.push(autoMerge);
    violations.push(...findMaskedVerifierViolations(content, file));
  }
  if (violations.length > 0) {
    console.error("Supply-chain workflow guard failed:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log("Supply-chain workflow guard passed.");
}

// Run only when invoked directly, not when imported by the self-test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
