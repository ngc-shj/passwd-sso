/**
 * RT7 self-test for check-workflow-supply-chain.mjs — the guard must be
 * provably able to fail. The current tree has zero auto-merge and no masked
 * verifier, so the live guard passes trivially; these synthetic-string cases
 * prove each detector fires on a planted violation and stays quiet on clean input.
 */
import { describe, it, expect } from "vitest";
import {
  extractRunCommands,
  findAutoMergeViolation,
  findMaskedVerifierViolations,
  findPublishJobIsolationViolation,
  findTrustedPublishNodeViolation,
  isTrustedPublishingNodeVersion,
  parseTopLevelEnv,
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

  it("flags the peter-evans enable-pull-request-automerge action for dependabot", () => {
    const wf = `
jobs:
  automerge:
    if: github.actor == 'dependabot[bot]'
    steps:
      - uses: peter-evans/enable-pull-request-automerge@v3
`;
    expect(findAutoMergeViolation(wf, "automerge.yml")).toMatch(/auto-merge/);
  });

  it("flags an enablePullRequestAutoMerge GraphQL mutation for dependabot", () => {
    const wf = `
jobs:
  automerge:
    if: github.actor == 'dependabot[bot]'
    steps:
      - run: gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'
`;
    expect(findAutoMergeViolation(wf, "automerge.yml")).not.toBeNull();
  });

  it("flags a REST pulls/N/merge call for dependabot", () => {
    const wf = `
jobs:
  automerge:
    if: github.actor == 'dependabot[bot]'
    steps:
      - run: gh api -X PUT repos/o/r/pulls/123/merge
`;
    expect(findAutoMergeViolation(wf, "automerge.yml")).not.toBeNull();
  });

  it("does NOT false-positive on a bare 'git merge' near the word dependabot", () => {
    const wf = `
# dependabot bumps land on main
jobs:
  sync:
    steps:
      - run: git merge --no-ff origin/main
`;
    expect(findAutoMergeViolation(wf, "sync.yml")).toBeNull();
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

  it("flags npm audit signatures masked with || exit 0", () => {
    const wf = `      - run: npm audit signatures || exit 0\n`;
    expect(findMaskedVerifierViolations(wf, "ci.yml")).toHaveLength(1);
  });

  it("flags npm audit signatures masked with || :", () => {
    const wf = `      - run: npm audit signatures || :\n`;
    expect(findMaskedVerifierViolations(wf, "ci.yml")).toHaveLength(1);
  });

  it("flags a mask split across a shell line-continuation", () => {
    const wf = [
      "    steps:",
      "      - run: |",
      "          npm audit signatures \\",
      "            || true",
    ].join("\n");
    expect(findMaskedVerifierViolations(wf, "ci.yml")).toHaveLength(1);
  });

  it("flags a mask folded across a YAML folded scalar (>)", () => {
    const wf = [
      "    steps:",
      "      - run: >",
      "          npm audit signatures",
      "          || true",
    ].join("\n");
    expect(findMaskedVerifierViolations(wf, "ci.yml")).toHaveLength(1);
  });

  it("flags continue-on-error in the expression form", () => {
    const wf = [
      "    steps:",
      "      - run: npm audit signatures",
      "        continue-on-error: ${{ true }}",
    ].join("\n");
    expect(
      findMaskedVerifierViolations(wf, "ci.yml").some((m) => /continue-on-error/.test(m)),
    ).toBe(true);
  });

  it("flags a provenance assertion (optional-chaining shape) masked with || true", () => {
    // Mirrors the REAL release.yml assertion, which uses optional chaining
    // (j?.dist?.attestations) — the detector must tolerate the `?.`.
    const wf = `      - run: node -e "j?.dist?.attestations?.provenance" || true\n`;
    expect(findMaskedVerifierViolations(wf, "release.yml")).toHaveLength(1);
  });

  it("flags a folded scalar with a trailing comment and an indentation indicator", () => {
    const withComment = [
      "    steps:",
      "      - run: > # folded",
      "          npm audit signatures",
      "          || true",
    ].join("\n");
    expect(findMaskedVerifierViolations(withComment, "ci.yml")).toHaveLength(1);
    const withIndent = [
      "    steps:",
      "      - run: >2",
      "          npm audit signatures",
      "          || true",
    ].join("\n");
    expect(findMaskedVerifierViolations(withIndent, "ci.yml")).toHaveLength(1);
  });

  it("catches continue-on-error when npm view + attestations span separate lines", () => {
    // The real release.yml has `npm view` and `attestations` on different lines;
    // continue-on-error on such a workflow must still be caught.
    const wf = `
    steps:
      - run: |
          VIEW=$(npm view pkg --json)
          echo "$VIEW" | jq .dist.attestations
        continue-on-error: true
`;
    expect(
      findMaskedVerifierViolations(wf, "release.yml").some((m) => /continue-on-error/.test(m)),
    ).toBe(true);
  });

  it("flags continue-on-error on a verifier-running workflow", () => {
    const wf = `
    steps:
      - run: npm audit signatures
        continue-on-error: true
`;
    const v = findMaskedVerifierViolations(wf, "ci.yml");
    expect(v.some((m) => /continue-on-error/.test(m))).toBe(true);
  });

  it("returns no violations for an unmasked npm audit signatures step", () => {
    const wf = `
    steps:
      - run: npm audit signatures
`;
    expect(findMaskedVerifierViolations(wf, "ci.yml")).toEqual([]);
  });

  it("does not flag continue-on-error in a workflow that runs no verifier", () => {
    const wf = `
    steps:
      - run: npm ci
        continue-on-error: true
`;
    expect(findMaskedVerifierViolations(wf, "build.yml")).toEqual([]);
  });
});

describe("findTrustedPublishNodeViolation", () => {
  it("flags an npm-publish workflow that inherits node-version-file (Node 20)", () => {
    const wf = [
      "    steps:",
      "      - uses: actions/setup-node@sha",
      "        with:",
      "          node-version-file: \".nvmrc\"",
      "      - run: npm publish",
    ].join("\n");
    expect(findTrustedPublishNodeViolation(wf, "release.yml")).toMatch(/22\.14/);
  });

  it("passes an npm-publish workflow pinned to node-version 24", () => {
    const wf = [
      "    steps:",
      "      - uses: actions/setup-node@sha",
      "        with:",
      "          node-version: \"24\"",
      "      - run: npm publish",
    ].join("\n");
    expect(findTrustedPublishNodeViolation(wf, "release.yml")).toBeNull();
  });

  it("passes node-version 22.14.x", () => {
    const wf = `          node-version: "22.14.0"\n      - run: npm publish\n`;
    expect(findTrustedPublishNodeViolation(wf, "release.yml")).toBeNull();
  });

  it("flags node-version 20 explicitly for an npm-publish workflow", () => {
    const wf = `          node-version: "20"\n      - run: npm publish\n`;
    expect(findTrustedPublishNodeViolation(wf, "release.yml")).not.toBeNull();
  });

  it("returns null for a workflow that does not run npm publish", () => {
    const wf = `          node-version-file: ".nvmrc"\n      - run: npm ci\n`;
    expect(findTrustedPublishNodeViolation(wf, "ci.yml")).toBeNull();
  });

  it("flags node-version 22.13.1 (below the 22.14 floor)", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    steps:",
      "      - uses: actions/setup-node@sha",
      "        with:",
      "          node-version: \"22.13.1\"",
      "      - run: npm publish",
    ].join("\n");
    expect(findTrustedPublishNodeViolation(wf, "release.yml")).not.toBeNull();
  });

  it("does NOT accept a Node-24 pin that lives in a different job than npm publish", () => {
    const wf = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - uses: actions/setup-node@sha",
      "        with:",
      "          node-version: \"24\"",
      "  publish:",
      "    steps:",
      "      - uses: actions/setup-node@sha",
      "        with:",
      "          node-version-file: \".nvmrc\"",
      "      - run: npm publish",
    ].join("\n");
    expect(findTrustedPublishNodeViolation(wf, "release.yml")).not.toBeNull();
  });

  it("resolves node-version from a top-level env pin (env.PUBLISH_NODE_VERSION)", () => {
    const wf = [
      "env:",
      '  PUBLISH_NODE_VERSION: "24.15.0"',
      "jobs:",
      "  publish:",
      "    steps:",
      "      - uses: actions/setup-node@sha",
      "        with:",
      "          node-version: ${{ env.PUBLISH_NODE_VERSION }}",
      "      - run: npm publish ./p.tgz",
    ].join("\n");
    expect(findTrustedPublishNodeViolation(wf, "release.yml")).toBeNull();
  });

  it("flags an env-resolved node-version below the floor", () => {
    const wf = [
      "env:",
      '  PUBLISH_NODE_VERSION: "20.11.0"',
      "jobs:",
      "  publish:",
      "    steps:",
      "      - uses: actions/setup-node@sha",
      "        with:",
      "          node-version: ${{ env.PUBLISH_NODE_VERSION }}",
      "      - run: npm publish ./p.tgz",
    ].join("\n");
    expect(findTrustedPublishNodeViolation(wf, "release.yml")).not.toBeNull();
  });

  it("passes when the publish job itself pins node-version 24 (sibling job irrelevant)", () => {
    const wf = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: npm ci",
      "  publish:",
      "    steps:",
      "      - uses: actions/setup-node@sha",
      "        with:",
      "          node-version: \"24\"",
      "      - run: npm publish",
    ].join("\n");
    expect(findTrustedPublishNodeViolation(wf, "release.yml")).toBeNull();
  });
});

