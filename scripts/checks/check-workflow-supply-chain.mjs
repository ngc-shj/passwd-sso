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

/**
 * Whether a node-version string clears the npm Trusted Publishing FLOOR (Node
 * >= 22.14). This is a lower-bound check only — it deliberately accepts floating
 * forms like `24` / `24.x`, because any 24.x meets the floor. It is NOT the
 * exact-pin invariant: the requirement that release.yml pin an exact Node patch
 * (so the bundled npm is deterministic) is a separate, stricter concern owned by
 * scripts/checks/check-publish-toolchain.sh. Do not tighten this helper to
 * require an exact patch — other publish workflows may legitimately floor-check
 * with `24.x`, and the exact-pin enforcement belongs in the toolchain gate.
 */
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

/**
 * Parses top-level workflow `env:` string entries into a name→value map, so a
 * `node-version: ${{ env.PUBLISH_NODE_VERSION }}` reference can be resolved to
 * its literal value. Only the top-level env block (before `jobs:`) is read.
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseTopLevelEnv(content) {
  const lines = content.split("\n");
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  const head = jobsIdx === -1 ? lines : lines.slice(0, jobsIdx);
  const envIdx = head.findIndex((l) => /^env:\s*(#.*)?$/.test(l));
  const map = {};
  if (envIdx === -1) return map;
  for (let i = envIdx + 1; i < head.length; i += 1) {
    const line = head[i];
    if (/^\S/.test(line) && line.trim() !== "") break; // dedent → end of block
    const m = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

export function findTrustedPublishNodeViolation(content, name) {
  if (!/npm\s+publish/.test(content)) return null;
  const env = parseTopLevelEnv(content);
  const jobs = splitJobs(content);
  const publishJobs = jobs.filter((j) => /npm\s+publish/.test(j.text));
  // Fall back to whole-file evaluation if job-splitting finds no publish job,
  // so the guard never silently passes on an unusual layout.
  const targets = publishJobs.length > 0 ? publishJobs : [{ name: "(file)", text: content }];
  for (const job of targets) {
    // Resolve `node-version: ${{ env.X }}` references against the top-level env
    // before matching, so a pinned patch declared in env still counts.
    const resolved = job.text.replace(
      /node-version:\s*\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gi,
      (whole, key) => (env[key] ? `node-version: "${env[key]}"` : whole),
    );
    const versions = [...resolved.matchAll(/node-version:\s*["']?([\d.x]+)["']?/gi)].map(
      (mm) => mm[1],
    );
    if (!versions.some((v) => isTrustedPublishingNodeVersion(v))) {
      return `${name} (job '${job.name}'): runs 'npm publish' (Trusted Publishing) but does not pin an explicit node-version >= 22.14 in that job — OIDC publishing requires Node >= 22.14.0 (do not inherit the Node-20 .nvmrc)`;
    }
  }
  return null;
}

/**
 * Extracts the shell command text of every `run:` step in a block of YAML,
 * as a flat list of individual command lines. Handles all three run forms:
 *   - inline: `run: npm ci`
 *   - block scalar: `run: |` / `run: >` followed by an indented body
 *   - shell line-continuation inside a block body (`npm \` + newline + `ci`)
 * Only `run:` content is returned — a `name:`/`env:`/comment line that merely
 * mentions a command string is never included, so it cannot trip a scanner.
 * Line-continuations are joined so a command split across lines is seen whole.
 * @param {string} text
 * @returns {string[]}
 */
export function extractRunCommands(text) {
  const lines = text.split("\n");
  const commands = [];
  const indentOf = (s) => (s.match(/^\s*/)?.[0].length ?? 0);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const runMatch = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!runMatch) continue;
    const baseIndent = runMatch[1].length;
    const inline = runMatch[2];
    // Block scalar: `run: |` / `run: >` with optional indicators + comment.
    if (/^[>|][0-9+-]*\s*(#.*)?$/.test(inline)) {
      const body = [];
      while (
        i + 1 < lines.length &&
        (lines[i + 1].trim() === "" || indentOf(lines[i + 1]) > baseIndent)
      ) {
        body.push(lines[i + 1]);
        i += 1;
      }
      // Join shell line-continuations, then split into individual commands.
      let joined = "";
      for (const b of body) {
        if (/\\\s*$/.test(joined)) joined = joined.replace(/\\\s*$/, "").trimEnd() + " " + b.trim();
        else joined += (joined ? "\n" : "") + b.trim();
      }
      for (const cmd of joined.split("\n")) {
        if (cmd.trim() && !/^#/.test(cmd.trim())) commands.push(cmd.trim());
      }
      continue;
    }
    // Inline single-line run. Fold a trailing `\` continuation into the next line.
    let joined = inline;
    while (/\\\s*$/.test(joined) && i + 1 < lines.length) {
      joined = joined.replace(/\\\s*$/, "").trimEnd() + " " + lines[i + 1].trim();
      i += 1;
    }
    if (joined.trim()) commands.push(joined.trim());
  }
  return commands;
}

