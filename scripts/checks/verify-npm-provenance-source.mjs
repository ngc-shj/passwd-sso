#!/usr/bin/env node
/**
 * Verify that the VERIFIED SLSA provenance attestation for a published npm
 * package binds it to THIS repository, commit, workflow, and ref — and that the
 * signed in-toto statement's own type, subject, and builder are what we expect.
 *
 * INPUT (stdin): the JSON output of
 *   `npm audit signatures --json --include-attestations`
 * i.e. `{ verified: [ { name, version, attestationBundles: [...] }, ... ] }`.
 * The bundles under `verified[].attestationBundles` are the ones npm
 * CRYPTOGRAPHICALLY verified (Sigstore signature + transparency log) during the
 * audit. We deliberately consume THOSE — not a separately fetched, unsigned copy
 * of the bundle — so the identity we assert is the identity of a bundle whose
 * signature was already checked, closing the registry-equivocation gap.
 *
 * Expected values come from the environment:
 *   EXPECTED_PACKAGE   e.g. "passwd-sso-cli"
 *   EXPECTED_VERSION   e.g. "0.4.71"
 *   EXPECTED_REPO      e.g. "ngc-shj/passwd-sso"        (github.repository)
 *   EXPECTED_SHA       40-hex commit                    (github.sha)
 *   EXPECTED_WORKFLOW  e.g. ".github/workflows/release.yml"
 *   EXPECTED_REF       e.g. "refs/heads/main"           (github.ref) — optional
 *
 * Exits 0 and prints `OK …` only when a verified provenance matches ALL required
 * fields exactly. Otherwise prints a specific reason and exits 1. Fails CLOSED on
 * every ambiguity: a false-fail on a legitimate release, never a false-pass.
 *
 * The verifier is pure (verifyProvenanceSource) so it is unit-tested against
 * SLSA v1 fixtures; the file also runs as a CLI when invoked directly.
 */

const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
// This release flow pins its Node/npm toolchain, so we require the EXACT values
// current npm Trusted Publishing emits rather than a compatibility set — an
// unexpected statement type or builder should fail closed for review, not be
// silently accepted. (Verified against real `npm audit signatures
// --include-attestations` output: _type = in-toto Statement/v1, builder =
// actions/runner/github-hosted.)
const EXPECTED_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const EXPECTED_BUILDER_ID = "https://github.com/actions/runner/github-hosted";

/**
 * @param {unknown} auditOutput  parsed `npm audit signatures --json --include-attestations`
 * @param {{package:string, version:string, repo:string, sha:string, workflow:string, ref?:string}} expected
 * @returns {{ok:true, repo:string, sha:string, workflow:string, ref:string, builder:string}
 *          | {ok:false, reason:string}}
 */