describe("findPublishJobIsolationViolation", () => {
  it("flags npm ci inside an id-token:write job", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - run: npm ci",
      "      - run: npm publish",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toMatch(/npm install\/ci\/exec/);
  });

  it("flags npm run build inside an id-token:write job", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - run: npm run build",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toMatch(/npm run build/);
  });

  it("flags a bare tsc invocation inside an id-token:write job", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - run: tsc",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toMatch(/tsc/);
  });

  it("flags a path-form tsc invocation inside an id-token:write job", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - run: ./node_modules/.bin/tsc",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toMatch(/tsc/);
  });

  it("does not false-positive on a word ending in tsc (e.g. tsconfig)", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - run: cat tsconfig.json",
      "      - run: npm publish ./pkg.tgz",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toBeNull();
  });

  it("flags even the pinned global npm bootstrap in an id-token:write job (no registry npm fetch under OIDC)", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - run: npm install -g npm@11.12.1 --ignore-scripts",
      "      - run: npm publish ./pkg.tgz",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toMatch(/npm install/);
  });

  it("allows a publish job that uses the bundled npm (no npm install at all)", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - uses: actions/setup-node@sha",
      "      - run: npm publish ./pkg.tgz",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toBeNull();
  });

  it("flags a floating npm@latest bootstrap", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - run: npm install -g npm@latest --ignore-scripts",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).not.toBeNull();
  });

  it.each(["npm i evil", "npm add evil", "npm exec evil", "npm x evil"])(
    "flags the npm install/exec alias %s in an id-token:write job",
    (cmd) => {
      const wf = [
        "jobs:",
        "  publish:",
        "    permissions:",
        "      id-token: write",
        "    steps:",
        `      - run: ${cmd}`,
      ].join("\n");
      expect(findPublishJobIsolationViolation(wf, "release.yml")).not.toBeNull();
    },
  );

  it("does not false-positive on 'npm publish' or 'npm view' in an id-token:write job", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - run: npm publish ./pkg.tgz",
      "      - run: npm view passwd-sso-cli@1.0.0 dist.integrity",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toBeNull();
  });

  it("flags a chained second install command in an id-token:write job", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - run: node --version && npm install evil",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toMatch(/npm install/);
  });

  it("returns null for a clean publish job that only downloads + publishes a tarball", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - uses: actions/download-artifact@sha",
      "      - run: npm publish ./passwd-sso-cli-1.0.0.tgz",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toBeNull();
  });

  it("does NOT flag npm ci in a sibling job that lacks id-token:write", () => {
    const wf = [
      "jobs:",
      "  build:",
      "    permissions:",
      "      contents: read",
      "    steps:",
      "      - run: npm ci --ignore-scripts",
      "      - run: npm run build",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - run: npm publish ./pkg.tgz",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toBeNull();
  });

  it("does not trip on the word 'npm ci' inside a comment in an id-token:write job", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      # Do NOT add npm ci here — this job is OIDC-privileged",
      "      - run: npm publish ./pkg.tgz",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toBeNull();
  });

  it("does not trip on 'npm ci' appearing only in a step name (not a run command)", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - name: run npm ci somewhere",
      "        run: npm publish ./pkg.tgz",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toBeNull();
  });

  it("flags a top-level id-token:write grant applied to a job that runs npm ci", () => {
    const wf = [
      "permissions:",
      "  id-token: write",
      "jobs:",
      "  publish:",
      "    steps:",
      "      - run: npm ci",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toMatch(/npm install\/ci\/exec/);
  });

  it("flags npm ci split across a shell line-continuation inside a block scalar", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - run: |",
      "          npm \\",
      "            ci",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toMatch(/npm install\/ci\/exec/);
  });

  it("flags npm run build inside a block scalar with other benign lines", () => {
    const wf = [
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - run: |",
      "          echo building",
      "          npm run build",
      "          npm publish ./pkg.tgz",
    ].join("\n");
    expect(findPublishJobIsolationViolation(wf, "release.yml")).toMatch(/npm run build/);
  });
});

