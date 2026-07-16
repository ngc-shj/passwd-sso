/**
 * Self-test for scripts/checks/verify-npm-provenance-source.mjs — the provenance
 * SOURCE-IDENTITY verifier. It consumes the VERIFIED attestation bundles from
 * `npm audit signatures --json --include-attestations` and must bind the
 * published package to THIS repo, commit, workflow, builder, and subject (all
 * exact), failing closed on any divergence. A regression that relaxed the match
 * would be a security false-green, so every failure mode gets a fixture
 * (RT7 — provably able to fail).
 */
import { describe, it, expect } from "vitest";
import { verifyProvenanceSource } from "../checks/verify-npm-provenance-source.mjs";

const EXPECTED = {
  package: "passwd-sso-cli",
  version: "0.4.71",
  repo: "ngc-shj/passwd-sso",
  sha: "deadbeefcafedeadbeefcafedeadbeefcafe0000",
  workflow: ".github/workflows/release.yml",
  ref: "refs/heads/main",
};

const GITHUB_BUILDER = "https://github.com/actions/runner/github-hosted";

/** Build a signed in-toto SLSA v1 statement (base64 DSSE payload). */
function payload({
  statementType = "https://in-toto.io/Statement/v1",
  innerPredicate = "https://slsa.dev/provenance/v1",
  subjectName = "pkg:npm/passwd-sso-cli@0.4.71",
  subjectDigest = undefined,
  repo = "https://github.com/ngc-shj/passwd-sso",
  path = ".github/workflows/release.yml",
  ref = "refs/heads/main",
  depUri = "git+https://github.com/ngc-shj/passwd-sso@refs/heads/main",
  sha = EXPECTED.sha,
  builder = GITHUB_BUILDER,
  omitWorkflow = false,
} = {}) {
  const stmt = {
    _type: statementType,
    predicateType: innerPredicate,
    subject: [{ name: subjectName, ...(subjectDigest ? { digest: { sha512: subjectDigest } } : {}) }],
    predicate: {
      buildDefinition: {
        externalParameters: omitWorkflow ? {} : { workflow: { repository: repo, path, ref } },
        resolvedDependencies: [{ uri: depUri, digest: sha ? { gitCommit: sha } : {} }],
      },
      runDetails: { builder: { id: builder } },
    },
  };
  return Buffer.from(JSON.stringify(stmt)).toString("base64");
}

/** Wrap payload(s) as `npm audit signatures --json --include-attestations` output. */
function audit(bundles, { name = "passwd-sso-cli", version = "0.4.71" } = {}) {
  return {
    verified: [
      {
        name,
        version,
        attestationBundles: bundles.map((b) => ({
          predicateType: b.outerPredicate ?? "https://slsa.dev/provenance/v1",
          bundle: { dsseEnvelope: { payload: b.payload } },
        })),
      },
    ],
  };
}

const good = () => audit([{ payload: payload() }]);

