/**
 * RT7 self-test for check-workflow-supply-chain.mjs — the guard must be
 * provably able to fail. The current tree has zero auto-merge and no masked
 * verifier, so the live guard passes trivially; these synthetic-string cases
 * prove each detector fires on a planted violation and stays quiet on clean input.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  extractRunCommands,
  findAutoMergeViolation,
  findMaskedVerifierViolations,
  findPublishJobIsolationViolation,
  findTrustedPublishNodeViolation,
  findUnsavedAuditSubjectViolations,
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

// C7 (stale-override-floors): check-override-floor-staleness must be recognized
// as a verifier, and the four masking forms C5 forbids (continue-on-error, || true,
// set +e, an unprotected pipe) must be caught for it — without false-reddening the
// real release.yml/dependency-signatures.yml workflows, which the plan measured a
// naive pipe rule to do (release.yml :210 and :268).
describe("findMaskedVerifierViolations — check-override-floor-staleness (C7)", () => {
  it("flags continue-on-error: true on a workflow invoking the new gate", () => {
    const wf = [
      "jobs:",
      "  staleness:",
      "    steps:",
      "      - run: node scripts/checks/check-override-floor-staleness.mjs",
      "        continue-on-error: true",
    ].join("\n");
    const v = findMaskedVerifierViolations(wf, "override-floor-staleness.yml");
    expect(v.some((m) => /continue-on-error/.test(m))).toBe(true);
  });

  it("flags || true on an invocation of the new gate", () => {
    const wf = [
      "    steps:",
      "      - run: node scripts/checks/check-override-floor-staleness.mjs || true",
    ].join("\n");
    const v = findMaskedVerifierViolations(wf, "override-floor-staleness.yml");
    expect(v.some((m) => /masked/.test(m))).toBe(true);
  });

  it("flags set +e ahead of the new gate in the same run block", () => {
    const wf = [
      "    steps:",
      "      - run: |",
      "          set +e",
      "          node scripts/checks/check-override-floor-staleness.mjs",
    ].join("\n");
    const v = findMaskedVerifierViolations(wf, "override-floor-staleness.yml");
    expect(v.some((m) => /masked/.test(m))).toBe(true);
  });

  it("flags set +o errexit, the long-option spelling of the same disable", () => {
    // `pipefailRe` on these same lines already had to handle `-o`'s long form,
    // so covering only the `+e` cluster left one function disagreeing with
    // itself about shell syntax.
    const wf = [
      "    steps:",
      "      - run: |",
      "          set +o errexit",
      "          node scripts/checks/check-override-floor-staleness.mjs",
    ].join("\n");
    const v = findMaskedVerifierViolations(wf, "override-floor-staleness.yml");
    expect(v.some((m) => /masked/.test(m))).toBe(true);
  });

  it("does NOT flag set -o errexit, which is the opposite instruction", () => {
    const wf = [
      "    steps:",
      "      - run: |",
      "          set -o errexit",
      "          node scripts/checks/check-override-floor-staleness.mjs",
    ].join("\n");
    expect(findMaskedVerifierViolations(wf, "override-floor-staleness.yml")).toEqual([]);
  });

  it("flags an unprotected pipe on an invocation of the new gate", () => {
    const wf = [
      "    steps:",
      "      - run: node scripts/checks/check-override-floor-staleness.mjs | tee output.log",
    ].join("\n");
    const v = findMaskedVerifierViolations(wf, "override-floor-staleness.yml");
    expect(v.some((m) => /unprotected pipe|pipefail/.test(m))).toBe(true);
  });

  it("does NOT flag the real release.yml protected-pipe shape (set -euo pipefail, then echo | node -e)", () => {
    const wf = [
      "      - name: Assert published provenance",
      "        run: |",
      "          set -euo pipefail",
      '          VIEW=$(npm view "pkg@1.0.0" --json)',
      '          echo "$VIEW" | node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{try{const j=JSON.parse(d);process.stdout.write(j?.dist?.attestations?.provenance?.predicateType||\'\')}catch{process.stdout.write(\'\')}})"',
    ].join("\n");
    // Not vacuous: this shape must first match the verifier-line predicate.
    expect(/dist\??\.attestations/.test(wf)).toBe(true);
    expect(findMaskedVerifierViolations(wf, "release.yml")).toEqual([]);
  });

  it("does NOT flag the new workflow's unmasked, unpiped invocation", () => {
    const wf = "      - run: node scripts/checks/check-override-floor-staleness.mjs\n";
    expect(findMaskedVerifierViolations(wf, "override-floor-staleness.yml")).toEqual([]);
  });

  it("does NOT flag continue-on-error on an unrelated step in a workflow that runs no verifier (I-7.2)", () => {
    const wf = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - run: npm ci",
      "        continue-on-error: true",
    ].join("\n");
    expect(findMaskedVerifierViolations(wf, "build.yml")).toEqual([]);
  });

  it("does NOT flag a workflow that only mentions the gate in a comment and masks an unrelated step", () => {
    const wf = [
      "jobs:",
      "  build:",
      "    steps:",
      "      # see scripts/checks/check-override-floor-staleness.mjs for the new gate",
      "      - run: npm ci",
      "        continue-on-error: true",
    ].join("\n");
    expect(findMaskedVerifierViolations(wf, "build.yml")).toEqual([]);
  });

  it("stays green on the real release.yml and dependency-signatures.yml (AC-7.3 unit-level echo)", () => {
    const releaseYml = readFileSync(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const depSigYml = readFileSync(
      new URL("../../.github/workflows/dependency-signatures.yml", import.meta.url),
      "utf8",
    );
    expect(findMaskedVerifierViolations(releaseYml, "release.yml")).toEqual([]);
    expect(findMaskedVerifierViolations(depSigYml, "dependency-signatures.yml")).toEqual([]);
  });
});

// The two rules that replaced the "simple top-level command" allowlist. That
// allowlist was measured to be both too loose (seven multi-line constructs
// still masked the exit status) and too tight (five shapes that abort under
// `bash -e` were rejected), so it was removed and the claim narrowed to what
// spelling rules can hold. These two are what a regex CAN decide, and both are
// holes the allowlist never covered.
describe("findMaskedVerifierViolations — the premise rules (shell:, ambient env:)", () => {
  const GATE = "node scripts/checks/check-override-floor-staleness.mjs";
  const step = (extra) => `    steps:\n      - run: ${GATE}\n${extra}`;

  it("DENY: shell: bash {0} removes the -e every other rule assumes", () => {
    const v = findMaskedVerifierViolations(step("        shell: bash {0}\n"), "w.yml");
    expect(v.some((m) => /shell: bash \{0\}/.test(m))).toBe(true);
  });

  it("ALLOW: the bare bash keyword form carries -e and is fine", () => {
    expect(findMaskedVerifierViolations(step("        shell: bash\n"), "w.yml")).toEqual([]);
    expect(findMaskedVerifierViolations(step("        shell: sh\n"), "w.yml")).toEqual([]);
  });

  it("ALLOW: a non-verifier workflow may use any shell it likes", () => {
    const wf = `    steps:\n      - run: npm test\n        shell: python\n`;
    expect(findMaskedVerifierViolations(wf, "w.yml")).toEqual([]);
  });

  it("DENY: an ambient-input env: key on a verifier-running workflow", () => {
    // The gate refuses these at runtime, but a loader named in NODE_OPTIONS
    // runs before its first line and can delete the variable it would have been
    // caught by — so the workflow is the only place this shape is decidable.
    for (const key of [
      "NODE_OPTIONS: --import ./x.mjs",
      "NODE_EXTRA_CA_CERTS: /tmp/ca.pem",
      "NODE_TLS_REJECT_UNAUTHORIZED: \"0\"",
      "HTTPS_PROXY: http://proxy.invalid:8080",
    ]) {
      const v = findMaskedVerifierViolations(step(`        env:\n          ${key}\n`), "w.yml");
      expect(v.some((m) => /redirects, intercepts or instruments/.test(m))).toBe(true);
    }
  });

  it("ALLOW: the token env: the real workflows use, and an ambient key on a non-verifier workflow", () => {
    expect(
      findMaskedVerifierViolations(step("        env:\n          GITHUB_TOKEN: x\n"), "w.yml"),
    ).toEqual([]);
    const noVerifier = `    steps:\n      - run: npm test\n        env:\n          NODE_OPTIONS: --max-old-space-size=4096\n`;
    expect(findMaskedVerifierViolations(noVerifier, "w.yml")).toEqual([]);
  });

  it("DENY: a trap on ERR, in either case — bash reads signal names case-insensitively", () => {
    for (const sig of ["ERR", "err", "Err"]) {
      const wf = `    steps:\n      - run: |\n          trap "exit 0" ${sig}\n          ${GATE}\n`;
      expect(findMaskedVerifierViolations(wf, "w.yml").some((m) => /trap/.test(m))).toBe(true);
    }
  });

  it("ALLOW: release.yml's real EXIT cleanup trap in a verifier block", () => {
    const wf = `    steps:\n      - run: |\n          trap 'rm -rf "$WORK"' EXIT\n          npm audit signatures\n`;
    expect(findMaskedVerifierViolations(wf, "release.yml")).toEqual([]);
  });

  // The five shapes the removed allowlist rejected. Each was measured to exit 1
  // under `bash -e`, so rejecting them was over-blocking — and over-blocking is
  // what gets a gate deleted rather than fixed.
  it("ALLOW: shapes that abort the step anyway are not violations", () => {
    const shapes = [
      `    steps:\n      - run: cd cli && ${GATE}\n`,
      `    steps:\n      - run: timeout 300 ${GATE}\n`,
      `    steps:\n      - run: |\n          ${GATE}\n          echo done\n`,
      `    steps:\n      - run: env FORCE_COLOR=0 npm audit signatures\n`,
      `    steps:\n      - name: npm audit signatures\n        run: npm audit signatures\n`,
    ];
    for (const wf of shapes) expect(findMaskedVerifierViolations(wf, "w.yml")).toEqual([]);
  });
});

// I-5.3 — the PR job that runs the staleness gate must NOT be paths-filtered.
// The gate walks all three manifests every run, so filtering on root
// package.json would skip a cli/-only stale floor: M6's exact shape, and user
// scenario 3. Today that is asserted by a nine-line comment in ci.yml and by
// nothing else — adding `needs: changes` plus an `if:` is a two-line edit that
// silently reinstates the blind spot one of the six original members occupied.
describe("I-5.3 — the override-floor-staleness PR job carries no paths-filter", () => {
  const CI = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

  /**
   * The narrowest structural extraction that answers this question. The repo
   * declares no YAML parser (`js-yaml` resolves only as a transitive eslint /
   * shadcn dependency, so importing it would bind this guard to somebody else's
   * dependency tree), so the `jobs:` block is read by indentation instead: the
   * named job's DIRECT child keys, and its body for the run-command extraction.
   * That is a parse of the job, not a regex over the file.
   */
  function extractJob(workflowText, jobName) {
    const lines = workflowText.split("\n");
    const start = lines.indexOf(`  ${jobName}:`);
    if (start === -1) return null;
    const body = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "" || /^\s*#/.test(line)) {
        body.push(line);
        continue;
      }
      if (!/^ {4}\S/.test(line) && !/^ {5,}/.test(line)) break; // dedented out of the job
      body.push(line);
    }
    return {
      keys: body.filter((l) => /^ {4}[A-Za-z_-]+:/.test(l)).map((l) => l.trim().split(":")[0]),
      body: body.join("\n"),
    };
  }

  const JOB = "override-floor-staleness";
  const job = extractJob(CI, JOB);

  it("the job exists and runs the gate", () => {
    // Guarded with a message so a RENAME reds here, on a sentence that says
    // what to do, rather than downstream on `Cannot read properties of null`.
    expect(job, `no job named '${JOB}' under jobs: in .github/workflows/ci.yml — if it was renamed, move this guard with it`).toBeTruthy();
    // extractRunCommands drops comments, so the nine-line rationale comment in
    // ci.yml cannot satisfy this by mentioning the path.
    expect(extractRunCommands(job.body)).toContain("node scripts/checks/check-override-floor-staleness.mjs");
  });

  it("DENY-shape: it declares neither `needs` nor `if`, so a cli/-only stale floor cannot skip it", () => {
    expect(job.keys, `'${JOB}' gained a job-level key it must not have: ${job.keys.join(", ")}`).not.toContain("needs");
    expect(job.keys).not.toContain("if");
  });

  it("ALLOW: a sibling job that IS legitimately paths-filtered keeps its needs/if", () => {
    // Scoped to one named job on purpose. A repo-wide "no job may declare
    // `needs: changes`" rule would catch app-ci, which is filtered by design —
    // and the extractor must be shown to find those keys when they are present,
    // or the DENY case above passes for the wrong reason.
    const appCi = extractJob(CI, "app-ci");
    expect(appCi, "no job named 'app-ci' in ci.yml").toBeTruthy();
    expect(appCi.keys).toContain("needs");
    expect(appCi.keys).toContain("if");
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

describe("findUnsavedAuditSubjectViolations", () => {
  // Releases 0.4.73 and 0.4.74 both failed the provenance identity check because
  // `npm install --no-save` kept the published package out of the dependency
  // graph, so `npm audit signatures` covered only its 8 dependencies. The gate
  // that would have caught it only runs on a real publish, so the regression was
  // invisible in PR CI — which is what this guard fixes.
  const withAudit = (install) => `
jobs:
  verify:
    steps:
      - name: Verify published package signature
        run: |
          npm init -y
          ${install}
          npm audit signatures --json --include-attestations > "$AUDIT_JSON"
`;

  it("flags a versioned install with --no-save alongside npm audit signatures", () => {
    const v = findUnsavedAuditSubjectViolations(
      withAudit('npm install --no-save --ignore-scripts "passwd-sso-cli@${VERSION}"'),
      "release.yml",
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("--no-save");
    expect(v[0]).toContain("never the package itself");
  });

  it("flags it regardless of flag order", () => {
    const v = findUnsavedAuditSubjectViolations(
      withAudit('npm install --ignore-scripts --no-save "passwd-sso-cli@1.2.3"'),
      "release.yml",
    );
    expect(v).toHaveLength(1);
  });

  // A guard that recognises one spelling of what it forbids is a tripwire, not a
  // boundary: every alias below reintroduces the identical defect, so each needs
  // its own fixture or the guard is bypassable by a routine refactor.
  it.each([
    ['npm i --no-save "passwd-sso-cli@1.0.0"', "install alias `i`"],
    ['npm add --no-save "passwd-sso-cli@1.0.0"', "install alias `add`"],
    ['npm install --save=false "passwd-sso-cli@1.0.0"', "--save=false"],
    ['npm i --save=false "passwd-sso-cli@${VERSION}"', "alias + --save=false"],
  ])("flags the equivalent form: %s", (install) => {
    expect(findUnsavedAuditSubjectViolations(withAudit(install), "release.yml")).toHaveLength(1);
  });

  // The allow side of the same axis: --no-save is only a problem when it applies
  // to a versioned package the audit is meant to cover.
  it.each([
    ["npm ci", "no install of a versioned spec"],
    ["npm install --no-save", "unversioned — installs the manifest, not a subject"],
    ["npm i --no-save eslint", "unversioned package name"],
  ])("stays silent for: %s", (install) => {
    expect(findUnsavedAuditSubjectViolations(withAudit(install), "release.yml")).toEqual([]);
  });

  // The allow side: this is the shape the fix ships, and it must stay silent.
  it("accepts the saved install the verification job now uses", () => {
    expect(
      findUnsavedAuditSubjectViolations(
        withAudit('npm install --ignore-scripts "passwd-sso-cli@${VERSION}"'),
        "release.yml",
      ),
    ).toEqual([]);
  });

  // --no-save is unremarkable outside a verification context; only an install
  // whose package the audit is supposed to cover matters.
  it("ignores --no-save in a workflow that does not audit signatures", () => {
    expect(
      findUnsavedAuditSubjectViolations(
        `jobs:\n  x:\n    steps:\n      - run: npm install --no-save "some-pkg@1.0.0"\n`,
        "ci.yml",
      ),
    ).toEqual([]);
  });

  it("passes against the real release.yml", () => {
    const content = readFileSync(".github/workflows/release.yml", "utf8");
    expect(findUnsavedAuditSubjectViolations(content, "release.yml")).toEqual([]);
  });
});