describe("parseTopLevelEnv", () => {
  it("parses quoted and unquoted top-level env entries", () => {
    const wf = [
      "env:",
      '  PUBLISH_NODE_VERSION: "24.15.0"',
      "  PUBLISH_NPM_VERSION: 11.12.1",
      "jobs:",
      "  build:",
      "    env:",
      "      SHOULD_NOT_APPEAR: nope",
    ].join("\n");
    const env = parseTopLevelEnv(wf);
    expect(env.PUBLISH_NODE_VERSION).toBe("24.15.0");
    expect(env.PUBLISH_NPM_VERSION).toBe("11.12.1");
    expect(env.SHOULD_NOT_APPEAR).toBeUndefined();
  });

  it("returns an empty map when there is no top-level env block", () => {
    expect(parseTopLevelEnv("jobs:\n  build:\n    steps: []")).toEqual({});
  });
});

describe("extractRunCommands", () => {
  it("returns inline run commands and ignores name/env lines", () => {
    const text = [
      "    steps:",
      "      - name: npm ci mention in a name",
      "        run: npm publish ./p.tgz",
    ].join("\n");
    expect(extractRunCommands(text)).toEqual(["npm publish ./p.tgz"]);
  });

  it("splits a block scalar into individual commands and drops comments", () => {
    const text = [
      "      - run: |",
      "          # a comment",
      "          echo hi",
      "          npm ci",
    ].join("\n");
    expect(extractRunCommands(text)).toEqual(["echo hi", "npm ci"]);
  });

  it("joins a line-continuation into a single command", () => {
    const text = ["      - run: |", "          npm \\", "            ci"].join("\n");
    expect(extractRunCommands(text)).toEqual(["npm ci"]);
  });
});

describe("isTrustedPublishingNodeVersion", () => {
  it("rejects the 22.0-22.13 range and bare 22 / 22.x", () => {
    for (const v of ["22", "22.0.0", "22.13.1", "22.x"]) {
      expect(isTrustedPublishingNodeVersion(v), v).toBe(false);
    }
  });
  it("accepts 22.14+, 23, 24, 24.x", () => {
    for (const v of ["22.14.0", "22.15", "23", "24", "24.x"]) {
      expect(isTrustedPublishingNodeVersion(v), v).toBe(true);
    }
  });
  it("rejects below-22 majors", () => {
    for (const v of ["20", "18.19.0"]) {
      expect(isTrustedPublishingNodeVersion(v), v).toBe(false);
    }
  });
});
