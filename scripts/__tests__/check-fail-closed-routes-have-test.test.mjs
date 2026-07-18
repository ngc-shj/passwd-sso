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

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAIL_CLOSED_TEST_ROOT: root,
      FAIL_CLOSED_TEST_DEBT_FILE: debtFile,
      FAIL_CLOSED_TEST_LEGACY_FILE: legacyFile,
      // Fixture-mode default so the env-pollution guard does not fire under
      // CI=true; the pollution-guard test overrides it back to "".
      FAIL_CLOSED_TEST_FIXTURE_MODE: "1",
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeRoute(rel, body) {
  const dir = join(apiDir, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "route.ts"), body, "utf8");
  return `src/app/api/${rel}/route.ts`;
}

function writeAdjacentTest(rel, body) {
  writeFileSync(join(apiDir, rel, "route.test.ts"), body, "utf8");
}

const FAIL_CLOSED_LINE =
  'const limiter = rateLimiter({ failClosedOnRedisError: true });\n';

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fail-closed-test-"));
  apiDir = join(root, "src/app/api");
  debtFile = join(root, "scripts/checks/fail-closed-test-debt.txt");
  legacyFile = join(root, "scripts/checks/fail-closed-legacy-direct.txt");
  mkdirSync(apiDir, { recursive: true });
  mkdirSync(dirname(debtFile), { recursive: true });
  writeFileSync(debtFile, "# fixture debt list\n", "utf8");
  writeFileSync(legacyFile, "# fixture legacy list\n", "utf8");
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

  it("passes when the opt-in route is listed in the debt file", () => {
    const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
    writeFileSync(debtFile, `${rel}\n`, "utf8");
    const { exitCode } = runGuard();
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

    it("bridge-code shape stays green while its debt entry exists, and FAILS the moment the entry is dropped", () => {
      // The exact drift path the review demonstrated: debt says untested,
      // the old gate said tested. Now the debt entry is load-bearing.
      const rel = writeRoute("widgets/bridge", FAIL_CLOSED_LINE);
      writeAdjacentTest(
        "widgets/bridge",
        'mockCheckRateLimitOrFail.mockResolvedValueOnce(null); // redisErrored\n',
      );
      writeFileSync(debtFile, `${rel}\n`, "utf8");
      expect(runGuard().exitCode).toBe(0);
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
it("fails closed", async () => {
  await assertFailClosed({ failure: { allowed: false, redisErrored: true } });
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
      const { exitCode, stdout } = runGuard();
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
      writeRoute("widgets/open", "const limiter = rateLimiter({});\n");
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

  describe("real repo (no overrides)", () => {
    it("passes against the actual repo source tree (incl. AC4.4/AC4.5 counts)", () => {
      const r = spawnSync("bash", [GUARD], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  });
});