describe("verifyProvenanceSource", () => {
  it("accepts a verified bundle whose repo, commit, workflow, ref, builder, subject all match", () => {
    expect(verifyProvenanceSource(good(), EXPECTED)).toMatchObject({ ok: true });
  });

  it("rejects when the package/version is not in the verified list", () => {
    const r = verifyProvenanceSource(good(), { ...EXPECTED, version: "9.9.9" });
    expect(r).toMatchObject({ ok: false, reason: "PACKAGE_NOT_VERIFIED" });
  });

  it("rejects a commit-SHA mismatch (same repo)", () => {
    const r = verifyProvenanceSource(audit([{ payload: payload({ sha: "0".repeat(40) }) }]), EXPECTED);
    expect(r).toMatchObject({ ok: false, reason: "SHA_MISMATCH" });
  });

  it("rejects a missing source commit", () => {
    const r = verifyProvenanceSource(audit([{ payload: payload({ sha: "" }) }]), EXPECTED);
    expect(r).toMatchObject({ ok: false, reason: "MISSING_COMMIT" });
  });

  it("rejects a workflow-path mismatch", () => {
    const r = verifyProvenanceSource(
      audit([{ payload: payload({ path: ".github/workflows/evil.yml" }) }]),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "WORKFLOW_MISMATCH" });
  });

  it("rejects a ref mismatch when a ref is asserted", () => {
    const r = verifyProvenanceSource(audit([{ payload: payload({ ref: "refs/heads/x" }) }]), EXPECTED);
    expect(r).toMatchObject({ ok: false, reason: "REF_MISMATCH" });
  });

  it("does not assert ref when EXPECTED_REF is unset", () => {
    const r = verifyProvenanceSource(audit([{ payload: payload({ ref: "refs/heads/x" }) }]), {
      ...EXPECTED,
      ref: "",
    });
    expect(r).toMatchObject({ ok: true });
  });

  it("rejects a repository mismatch", () => {
    const r = verifyProvenanceSource(
      audit([{ payload: payload({ repo: "https://github.com/attacker/passwd-sso" }) }]),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "REPO_MISMATCH" });
  });

  it("rejects a bundle with no provenance predicate", () => {
    const b = audit([{ payload: payload(), outerPredicate: "https://spdx.dev/Document" }]);
    expect(verifyProvenanceSource(b, EXPECTED)).toMatchObject({
      ok: false,
      reason: "NO_VERIFIED_PROVENANCE",
    });
  });

  it("rejects a corrupt DSSE payload", () => {
    const b = { verified: [{ name: "passwd-sso-cli", version: "0.4.71", attestationBundles: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: "!!!" } } }] }] };
    expect(verifyProvenanceSource(b, EXPECTED).ok).toBe(false);
  });

  it("rejects when the inner signed statement type is wrong (outer lies)", () => {
    const r = verifyProvenanceSource(
      audit([{ payload: payload({ statementType: "https://in-toto.io/Statement/vEVIL" }) }]),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "BAD_STATEMENT_TYPE" });
  });

  it("rejects when the inner predicate type is not SLSA provenance (outer lies)", () => {
    const r = verifyProvenanceSource(
      audit([{ payload: payload({ innerPredicate: "https://example.com/other" }) }]),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "BAD_INNER_PREDICATE_TYPE" });
  });

  it("matches a scoped package whose subject encodes the leading @ as %40", () => {
    const scoped = {
      package: "@ngc-shj/passwd-sso-cli",
      version: "0.4.71",
      repo: "ngc-shj/passwd-sso",
      sha: EXPECTED.sha,
      workflow: ".github/workflows/release.yml",
      ref: "refs/heads/main",
    };
    const r = verifyProvenanceSource(
      audit([{ payload: payload({ subjectName: "pkg:npm/%40ngc-shj/passwd-sso-cli@0.4.71" }) }], {
        name: scoped.package,
        version: scoped.version,
      }),
      scoped,
    );
    expect(r).toMatchObject({ ok: true });
  });

  it("rejects when the subject is a different package", () => {
    const r = verifyProvenanceSource(
      audit([{ payload: payload({ subjectName: "pkg:npm/other-pkg@0.4.71" }) }]),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "SUBJECT_MISMATCH" });
  });

  it("rejects when the builder is not a GitHub-hosted runner", () => {
    const r = verifyProvenanceSource(
      audit([{ payload: payload({ builder: "https://evil.example/runner" }) }]),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "BUILDER_MISMATCH" });
  });

  it("rejects the non-hosted actions/runner builder (exact GitHub-hosted required)", () => {
    const r = verifyProvenanceSource(
      audit([{ payload: payload({ builder: "https://github.com/actions/runner" }) }]),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "BUILDER_MISMATCH" });
  });

  it("rejects an older in-toto Statement/v0.1 type (exact v1 required)", () => {
    const r = verifyProvenanceSource(
      audit([{ payload: payload({ statementType: "https://in-toto.io/Statement/v0.1" }) }]),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "BAD_STATEMENT_TYPE" });
  });

  it("rejects when the expected repo appears only as a resolved DEPENDENCY, not the source", () => {
    const r = verifyProvenanceSource(
      audit([
        {
          payload: payload({
            repo: "https://github.com/attacker/repo",
            depUri: "git+https://github.com/ngc-shj/passwd-sso@refs/heads/main",
          }),
        },
      ]),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "REPO_MISMATCH" });
  });

  it("does NOT treat a similarly-named repo (passwd-sso-evil) as this repo's source dep", () => {
    const r = verifyProvenanceSource(
      audit([{ payload: payload({ depUri: "git+https://github.com/ngc-shj/passwd-sso-evil@refs/heads/main" }) }]),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "MISSING_COMMIT" });
  });

  it("rejects provenance missing the source repository field", () => {
    const r = verifyProvenanceSource(audit([{ payload: payload({ omitWorkflow: true }) }]), EXPECTED);
    expect(r).toMatchObject({ ok: false, reason: "MISSING_SOURCE_REPOSITORY" });
  });

  it("binds the subject digest to the built tarball when supplied", () => {
    const digest = "a".repeat(128);
    const withDigest = { ...EXPECTED, sha512Digest: digest };
    expect(
      verifyProvenanceSource(audit([{ payload: payload({ subjectDigest: digest }) }]), withDigest),
    ).toMatchObject({ ok: true });
    expect(
      verifyProvenanceSource(audit([{ payload: payload({ subjectDigest: "b".repeat(128) }) }]), withDigest),
    ).toMatchObject({ ok: false, reason: "SUBJECT_DIGEST_MISMATCH" });
  });

  it("accepts when one of several provenances fully matches (decoy from another repo)", () => {
    const decoy = payload({
      repo: "https://github.com/attacker/repo",
      depUri: "git+https://github.com/attacker/repo@refs/heads/main",
    });
    const r = verifyProvenanceSource(audit([{ payload: decoy }, { payload: payload() }]), EXPECTED);
    expect(r).toMatchObject({ ok: true });
  });

  it("fails closed on an unexpected top-level shape", () => {
    expect(verifyProvenanceSource(null, EXPECTED).ok).toBe(false);
    expect(verifyProvenanceSource({ verified: "nope" }, EXPECTED)).toMatchObject({
      ok: false,
      reason: "PACKAGE_NOT_VERIFIED",
    });
  });

  it("fails closed when expected inputs are missing", () => {
    expect(verifyProvenanceSource(good(), { ...EXPECTED, sha: "" })).toMatchObject({
      ok: false,
      reason: "EXPECTED_SHA not set",
    });
    expect(verifyProvenanceSource(good(), { ...EXPECTED, package: "" })).toMatchObject({
      ok: false,
      reason: "EXPECTED_PACKAGE not set",
    });
  });
});
