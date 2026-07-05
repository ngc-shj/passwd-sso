/**
 * Regression tests for check-bypass-rls.mjs — specifically the F3 anti-drift
 * scan (scripts/checks/check-bypass-rls.mjs:300-333), which flags any file that
 * suppresses an unused `tx` on a with*Rls (tx) => callback with an
 * eslint-disable-next-line no-unused-vars, outside the F3 allowlist.
 *
 * The guard reads its source tree from `src/` relative to the process cwd
 * (`readdirSync("src", ...)`), so each case runs the real CLI with cwd set to an
 * isolated fixture tree — mirroring the file layout the guard keys off of.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("../checks/check-bypass-rls.mjs", import.meta.url));

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bypass-rls-check-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(relPath, source) {
  mkdirSync(join(dir, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(dir, relPath), source, "utf8");
  try {
    const stdout = execFileSync("node", [CHECKER], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stderr: "", stdout };
  } catch (e) {
    return { code: e.status, stderr: e.stderr?.toString() ?? "", stdout: e.stdout?.toString() ?? "" };
  }
}

// F3 violation, isolated: the file IS on the model allowlist (audit-outbox.ts,
// models: auditOutbox) so it does NOT trip the "not on the allowlist" check —
// the ONLY thing wrong is the eslint-disable(no-unused-vars) on an unused `tx`.
// This pins that F3 fires on its own, not just as a side effect of an
// unallowlisted file.
const F3_UNUSED_TX_ON_ALLOWLISTED_FILE = `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function h() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => drain());
}`;

// The sanctioned shape: tenant-context.ts is in F3_UNUSED_TX_DISABLE_ALLOWLIST,
// so its unused-tx delegating wrapper (fn(tenantId) public contract) is allowed.
// A sibling real (tx) => tx.x callback confirms the file still passes the model
// allowlist (tenantMember, team).
const TENANT_CONTEXT_ALLOWED = `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function withTenantContext(tenantId) {
  return withBypassRls(prisma, BYPASS_PURPOSE.CTX, async (tx) => {
    return tx.tenantMember.findFirst({ where: { tenantId } });
  });
}
export async function withTeamContext(tenantId, fn) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return withBypassRls(prisma, BYPASS_PURPOSE.CTX, async (tx) => fn(tenantId));
}`;

// A brand-new (non-allowlisted) file that suppresses an unused tx — trips BOTH
// the model-allowlist check and F3. Confirms F3 detects the drift even on a file
// the guard would reject for other reasons.
const F3_UNUSED_TX_ON_NEW_FILE = `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function h() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return withBypassRls(prisma, BYPASS_PURPOSE.X, async (tx) => doThing());
}`;

describe("check-bypass-rls F3 unused-tx anti-drift", () => {
  it("fails an allowlisted file that suppresses an unused tx on a with*Rls callback", () => {
    const r = run("src/lib/audit/audit-outbox.ts", F3_UNUSED_TX_ON_ALLOWLISTED_FILE);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no-unused-vars");
    expect(r.stderr).toContain("src/lib/audit/audit-outbox.ts");
  });

  it("passes the tenant-context.ts delegating wrappers (F3 allowlisted)", () => {
    const r = run("src/lib/tenant-context.ts", TENANT_CONTEXT_ALLOWED);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-bypass-rls: OK");
  });

  it("flags a new non-allowlisted file that suppresses an unused tx", () => {
    const r = run("src/app/api/y/route.ts", F3_UNUSED_TX_ON_NEW_FILE);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no-unused-vars");
    expect(r.stderr).toContain("src/app/api/y/route.ts");
  });
});
