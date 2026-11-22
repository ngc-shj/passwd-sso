/**
 * Self-test for scripts/checks/check-coverage-scope.mjs and the member set it
 * shares (scripts/checks/lib/coverage-members.mjs).
 *
 * Two layers (plan C1): the config layer runs the shared checks against the
 * real vitest.config.ts; the output layer runs the gate on summary fixtures.
 * Every refusal has its own case.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MEMBER_PATHSPECS,
  checkScope,
  checkSummary,
  checkThresholdKeys,
  listMembers,
  scopeMatcher,
} from "../checks/lib/coverage-members.mjs";
import { checkCoverageSummaryFile } from "../checks/check-coverage-scope.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const GATE = resolve(REPO, "scripts/checks/check-coverage-scope.mjs");

// Literal, not the module's REQUIRED_MEMBERS: a table read from the subject
// shrinks with it, and a dropped anchor would drop its own test case.
const REQUIRED = ["src/proxy.ts", "src/auth.ts", "proxy.ts", "sentry.server.config.ts"];

// The plan's declared scope. A narrower list must be a reviewed change to this
// test, not an edit to the config alone.
const DECLARED_INCLUDE = [
  "src/**/*.{ts,tsx}",
  "proxy.ts",
  "instrumentation-client.ts",
  "sentry.client.config.ts",
  "sentry.server.config.ts",
];

const realMembers = listMembers();

async function loadConfig(shard) {
  vi.stubEnv("VITEST_COVERAGE_SHARD", shard);
  vi.resetModules();
  return import("../../vitest.config.ts");
}

/** A fake `git ls-files -z` returning the real members, edited by `edit`. */
function fakeGit(edit = (m) => m) {
  return () => `${edit([...realMembers]).join("\0")}\0`;
}

