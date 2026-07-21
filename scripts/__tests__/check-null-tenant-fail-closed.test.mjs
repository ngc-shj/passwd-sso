/**
 * Regression tests for check-null-tenant-fail-closed.mjs (AST, per-read-site).
 *
 * The guard pins COMPLETENESS + per-disposition IMPLEMENTATION of the
 * null-tenant fail-open enforcement class. An earlier version tracked only the
 * set of files with an enforcement read, so intra-file mutations (reverting a
 * throw, adding a permissive coalesce to a failsafe file, adding an access
 * decision to a display-exempt echo) slipped through (external review Medium).
 * These tests reproduce the manifest paths in an isolated tree via
 * NTFC_CHECK_ROOT and mutate each — the RT7 "proven able to fail" self-test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(
  new URL("../checks/check-null-tenant-fail-closed.mjs", import.meta.url),
);

// Manifest paths and their disposition, mirrored from the guard. Each is seeded
// with source matching its disposition so the baseline is green.
const THROW_PATHS = [
  "src/lib/auth/policy/access-restriction.ts",
  "src/lib/auth/policy/passkey-enforcement.ts",
  "src/lib/auth/session/auth-adapter.ts",
  "src/lib/auth/tokens/extension-token.ts",
  "src/app/api/extension/token/refresh/route.ts",
  "src/app/api/webauthn/register/verify/route.ts",
  "src/lib/team/team-policy.ts",
  "src/auth.ts",
];
const FAILSAFE_PATHS = [
  "src/lib/auth/policy/account-lockout.ts",
  "src/lib/auth/session/session-timeout.ts",
];
const DISPLAY_PATHS = [
  "src/app/api/tenant/policy/route.ts",
  "src/app/api/teams/[teamId]/policy/route.ts",
  "src/app/api/vault/status/route.ts",
  "src/app/api/vault/unlock/data/route.ts",
  "src/app/api/user/passkey-status/route.ts",
  "src/app/api/sessions/route.ts",
];

// A throw-disposition read: enforcement select + null-tenant throw guard.
const THROW_SRC = `
import { prisma } from "@/lib/prisma";
export async function read(id: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id },
    select: { allowedCidrs: true },
  });
  if (!tenant) throw new Error("tenant not found");
  return tenant.allowedCidrs;
}`;

// A failsafe-default read: enforcement select, restrictive default on null, NO
// permissive enforcement-field coalesce.
const FAILSAFE_SRC = `
import { prisma } from "@/lib/prisma";
const STRICT = [{ attempts: 1 }];
export async function read(id: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id },
    select: { lockoutThreshold1: true },
  });
  if (!tenant) return STRICT;
  return [{ attempts: tenant.lockoutThreshold1 }];
}`;

// A display-exempt read: enforcement select echoed into a response, no access
// decision call.
const DISPLAY_SRC = `
import { prisma } from "@/lib/prisma";
export async function GET(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { tenant: { select: { vaultAutoLockMinutes: true } } },
  });
  return { vaultAutoLockMinutes: user?.tenant?.vaultAutoLockMinutes ?? null };
}`;

let dir;

function writeFile(relPath, source) {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, source, "utf8");
}

function run() {
  try {
    const stdout = execFileSync("node", [CHECKER], {
      env: { ...process.env, NTFC_CHECK_ROOT: dir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stderr: "", stdout };
  } catch (e) {
    return { code: e.status, stderr: e.stderr?.toString() ?? "", stdout: e.stdout?.toString() ?? "" };
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ntfc-check-"));
  for (const p of THROW_PATHS) writeFile(p, THROW_SRC);
  for (const p of FAILSAFE_PATHS) writeFile(p, FAILSAFE_SRC);
  for (const p of DISPLAY_PATHS) writeFile(p, DISPLAY_SRC);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("check-null-tenant-fail-closed (AST)", () => {
  it("passes when every read matches its manifest disposition", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-null-tenant-fail-closed: OK");
  });

  it("fails a NEW unclassified enforcement read", () => {
    writeFile("src/lib/newleak.ts", THROW_SRC);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no MANIFEST disposition");
    expect(r.stderr).toContain("src/lib/newleak.ts");
  });

  it("fails a vanished manifest read (stale entry)", () => {
    rmSync(join(dir, "src/lib/auth/tokens/extension-token.ts"));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stale");
    expect(r.stderr).toContain("src/lib/auth/tokens/extension-token.ts");
  });

  it("fails a throw-disposition read whose null-tenant guard was reverted to a permissive coalesce", () => {
    // Same enforcement read, but the throw guard is replaced by `?? []`.
    writeFile(
      "src/lib/auth/policy/access-restriction.ts",
      `import { prisma } from "@/lib/prisma";
       export async function read(id: string) {
         const tenant = await prisma.tenant.findUnique({ where: { id }, select: { allowedCidrs: true } });
         return tenant?.allowedCidrs ?? [];
       }`,
    );
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('disposition "throw"');
    expect(r.stderr).toContain("src/lib/auth/policy/access-restriction.ts");
  });

  it("fails a failsafe-default file that introduces a permissive enforcement coalesce", () => {
    writeFile(
      "src/lib/auth/policy/account-lockout.ts",
      `import { prisma } from "@/lib/prisma";
       export async function read(id: string) {
         const tenant = await prisma.tenant.findUnique({ where: { id }, select: { lockoutThreshold1: true } });
         return tenant?.lockoutThreshold1 ?? 5;
       }`,
    );
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('disposition "failsafe-default"');
  });

  it("fails a display-exempt file that adds an access-restriction call", () => {
    writeFile(
      "src/app/api/vault/status/route.ts",
      `import { prisma } from "@/lib/prisma";
       import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
       export async function GET(id: string) {
         const user = await prisma.user.findUnique({ where: { id }, select: { tenant: { select: { vaultAutoLockMinutes: true } } } });
         await enforceAccessRestriction();
         return { vaultAutoLockMinutes: user?.tenant?.vaultAutoLockMinutes ?? null };
       }`,
    );
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('disposition "display-exempt"');
  });

  it("does not flag a file that reads tenant but no enforcement field", () => {
    writeFile(
      "src/lib/benign.ts",
      `import { prisma } from "@/lib/prisma";
       export async function h(id: string) {
         const t = await prisma.tenant.findUnique({ where: { id }, select: { name: true } });
         return t?.name;
       }`,
    );
    const r = run();
    expect(r.code).toBe(0);
  });
});
