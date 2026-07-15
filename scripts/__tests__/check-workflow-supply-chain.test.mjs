/**
 * RT7 self-test for check-workflow-supply-chain.mjs — the guard must be
 * provably able to fail. The current tree has zero auto-merge and no masked
 * verifier, so the live guard passes trivially; these synthetic-string cases
 * prove each detector fires on a planted violation and stays quiet on clean input.
 */
import { describe, it, expect } from "vitest";
import {
  findAutoMergeViolation,
  findMaskedVerifierViolations,
} from "../checks/check-workflow-supply-chain.mjs";

describe("findAutoMergeViolation", () => {
  it("flags a workflow pairing dependabot with gh pr merge --auto", () => {
    const wf = `
on: pull_request
jobs:
  automerge:
    if: github.actor == 'dependabot[bot]'
    steps:
      - run: gh pr merge --auto --squash "$PR_URL"
`;
    expect(findAutoMergeViolation(wf, "automerge.yml")).toMatch(/dependabot/);
  });

  it("returns null for a dependabot-mentioning workflow with no merge command", () => {
    const wf = `
# dependabot config reference only
jobs:
  build:
    steps:
      - run: npm ci
`;
    expect(findAutoMergeViolation(wf, "build.yml")).toBeNull();
  });

  it("returns null for a merge command with no dependabot context", () => {
    const wf = `
jobs:
  release:
    steps:
      - run: gh pr merge --auto "$PR"
`;
    expect(findAutoMergeViolation(wf, "release.yml")).toBeNull();
  });
});

describe("findMaskedVerifierViolations", () => {
  it("flags npm audit signatures masked with || true", () => {
    const wf = `
    steps:
      - run: npm audit signatures || true
`;
    const v = findMaskedVerifierViolations(wf, "ci.yml");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/masked/);
  });

  it("flags npm audit signatures masked with ; true", () => {
    const wf = `      - run: npm audit signatures ; true\n`;
    expect(findMaskedVerifierViolations(wf, "ci.yml")).toHaveLength(1);
  });

  it("returns no violations for an unmasked npm audit signatures step", () => {
    const wf = `
    steps:
      - run: npm audit signatures
`;
    expect(findMaskedVerifierViolations(wf, "ci.yml")).toEqual([]);
  });
});
