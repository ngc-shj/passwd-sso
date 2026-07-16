#!/usr/bin/env node
/**
 * Verify that an npm SLSA v1 provenance attestation binds a published package to
 * THIS repository, commit, workflow, and ref — not merely to the same repo. The
 * registry attestation bundle (JSON) is read from stdin; expected values come
 * from the environment:
 *
 *   EXPECTED_REPO      e.g. "ngc-shj/passwd-sso"        (github.repository)
 *   EXPECTED_SHA       e.g. "deadbeef…" (40-hex)        (github.sha)
 *   EXPECTED_WORKFLOW  e.g. ".github/workflows/release.yml"
 *   EXPECTED_REF       e.g. "refs/heads/main"           (github.ref) — optional;
 *                      when unset, ref is not asserted.
 *
 * Exits 0 and prints `OK …` only when a provenance predicate matches ALL of the
 * required fields exactly. Otherwise prints a specific reason and exits 1. It
 * fails CLOSED on every ambiguity (no provenance, missing field, unparseable
 * bundle): a false-fail on a legitimate release, never a false-pass.
 *
 * The verifier is pure (verifyProvenanceSource) so it can be unit-tested against
 * SLSA v1 fixtures; the file also runs as a CLI when invoked directly.
 */

const GITHUB = "https://github.com/";

/**
 * @param {unknown} bundle  parsed attestation bundle
 * @param {{repo:string, sha:string, workflow:string, ref?:string}} expected
 * @returns {{ok:true, repo:string, sha:string, workflow:string, ref:string}
 *          | {ok:false, reason:string}}
 */
export function verifyProvenanceSource(bundle, expected) {
  if (!expected?.repo) return { ok: false, reason: "EXPECTED_REPO not set" };
  if (!expected?.sha) return { ok: false, reason: "EXPECTED_SHA not set" };
  if (!expected?.workflow) return { ok: false, reason: "EXPECTED_WORKFLOW not set" };

  const atts = Array.isArray(bundle?.attestations) ? bundle.attestations : [];
  const provs = atts.filter(
    (a) => a?.predicateType === "https://slsa.dev/provenance/v1",
  );
  if (provs.length === 0) return { ok: false, reason: "NO_PROVENANCE" };

  // Collect a specific rejection reason from the last candidate we could parse,
  // so a caller sees WHICH field diverged rather than a generic mismatch.
  let lastReason = "NO_MATCHING_PROVENANCE";

  for (const a of provs) {
    const env = a?.bundle?.dsseEnvelope || a?.dsseEnvelope;
    if (!env?.payload) {
      lastReason = "NO_DSSE_PAYLOAD";
      continue;
    }
    let stmt;
    try {
      stmt = JSON.parse(Buffer.from(env.payload, "base64").toString("utf8"));
    } catch {
      lastReason = "PAYLOAD_PARSE_ERROR";
      continue;
    }
    const pred = stmt?.predicate || {};
    const bd = pred.buildDefinition || {};
    const wf = bd.externalParameters?.workflow || {};

    // Source repository — the authoritative field is externalParameters.workflow
    // .repository. Do NOT fall back to scanning resolvedDependencies: any GitHub
    // URI there could be an ordinary dependency, not the built source, which
    // would let an attacker's provenance pass by listing the expected repo as a
    // dep. Missing source repository fails closed.
    if (!wf.repository) {
      lastReason = "MISSING_SOURCE_REPOSITORY";
      continue;
    }
    const repo = String(wf.repository).replace(/^https:\/\/github\.com\//, "");
    if (repo !== expected.repo) {
      lastReason = "REPO_MISMATCH";
      continue;
    }

    // Source commit — from the resolved dependency whose URI is THIS repo.
    const deps = Array.isArray(bd.resolvedDependencies) ? bd.resolvedDependencies : [];
    const repoUriPrefix = `git+${GITHUB}${expected.repo}`;
    const srcDep = deps.find((d) => String(d?.uri || "").startsWith(repoUriPrefix));
    const sha = srcDep?.digest?.gitCommit || "";
    if (!sha) {
      lastReason = "MISSING_COMMIT";
      continue;
    }
    if (sha !== expected.sha) {
      lastReason = "SHA_MISMATCH";
      continue;
    }

    // Workflow path — strip an `owner/repo/` prefix and any `@ref` suffix so we
    // compare the repo-relative path (`.github/workflows/release.yml`).
    const rawPath = String(wf.path || "");
    if (!rawPath) {
      lastReason = "MISSING_WORKFLOW_PATH";
      continue;
    }
    const path = rawPath
      .replace(new RegExp(`^${expected.repo}/`), "")
      .replace(/@.*$/, "");
    if (path !== expected.workflow) {
      lastReason = "WORKFLOW_MISMATCH";
      continue;
    }

    // Ref — asserted only when an expected ref is supplied.
    const ref = String(wf.ref || "");
    if (expected.ref) {
      if (!ref) {
        lastReason = "MISSING_REF";
        continue;
      }
      if (ref !== expected.ref) {
        lastReason = "REF_MISMATCH";
        continue;
      }
    }

    return { ok: true, repo, sha, workflow: path, ref };
  }

  return { ok: false, reason: lastReason };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let bundle;
  try {
    bundle = JSON.parse(await readStdin());
  } catch (e) {
    console.error(`::error::attestation bundle is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const result = verifyProvenanceSource(bundle, {
    repo: process.env.EXPECTED_REPO || "",
    sha: process.env.EXPECTED_SHA || "",
    workflow: process.env.EXPECTED_WORKFLOW || "",
    ref: process.env.EXPECTED_REF || "",
  });
  if (result.ok) {
    console.log(
      `OK repo=${result.repo} sha=${result.sha} workflow=${result.workflow} ref=${result.ref || "(not asserted)"}`,
    );
    process.exit(0);
  }
  console.error(`::error::provenance source identity check failed: ${result.reason}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