function runGate(summaryPath) {
  try {
    const stdout = execFileSync("node", [GATE, summaryPath], { cwd: REPO, encoding: "utf8", stdio: "pipe" });
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout}${err.stderr}` };
  }
}

let tmp;
afterEach(() => {
  vi.unstubAllEnvs();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function writeTmp(name, content) {
  tmp ??= mkdtempSync(join(tmpdir(), "coverage-scope-"));
  const p = join(tmp, name);
  writeFileSync(p, content);
  return p;
}

function summaryOf(members) {
  const entry = { lines: { total: 1, covered: 1, skipped: 0, pct: 100 } };
  return Object.fromEntries([["total", entry], ...members.map((m) => [join(REPO, m), entry])]);
}

describe("listMembers", () => {
  it("lists the real tree, including the four required paths", () => {
    expect(realMembers.length).toBeGreaterThanOrEqual(1000);
    expect(realMembers).toEqual(expect.arrayContaining(REQUIRED));
  });

  it("queries git with the member pathspecs", () => {
    let seen;
    listMembers((args) => {
      seen = args;
      return fakeGit()();
    });
    expect(seen).toEqual(["ls-files", "-z", "--", ...MEMBER_PATHSPECS]);
  });

  it("drops test files, __tests__ helpers and declaration files", () => {
    const members = listMembers(
      fakeGit((m) => [...m, "src/a.test.ts", "src/b.spec.tsx", "src/__tests__/helper.ts", "src/types/x.d.ts"]),
    );
    expect(members).not.toEqual(expect.arrayContaining(["src/a.test.ts"]));
    expect(members.filter((m) => /test|spec|\.d\.ts$/.test(m) && !realMembers.includes(m))).toEqual([]);
    expect(members).toHaveLength(realMembers.length);
  });

  it("refuses when git fails", () => {
    expect(() =>
      listMembers(() => {
        throw new Error("fatal: not a git repository");
      }),
    ).toThrow(/COVERAGE_MEMBERS_GIT_ERROR/);
  });

  it("refuses an empty set", () => {
    expect(() => listMembers(() => "")).toThrow(/COVERAGE_MEMBERS_EMPTY/);
  });

  it("refuses fewer than 1,000 members", () => {
    expect(() => listMembers(fakeGit((m) => m.slice(0, 999)))).toThrow(/COVERAGE_MEMBERS_TOO_FEW: 999/);
  });

  it.each(REQUIRED)("refuses when the required member %s is absent", (path) => {
    expect(() => listMembers(fakeGit((m) => m.filter((x) => x !== path)))).toThrow(
      new RegExp(`COVERAGE_MEMBERS_REQUIRED_ABSENT: ${path.replace(/\./g, "\\.")}$`),
    );
  });
});

describe("config layer: the real vitest.config.ts", () => {
  it("puts every member in coverage scope", async () => {
    const cfg = await loadConfig("");
    expect(checkScope(cfg.default.test.coverage, realMembers)).toEqual([]);
  });

  it("declares exactly the planned include list", async () => {
    const cfg = await loadConfig("");
    expect(cfg.default.test.coverage.include).toEqual(DECLARED_INCLUDE);
  });

  // CI's app-test sets VITEST_COVERAGE_SHARD=1, under which the config carries
  // no thresholds. loadConfig("") re-imports it with the variable cleared, so
  // these checks read the thresholds the app-coverage merge enforces even
  // when this file runs inside a coverage shard.
  it("has threshold keys that each floor at least one member", async () => {
    const cfg = await loadConfig("");
    expect(checkThresholdKeys(cfg.default.test.coverage.thresholds, realMembers)).toEqual([]);
  });

  it("floors the global aggregates and named files", async () => {
    const { thresholds } = (await loadConfig("")).default.test.coverage;
    expect(thresholds).toMatchObject({ lines: 75, branches: 65, statements: 75 });
    expect(thresholds["src/lib/proxy/auth-gate.ts"]).toEqual({ lines: 95, branches: 92 });
  });

  it("floors every file and each security directory", async () => {
    const { thresholds } = (await loadConfig("")).default.test.coverage;
    expect(thresholds.perFile).toEqual({ statements: 60, lines: 60 });
    for (const dir of ["crypto", "proxy", "security", "audit", "tenant", "auth", "vault"]) {
      expect(thresholds[`src/lib/${dir}/**`]).toMatchObject({
        statements: expect.any(Number),
        lines: expect.any(Number),
        branches: expect.any(Number),
      });
    }
  });

  it("drops thresholds on a coverage shard, so the checks must not read that view", async () => {
    const cfg = await loadConfig("1");
    expect(cfg.default.test.coverage.thresholds).toBeUndefined();
  });
});

describe("checkScope", () => {
  const coverage = { include: DECLARED_INCLUDE, exclude: ["src/**/*.test.{ts,tsx}", "src/**/__tests__/**", "src/**/*.d.ts"] };

  it("reports the members a narrowed include drops", () => {
    const narrowed = { ...coverage, include: ["src/lib/**/*.ts", ...DECLARED_INCLUDE.slice(1)] };
    const missing = checkScope(narrowed, realMembers);
    expect(missing).toContain("src/components/ui/button.tsx");
    expect(missing).not.toContain("src/lib/prisma.ts");
  });

  it("reports the members an added exclude drops", () => {
    const missing = checkScope({ ...coverage, exclude: [...coverage.exclude, "src/app/api/auth/\\[...nextauth\\]/**"] }, realMembers);
    expect(missing).toEqual(["src/app/api/auth/[...nextauth]/route.ts"]);
  });

  it("matches both .well-known routes (dot segments)", () => {
    const wellKnown = realMembers.filter((m) => m.includes("/.well-known/"));
    expect(wellKnown).toHaveLength(2);
    const inScope = scopeMatcher(coverage.include, coverage.exclude);
    expect(wellKnown.filter(inScope)).toEqual(wellKnown);
  });
});

