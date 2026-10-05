/**
 * Self-test for scripts/checks/check-npm-audit.mjs: the dev-scope audit gate
 * with expiring suppressions. Driven through its seams (NPM_AUDIT_JSON,
 * CHECK_NPM_AUDIT_TODAY, --suppressions) so no network is needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "..", "checks", "check-npm-audit.mjs");
const REAL_SUPPRESSIONS = resolve(__dirname, "..", "checks", "npm-audit-suppressions.json");

const TODAY = "2026-10-05";
const GHSA = "GHSA-vfj7-8cjw-p6xm";
const REASON = "dev scope only; patterns come from this repository, never external input";

const advisory = (overrides = {}) => ({
  source: 1,
  name: "braces",
  dependency: "braces",
  title: "stack exhaustion",
  url: `https://github.com/advisories/${GHSA}`,
  severity: "high",
  range: "<=3.0.3",
  ...overrides,
});

const report = (vias, extra = {}) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    braces: { name: "braces", severity: "high", via: vias },
    // A dependent: vulnerable only through the root above, named by string.
    micromatch: { name: "micromatch", severity: "high", via: ["braces"] },
    ...extra,
  },
  metadata: {},
});

const suppression = (overrides = {}) => ({
  id: GHSA, package: "braces", reason: REASON, expires: "2026-12-01", ...overrides,
});

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "npm-audit-gate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run({ audit, suppressions = [], today = TODAY, rawAudit }) {
  const auditPath = join(dir, "audit.json");
  const supPath = join(dir, "suppressions.json");
  writeFileSync(auditPath, rawAudit ?? JSON.stringify(audit));
  writeFileSync(supPath, JSON.stringify({ suppressions }));
  return spawnSync("node", [SCRIPT, "--suppressions", supPath], {
    env: { PATH: process.env.PATH, NPM_AUDIT_JSON: auditPath, CHECK_NPM_AUDIT_TODAY: today },
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("check-npm-audit.mjs", () => {
  it("passes a clean report", () => {
    const r = run({ audit: { auditReportVersion: 2, vulnerabilities: {}, metadata: {} } });
    expect(r.status, r.stderr).toBe(0);
  });

  it("fails an unsuppressed high advisory and names it", () => {
    const r = run({ audit: report([advisory()]) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${GHSA} (braces, high)`);
  });

  it("fails an unsuppressed critical advisory", () => {
    const r = run({ audit: report([advisory({ severity: "critical" })]) });
    expect(r.status).toBe(1);
  });

  it("ignores advisories below high", () => {
    const r = run({ audit: report([advisory({ severity: "moderate" })]) });
    expect(r.status, r.stderr).toBe(0);
  });

  it("passes a high advisory covered by an unexpired suppression", () => {
    const r = run({ audit: report([advisory()]), suppressions: [suppression()] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`suppressed: ${GHSA} (braces) until 2026-12-01`);
  });

  it("still fails a second advisory the suppression does not name", () => {
    const other = advisory({ name: "fast-glob", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" });
    const r = run({ audit: report([advisory(), other]), suppressions: [suppression()] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("GHSA-aaaa-bbbb-cccc (fast-glob, high)");
    expect(r.stderr).not.toContain(`${GHSA} (braces, high)`);
  });

  it("does not let a suppression for one package cover the same id on another", () => {
    const r = run({ audit: report([advisory()]), suppressions: [suppression({ package: "micromatch" })] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${GHSA} (braces, high)`);
  });

  it("fails once the suppression has expired", () => {
    const r = run({ audit: report([advisory()]), suppressions: [suppression({ expires: "2026-10-04" })] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("suppression expired on 2026-10-04");
  });

  it("accepts a suppression on its expiry day", () => {
    const r = run({ audit: report([advisory()]), suppressions: [suppression({ expires: TODAY })] });
    expect(r.status, r.stderr).toBe(0);
  });

  it("refuses an expiry more than 90 days out", () => {
    const r = run({ audit: report([advisory()]), suppressions: [suppression({ expires: "2027-01-04" })] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("more than 90 days out");
  });

  it("accepts an expiry exactly 90 days out", () => {
    const r = run({ audit: report([advisory()]), suppressions: [suppression({ expires: "2027-01-03" })] });
    expect(r.status, r.stderr).toBe(0);
  });

  it("fails a suppression that matches no current advisory", () => {
    const r = run({ audit: { auditReportVersion: 2, vulnerabilities: {}, metadata: {} }, suppressions: [suppression()] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("matches no current advisory");
  });

  it.each([
    ["a non-GHSA id", { id: "CVE-2026-1234" }, "id must be a GHSA id"],
    ["an empty reason", { reason: "" }, "reason must explain"],
    ["an impossible date", { expires: "2026-02-30" }, "expires must be a YYYY-MM-DD date"],
  ])("refuses a suppression with %s", (_name, overrides, msg) => {
    const r = run({ audit: report([advisory()]), suppressions: [suppression(overrides)] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(msg);
  });

  it("fails a high advisory it cannot identify by GHSA id", () => {
    const r = run({ audit: report([advisory({ url: "https://example.test/advisory/1" })]) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("without a GHSA url");
  });

  it.each([
    ["non-JSON output", "npm ERR! network", "not JSON"],
    ["an npm error report", JSON.stringify({ error: { code: "ENOAUDIT", summary: "audit endpoint down" } }), "audit endpoint down"],
    ["an unexpected report version", JSON.stringify({ auditReportVersion: 1, advisories: {} }), "auditReportVersion 2"],
  ])("fails closed on %s", (_name, rawAudit, msg) => {
    const r = run({ rawAudit });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(msg);
  });

  it("ships suppressions that are well-formed and within the 90-day bound", () => {
    // Validates the committed file against a report containing exactly the
    // advisories it names, so a malformed or over-long entry is caught here
    // rather than first in CI's audit job.
    const committed = JSON.parse(readFileSync(REAL_SUPPRESSIONS, "utf8")).suppressions;
    const vias = committed.map((s) => advisory({ name: s.package, url: `https://github.com/advisories/${s.id}` }));
    const auditPath = join(dir, "audit.json");
    writeFileSync(auditPath, JSON.stringify(report(vias)));
    const r = spawnSync("node", [SCRIPT], {
      env: { PATH: process.env.PATH, NPM_AUDIT_JSON: auditPath },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.status, r.stderr).toBe(0);
  });
});
