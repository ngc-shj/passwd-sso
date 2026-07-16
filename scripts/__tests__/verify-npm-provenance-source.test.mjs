/**
 * Self-test for scripts/checks/verify-npm-provenance-source.mjs — the provenance
 * SOURCE-IDENTITY verifier. It must bind a published package to THIS repo,
 * commit, and workflow (all exact) and fail closed on any divergence. A
 * regression that relaxed the match would be a security false-green, so every
 * failure mode gets a fixture (RT7 — provably able to fail).
 */
import { describe, it, expect } from "vitest";
import { verifyProvenanceSource } from "../checks/verify-npm-provenance-source.mjs";

const EXPECTED = {
  repo: "ngc-shj/passwd-sso",
  sha: "deadbeefcafedeadbeefcafedeadbeefcafe0000",
  workflow: ".github/workflows/release.yml",
  ref: "refs/heads/main",
};

/** Build an npm attestation bundle with a single SLSA v1 provenance. */
function bundle({
  repo = "https://github.com/ngc-shj/passwd-sso",
  sha = EXPECTED.sha,
  path = ".github/workflows/release.yml",
  ref = "refs/heads/main",
  depUri = `git+https://github.com/ngc-shj/passwd-sso@refs/heads/main`,
  omitWorkflow = false,
  omitPayload = false,
  extraProvenance = null,
} = {}) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://github.com/actions/runner",
        externalParameters: omitWorkflow ? {} : { workflow: { repository: repo, path, ref } },
        resolvedDependencies: [
          { uri: depUri, digest: sha ? { gitCommit: sha } : {} },
        ],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner" } },
    },
  };
  const payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  const att = {
    predicateType: "https://slsa.dev/provenance/v1",
    bundle: { dsseEnvelope: omitPayload ? {} : { payload } },
  };
  const attestations = [att];
  if (extraProvenance) attestations.unshift(extraProvenance);
  return { attestations };
}

describe("verifyProvenanceSource", () => {
  it("accepts a bundle whose repo, commit, workflow, and ref all match", () => {
    expect(verifyProvenanceSource(bundle(), EXPECTED)).toMatchObject({ ok: true });
  });

  it("rejects a commit-SHA mismatch (same repo)", () => {
    const r = verifyProvenanceSource(bundle({ sha: "0".repeat(40) }), EXPECTED);
    expect(r).toMatchObject({ ok: false, reason: "SHA_MISMATCH" });
  });

  it("rejects a missing source commit", () => {
    const r = verifyProvenanceSource(bundle({ sha: "" }), EXPECTED);
    expect(r).toMatchObject({ ok: false, reason: "MISSING_COMMIT" });
  });

  it("rejects a workflow-path mismatch", () => {
    const r = verifyProvenanceSource(
      bundle({ path: ".github/workflows/evil.yml" }),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "WORKFLOW_MISMATCH" });
  });

  it("rejects a ref mismatch when a ref is asserted", () => {
    const r = verifyProvenanceSource(
      bundle({ ref: "refs/heads/attacker" }),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "REF_MISMATCH" });
  });

  it("does not assert ref when EXPECTED_REF is unset", () => {
    const r = verifyProvenanceSource(bundle({ ref: "refs/heads/anything" }), {
      ...EXPECTED,
      ref: "",
    });
    expect(r).toMatchObject({ ok: true });
  });

  it("rejects a repository mismatch", () => {
    const r = verifyProvenanceSource(
      bundle({ repo: "https://github.com/attacker/passwd-sso" }),
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "REPO_MISMATCH" });
  });

  it("rejects a bundle with no provenance predicate", () => {
    const r = verifyProvenanceSource(
      { attestations: [{ predicateType: "https://spdx.dev/Document" }] },
      EXPECTED,
    );
    expect(r).toMatchObject({ ok: false, reason: "NO_PROVENANCE" });
  });

  it("rejects a corrupt DSSE payload", () => {
    const b = bundle();
    b.attestations[0].bundle.dsseEnvelope.payload = "!!!not-base64-json!!!";
    const r = verifyProvenanceSource(b, EXPECTED);
    expect(r.ok).toBe(false);
    expect(["PAYLOAD_PARSE_ERROR", "NO_MATCHING_PROVENANCE"]).toContain(r.reason);
  });

  it("does NOT accept when the expected repo is only a resolved DEPENDENCY, not the source", () => {
    // Source workflow.repository is the attacker's repo; the expected repo
    // appears only as a resolvedDependency URI. The fallback that scanned
    // dependencies would have wrongly matched — the strict verifier must not.
    const b = bundle({
      repo: "https://github.com/attacker/repo",
      depUri: "git+https://github.com/ngc-shj/passwd-sso@refs/heads/main",
    });
    const r = verifyProvenanceSource(b, EXPECTED);
    expect(r).toMatchObject({ ok: false, reason: "REPO_MISMATCH" });
  });

  it("rejects provenance missing the source repository field", () => {
    const r = verifyProvenanceSource(bundle({ omitWorkflow: true }), EXPECTED);
    expect(r).toMatchObject({ ok: false, reason: "MISSING_SOURCE_REPOSITORY" });
  });

  it("accepts when one of several provenances fully matches", () => {
    const decoy = {
      predicateType: "https://slsa.dev/provenance/v1",
      bundle: {
        dsseEnvelope: {
          payload: Buffer.from(
            JSON.stringify({
              predicateType: "https://slsa.dev/provenance/v1",
              predicate: {
                buildDefinition: {
                  externalParameters: {
                    workflow: {
                      repository: "https://github.com/attacker/repo",
                      path: ".github/workflows/release.yml",
                      ref: "refs/heads/main",
                    },
                  },
                  resolvedDependencies: [
                    {
                      uri: "git+https://github.com/attacker/repo@refs/heads/main",
                      digest: { gitCommit: EXPECTED.sha },
                    },
                  ],
                },
              },
            }),
          ).toString("base64"),
        },
      },
    };
    const r = verifyProvenanceSource(bundle({ extraProvenance: decoy }), EXPECTED);
    expect(r).toMatchObject({ ok: true });
  });

  it("fails closed on an unexpected bundle shape (not an object)", () => {
    expect(verifyProvenanceSource(null, EXPECTED).ok).toBe(false);
    expect(verifyProvenanceSource(42, EXPECTED).ok).toBe(false);
  });

  it("fails closed when expected inputs are missing", () => {
    expect(verifyProvenanceSource(bundle(), { ...EXPECTED, sha: "" })).toMatchObject({
      ok: false,
      reason: "EXPECTED_SHA not set",
    });
    expect(
      verifyProvenanceSource(bundle(), { ...EXPECTED, workflow: "" }),
    ).toMatchObject({ ok: false, reason: "EXPECTED_WORKFLOW not set" });
  });
});