/**
 * Returns true if the workflow grants `id-token: write` at the TOP LEVEL (a
 * `permissions:` block before `jobs:`), which applies to every job. A top-level
 * grant makes even a job with no `permissions:` block OIDC-privileged.
 * @param {string} content
 * @returns {boolean}
 */
function hasTopLevelIdTokenWrite(content) {
  const lines = content.split("\n");
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  const head = jobsIdx === -1 ? lines : lines.slice(0, jobsIdx);
  return head.some((l) => !/^\s*#/.test(l) && /id-token:\s*write/.test(l));
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
 * scripts). NO npm install is permitted here — not even `npm install -g npm@...`:
 * fetching npm from the registry would run externally-sourced code while the OIDC
 * publish token is mintable. The publish job uses the npm bundled in the
 * SHA-pinned setup-node's official Node distribution instead.
 * @param {string} content
 * @param {string} name
 * @returns {string | null}
 */
export function findPublishJobIsolationViolation(content, name) {
  const jobs = splitJobs(content);
  const targets =
    jobs.length > 0 ? jobs : [{ name: "(file)", text: content }];
  // Forbidden install/build shapes inside an id-token:write job. `npm install`
  // in ANY form is forbidden — including the global npm bootstrap, which would
  // execute registry-fetched code under the live OIDC token.
  const forbidden = [
    { re: /\bnpm\s+run\s+build\b/, label: "npm run build" },
    // Cover every npm install/exec alias, not just the literal word `install`:
    // `npm i` / `npm add` install from the registry (running lifecycle scripts),
    // `npm ci` too, and `npm exec` / `npm x` run an arbitrary package — all of
    // which execute externally-sourced code under the live OIDC publish token.
    { re: /\bnpm\s+(install|i|ci|add|exec|x)\b/, label: "npm install/ci/exec" },
    { re: /\byarn\s+(install|add)\b/, label: "yarn install/add" },
    { re: /\bpnpm\s+(install|i|add|dlx)\b/, label: "pnpm install/dlx" },
    // Match `tsc`, `npx tsc`, and path-form invocations (`./node_modules/.bin/tsc`).
    { re: /\bnpx\s+tsc\b|(?:^|[\s/])tsc(?:\s|$)/m, label: "tsc" },
  ];
  // Match the actual permission grant only, on a non-comment line — a comment
  // like "# the only job with id-token:write" (which splitJobs attributes to the
  // preceding job) must not mark a job as OIDC-privileged. A top-level grant
  // applies to every job even when the job has no permissions block of its own.
  const topLevelGrant = hasTopLevelIdTokenWrite(content);
  const grantsIdToken = (text) =>
    topLevelGrant ||
    text.split("\n").some((l) => !/^\s*#/.test(l) && /id-token:\s*write/.test(l));
  for (const job of targets) {
    if (!grantsIdToken(job.text)) continue;
    // Inspect ONLY the shell text of `run:` steps — a `name:`/`env:`/comment line
    // that mentions a command string must never trip the guard. extractRunCommands
    // also joins block scalars and line-continuations, so a command split across
    // lines (`npm \` + newline + `ci`) is seen whole.
    for (const command of extractRunCommands(job.text)) {
      for (const { re, label } of forbidden) {
        if (re.test(command)) {
          return `${name} (job '${job.name}'): a job with 'id-token: write' runs '${label}' — an OIDC-publish job must not install dependencies, build, or fetch npm from the registry (that runs externally-sourced code under the live OIDC token). Move any install/build to an unprivileged (contents:read) job, publish the pre-built tarball, and use the npm bundled with the pinned Node distribution.`;
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
