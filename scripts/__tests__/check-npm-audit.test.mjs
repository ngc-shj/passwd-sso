/**
 * Self-test for scripts/checks/check-npm-audit.mjs: the production and
 * whole-tree audit gates with expiring, scoped suppressions. Driven through its seams (NPM_AUDIT_JSON,
 * CHECK_NPM_AUDIT_TODAY, --suppressions) so no network is needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "..", "checks", "check-npm-audit.mjs");
const REAL_SUPPRESSIONS = resolve(__dirname, "..", "checks", "npm-audit-suppressions.json");
const CI_WORKFLOW = resolve(__dirname, "..", "..", ".github", "workflows", "ci.yml");

const TODAY = "2026-10-05";
const GHSA = "GHSA-vfj7-8cjw-p6xm";
const REASON = "dev scope only; patterns come from this repository, never external input";
const NODES = ["node_modules/braces", "node_modules/fast-glob/node_modules/braces"];
const DEV_NODE = "node_modules/vite/node_modules/braces";

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

const report = (vias, extra = {}, nodes = NODES) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    braces: { name: "braces", severity: "high", via: vias, nodes },
    // A dependent: vulnerable only through the root above, named by string.
    micromatch: { name: "micromatch", severity: "high", via: ["braces"] },
    ...extra,
  },
  metadata: {},
});

const suppression = (overrides = {}) => ({
  id: GHSA, package: "braces", scope: "dev", reason: REASON, expires: "2026-12-01", ...overrides,
});
const prodSuppression = (overrides = {}) => suppression({ scope: "production", nodes: NODES, ...overrides });

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "npm-audit-gate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run({ audit, suppressions = [], today = TODAY, rawAudit, args = [] }) {
  const auditPath = join(dir, "audit.json");
  const supPath = join(dir, "suppressions.json");
  writeFileSync(auditPath, rawAudit ?? JSON.stringify(audit));
  writeFileSync(supPath, JSON.stringify({ suppressions }));
  return spawnSync("node", [SCRIPT, "--suppressions", supPath, ...args], {
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
    ["no scope", { scope: undefined }, 'scope must be "production" or "dev"'],
    ["an unknown scope", { scope: "prod" }, 'scope must be "production" or "dev"'],
    ["a production scope without nodes", { scope: "production" }, 'must list the reviewed install paths in "nodes"'],
    ["a production scope with empty nodes", { scope: "production", nodes: [] }, 'must list the reviewed install paths in "nodes"'],
    ["a production scope with a duplicated node", { scope: "production", nodes: [NODES[0], NODES[0]] }, 'must list the reviewed install paths in "nodes"'],
    ["a production scope with an empty-string node", { scope: "production", nodes: [""] }, 'must list the reviewed install paths in "nodes"'],
    ["a production scope with a non-string node", { scope: "production", nodes: [1] }, 'must list the reviewed install paths in "nodes"'],
    ["empty devNodes", { scope: "production", nodes: NODES, devNodes: [] }, '"devNodes", when present, must be a non-empty list'],
    ["a path in both nodes and devNodes", { scope: "production", nodes: NODES, devNodes: [NODES[0]] }, 'cannot be in both "nodes" and "devNodes"'],
    ["nodes on a dev entry", { nodes: NODES }, '"nodes" and "devNodes" apply only to production entries'],
    ["devNodes on a dev entry", { devNodes: [DEV_NODE] }, '"nodes" and "devNodes" apply only to production entries'],
  ])("refuses a suppression with %s", (_name, overrides, msg) => {
    const r = run({ audit: report([advisory()]), suppressions: [suppression(overrides)] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(msg);
  });

  describe("whole tree with a production-scope suppression", () => {
    // The whole tree reports dev-tree copies under the same package key.
    it("passes when the reported nodes equal nodes plus devNodes", () => {
      const r = run({ audit: report([advisory()], {}, [DEV_NODE, ...NODES]), suppressions: [prodSuppression({ devNodes: [DEV_NODE] })] });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`suppressed: ${GHSA} (braces)`);
      expect(r.stdout).toContain("whole tree");
    });

    it("fails a dev-tree node that is not in devNodes", () => {
      const r = run({ audit: report([advisory()], {}, [...NODES, DEV_NODE]), suppressions: [prodSuppression()] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${DEV_NODE} is not among the reviewed "nodes" or "devNodes"`);
    });

    it("fails a reviewed devNodes path that is no longer installed", () => {
      const r = run({ audit: report([advisory()]), suppressions: [prodSuppression({ devNodes: [DEV_NODE] })] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`reviewed node ${DEV_NODE} is no longer installed`);
    });

    it("does not compare nodes for a dev-scope suppression", () => {
      const r = run({ audit: report([advisory()], {}, [DEV_NODE]), suppressions: [suppression()] });
      expect(r.status, r.stderr).toBe(0);
    });
  });

  it("names the whole-tree remedy for a stale entry", () => {
    const r = run({ audit: { auditReportVersion: 2, vulnerabilities: {}, metadata: {} }, suppressions: [prodSuppression()] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("matches no current advisory — delete it");
  });

  describe("--omit-dev (production tree)", () => {
    it("does not let a dev-scope suppression cover an advisory in the production tree", () => {
      const r = run({ audit: report([advisory()]), suppressions: [suppression()], args: ["--omit-dev"] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${GHSA} (braces, high)`);
    });

    it("passes an advisory covered by a production-scope suppression", () => {
      const r = run({ audit: report([advisory()]), suppressions: [prodSuppression()], args: ["--omit-dev"] });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`suppressed: ${GHSA} (braces) until 2026-12-01`);
      expect(r.stdout).toContain("production tree");
    });

    it("does not report a dev-scope suppression as stale when the production tree lacks its advisory", () => {
      const r = run({ audit: { auditReportVersion: 2, vulnerabilities: {}, metadata: {} }, suppressions: [suppression()], args: ["--omit-dev"] });
      expect(r.status, r.stderr).toBe(0);
    });

    it("fails a production-scope suppression that matches no current advisory", () => {
      const r = run({ audit: { auditReportVersion: 2, vulnerabilities: {}, metadata: {} }, suppressions: [prodSuppression()], args: ["--omit-dev"] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('matches no advisory in the production tree — delete it, or change its scope to "dev"');
    });

    it("ignores devNodes on the production run", () => {
      const r = run({ audit: report([advisory()]), suppressions: [prodSuppression({ devNodes: [DEV_NODE] })], args: ["--omit-dev"] });
      expect(r.status, r.stderr).toBe(0);
    });

    it("passes when the reported nodes equal the reviewed nodes in any order", () => {
      const r = run({ audit: report([advisory()], {}, [...NODES].reverse()), suppressions: [prodSuppression()], args: ["--omit-dev"] });
      expect(r.status, r.stderr).toBe(0);
    });

    it("fails a reported node that was not reviewed", () => {
      const extra = "node_modules/next/node_modules/braces";
      const r = run({ audit: report([advisory()], {}, [...NODES, extra]), suppressions: [prodSuppression()], args: ["--omit-dev"] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${extra} is not among the reviewed "nodes"`);
    });

    it("fails a reviewed node that is no longer installed", () => {
      const r = run({ audit: report([advisory()], {}, [NODES[0]]), suppressions: [prodSuppression()], args: ["--omit-dev"] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`reviewed node ${NODES[1]} is no longer installed`);
    });

    it("fails closed when npm audit reports no nodes to compare", () => {
      const r = run({ audit: report([advisory()], {}, null), suppressions: [prodSuppression()], args: ["--omit-dev"] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("reported no install paths");
    });

    it("still validates dev-scope entries it does not apply", () => {
      const r = run({ audit: report([advisory()]), suppressions: [prodSuppression(), suppression({ expires: "2026-10-04" })], args: ["--omit-dev"] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("suppression expired on 2026-10-04");
    });

    it.each([
      [[], ["audit", "--json"]],
      [["--omit-dev"], ["audit", "--json", "--omit=dev"]],
    ])("runs npm with %j as %j", (args, expected) => {
      // A stand-in npm on PATH records its argv and returns a clean report.
      const argvPath = join(dir, "npm-argv.json");
      const fakeNpm = join(dir, "npm");
      writeFileSync(fakeNpm, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} }));
`);
      chmodSync(fakeNpm, 0o755);
      const supPath = join(dir, "suppressions.json");
      writeFileSync(supPath, JSON.stringify({ suppressions: [] }));
      const r = spawnSync("node", [SCRIPT, "--suppressions", supPath, ...args], {
        env: { PATH: `${dir}:${process.env.PATH}`, CHECK_NPM_AUDIT_TODAY: TODAY },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(readFileSync(argvPath, "utf8"))).toEqual(expected);
    });
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

  it.each([
    ["the whole tree", [], () => true],
    ["the production tree", ["--omit-dev"], (s) => s.scope === "production"],
  ])("ships suppressions that are well-formed and within the 90-day bound for %s", (_name, args, inTree) => {
    // Validates the committed file against a report containing exactly the
    // advisories that tree would show, so a malformed or over-long entry is
    // caught here rather than first in CI's audit job.
    const committed = JSON.parse(readFileSync(REAL_SUPPRESSIONS, "utf8")).suppressions;
    const vulnerabilities = {};
    for (const s of committed.filter(inTree)) {
      const nodes = args.includes("--omit-dev") ? s.nodes : [...(s.nodes ?? []), ...(s.devNodes ?? [])];
      const entry = (vulnerabilities[s.package] ??= { name: s.package, severity: "high", via: [], nodes });
      entry.via.push(advisory({ name: s.package, url: `https://github.com/advisories/${s.id}` }));
    }
    const auditPath = join(dir, "audit.json");
    writeFileSync(auditPath, JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: {} }));
    const r = spawnSync("node", [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, NPM_AUDIT_JSON: auditPath },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("is wired into CI's app audit job for both the production and the whole tree", () => {
    // The production scope rests on one flag in ci.yml: without --omit-dev the
    // production step would become a second whole-tree run honouring dev entries.
    const lines = readFileSync(CI_WORKFLOW, "utf8").split("\n").map((l) => l.trim());
    expect(lines).toContain("- run: node scripts/checks/check-npm-audit.mjs --omit-dev");
    expect(lines).toContain("- run: node scripts/checks/check-npm-audit.mjs");
  });
});