export function verifyProvenanceSource(auditOutput, expected) {
  for (const [k, label] of [
    ["package", "EXPECTED_PACKAGE"],
    ["version", "EXPECTED_VERSION"],
    ["repo", "EXPECTED_REPO"],
    ["sha", "EXPECTED_SHA"],
    ["workflow", "EXPECTED_WORKFLOW"],
  ]) {
    if (!expected?.[k]) return { ok: false, reason: `${label} not set` };
  }

  const verified = Array.isArray(auditOutput?.verified) ? auditOutput.verified : [];
  const entry = verified.find(
    (v) => v?.name === expected.package && v?.version === expected.version,
  );
  if (!entry) return { ok: false, reason: "PACKAGE_NOT_VERIFIED" };

  const bundles = Array.isArray(entry.attestationBundles) ? entry.attestationBundles : [];
  const provBundles = bundles.filter((b) => b?.predicateType === PROVENANCE_PREDICATE);
  if (provBundles.length === 0) return { ok: false, reason: "NO_VERIFIED_PROVENANCE" };

  let lastReason = "NO_MATCHING_PROVENANCE";

  for (const b of provBundles) {
    const env = b?.bundle?.dsseEnvelope || b?.dsseEnvelope;
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

    // Inner (signed) statement must itself be an in-toto SLSA provenance — the
    // OUTER predicateType is not signed, so we do not trust it alone.
    if (String(stmt?._type) !== EXPECTED_STATEMENT_TYPE) {
      lastReason = "BAD_STATEMENT_TYPE";
      continue;
    }
    if (stmt?.predicateType !== PROVENANCE_PREDICATE) {
      lastReason = "BAD_INNER_PREDICATE_TYPE";
      continue;
    }

    // Subject must be OUR package@version.
    const subjects = Array.isArray(stmt.subject) ? stmt.subject : [];
    const wantSubject = `pkg:npm/${expected.package.replace("@", "%40")}@${expected.version}`;
    const subject = subjects.find((s) => {
      const n = String(s?.name || "");
      return n === wantSubject || n === `pkg:npm/${expected.package}@${expected.version}`;
    });
    if (!subject) {
      lastReason = "SUBJECT_MISMATCH";
      continue;
    }
    // If build-cli's integrity was supplied, bind the subject digest to it.
    if (expected.sha512Digest) {
      const digest = subject.digest?.sha512 || "";
      if (digest !== expected.sha512Digest) {
        lastReason = "SUBJECT_DIGEST_MISMATCH";
        continue;
      }
    }

    const pred = stmt.predicate || {};
    const bd = pred.buildDefinition || {};
    const wf = bd.externalParameters?.workflow || {};

    // Builder identity must be the GitHub-hosted runner.
    const builder = String(pred.runDetails?.builder?.id || "");
    if (builder !== EXPECTED_BUILDER_ID) {
      lastReason = "BUILDER_MISMATCH";
      continue;
    }

    // Source repository — the authoritative field is workflow.repository. No
    // fallback to scanning resolvedDependencies (any dep URI could be planted).
    if (!wf.repository) {
      lastReason = "MISSING_SOURCE_REPOSITORY";
      continue;
    }
    const repo = String(wf.repository).replace(/^https:\/\/github\.com\//, "");
    if (repo !== expected.repo) {
      lastReason = "REPO_MISMATCH";
      continue;
    }

    // Source commit — from the resolved dependency whose URI is EXACTLY this repo
    // (prefix-then-boundary, so `repo-evil` cannot satisfy `repo`).
    const deps = Array.isArray(bd.resolvedDependencies) ? bd.resolvedDependencies : [];
    const srcDep = deps.find((d) => isThisRepoUri(String(d?.uri || ""), expected.repo));
    const sha = srcDep?.digest?.gitCommit || "";
    if (!sha) {
      lastReason = "MISSING_COMMIT";
      continue;
    }
    if (sha !== expected.sha) {
      lastReason = "SHA_MISMATCH";
      continue;
    }

    // Workflow path — strip an `owner/repo/` prefix and any `@ref` suffix.
    const rawPath = String(wf.path || "");
    if (!rawPath) {
      lastReason = "MISSING_WORKFLOW_PATH";
      continue;
    }
    const path = rawPath.replace(new RegExp(`^${escapeRe(expected.repo)}/`), "").replace(/@.*$/, "");
    if (path !== expected.workflow) {
      lastReason = "WORKFLOW_MISMATCH";
      continue;
    }

    // Ref — asserted only when supplied.
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

    return { ok: true, repo, sha, workflow: path, ref, builder };
  }

  return { ok: false, reason: lastReason };
}

/**
 * True when a resolved-dependency URI names EXACTLY this repo. Matches
 * `git+https://github.com/<repo>` followed by a boundary (`@`, `.git`, or end),
 * so `…/passwd-sso-evil` does NOT match `…/passwd-sso`.
 */
function isThisRepoUri(uri, repo) {
  const m = uri.match(/^git\+https:\/\/github\.com\/(.+?)(?:\.git)?(?:@.*)?$/);
  if (!m) return false;
  return m[1] === repo;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let auditOutput;
  try {
    auditOutput = JSON.parse(await readStdin());
  } catch (e) {
    console.error(`::error::audit output is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const result = verifyProvenanceSource(auditOutput, {
    package: process.env.EXPECTED_PACKAGE || "",
    version: process.env.EXPECTED_VERSION || "",
    repo: process.env.EXPECTED_REPO || "",
    sha: process.env.EXPECTED_SHA || "",
    workflow: process.env.EXPECTED_WORKFLOW || "",
    ref: process.env.EXPECTED_REF || "",
    sha512Digest: process.env.EXPECTED_SHA512_DIGEST || "",
  });
  if (result.ok) {
    console.log(
      `OK repo=${result.repo} sha=${result.sha} workflow=${result.workflow} ref=${result.ref || "(not asserted)"} builder=${result.builder}`,
    );
    process.exit(0);
  }
  console.error(`::error::provenance source identity check failed: ${result.reason}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
