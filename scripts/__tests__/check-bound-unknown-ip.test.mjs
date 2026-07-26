/**
 * Self-test for scripts/checks/check-bound-unknown-ip.mjs — the M2 completeness
 * gate that fails when a checkIpRateLimit call site leaves IP-less traffic
 * fail-open without being on the exclusion manifest.
 *
 * RT7: red-proven by the exact regression that shipped — an unbound, unlisted
 * scope (the magic-link miss). Also proves manifest completeness both ways
 * (stale entry: vanished / now-bound).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-bound-unknown-ip.mjs");

let root;
let manifestPath;

function runGuard() {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      BOUND_UNKNOWN_IP_ROOT: root,
      BOUND_UNKNOWN_IP_MANIFEST: manifestPath,
    },
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writeSrc(rel, contents) {
  const full = join(root, "src", rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function writeManifest(excluded) {
  manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ excluded_scopes: excluded }), "utf8");
}

const boundCall = (scope) =>
  `await checkIpRateLimit({ ip, pathname: "/x", scope: "${scope}", limiter, boundUnknownIp: true });\n`;
const unboundCall = (scope) =>
  `await checkIpRateLimit({ ip, pathname: "/x", scope: "${scope}", limiter });\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bound-unknown-ip-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-bound-unknown-ip.mjs", () => {
  it("passes when every scope is bound or excluded", () => {
    writeSrc("a/route.ts", boundCall("auth_callback"));
    writeSrc("b/route.ts", unboundCall("csp_report"));
    writeManifest({ csp_report: { reason: "telemetry sink" } });
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("1 documented-exclusion");
  });

  it("FAILS on an unbound, unlisted scope (the magic-link regression)", () => {
    writeSrc("a/route.ts", boundCall("auth_callback"));
    writeSrc("magic/route.ts", unboundCall("magic_link_signin"));
    writeManifest({ csp_report: { reason: "telemetry sink" } });
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout + "").toBeTruthy();
  });

  it("accepts an explicit unknownIpLimiter as bound", () => {
    writeSrc(
      "a/route.ts",
      `await checkIpRateLimit({ ip, pathname: "/x", scope: "custom", limiter, unknownIpLimiter: myLimiter });\n`,
    );
    writeManifest({});
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("FAILS on a stale manifest entry (excluded scope no longer present)", () => {
    writeSrc("a/route.ts", boundCall("auth_callback"));
    writeManifest({ gone_scope: { reason: "removed long ago" } });
    const { exitCode } = runGuard();
    expect(exitCode).toBe(1);
  });

  it("FAILS on a stale manifest entry (excluded scope is now bound)", () => {
    writeSrc("a/route.ts", boundCall("csp_report"));
    writeManifest({ csp_report: { reason: "should be dropped now" } });
    const { exitCode } = runGuard();
    expect(exitCode).toBe(1);
  });

  it("passes against the real repo + manifest", () => {
    const r = spawnSync("node", [GUARD], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
