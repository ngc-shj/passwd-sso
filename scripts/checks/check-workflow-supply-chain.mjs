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
  // Each alternative uses a single bounded character class (no overlapping
  // greedy groups) so the pattern is linear — no ReDoS surface on hostile
  // workflow content. `pulls\/[^\s]*\/merge` covers every `gh api … pulls/N/merge`
  // REST shape, so no separate `gh api …` alternative is needed. `merge-dependabot`
  // and `pulls.merge` cover the fastify action and github-script REST client.
  const mergeRe =
    /gh\s+pr\s+merge|--auto\b|enable-pull-request-automerge|enablePullRequestAutoMerge|merge-dependabot|pulls\.merge|pulls\/[^\s]*\/merge|pull-request\/merge/i;
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
  // Join shell line-continuations (`… \` + newline) into one logical line BEFORE
  // scanning, so a mask split across lines (`npm audit signatures \` / `  || true`)
  // is caught. Track the original 1-based line number of each logical line's start.
  const rawLines = content.split("\n");
  const logical = [];
  const indentOf = (s) => (s.match(/^\s*/)?.[0].length ?? 0);
  for (let i = 0; i < rawLines.length; i += 1) {
    let joined = rawLines[i];
    const start = i;
    // Block-scalar header: `>`/`|` then indentation- and chomping-indicators in
    // any order (`>2`, `|-`, `>2-`, `|+2`), then an optional trailing comment.
    const blockMatch = joined.match(/(^\s*)(?:-\s+)?run:\s*[>|][0-9+-]*\s*(#.*)?$/);
    if (blockMatch && i + 1 < rawLines.length) {
      const baseIndent = blockMatch[1].length;
      while (
        i + 1 < rawLines.length &&
        (rawLines[i + 1].trim() === "" || indentOf(rawLines[i + 1]) > baseIndent)
      ) {
        joined += " " + rawLines[i + 1].trim();
        i += 1;
      }
      logical.push({ text: joined, line: start + 1 });
      continue;
    }
    while (/\\\s*$/.test(joined) && i + 1 < rawLines.length) {
      joined = joined.replace(/\\\s*$/, " ") + rawLines[i + 1];
      i += 1;
    }
    logical.push({ text: joined, line: start + 1 });
  }
  // `dist\??\.attestations` tolerates optional chaining (`j?.dist?.attestations`
  // in the real release.yml assertion). `runsVerifier` is a WORKFLOW-level flag,
  // not per-line, so a `npm view` and an `attestations` reference on separate
  // lines still mark the workflow as verifier-running.
  const verifierLineRe = /audit\s+signatures|dist\??\.attestations/;
  const runsVerifier =
    /audit\s+signatures/.test(content) ||
    (/npm\s+view/.test(content) && /attestations/.test(content));
  // `:` needs a lookahead boundary (a trailing \b never matches after non-word `:`).
  const maskRe = /(\|\|\s*(true|exit\s+0|echo)|;\s*(true|exit\s+0)|\|\|\s*:(?=\s|$))/;
  for (const { text, line } of logical) {
    if (verifierLineRe.test(text) && maskRe.test(text)) {
      violations.push(
        `${name}:${line}: supply-chain verifier exit status is masked (|| true / ; true / || exit 0 / || : / || echo) — it must fail closed`,
      );
    }
  }
  // A workflow-level continue-on-error on a verifier-running workflow silently
  // downgrades a red verifier to a soft warning — including the `${{ true }}`
  // expression form and a bare `true`.
  if (runsVerifier && /continue-on-error:\s*(\$\{\{\s*)?true/i.test(content)) {
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

export function isTrustedPublishingNodeVersion(version) {
  const m = version.match(/^(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/);
  if (!m) return false;
  const major = Number(m[1]);
  if (major > 22) return true;
  if (major < 22) return false;
  // major === 22: need an explicit numeric minor >= 14 (bare `22`/`22.x`
  // resolves to the latest 22.x at runtime — not a reproducible >= 22.14).
  if (m[2] === undefined || m[2] === "x") return false;
  return Number(m[2]) >= 14;
}

function splitJobs(content) {
  const lines = content.split("\n");
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (jobsIdx === -1) return [];
  const jobs = [];
  let current = null;
  for (let i = jobsIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() !== "") break;
    const jobHeader = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/);
    if (jobHeader) {
      if (current) jobs.push(current);
      current = { name: jobHeader[1], text: line + "\n" };
    } else if (current) {
      current.text += line + "\n";
    }
  }
  if (current) jobs.push(current);
  return jobs;
}

export function findTrustedPublishNodeViolation(content, name) {
  if (!/npm\s+publish/.test(content)) return null;
  const jobs = splitJobs(content);
  const publishJobs = jobs.filter((j) => /npm\s+publish/.test(j.text));
  // Fall back to whole-file evaluation if job-splitting finds no publish job,
  // so the guard never silently passes on an unusual layout.
  const targets = publishJobs.length > 0 ? publishJobs : [{ name: "(file)", text: content }];
  for (const job of targets) {
    const versions = [...job.text.matchAll(/node-version:\s*["']?([\d.x]+)["']?/gi)].map(
      (mm) => mm[1],
    );
    if (!versions.some((v) => isTrustedPublishingNodeVersion(v))) {
      return `${name} (job '${job.name}'): runs 'npm publish' (Trusted Publishing) but does not pin an explicit node-version >= 22.14 in that job — OIDC publishing requires Node >= 22.14.0 (do not inherit the Node-20 .nvmrc)`;
    }
  }
  return null;
}

/**
 * Returns a violation string for any job that grants `id-token: write` and also
 * runs untrusted install/build code, else null. A job holding id-token:write can
 * mint an OIDC token (npm Trusted Publishing); GitHub permissions are job-scoped,
 * so ANY step in that job runs with that capability. Running `npm ci`, a build,
 * or `tsc` there lets a compromised dependency (via an install script or the
 * build) mint the publish token — the exact amplification the build/publish
 * split closes. The publish job must only download the pre-built tarball, verify
 * its digest, and `npm publish <tarball>` (a tarball spec runs no lifecycle
 * scripts). The pinned `npm install -g npm@X.Y.Z --ignore-scripts` is allowed —
 * it is the OIDC-capable npm itself and is script-suppressed and version-pinned.
 * @param {string} content
 * @param {string} name
 * @returns {string | null}
 */
export function findPublishJobIsolationViolation(content, name) {
  const jobs = splitJobs(content);
  const targets =
    jobs.length > 0 ? jobs : [{ name: "(file)", text: content }];
  // Forbidden install/build shapes inside an id-token:write job. `npm install -g
  // npm@...` (the toolchain bootstrap) is explicitly excluded — it is matched and
  // skipped below before the generic `npm install` rule applies.
  const forbidden = [
    { re: /\bnpm\s+ci\b/, label: "npm ci" },
    { re: /\bnpm\s+run\s+build\b/, label: "npm run build" },
    { re: /\bnpm\s+install\b/, label: "npm install" },
    { re: /\byarn\s+(install|add)\b/, label: "yarn install/add" },
    { re: /\bpnpm\s+(install|i|add)\b/, label: "pnpm install" },
    // Match `tsc`, `npx tsc`, and path-form invocations (`./node_modules/.bin/tsc`).
    { re: /\bnpx\s+tsc\b|(?:^|[\s/])tsc(?:\s|$)/m, label: "tsc" },
  ];
  const toolchainBootstrapRe = /\bnpm\s+install\s+-g\s+npm@[\d.]+/;
  // Match the actual permission grant only, on a non-comment line — a comment
  // like "# the only job with id-token:write" (which splitJobs attributes to the
  // preceding job) must not mark a job as OIDC-privileged.
  const grantsIdToken = (text) =>
    text.split("\n").some((l) => !/^\s*#/.test(l) && /id-token:\s*write/.test(l));
  for (const job of targets) {
    if (!grantsIdToken(job.text)) continue;
    for (const rawLine of job.text.split("\n")) {
      // Only inspect run-command content; a comment or an env value that merely
      // mentions "npm ci" must not trip the guard.
      const runMatch = rawLine.match(/^\s*(?:-\s+)?run:\s*(.*)$/);
      const line = runMatch ? runMatch[1] : rawLine;
      if (!runMatch && /^\s*#/.test(rawLine)) continue;
      // Allow the pinned toolchain bootstrap (`npm install -g npm@X.Y.Z`).
      const scrubbed = line.replace(toolchainBootstrapRe, "");
      for (const { re, label } of forbidden) {
        if (re.test(scrubbed)) {
          return `${name} (job '${job.name}'): a job with 'id-token: write' runs '${label}' — an OIDC-publish job must not install dependencies or build (a compromised dep could mint the publish token). Move the build to an unprivileged (contents:read) job and publish the pre-built tarball.`;
        }
      }
    }
  }
  return null;
}

function main() {
  const violations = [];
  for (const file of listWorkflowFiles()) {
    const content = readFileSync(file, "utf8");
    const autoMerge = findAutoMergeViolation(content, file);
    if (autoMerge) violations.push(autoMerge);
    const nodePin = findTrustedPublishNodeViolation(content, file);
    if (nodePin) violations.push(nodePin);
    const publishIsolation = findPublishJobIsolationViolation(content, file);
    if (publishIsolation) violations.push(publishIsolation);
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
