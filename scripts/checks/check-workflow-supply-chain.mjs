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
 *  2. A supply-chain verifier (`npm audit signatures`, the post-publish
 *     provenance assertion `npm view … dist.attestations`, or an invocation of
 *     the override-floor staleness gate, `check-override-floor-staleness`)
 *     must never be exit-masked. A verifier behind `|| true` / `; true` /
 *     `|| exit 0` / `continue-on-error` / `set +e` / an unprotected pipe is
 *     theater — a real tamper (or a stale floor) would be swallowed.
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
 * signatures`, the post-publish provenance assertion (`npm view` reading
 * `dist.attestations`), or an invocation of `check-override-floor-staleness`
 * (the override-floor staleness gate) — whose exit status is masked, or a
 * step-level `continue-on-error: true` anywhere in a workflow that runs such a
 * verifier.
 *
 * WHAT THIS CAN AND CANNOT DECIDE — read this before extending it.
 *
 * These are SPELLING rules over shell text, and bash's grammar is not decidable
 * by them. An earlier revision tried to escape that by inverting the polarity —
 * requiring a verifier invocation to be a "simple top-level command" and naming
 * anything else — and review measured the result to be simultaneously too loose
 * and too tight: seven multi-line constructs still masked the exit status
 * unseen (an `if` spanning lines, a function body, a heredoc, `eval`, a name
 * arriving through a variable, a backgrounded group, a lowercase `err` trap),
 * while five shapes that are provably fail-closed under `bash -e` were rejected
 * (`cd x && verifier`, `timeout N verifier`, `verifier; echo`, `env K=V
 * verifier`, and a pipe under `set -o pipefail` that the rule twenty lines
 * below deliberately exempts). Writing a shell parser by accretion is how that
 * happens; the same lesson is recorded for this repo's SQL gates.
 *
 * So the claim here is deliberately narrow, and matches what the rules do:
 *
 *   - CAUGHT: the single-line masking spellings (`|| true`, `; true`,
 *     `|| exit 0`, `|| :`, `|| echo`, `set +e`, `set +o errexit`), an
 *     unprotected pipe, a `trap … ERR` sharing a run block with a verifier, a
 *     `continue-on-error` on a verifier-running workflow, a non-`bash`/`sh`
 *     `shell:` (which removes the `-e` every other rule assumes), and an
 *     ambient-input `env:` key on a verifier-running workflow.
 *   - NOT CAUGHT: any construct that spans lines, indirects through a variable
 *     or `eval`, or nests the verifier inside a compound command. This gate does
 *     not see those and does not claim to.
 *
 * The PRIMARY control for all of it remains CODEOWNERS on `/.github/workflows/`
 * (see the file header): every shape above, caught or not, requires owner review
 * to land. These rules are the fast, specific half — they name the construct an
 * operator wrote — not the boundary.
 * @param {string} content
 * @param {string} name
 * @returns {string[]}
 */
export function findMaskedVerifierViolations(content, name) {
  const violations = [];
  // Join shell line-continuations (`… \` + newline) into one logical line BEFORE
  // scanning, so a mask split across lines (`npm audit signatures \` / `  || true`)
  // is caught. Track the original 1-based line number of each logical line's start.
  // `body` mirrors `text` but, for a `run: |`/`run: >` block, omits the block-scalar
  // HEADER line itself — the header's own `|`/`>` indicator would otherwise read as
  // an unprotected shell pipe to the pipe rule below.
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
      let body = "";
      while (
        i + 1 < rawLines.length &&
        (rawLines[i + 1].trim() === "" || indentOf(rawLines[i + 1]) > baseIndent)
      ) {
        joined += " " + rawLines[i + 1].trim();
        body += (body ? " " : "") + rawLines[i + 1].trim();
        i += 1;
      }
      logical.push({ text: joined, body, line: start + 1 });
      continue;
    }
    while (/\\\s*$/.test(joined) && i + 1 < rawLines.length) {
      joined = joined.replace(/\\\s*$/, " ") + rawLines[i + 1];
      i += 1;
    }
    logical.push({ text: joined, body: joined, line: start + 1 });
  }
  // `dist\??\.attestations` tolerates optional chaining (`j?.dist?.attestations`
  // in the real release.yml assertion). `check-override-floor-staleness` names the
  // new gate (C7 of stale-override-floors) as a verifier too. `runsVerifier` is a
  // WORKFLOW-level flag, not per-line, so a `npm view` and an `attestations`
  // reference on separate lines still mark the workflow as verifier-running.
  const verifierLineRe =
    /audit\s+signatures|dist\??\.attestations|check-override-floor-staleness/;
  // The `check-override-floor-staleness` alternative is bound to actual `run:`
  // COMMAND text via extractRunCommands, not raw file content — a YAML comment
  // that merely mentions the gate must not flip this workflow-level flag, which
  // would otherwise subject the whole file to the continue-on-error ban below.
  const runsVerifier =
    /audit\s+signatures/.test(content) ||
    (/npm\s+view/.test(content) && /attestations/.test(content)) ||
    extractRunCommands(content).some((cmd) => /check-override-floor-staleness/.test(cmd));
  // `:` needs a lookahead boundary (a trailing \b never matches after non-word `:`).
  // `set +e` disables errexit, so a verifier's non-zero exit stops aborting the
  // rest of the script. Both spellings count: the `+`-cleared flag cluster
  // (`set +e`, `set +ex`) and the long option (`set +o errexit`). `pipefailRe`
  // below already had to handle `-o`'s long form, so covering only the cluster
  // here left the two halves of one function disagreeing about shell syntax.
  const maskRe =
    /(\|\|\s*(true|exit\s+0|echo)|;\s*(true|exit\s+0)|\|\|\s*:(?=\s|$)|\bset\s+\+\S*e\S*\b|\bset\s+\+o\s+errexit\b)/;
  // A `trap … ERR` handler is block-scoped like `set +e`, so no per-line rule can
  // see it: `trap "exit 0" ERR` ahead of the verifier turns its non-zero exit into
  // a clean step exit. Matched against a single extracted COMMAND rather than the
  // joined block so that release.yml's real `trap 'rm -rf "$WORK"' EXIT` — a
  // cleanup handler on a different signal, in a block that does run a verifier —
  // is not swept up by a `\bERR\b` looked for anywhere in the same joined text.
  const trapErrRe = /^\s*trap\b[^\n]*\berr\b/i;
  // An unprotected pipe: a LONE `|` — not `||` (shell OR / JS logical-or both use
  // adjacent pipe pairs, which the lookaround below excludes on both sides) — whose
  // exit status only `pipefail` preserves. No workflow here sets `shell:` or
  // `defaults.run.shell`, so GitHub's default (`bash --noprofile --norc -eo …`,
  // WITHOUT `pipefail`) applies: a pipe really does discard an upstream verifier's
  // exit code unless the script opts in itself. Scoped to the whole joined block
  // (not just the verifier's own line) because the block-join above already
  // flattens a `run: |` body into one logical line — e.g. release.yml's
  // `echo "$VIEW" | node -e …` sits under a `set -euo pipefail` a few lines above
  // it in the SAME block, which is what makes that particular pipe safe.
  const pipeRe = /(?<!\|)\|(?!\|)/;
  const pipefailRe = /\bset\s+-\S*o\S*\s+pipefail\b/;
  // Logical lines the spelling layer already named. A line it named is not named
  // a second time by the allowlist: the spelling is the better diagnostic, and
  // reporting one construct twice reads as two defects.
  const spelled = new Set();
  for (const { text, body, line } of logical) {
    if (verifierLineRe.test(text) && maskRe.test(text)) {
      spelled.add(line);
      violations.push(
        `${name}:${line}: supply-chain verifier exit status is masked (|| true / ; true / || exit 0 / || : / || echo / set +e) — it must fail closed`,
      );
    }
    if (verifierLineRe.test(text) && pipeRe.test(body) && !pipefailRe.test(text)) {
      spelled.add(line);
      violations.push(
        `${name}:${line}: supply-chain verifier's exit status can be discarded by a pipe with no 'pipefail' in effect in this run block — add 'set -euo pipefail' (or 'set -o pipefail'), or restructure to avoid piping the verifier`,
      );
    }
  }

  // `trap … ERR` is block-scoped, so it is matched against one extracted COMMAND
  // rather than the joined block: release.yml's real `trap 'rm -rf "$WORK"' EXIT`
  // is a cleanup handler on a different signal in a block that does run a
  // verifier, and a `\bERR\b` looked for anywhere in the joined text would sweep
  // it up. Signal names are case-insensitive to bash, so `err` counts too — the
  // previous spelling enumerated one case of a name the shell does not.
  const records = extractRunCommandRecords(content);
  const verifierBlocks = new Set(
    records.filter((r) => verifierLineRe.test(r.command)).map((r) => r.blockLine),
  );
  for (const record of records) {
    if (verifierBlocks.has(record.blockLine) && trapErrRe.test(record.command)) {
      violations.push(
        `${name}:${record.firstLine}: a 'trap … ERR' handler shares a run block with a supply-chain verifier — an ERR trap that does not re-raise turns the verifier's non-zero exit into a clean step; remove it or move the verifier to its own step`,
      );
    }
  }

  // Every rule above reasons from GitHub's default shell, which is bash with
  // `-e`. Only the `bash` and `sh` KEYWORD forms carry it: `shell: bash {0}` is
  // the custom-command form and runs without `-e`, at which point a verifier's
  // non-zero exit stops aborting the step and every rule here is deciding by a
  // model the runner no longer uses. A one-token diff would otherwise convert a
  // whole file's verifiers to theatre while this gate reported PASS.
  if (runsVerifier) {
    for (let n = 0; n < rawLines.length; n += 1) {
      const shellMatch = rawLines[n].match(/^\s*(?:-\s+)?shell:\s*(\S.*?)\s*$/);
      if (!shellMatch) continue;
      const value = shellMatch[1].replace(/^["']|["']$/g, "");
      if (value === "bash" || value === "sh") continue;
      violations.push(
        `${name}:${n + 1}: a verifier-running workflow sets 'shell: ${value}' — only the bare 'bash'/'sh' keyword forms carry the '-e' that makes a verifier's non-zero exit abort the step`,
      );
    }
  }

  // The staleness gate refuses these at runtime, but a loader named in
  // NODE_OPTIONS runs before its first line and can delete the variable it would
  // have been caught by — so the workflow is the only place that shape is
  // decidable. The member set is the gate's own AMBIENT_ORIGIN_VARS, kept
  // identical on purpose: two adjudicators of one predicate must not drift.
  if (runsVerifier) {
    for (let n = 0; n < rawLines.length; n += 1) {
      const envMatch = rawLines[n].match(/^\s*(NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_USE_ENV_PROXY|HTTPS?_PROXY|ALL_PROXY|https?_proxy|all_proxy):/);
      if (!envMatch) continue;
      violations.push(
        `${name}:${n + 1}: a verifier-running workflow sets '${envMatch[1]}' — it redirects, intercepts or instruments the verifier's own process, which the verifier cannot refuse for itself once a loader is in play`,
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
  return extractRunCommandRecords(text).map((r) => r.command);
}

/**
 * The same extraction as `extractRunCommands`, but each command keeps where it
 * came from: `firstLine`/`lastLine` are the 1-based raw lines it was built from,
 * and `blockLine` is the 1-based line of the `run:` that owns it. The line
 * numbers are what let a per-command rule report a location, and what lets a
 * verifier mention that NO run: command accounts for be told apart from one that
 * simply passes — a skip and a pass are the same output otherwise.
 * @param {string} text
 * @returns {{command: string, firstLine: number, lastLine: number, blockLine: number}[]}
 */
function extractRunCommandRecords(text) {
  const lines = text.split("\n");
  const records = [];
  const indentOf = (s) => (s.match(/^\s*/)?.[0].length ?? 0);
  const keep = (record) => {
    if (record.command && !/^#/.test(record.command)) records.push(record);
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const runMatch = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!runMatch) continue;
    const baseIndent = runMatch[1].length;
    const inline = runMatch[2];
    const blockLine = i + 1;
    // Block scalar: `run: |` / `run: >` with optional indicators + comment.
    if (/^[>|][0-9+-]*\s*(#.*)?$/.test(inline)) {
      const body = [];
      while (
        i + 1 < lines.length &&
        (lines[i + 1].trim() === "" || indentOf(lines[i + 1]) > baseIndent)
      ) {
        body.push({ text: lines[i + 1], line: i + 2 });
        i += 1;
      }
      // Join shell line-continuations; each unbroken run of them is one command.
      let current = null;
      for (const b of body) {
        if (current && /\\\s*$/.test(current.command)) {
          current.command = current.command.replace(/\\\s*$/, "").trimEnd() + " " + b.text.trim();
          current.lastLine = b.line;
          continue;
        }
        if (current) keep(current);
        current = { command: b.text.trim(), firstLine: b.line, lastLine: b.line, blockLine };
      }
      if (current) keep(current);
      continue;
    }
    // Inline single-line run. Fold a trailing `\` continuation into the next line.
    let joined = inline;
    let last = i;
    while (/\\\s*$/.test(joined) && last + 1 < lines.length) {
      joined = joined.replace(/\\\s*$/, "").trimEnd() + " " + lines[last + 1].trim();
      last += 1;
    }
    i = last;
    keep({ command: joined.trim(), firstLine: blockLine, lastLine: last + 1, blockLine });
  }
  return records;
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

// Every alias npm resolves to `install`, taken from npm 11's own
// lib/utils/cmd-list.js rather than guessed — the typo-tolerant ones (`isntall`)
// are real and install just as well as the canonical spelling.
const NPM_INSTALL_ALIASES = [
  "install",
  "add",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
];
// Longest-first so `i` cannot shadow `install` in the alternation.
const INSTALL_INVOCATION_RE = new RegExp(
  `\\bnpm\\s+(?:${[...NPM_INSTALL_ALIASES].sort((a, b) => b.length - a.length).join("|")})\\b[^\\n;&|]*`,
  "g",
);

/**
 * Resolve npm's `save` config for one install invocation the way npm itself
 * does, rather than pattern-matching flag text. Two cases make the naive regex
 * wrong in BOTH directions, and both are verified against real npm 11:
 *   `--save='false'` / `--save="false"` → save=false (a miss: quotes survive
 *       shell-less matching, so a `--save=false` regex does not see them)
 *   `--no-save=false`                   → save=true  (a FALSE POSITIVE: the
 *       explicit value negates the `no-` prefix, so flagging it would block a
 *       correct command — the way a gate earns being switched off)
 *
 * @param {string} invocation  a single `npm install …` command string
 * @returns {boolean} the effective `save` setting (npm's default is true)
 */
export function resolveSaveFlag(invocation) {
  let save = true;
  // `=`-attached values bind unconditionally; a SPACE-separated value binds only
  // when the next token is literally true/false (quoted or not). Consuming any
  // next token would let `--save --no-save` read `--no-save` as `--save`'s value
  // and return true, where npm returns false — npm takes the LAST flag, and the
  // loop below reproduces that by simply overwriting `save` each time.
  const flag = /--(no-)?save(?:=("[^"]*"|'[^']*'|[^\s]*)|\s+(?:"(true|false)"|'(true|false)'|(true|false))\b)?/g;
  for (const m of invocation.matchAll(flag)) {
    const negated = Boolean(m[1]);
    const raw = m[2] ?? m[3] ?? m[4] ?? m[5];
    if (raw === undefined) {
      // Bare `--save` / `--no-save`: the prefix alone decides.
      save = !negated;
      continue;
    }
    const value = raw.replace(/^['"]|['"]$/g, "") !== "false";
    // `--no-save=false` is save=true: the explicit value is what npm reads, and
    // the `no-` prefix inverts it.
    save = negated ? !value : value;
  }
  return save;
}

/**
 * `npm audit signatures` walks the dependency graph, so a package installed with
 * `--no-save` — absent from both the manifest and the lockfile's root deps — is
 * never reached. The audit then covers only that package's own dependencies and
 * reports a healthy-looking count while never touching the subject it was run to
 * verify. Releases 0.4.73 and 0.4.74 both failed the downstream identity check
 * this way, and nothing caught it before the release itself, because the
 * verifying job only runs when a publish actually happens.
 *
 * Flags an install whose target is a versioned package spec (the shape used to
 * fetch a just-published artifact for verification) combined with `--no-save`,
 * but only in a workflow that also runs `npm audit signatures` — elsewhere
 * `--no-save` is unremarkable.
 *
 * @param {string} content  workflow file text
 * @param {string} name     file name for the message
 * @returns {string[]} violation messages
 */
export function findUnsavedAuditSubjectViolations(content, name) {
  if (!/npm\s+audit\s+signatures/.test(content)) return [];
  const violations = [];
  for (const command of extractRunCommands(content)) {
    const install = command.match(INSTALL_INVOCATION_RE) || [];
    for (const inv of install) {
      if (resolveSaveFlag(inv) !== false) continue;
      if (!/[\w@/.-]+@\$?\{?[\w.$-]/.test(inv.replace(/--[\w-]+/g, ""))) continue;
      violations.push(
        `${name}: '${inv.trim()}' installs a versioned package with --no-save in a workflow that runs 'npm audit signatures'. An unsaved install leaves the package out of the dependency graph, so the audit silently covers only its dependencies and never the package itself — the subject of the verification is skipped while the audit still reports success. Drop --no-save so the package is part of the audited graph.`,
      );
    }
  }
  return violations;
}

function main() {
  const violations = [];
  for (const file of listWorkflowFiles()) {
    const content = readFileSync(file, "utf8");
    const autoMerge = findAutoMergeViolation(content, file);
    if (autoMerge) violations.push(autoMerge);
    violations.push(...findUnsavedAuditSubjectViolations(content, file));
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
