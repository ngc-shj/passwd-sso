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

// ─── Call-extent scanning (the model-allowlist window) ────────────────────────
//
// These pin the scanner that decides WHICH lines a call site's model references
// are read from. It used to be a fixed 10-line radius, which silently stopped
// covering callbacks as they grew, and then briefly a same-line regex that
// mistook a string containing "//" for a comment and skipped the call whole.
// Both failures were found by hand-run mutations; these are those mutations,
// persisted, because a gate proven once by hand has no tripwire against its own
// next edit (RT7).
//
// audit-outbox.ts is used as the subject throughout: it is allowlisted for
// `auditOutbox` only, so any other model inside its callback must be reported.

describe("call-extent scanning", () => {
  it("reads a model reference far past the old fixed 10-line radius", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `      const pad${i} = ${i};`).join("\n");
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => {
${filler}
      return tx.tenantMember.findFirst({ where: { id: "x" } });
  });
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("still passes a long callback that only touches allowed models", () => {
    // The allow side of the case above: widening the window must not turn every
    // long callback into a violation.
    const filler = Array.from({ length: 30 }, (_, i) => `      const pad${i} = ${i};`).join("\n");
    const { code } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => {
${filler}
      return tx.auditOutbox.findMany({ where: { status: "PENDING" } });
  });
}`);
    expect(code).toBe(0);
  });

  it("scans a real call whose line also contains a string holding '//'", () => {
    // The regression that made this suite necessary: judging "is this a
    // comment?" from raw text let a string containing "//" hide a real call
    // site, so it was scanned by nothing at all — worse than a short window,
    // because it also escaped the undeterminable-extent report.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  log("fallback path // see runbook"); return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => {
      return tx.tenantMember.findFirst({ where: { id: "x" } });
  });
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("ignores a call-shaped mention inside a comment", () => {
    // src/auth.ts carries exactly this in prose. It must not be treated as a
    // call site — and must not be reported as an undeterminable extent either.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
// Emitting here would run logAuditAsync -> withBypassRls (nested), an R9 shape.
export async function drain() {
  return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => tx.auditOutbox.findMany());
}`);
    expect(code).toBe(0);
    expect(stderr).not.toContain("could not be determined");
  });

  it("ignores a call-shaped mention inside a string literal", () => {
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
const HELP = "see withBypassRls(prisma, purpose, cb) for the pattern";
export async function drain() {
  return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => tx.auditOutbox.findMany());
}`);
    expect(code).toBe(0);
    expect(stderr).not.toContain("could not be determined");
  });

  it("is not fooled by a paren inside a string or a template interpolation", () => {
    // A ")" in string text must not close the call early, and a call expression
    // inside `${...}` must not be counted either — both would end the extent
    // before the offending model reference below.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain(id) {
  return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => {
      log("closing paren ) inside a string");
      log(\`key:\${hash(id)}\`);
      return tx.tenantMember.findFirst({ where: { id } });
  });
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("fails by name when a call's extent cannot be determined", () => {
    // Unbalanced source: the gate must say so rather than fall back to a window
    // it cannot justify. "Examined nothing" must not read like "found nothing".
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => {
      return tx.auditOutbox.findMany();
`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be determined");
    expect(stderr).toContain("audit-outbox.ts");
  });
});
