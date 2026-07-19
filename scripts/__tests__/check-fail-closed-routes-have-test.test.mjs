/**
 * Self-test for scripts/checks/check-fail-closed-routes-have-test.sh (AC4.3)
 * — the CI guard requiring every route with `failClosedOnRedisError: true`
 * to be covered by exactly one mode: shared-helper contract test, a
 * fail-closed-legacy-direct.txt entry (pre-helper direct test), or a
 * fail-closed-test-debt.txt entry.
 *
 * Multi-input gate (test-F10, plan C2): the route-scan root (src/app/api),
 * the debt file AND the legacy file are all read relative to a SINGLE
 * fixture root via FAIL_CLOSED_TEST_ROOT — never per-file overrides — so a
 * fixture route can never end up checked against the real repo's manifests
 * or vice versa. The AC4.4/AC4.5 whole-repo limiter-count invariants are
 * skipped whenever the fixture root is overridden; the "real repo, no
 * overrides" case still exercises them.
 *
 * The false-green shapes demonstrated by the external review of PR #680
 * (comment-only `redisErrored`, describe-label match, mapping-stubbed test
 * a la extension/bridge-code) are pinned here as red fixtures.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-fail-closed-routes-have-test.sh");

let root;
let apiDir;
let debtFile;
let legacyFile;
let manifestFile;

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAIL_CLOSED_TEST_ROOT: root,
      FAIL_CLOSED_TEST_DEBT_FILE: debtFile,
      FAIL_CLOSED_TEST_LEGACY_FILE: legacyFile,
      FAIL_CLOSED_TEST_MANIFEST_FILE: manifestFile,
      // Fixture-mode default so the env-pollution guard does not fire under
      // CI=true; the pollution-guard test overrides it back to "".
      FAIL_CLOSED_TEST_FIXTURE_MODE: "1",
      // Real-repo defaults (0 debt / 16 legacy) are meaningless against an
      // empty fixture tree — default fixture expectations to 0/0 so plain
      // fixtures (no debt, no legacy entries) pass without every test
      // needing to pass these explicitly. Individual ratchet tests override.
      FAIL_CLOSED_EXPECTED_DEBT_COUNT: "0",
      FAIL_CLOSED_EXPECTED_LEGACY_COUNT: "0",
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

// manifestEntries accumulates (path, count) pairs across writeRoute() calls
// within a single test; flushed to MANIFEST_FILE by writeRoute itself so
// every route fixture is self-registering (count=1, matching FAIL_CLOSED_LINE's
// single `createRateLimiter(...)` instantiation) unless a test overwrites the
// manifest explicitly via writeManifest() for a C5-specific scenario.
let manifestEntries;

function writeRoute(rel, body, { count = 1, registerManifest = true } = {}) {
  const dir = join(apiDir, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "route.ts"), body, "utf8");
  const routePath = `src/app/api/${rel}/route.ts`;
  if (registerManifest) {
    manifestEntries.push([routePath, count]);
    writeManifest(manifestEntries);
  }
  return routePath;
}

function writeAdjacentTest(rel, body) {
  writeFileSync(join(apiDir, rel, "route.test.ts"), body, "utf8");
}

function writeManifest(entries) {
  const lines = entries.map(([path, count]) => `${path}\t${count}`);
  writeFileSync(manifestFile, `${lines.length > 0 ? `${lines.join("\n")}\n` : ""}`, "utf8");
}

// Write a NON-ROUTE fail-closed member (a lib limiter / auth.config) plus its
// mapped sibling test, at the exact repo-relative paths the gate's hardcoded
// NON_ROUTE_TEST_MAP recognizes. Registers the member in the manifest and,
// when `legacy: true`, in the legacy manifest. `testBody` is the contents of
// the mapped test; omit to write no test file at all. The 3 real members are
// helper-mode (legacy: false); the legacy path is still exercised for the
// route-parity drift fixtures.
function writeNonRouteMember(memberPath, testPath, testBody, { legacy = true } = {}) {
  const memberAbs = join(root, memberPath);
  mkdirSync(dirname(memberAbs), { recursive: true });
  writeFileSync(memberAbs, FAIL_CLOSED_LINE, "utf8");
  manifestEntries.push([memberPath, 1]);
  writeManifest(manifestEntries);
  if (legacy) writeFileSync(legacyFile, `${memberPath}\n`, "utf8");
  if (testBody !== undefined) {
    const testAbs = join(root, testPath);
    mkdirSync(dirname(testAbs), { recursive: true });
    writeFileSync(testAbs, testBody, "utf8");
  }
}

// A genuine shared-helper contract test for a non-route member (helper mode,
// production mapping NOT stubbed) — the real coverage shape the 3 members use.
const NON_ROUTE_HELPER_TEST = `import { it } from "vitest";
import { assertRedisFailClosedResult } from "@/__tests__/helpers/fail-closed";
import { v1ApiKeyLimiter } from "@/lib/security/rate-limiters";
it("fails closed when Redis is unreachable", async () => {
  await assertRedisFailClosedResult({ limiter: v1ApiKeyLimiter, key: "k" });
});
`;

// The same-shape test but passing a locally-built FAKE limiter — the
// direct-result weakening the resultfake guard rejects (RESULT_HELPER_FAKE_LIMITER).
const NON_ROUTE_RESULT_FAKE_TEST = `import { it, vi } from "vitest";
import { assertRedisFailClosedResult } from "@/__tests__/helpers/fail-closed";
it("fails closed when Redis is unreachable", async () => {
  const limiter = { check: vi.fn(async () => ({ allowed: false, redisErrored: true })) };
  await assertRedisFailClosedResult({ limiter, key: "k" });
});
`;

// Matches the real production shape (`createRateLimiter({ ... })`) — the C5
// AST-authoritative per-file counter only recognizes this callee name, so a
// lookalike helper name (e.g. `rateLimiter(...)`) would count as zero real
// instantiations despite the text literal being present (MANIFEST_COMMENT_LITERAL).
const FAIL_CLOSED_LINE =
  'const limiter = createRateLimiter({ failClosedOnRedisError: true });\n';

// A minimal, well-formed shared-helper contract test (helper mode).
const HELPER_CONTRACT_TEST = `import { it } from "vitest";
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
it("fails closed (503, no mutation) when Redis is unavailable", async () => {
  await assertRedisFailClosed({
    invoke: () => POST(req),
    limiter,
    expectation: { envelope: "canonical" },
    assertNoMutation: [mutationSpy],
    limiterFactory,
    failure: { allowed: false, redisErrored: true },
  });
});
`;

// A helper contract test with TWO assertRedisFailClosed calls — the shape a
// count=2 (multi-limiter) file must have so every limiter's fail-closed path
// is asserted, not just the first.
const HELPER_CONTRACT_TEST_TWO_CALLS = `import { it } from "vitest";
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
const ipLimiter = {};
const tokenLimiter = {};
it("limiter 1 fails closed", async () => {
  await assertRedisFailClosed({ limiter: ipLimiter, failure: { allowed: false, redisErrored: true } });
});
it("limiter 2 fails closed", async () => {
  await assertRedisFailClosed({ limiter: tokenLimiter, failure: { allowed: false, redisErrored: true } });
});
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fail-closed-test-"));
  apiDir = join(root, "src/app/api");
  debtFile = join(root, "scripts/checks/fail-closed-test-debt.txt");
  legacyFile = join(root, "scripts/checks/fail-closed-legacy-direct.txt");
  manifestFile = join(root, "scripts/checks/fail-closed-manifest.txt");
  manifestEntries = [];
  mkdirSync(apiDir, { recursive: true });
  mkdirSync(dirname(debtFile), { recursive: true });
  writeFileSync(debtFile, "# fixture debt list\n", "utf8");
  writeFileSync(legacyFile, "# fixture legacy list\n", "utf8");
  writeFileSync(manifestFile, "# fixture manifest\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-fail-closed-routes-have-test.sh", () => {
  it("FAILS (MISSING_FAIL_CLOSED_TEST) when an opt-in route has no sibling test and no manifest entry", () => {
    const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
    expect(stdout).toContain(rel);
  });

  it("passes when the adjacent test is a genuine shared-helper contract test", () => {
    writeRoute("widgets/purge", FAIL_CLOSED_LINE);
    writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("passes when the __tests__ sibling is a genuine shared-helper contract test", () => {
    writeRoute("widgets/purge", FAIL_CLOSED_LINE);
    const altDir = join(root, "src/__tests__/api/widgets");
    mkdirSync(altDir, { recursive: true });
    writeFileSync(join(altDir, "purge.test.ts"), HELPER_CONTRACT_TEST, "utf8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  // ── Non-route member coverage (external-review Major, 2026-07-19) ────────
  // The 3 non-route fail-closed members (auth.config + 2 lib limiters) live
  // outside src/app/api, so the route loop never classified their tests — the
  // manifest pinned the opt-in flag but nothing verified a live fail-closed
  // test still existed. These fixtures pin that the gate now catches test
  // drift on a non-route member: a removed redisErrored reference, a stubbed
  // mapping, an absent test, and an unmapped new opt-in.
  describe("non-route member coverage", () => {
    const NO_REDIS_TEST = 'it("x", () => { /* no code-level redisErrored */ });\n';

    it("passes when a non-route member's mapped test is a genuine shared-helper contract (helper mode)", () => {
      // The real coverage shape: a fail-closed helper call, mapping not stubbed,
      // NOT in the legacy manifest. This is how the 3 real members classify.
      writeNonRouteMember(
        "src/auth.config.ts",
        "src/auth.config.test.ts",
        NON_ROUTE_HELPER_TEST,
        { legacy: false },
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("FAILS (STALE_LEGACY_ENTRY) when a helper-migrated non-route member still has a legacy entry", () => {
      // Route-parity: a helper-mode member must drop its legacy entry in the
      // same PR (mirrors the route loop's STALE_LEGACY_ENTRY). Without this,
      // a member could migrate to helper mode yet keep inflating the legacy
      // count and mislabeling its migration state.
      writeNonRouteMember(
        "src/auth.config.ts",
        "src/auth.config.test.ts",
        NON_ROUTE_HELPER_TEST,
        { legacy: true },
      );
      const { exitCode, stdout } = runGuard({ FAIL_CLOSED_EXPECTED_LEGACY_COUNT: "1" });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("STALE_LEGACY_ENTRY:");
      expect(stdout).toContain("src/auth.config.ts");
    });

    it("FAILS (LEGACY_TEST_MISSING) when a legacy-mode non-route member's mapped test drops its redisErrored reference", () => {
      writeNonRouteMember("src/auth.config.ts", "src/auth.config.test.ts", NO_REDIS_TEST);
      const { exitCode, stdout } = runGuard({ FAIL_CLOSED_EXPECTED_LEGACY_COUNT: "1" });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("LEGACY_TEST_MISSING:");
      expect(stdout).toContain("src/auth.config.ts");
    });

    it("FAILS (LEGACY_TEST_MISSING) when a legacy-mode non-route member's mapped test is deleted entirely", () => {
      // testBody omitted → no test file written at the mapped path.
      writeNonRouteMember("src/lib/security/rate-limiters.ts", "src/lib/security/rate-limiters.test.ts");
      const { exitCode, stdout } = runGuard({ FAIL_CLOSED_EXPECTED_LEGACY_COUNT: "1" });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("LEGACY_TEST_MISSING:");
      expect(stdout).toContain("src/lib/security/rate-limiters.ts");
    });

    it("FAILS (MAPPING_MOCKED_CONTRACT_TEST) when a non-route member's helper test stubs the production mapping", () => {
      const stubHelperTest = `import { it, vi } from "vitest";
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
vi.mock("@/lib/security/rate-limit-audit", () => ({ checkRateLimitOrFail: vi.fn() }));
it("x", async () => { await assertRedisFailClosed({}); });
`;
      writeNonRouteMember("src/lib/scim/rate-limit.ts", "src/lib/scim/with-scim-auth.test.ts", stubHelperTest);
      const { exitCode, stdout } = runGuard({ FAIL_CLOSED_EXPECTED_LEGACY_COUNT: "1" });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MAPPING_MOCKED_CONTRACT_TEST:");
      expect(stdout).toContain("src/lib/scim/rate-limit.ts");
    });

    it("FAILS (NON_ROUTE_COVERAGE_UNMAPPED) when a new non-route file opts in but is not in the gate's member→test map", () => {
      // A non-route member the hardcoded map does not know about.
      const memberAbs = join(root, "src/lib/security/mystery-limiter.ts");
      mkdirSync(dirname(memberAbs), { recursive: true });
      writeFileSync(memberAbs, FAIL_CLOSED_LINE, "utf8");
      manifestEntries.push(["src/lib/security/mystery-limiter.ts", 1]);
      writeManifest(manifestEntries);
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("NON_ROUTE_COVERAGE_UNMAPPED:");
      expect(stdout).toContain("src/lib/security/mystery-limiter.ts");
    });
  });

  it("passes when the opt-in route is listed in the debt file", () => {
    const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
    writeFileSync(debtFile, `${rel}\n`, "utf8");
    const { exitCode } = runGuard({ FAIL_CLOSED_EXPECTED_DEBT_COUNT: "1" });
    expect(exitCode).toBe(0);
  });

  describe("false-green shapes from the PR #680 external review (red fixtures)", () => {
    it("FAILS when redisErrored appears only in a comment (no helper contract)", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/purge",
        '// TODO: write the redisErrored test\nit("placeholder", () => { expect(true).toBe(true); });\n',
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
      expect(stdout).toContain(rel);
    });

    it("FAILS when redisErrored appears only in a describe label", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/purge",
        'it("redisErrored", () => { expect(true).toBe(true); });\n',
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
      expect(stdout).toContain(rel);
    });

    it("FAILS (bridge-code regression shape): redisErrored fixture + mapping stub, no debt entry", () => {
      // Replicates the extension/bridge-code adjacent test that satisfied
      // the old bare grep: a limiter-level redisErrored fixture whose 503
      // comes from a stubbed checkRateLimitOrFail, not the production
      // mapping. Must NOT count as tested.
      const rel = writeRoute("widgets/bridge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/bridge",
        `mockCheckIpRateLimit.mockResolvedValueOnce({ allowed: false, redisErrored: true });
mockCheckRateLimitOrFail.mockImplementationOnce(async () =>
  new Response(JSON.stringify({ error: "SERVICE_UNAVAILABLE" }), { status: 503 }),
);
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
      expect(stdout).toContain(rel);
    });

    it("bridge-code shape: the debt entry no longer masks the stub once C6 lands (structural gate, SC1)", () => {
      // Pre-C6 drift path the review demonstrated: debt says untested, the
      // old (C3-only) gate said tested while the entry existed, and only
      // failed once the entry was dropped. C6 closes that gap structurally:
      // the mockCheckRateLimitOrFail stub now fails EITHER way, because a
      // debt entry never licenses the anti-pattern (only the frozen
      // exemption list does).
      const rel = writeRoute("widgets/bridge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/bridge",
        'mockCheckRateLimitOrFail.mockResolvedValueOnce(null); // redisErrored\n',
      );
      writeFileSync(debtFile, `${rel}\n`, "utf8");
      const withDebt = runGuard({ FAIL_CLOSED_EXPECTED_DEBT_COUNT: "1" });
      expect(withDebt.exitCode).toBe(1);
      expect(withDebt.stdout).toContain("STUB_MOCKED_RATE_LIMIT_AUDIT:");

      writeFileSync(debtFile, "# emptied\n", "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
    });

    it("FAILS (MAPPING_MOCKED_CONTRACT_TEST) when a helper-call test also stubs the production mapping", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/purge",
        `vi.mock("@/lib/security/rate-limit-audit", () => ({ checkRateLimitOrFail: vi.fn() }));
${HELPER_CONTRACT_TEST}`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MAPPING_MOCKED_CONTRACT_TEST:");
      expect(stdout).toContain(rel);
    });

    it("FAILS when assertRedisFailClosed( appears without the helper import", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/purge",
        '// assertRedisFailClosed( — mentioned in prose only, redisErrored\n',
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
      expect(stdout).toContain(rel);
    });

    it("FAILS when the entire helper import + call lives inside a block comment (AST, not text)", () => {
      // A text-based gate (even one requiring import + call) passes this
      // shape; only AST classification rejects it.
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/purge",
        `/*
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
*/
it("placeholder", () => { expect(true).toBe(true); });
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
      expect(stdout).toContain(rel);
    });

    it("FAILS when the helper call is parked in a function no test invokes (execution binding)", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/purge",
        `import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
async function neverCalled() {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
}
it("placeholder", () => { expect(true).toBe(true); });
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
      expect(stdout).toContain(rel);
    });

    it("FAILS when the only helper contract lives inside it.skip", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/purge",
        `import { it } from "vitest";
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
it.skip("fails closed", async () => {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
});
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
      expect(stdout).toContain(rel);
    });

    it("FAILS when a local function shadows the imported helper", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/purge",
        `import { it } from "vitest";
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
it("shadowed", async () => {
  const assertRedisFailClosed = async () => undefined;
  await assertRedisFailClosed();
});
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
      expect(stdout).toContain(rel);
    });

    it("passes with an alias import called from a real test (symbol binding)", () => {
      writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/purge",
        `import { it } from "vitest";
import { assertRedisFailClosed as assertFailClosed } from "@/__tests__/helpers/fail-closed";
const limiter = {};
it("fails closed", async () => {
  await assertFailClosed({ limiter, failure: { allowed: false, redisErrored: true } });
});
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("FAILS when the contract is registered via a fake local `it` (vitest symbol binding)", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/purge",
        `import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
const it = (_name, _callback) => undefined;
it("not a vitest test", async () => {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
});
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
      expect(stdout).toContain(rel);
    });

    it("FAILS when the only contract sits under it.skipIf(true) (modifier allowlist)", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/purge",
        `import { it } from "vitest";
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
it.skipIf(true)("conditionally skipped", async () => {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
});
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
      expect(stdout).toContain(rel);
    });

    it("FAILS (LEGACY_TEST_MISSING) when a legacy entry's redisErrored is only a describe label (AST, not text)", () => {
      // The exact shape found in the real repo (mcp/authorize:345 et al.)
      // when the classifier went AST-based: label-only references moved 7
      // routes back into debt.
      const rel = writeRoute("widgets/legacy", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/legacy",
        'describe("rate limiting (redisErrored)", () => { it("stub 503", () => { expect(s).toBe(503); }); });\n',
      );
      writeFileSync(legacyFile, `${rel}\n`, "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("LEGACY_TEST_MISSING:");
      expect(stdout).toContain(rel);
    });
  });

  describe("anti-drift: stale / conflicting / dangling manifest entries", () => {
    it("FAILS (STALE_DEBT_ENTRY) when a helper contract test exists but the debt entry remains", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      writeFileSync(debtFile, `${rel}\n`, "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("STALE_DEBT_ENTRY:");
      expect(stdout).toContain(rel);
    });

    it("FAILS (STALE_LEGACY_ENTRY) when a helper contract test exists but the legacy entry remains", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      writeFileSync(legacyFile, `${rel}\n`, "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("STALE_LEGACY_ENTRY:");
      expect(stdout).toContain(rel);
    });

    it("passes for a legacy-direct entry whose sibling test contains redisErrored", () => {
      const rel = writeRoute("widgets/legacy", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/legacy",
        'it("503s when redis errors", () => { expect(rl.redisErrored).toBe(true); });\n',
      );
      writeFileSync(legacyFile, `${rel}\n`, "utf8");
      const { exitCode, stdout } = runGuard({ FAIL_CLOSED_EXPECTED_LEGACY_COUNT: "1" });
      expect(exitCode, stdout).toBe(0);
    });

    it("FAILS (LEGACY_TEST_MISSING) when a legacy entry's sibling test lost redisErrored", () => {
      const rel = writeRoute("widgets/legacy", FAIL_CLOSED_LINE);
      writeAdjacentTest("widgets/legacy", 'it("unrelated", () => {});\n');
      writeFileSync(legacyFile, `${rel}\n`, "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("LEGACY_TEST_MISSING:");
      expect(stdout).toContain(rel);
    });

    it("FAILS (LEGACY_DEBT_CONFLICT) when a route is listed in both manifests", () => {
      const rel = writeRoute("widgets/legacy", FAIL_CLOSED_LINE);
      writeAdjacentTest("widgets/legacy", "// redisErrored direct test\n");
      writeFileSync(legacyFile, `${rel}\n`, "utf8");
      writeFileSync(debtFile, `${rel}\n`, "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("LEGACY_DEBT_CONFLICT:");
      expect(stdout).toContain(rel);
    });

    it("FAILS (DANGLING_ENTRY) when a debt entry's route no longer opts into fail-closed", () => {
      writeRoute("widgets/open", "const limiter = createRateLimiter({});\n", { registerManifest: false });
      writeFileSync(debtFile, "src/app/api/widgets/open/route.ts\n", "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("DANGLING_ENTRY:");
    });

    it("FAILS (DANGLING_ENTRY) when a legacy entry's route no longer opts into fail-closed", () => {
      writeFileSync(legacyFile, "src/app/api/widgets/gone/route.ts\n", "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("DANGLING_ENTRY:");
    });
  });

  describe("env-pollution guard (sec-F6)", () => {
    it("FAILS when CI=true and an override is set without FAIL_CLOSED_TEST_FIXTURE_MODE=1", () => {
      const { exitCode, stdout } = runGuard({ CI: "true", FAIL_CLOSED_TEST_FIXTURE_MODE: "" });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("ENV_POLLUTION_GUARD");
    });

    it("passes under CI=true when FAIL_CLOSED_TEST_FIXTURE_MODE=1 is set and the fixture tree is clean", () => {
      const { exitCode } = runGuard({ CI: "true", FAIL_CLOSED_TEST_FIXTURE_MODE: "1" });
      expect(exitCode).toBe(0);
    });
  });

  // C5 — class manifest pinning + whole-src enumeration (Round 1 M2 actions
  // 1/4). Red fixtures FIRST per the order-of-work invariant: each of these
  // failed before the C5 gate section existed (no manifest checking at all).
  describe("C5 manifest: set equality + AST-authoritative per-file counts", () => {
    it("FAILS (MANIFEST_MISSING_ROUTE) when an opt-in file has no manifest entry", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE, { registerManifest: false });
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      writeManifest([]);
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MANIFEST_MISSING_ROUTE:");
      expect(stdout).toContain(rel);
    });

    it("FAILS (MANIFEST_STALE_ROUTE) when a manifest entry's file no longer opts in", () => {
      writeRoute("widgets/purge", "const limiter = createRateLimiter({});\n", { registerManifest: false });
      writeManifest([["src/app/api/widgets/purge/route.ts", 1]]);
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MANIFEST_STALE_ROUTE:");
    });

    it("FAILS (MANIFEST_COUNT_MISMATCH) when a 2-limiter file has a count-1 manifest entry", () => {
      const rel = writeRoute(
        "widgets/purge",
        `const a = createRateLimiter({ failClosedOnRedisError: true });
const b = createRateLimiter({ failClosedOnRedisError: true });
`,
        { registerManifest: false },
      );
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      writeManifest([["src/app/api/widgets/purge/route.ts", 1]]);
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MANIFEST_COUNT_MISMATCH:");
      expect(stdout).toContain(rel);
    });

    it("FAILS (MANIFEST_COMMENT_LITERAL) when the literal only appears in a comment (grep count exceeds AST count)", () => {
      const rel = writeRoute(
        "widgets/purge",
        '// failClosedOnRedisError: true was removed here\nconst limiter = createRateLimiter({});\n',
        { registerManifest: false },
      );
      writeManifest([["src/app/api/widgets/purge/route.ts", 1]]);
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MANIFEST_COMMENT_LITERAL:");
      expect(stdout).toContain(rel);
    });

    it("FAILS (MANIFEST_PARSE_ERROR) on a malformed manifest line (missing tab)", () => {
      writeRoute("widgets/purge", FAIL_CLOSED_LINE, { registerManifest: false });
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      writeFileSync(manifestFile, "src/app/api/widgets/purge/route.ts 1\n", "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MANIFEST_PARSE_ERROR:");
    });

    it("FAILS (MANIFEST_PARSE_ERROR) on a malformed manifest line (non-numeric count)", () => {
      writeRoute("widgets/purge", FAIL_CLOSED_LINE, { registerManifest: false });
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      writeFileSync(manifestFile, "src/app/api/widgets/purge/route.ts\tone\n", "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MANIFEST_PARSE_ERROR:");
    });

    it("passes when the manifest entry's count matches the AST-authoritative count", () => {
      writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });
  });

  // C6 — structural stub-detection gate (SC1 / parent R3-1). Red fixtures
  // FIRST: none of these tokens existed before the C6 stub-scan section.
  describe("C6 structural stub gate: RECALL-first vi resolution + config-seam guard", () => {
    it("FAILS (STUB_MOCKED_RATE_LIMIT_AUDIT) for a CENTRAL non-sibling stub outside the frozen exemption list", () => {
      writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      const centralDir = join(root, "src/__tests__/api/other");
      mkdirSync(centralDir, { recursive: true });
      writeFileSync(
        join(centralDir, "unrelated.test.ts"),
        `import { vi, it } from "vitest";
vi.mock("@/lib/security/rate-limit-audit", () => ({}));
it("placeholder", () => { expect(true).toBe(true); });
`,
        "utf8",
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("STUB_MOCKED_RATE_LIMIT_AUDIT:");
      expect(stdout).toContain("src/__tests__/api/other/unrelated.test.ts");
    });

    it("FAILS (STUB_DYNAMIC_SPECIFIER) for a vi.doMock with a non-literal specifier anywhere under src", () => {
      writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      const centralDir = join(root, "src/__tests__/api/other");
      mkdirSync(centralDir, { recursive: true });
      writeFileSync(
        join(centralDir, "unrelated.test.ts"),
        `import { vi, it } from "vitest";
const modulePath = "@/lib/security/rate-limit-audit";
vi.doMock(modulePath, () => ({}));
it("placeholder", () => { expect(true).toBe(true); });
`,
        "utf8",
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("STUB_DYNAMIC_SPECIFIER:");
      expect(stdout).toContain("src/__tests__/api/other/unrelated.test.ts");
    });

    it("FAILS (STUB_CONFIG_SEAM) when a fixture vitest config aliases rate-limit-audit", () => {
      writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      writeFileSync(
        join(root, "vitest.config.ts"),
        `export default {
  resolve: { alias: { "@/lib/security/rate-limit-audit": "./test/stub-rate-limit-audit.ts" } },
};
`,
        "utf8",
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("STUB_CONFIG_SEAM:");
    });

    it("FAILS (STUB_CONFIG_SEAM) when a fixture vitest config aliases security/rate-limiters", () => {
      // Aliasing the direct-result limiter module swaps v1ApiKeyLimiter for a
      // fake while every import binding still looks production-legitimate —
      // same evasion class as aliasing rate-limit-audit (external review round 6).
      writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      writeFileSync(
        join(root, "vitest.config.ts"),
        `export default {
  resolve: { alias: { "@/lib/security/rate-limiters": "./test/fake-limiters.ts" } },
};
`,
        "utf8",
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("STUB_CONFIG_SEAM:");
      expect(stdout).toContain("security/rate-limiters");
    });

    it("FAILS (STUB_MOCKED_RATE_LIMIT_AUDIT) for a stub in a MULTILINE setupFiles array", () => {
      // A setup file listed across multiple lines (the common prettier shape)
      // must still be scanned — the old same-line grep missed it, letting a
      // stub parked there evade C6 (external review 2026-07-19, round 2).
      writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      const setupAbs = join(root, "src/__tests__/evil-setup.ts");
      mkdirSync(dirname(setupAbs), { recursive: true });
      writeFileSync(
        setupAbs,
        `import { vi } from "vitest";
vi.mock("@/lib/security/rate-limit-audit", () => ({ checkRateLimitOrFail: vi.fn() }));
`,
        "utf8",
      );
      writeFileSync(
        join(root, "vitest.config.ts"),
        `export default {
  test: {
    setupFiles: [
      "src/__tests__/evil-setup.ts",
    ],
  },
};
`,
        "utf8",
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("STUB_MOCKED_RATE_LIMIT_AUDIT:");
      expect(stdout).toContain("src/__tests__/evil-setup.ts");
    });

    it("FAILS (STUB_MOCKED_RATE_LIMITERS_MODULE) when a SETUP FILE mocks the rate-limiters module", () => {
      // A setup file carries no helper call, so resultfake stays 0 — but
      // registering it in setupFiles swaps v1ApiKeyLimiter for a fake across
      // every test. The C6 scan rejects resultmodulemock=1 in setup files
      // regardless of helper calls (external review 2026-07-19, round 7).
      writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      const setupAbs = join(root, "src/__tests__/limiter-setup.ts");
      mkdirSync(dirname(setupAbs), { recursive: true });
      writeFileSync(
        setupAbs,
        `import { vi } from "vitest";
vi.mock("@/lib/security/rate-limiters", () => ({ v1ApiKeyLimiter: { check: vi.fn() } }));
`,
        "utf8",
      );
      writeFileSync(
        join(root, "vitest.config.ts"),
        `export default { test: { setupFiles: ["src/__tests__/limiter-setup.ts"] } };\n`,
        "utf8",
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("STUB_MOCKED_RATE_LIMITERS_MODULE:");
      expect(stdout).toContain("src/__tests__/limiter-setup.ts");
    });

    it("passes when an ORDINARY test file mocks rate-limiters for its own limiter (not a setup file)", () => {
      // A per-file rate-limiters mock only affects that file's own unrelated
      // limiter (e.g. migrateLimiter) — legitimate, must NOT fire.
      writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeAdjacentTest("widgets/purge", HELPER_CONTRACT_TEST);
      const otherDir = join(root, "src/__tests__/api/other");
      mkdirSync(otherDir, { recursive: true });
      writeFileSync(
        join(otherDir, "migrate.test.ts"),
        `import { it, vi } from "vitest";
vi.mock("@/lib/security/rate-limiters", () => ({ migrateLimiter: { check: vi.fn() } }));
it("x", () => {});
`,
        "utf8",
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
      expect(stdout).not.toContain("STUB_MOCKED_RATE_LIMITERS_MODULE:");
    });

    it("passes for a stub in an EXEMPT frozen-list file (tenant/service-accounts sibling shape)", () => {
      const rel = writeRoute("tenant/service-accounts", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "tenant/service-accounts",
        `import { vi, it } from "vitest";
vi.mock("@/lib/security/rate-limit-audit", () => ({}));
it("legacy direct", () => { expect(rl.redisErrored).toBe(true); });
`,
      );
      writeFileSync(legacyFile, `${rel}\n`, "utf8");
      const { exitCode, stdout } = runGuard({ FAIL_CLOSED_EXPECTED_LEGACY_COUNT: "1" });
      expect(exitCode, stdout).toBe(0);
      expect(stdout).not.toContain("STUB_MOCKED_RATE_LIMIT_AUDIT:");
    });
  });

  // Multi-limiter coverage (external review 2026-07-19, round 2): a helper-mode
  // file must have at least as many assertRedisFailClosed* calls as the limiter
  // count the manifest declares — one call in a 2-limiter file leaves the
  // second limiter's fail-closed path untested.
  describe("multi-limiter files require a contract per limiter", () => {
    it("FAILS (HELPER_CALLS_BELOW_LIMITER_COUNT) when a count=2 file has only 1 helper call", () => {
      const rel = writeRoute("widgets/multi", `${FAIL_CLOSED_LINE}${FAIL_CLOSED_LINE}`, {
        count: 2,
      });
      writeAdjacentTest("widgets/multi", HELPER_CONTRACT_TEST); // 1 call only
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("HELPER_CALLS_BELOW_LIMITER_COUNT:");
      expect(stdout).toContain(rel);
    });

    it("FAILS (HELPER_CALLS_BELOW_LIMITER_COUNT) when a count=2 file asserts the SAME limiter twice", () => {
      // Two helper calls but the SAME limiter symbol → distinct=1 < 2. Call
      // count alone would be satisfied; distinct-limiter accounting is what
      // catches the second limiter going untested (external review round 3).
      const rel = writeRoute("widgets/multi", `${FAIL_CLOSED_LINE}${FAIL_CLOSED_LINE}`, {
        count: 2,
      });
      writeAdjacentTest(
        "widgets/multi",
        `import { it } from "vitest";
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
const onlyLimiter = {};
it("1", async () => { await assertRedisFailClosed({ limiter: onlyLimiter, failure: { allowed: false, redisErrored: true } }); });
it("2", async () => { await assertRedisFailClosed({ limiter: onlyLimiter, failure: { allowed: false, redisErrored: true } }); });
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("HELPER_CALLS_BELOW_LIMITER_COUNT:");
      expect(stdout).toContain(rel);
    });

    it("passes when a count=2 file asserts one DISTINCT limiter per limiter", () => {
      writeRoute("widgets/multi", `${FAIL_CLOSED_LINE}${FAIL_CLOSED_LINE}`, { count: 2 });
      writeAdjacentTest("widgets/multi", HELPER_CONTRACT_TEST_TWO_CALLS);
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });
  });

  // Direct-result tier must probe the real limiter, not a fixed-result fake
  // (external review 2026-07-19, round 3).
  describe("direct-result helper requires a real limiter", () => {
    it("FAILS (RESULT_HELPER_FAKE_LIMITER) when a non-route member passes a fake to assertRedisFailClosedResult", () => {
      writeNonRouteMember(
        "src/lib/security/rate-limiters.ts",
        "src/lib/security/rate-limiters.test.ts",
        NON_ROUTE_RESULT_FAKE_TEST,
        { legacy: false },
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("RESULT_HELPER_FAKE_LIMITER:");
      expect(stdout).toContain("src/lib/security/rate-limiters.ts");
    });

    it("passes when the direct-result member imports the production limiter", () => {
      writeNonRouteMember(
        "src/lib/security/rate-limiters.ts",
        "src/lib/security/rate-limiters.test.ts",
        NON_ROUTE_HELPER_TEST,
        { legacy: false },
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });
  });

  // C3/C5 re-entry ratchets (Round 1 m13, Round 2 S2-5) — exact equality,
  // fixture-overridable per the Fixture-executability rules (F-R2-1/S2-6).
  describe("C3/C5 re-entry ratchets: EXPECTED_DEBT_COUNT / EXPECTED_LEGACY_COUNT", () => {
    it("FAILS (EXPECTED_DEBT_COUNT) when a 1-entry debt list mismatches the default expectation of 0", () => {
      const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
      writeFileSync(debtFile, `${rel}\n`, "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("EXPECTED_DEBT_COUNT FAIL:");
    });

    it("FAILS (EXPECTED_LEGACY_COUNT) when a 17-entry legacy list mismatches an override of 16", () => {
      const legacyRoutes = [];
      for (let i = 0; i < 17; i++) {
        const rel = writeRoute(`widgets/legacy${i}`, FAIL_CLOSED_LINE);
        writeAdjacentTest(`widgets/legacy${i}`, `it("x", () => { expect(rl.redisErrored).toBe(true); });\n`);
        legacyRoutes.push(rel);
      }
      writeFileSync(legacyFile, `${legacyRoutes.join("\n")}\n`, "utf8");
      const { exitCode, stdout } = runGuard({ FAIL_CLOSED_EXPECTED_LEGACY_COUNT: "16" });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("EXPECTED_LEGACY_COUNT FAIL:");
    });
  });

  describe("real repo (no overrides)", () => {
    // End-state assertion (fail-closed-tranche2, all batches landed): the real
    // repo now passes the gate cleanly — debt burned to 0, legacy pinned at 16
    // (13 routes + 3 lib members), the manifest set-equality + per-file counts
    // match the tree, and every rate-limit-audit stub is either migrated
    // (C7/C8b) or one of the 4 frozen tenant/* legacy exemptions. This test
    // pins the clean state so ANY regression — a re-added debt entry, a
    // dropped opt-in flag, a new stub, manifest drift — fails loudly.
    it("passes cleanly with the tranche-2 burndown applied", () => {
      // The real-repo run classifies the whole src/app/api sibling-test set
      // PLUS every *.test.ts(x) under src for the C6 stub scan (~2 batched
      // ts-morph invocations over hundreds of files) — slower than the
      // isolated-fixture cases above; raised timeout accordingly.
      const r = spawnSync("bash", [GUARD], { encoding: "utf8" });
      expect(r.stdout + r.stderr).not.toContain("FAIL");
      expect(r.stdout).not.toContain("MANIFEST_MISSING_ROUTE:");
      expect(r.stdout).not.toContain("MANIFEST_STALE_ROUTE:");
      expect(r.stdout).not.toContain("MANIFEST_COUNT_MISMATCH:");
      expect(r.stdout).not.toContain("MANIFEST_COMMENT_LITERAL:");
      expect(r.stdout).not.toContain("MANIFEST_PARSE_ERROR:");
      expect(r.stdout).not.toContain("CLASSIFIER_FAILURE:");
      expect(r.stdout).not.toContain("STUB_MOCKED_RATE_LIMIT_AUDIT:");
      expect(r.stdout).not.toContain("STUB_DYNAMIC_SPECIFIER:");
      expect(r.stdout).not.toContain("STUB_CONFIG_SEAM:");
      expect(r.stdout).not.toContain("DANGLING_ENTRY:");
      expect(r.status).toBe(0);
    }, 60_000);
  });
});