describe("checkThresholdKeys", () => {
  const ok = { lines: 75, branches: 65, statements: 75, functions: 0, perFile: true, autoUpdate: false, 100: false };

  it("accepts reserved keys, an exact member path and a matching glob", () => {
    expect(checkThresholdKeys({ ...ok, "src/proxy.ts": { lines: 1 }, "src/lib/crypto/**": { lines: 1 } }, realMembers)).toEqual([]);
  });

  it("reports a glob that matches no member", () => {
    expect(checkThresholdKeys({ ...ok, "src/lib/no-such-dir/**": { lines: 1 } }, realMembers)).toEqual([
      'COVERAGE_THRESHOLD_GLOB_UNMATCHED: "src/lib/no-such-dir/**" matches no member',
    ]);
  });

  it("reports an exact key that matches no member", () => {
    expect(checkThresholdKeys({ ...ok, "src/lib/renamed-away.ts": { lines: 1 } }, realMembers)).toEqual([
      'COVERAGE_THRESHOLD_PATH_UNMATCHED: "src/lib/renamed-away.ts" matches 0 members, expected exactly 1',
    ]);
  });

  it("refuses undefined thresholds", () => {
    expect(() => checkThresholdKeys(undefined, realMembers)).toThrow(/COVERAGE_THRESHOLDS_MISSING/);
  });

  it("refuses an empty thresholds object", () => {
    expect(() => checkThresholdKeys({}, realMembers)).toThrow(/COVERAGE_THRESHOLDS_EMPTY/);
  });
});

describe("output layer: the coverage summary", () => {
  it("checkSummary relativises absolute keys and ignores total", () => {
    expect(checkSummary(summaryOf(realMembers), realMembers, REPO)).toEqual([]);
  });

  it("reports a summary missing one member", () => {
    const summary = summaryOf(realMembers.filter((m) => m !== "src/auth.ts"));
    expect(checkSummary(summary, realMembers, REPO)).toEqual(["src/auth.ts"]);
  });

  it("reds the gate's exit code on a summary missing one member", () => {
    const p = writeTmp("summary.json", JSON.stringify(summaryOf(realMembers.filter((m) => m !== "proxy.ts"))));
    const { code, output } = runGate(p);
    expect(code).toBe(1);
    expect(output).toContain("COVERAGE_MEMBER_MISSING: proxy.ts");
  });

  it("refuses a missing summary", () => {
    expect(checkCoverageSummaryFile(join(tmpdir(), "no-such-coverage-summary.json"), realMembers, REPO)).toEqual([
      expect.stringMatching(/^COVERAGE_SUMMARY_MISSING: /),
    ]);
  });

  it("refuses an unparseable summary", () => {
    expect(checkCoverageSummaryFile(writeTmp("summary.json", "{ not json"), realMembers, REPO)).toEqual([
      expect.stringMatching(/^COVERAGE_SUMMARY_UNPARSEABLE: /),
    ]);
  });

  it("refuses a summary holding only total", () => {
    expect(checkCoverageSummaryFile(writeTmp("summary.json", JSON.stringify(summaryOf([]))), realMembers, REPO)).toEqual([
      expect.stringMatching(/^COVERAGE_SUMMARY_EMPTY: /),
    ]);
  });

  it("reds the gate's exit code on a missing summary", () => {
    const { code, output } = runGate(join(tmpdir(), "no-such-coverage-summary.json"));
    expect(code).toBe(1);
    expect(output).toContain("COVERAGE_SUMMARY_MISSING");
  });

  it("refuses an empty member list", () => {
    const p = writeTmp("summary.json", JSON.stringify(summaryOf(realMembers)));
    expect(checkCoverageSummaryFile(p, [], REPO)).toEqual(["COVERAGE_MEMBERS_EMPTY: no members to check the summary against"]);
  });

  it("passes the gate on a summary measuring every member of the real tree", () => {
    const { code, output } = runGate(writeTmp("summary.json", JSON.stringify(summaryOf(realMembers))));
    expect(code).toBe(0);
    expect(output).toContain(`check-coverage-scope: OK (${realMembers.length} members measured)`);
  });
});
