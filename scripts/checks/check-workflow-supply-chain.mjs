#!/usr/bin/env node
/**
 * CI guard: supply-chain workflow invariants.
 *
 *  1. No Dependabot auto-merge. Auto-merging an upstream version bump into a
 *     password manager treats an untrusted upstream as trusted (tests do not
 *     detect a supply-chain payload — event-stream/ua-parser-js/xz were all
 *     patch/minor bumps that passed tests). Human review must stay required, so
 *     no workflow may pair a `dependabot` context with an auto-merge command.
 *
 *  2. A supply-chain verifier (`npm audit signatures`, or the post-publish
 *     provenance assertion `npm view … dist.attestations`) must never be
 *     exit-masked. A verifier behind `|| true` / `; true` / `|| exit 0` /
 *     `continue-on-error` is theater — a real tamper would be swallowed.
 *
 * PRIMARY control note: `/.github/workflows/` is CODEOWNERS-gated to @ngc-shj,
 * so ANY new auto-merge or verifier-masking workflow — in any shape — already
 * requires owner review to land. These regex checks are DEFENSE-IN-DEPTH: they
 * catch the common shapes fast in `pre-pr.sh`, but a per-file grep cannot see a
 * cross-file reusable-workflow auto-merge split, so CODEOWNERS is the backstop.
 *
 * The detection logic is exported as pure functions so it can be unit-tested
 * with synthetic inputs (RT7 — the guard must be provably able to fail).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS_DIR = ".github/workflows";

/**
 * Returns a violation string if the workflow content pairs a dependabot context
 * with an auto-merge command, else null. Covers the documented Dependabot
 * auto-merge shapes; a cross-file reusable-workflow split is out of a per-file
 * grep's reach and is backstopped by CODEOWNERS (see header).
 * @param {string} content
 * @param {string} name
 * @returns {string | null}
 */
export function findAutoMergeViolation(content, name) {
  const mentionsDependabot = /dependabot/i.test(content);
  if (!mentionsDependabot) return null;
  const mergeRe =
    /gh\s+pr\s+merge|--auto\b|enable-pull-request-automerge|enablePullRequestAutoMerge|gh\s+api[^\n]*pulls\/[^\n]*\/merge|pulls\/[^\s]*\/merge|pull-request\/merge/i;
  if (mergeRe.test(content)) {
    return `${name}: workflow references 'dependabot' and an auto-merge command — Dependabot auto-merge is forbidden (human review required)`;
  }
  return null;
}

/**
 * Returns violation strings for any supply-chain verifier — `npm audit
 * signatures` or the post-publish provenance assertion (`npm view` reading
 * `dist.attestations`) — whose exit status is masked (|| true / ; true /
 * || exit 0 / || : / || echo), or a step-level `continue-on-error: true`
 * anywhere in a workflow that runs such a verifier.
 * @param {string} content
 * @param {string} name
 * @returns {string[]}
 */
export function findMaskedVerifierViolations(content, name) {
  const violations = [];
  const lines = content.split("\n");
  const verifierRe = /audit\s+signatures|npm\s+view[^\n]*attestations|dist\.attestations/;
  const maskRe = /(\|\|\s*(true|:|exit\s+0|echo)|;\s*(true|exit\s+0))\b/;
  let runsVerifier = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (verifierRe.test(line)) {
      runsVerifier = true;
      if (maskRe.test(line)) {
        violations.push(
          `${name}:${i + 1}: supply-chain verifier exit status is masked (|| true / ; true / || exit 0 / || echo) — it must fail closed`,
        );
      }
    }
  }
  // A workflow-level continue-on-error on a verifier-running workflow silently
  // downgrades a red verifier to a soft warning.
  if (runsVerifier && /continue-on-error:\s*true/i.test(content)) {
    violations.push(
      `${name}: a verifier-running workflow sets 'continue-on-error: true' — remove it so the verifier fails closed`,
    );
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
