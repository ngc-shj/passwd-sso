/**
 * Regression tests for check-null-tenant-fail-closed.mjs.
 *
 * The guard pins COMPLETENESS of the null-tenant fail-open enforcement class: it
 * enumerates every enforcement-field `tenant.findUnique` / relation-join read
 * from the defining primitive and fails when the live set diverges from the
 * reviewed MANIFEST (a NEW unclassified member, or a VANISHED stale entry). This
 * class expanded 4 → 5 → 7 during review precisely because completeness wasn't
 * mechanized. Each case runs the real CLI against an isolated fixture tree via
 * NTFC_CHECK_ROOT.
 *
 * The fixture reproduces the manifest paths so the baseline is green, then
 * mutates: add an unlisted enforcement read (→ red) or delete a manifest'd file
 * (→ red). This is the RT7 "proven able to fail" self-test for the gate.
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

// The exact MANIFEST paths in the guard. Kept in sync by the guard's own
// stale-entry detection: if a manifest path is removed from the guard, this
// list and the guard would diverge and the real-tree run would catch it.
const MANIFEST_PATHS = [
  "src/lib/auth/policy/access-restriction.ts",
  "src/lib/auth/policy/passkey-enforcement.ts",
  "src/lib/auth/session/auth-adapter.ts",
  "src/lib/auth/tokens/extension-token.ts",
  "src/app/api/extension/token/refresh/route.ts",
  "src/app/api/webauthn/register/verify/route.ts",
  "src/lib/team/team-policy.ts",
  "src/auth.ts",
  "src/lib/auth/policy/account-lockout.ts",
  "src/lib/auth/session/session-timeout.ts",
  "src/app/api/tenant/policy/route.ts",
  "src/app/api/teams/[teamId]/policy/route.ts",
  "src/app/api/vault/status/route.ts",
  "src/app/api/vault/unlock/data/route.ts",
  "src/app/api/user/passkey-status/route.ts",
  "src/app/api/sessions/route.ts",
];

// A minimal source that reads an enforcement field via tenant.findUnique so the
// guard classifies the file as an enforcement read.
const ENFORCEMENT_READ_SRC = `
import { prisma } from "@/lib/prisma";
export async function read(id) {
  const tenant = await prisma.tenant.findUnique({
    where: { id },
    select: { allowedCidrs: true, requirePasskey: true },
  });
  if (!tenant) throw new Error("not found");
  return tenant.allowedCidrs;
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
    return {
      code: e.status,
      stderr: e.stderr?.toString() ?? "",
      stdout: e.stdout?.toString() ?? "",
    };
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ntfc-check-"));
  // Populate every manifest path with an enforcement read so the baseline is
  // green (live set == manifest).
  for (const p of MANIFEST_PATHS) writeFile(p, ENFORCEMENT_READ_SRC);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("check-null-tenant-fail-closed", () => {
  it("passes when the live enforcement-read set matches the manifest", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-null-tenant-fail-closed: OK");
  });

  it("fails when a NEW unlisted enforcement tenant read is added", () => {
    writeFile("src/lib/newthing.ts", ENFORCEMENT_READ_SRC);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not in the MANIFEST");
    expect(r.stderr).toContain("src/lib/newthing.ts");
  });

  it("fails when a manifest'd enforcement read vanishes (stale entry)", () => {
    rmSync(join(dir, "src/lib/auth/tokens/extension-token.ts"));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stale");
    expect(r.stderr).toContain("src/lib/auth/tokens/extension-token.ts");
  });

  it("does not flag a file that reads tenant but no enforcement field", () => {
    writeFile(
      "src/lib/benign.ts",
      `import { prisma } from "@/lib/prisma";
       export async function h(id) {
         const t = await prisma.tenant.findUnique({ where: { id }, select: { name: true } });
         return t?.name;
       }`,
    );
    const r = run();
    expect(r.code).toBe(0);
  });

  it("does not flag a non-tenant read of an enforcement-named field", () => {
    // A field name match WITHOUT a tenant read must not trip the guard.
    writeFile(
      "src/lib/other.ts",
      `export const requirePasskey = false;
       export function h() { return requirePasskey; }`,
    );
    const r = run();
    expect(r.code).toBe(0);
  });
});
