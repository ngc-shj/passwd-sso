/**
 * Self-test for scripts/checks/check-passkey-blocked-audit-scope.mjs — every
 * PASSKEY_ENFORCEMENT_BLOCKED writer must produce a TENANT-scoped row.
 *
 * RT7: red-proven by a writer that spreads personalAuditBase (the shape eight
 * writers shipped with, #976) and by one that sets no scope at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-passkey-blocked-audit-scope.mjs");

let root;

function runGuard() {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, PASSKEY_BLOCKED_AUDIT_SCOPE_ROOT: root },
  });
  return { exitCode: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function write(rel, contents) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

const IMPORTS = `import { logAuditAsync, personalAuditBase, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
`;

const writer = (body) => `${IMPORTS}
export async function refuse(req: Request, userId: string, tenantId: string) {
  await logAuditAsync({
${body}
    metadata: { blockedPath: "/api/x" },
  });
}
`;

const TENANT_WRITER = writer(`    ...tenantAuditBase(req, userId, tenantId),
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "passkey-blocked-audit-scope-"));
  // The definition file lists the action outside any writer; it is skipped.
  write(
    "src/lib/constants/audit/audit.ts",
    `export const AUDIT_ACTION = { PASSKEY_ENFORCEMENT_BLOCKED: "PASSKEY_ENFORCEMENT_BLOCKED" } as const;
export const GROUP = [AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED];
`,
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function expectFail(pattern) {
  const { exitCode, out } = runGuard();
  expect(exitCode, out).toBe(1);
  expect(out).toMatch(pattern);
}

describe("check-passkey-blocked-audit-scope.mjs", () => {
  it("passes for a tenantAuditBase writer and an explicit TENANT scope with a tenantId", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/b.ts",
      writer(`    ...personalAuditBase(req, userId),
    scope: AUDIT_SCOPE.TENANT,
    tenantId,
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,`),
    );
    const { exitCode, out } = runGuard();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("writers=2");
  });

  it("ignores test files", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write("src/app/api/a/route.test.ts", writer(`    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,`));
    const { exitCode, out } = runGuard();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("writers=1");
  });

  it("FAILS for a personalAuditBase writer, even with a tenantId beside it", () => {
    write(
      "src/app/api/a/route.ts",
      writer(`    ...personalAuditBase(req, userId),
    tenantId,
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,`),
    );
    expectFail(/route\.ts:\d+ {2}writes PASSKEY_ENFORCEMENT_BLOCKED with scope PERSONAL/);
  });

  it("FAILS for a writer that sets no scope", () => {
    write("src/app/api/a/route.ts", writer(`    userId,
    tenantId,
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,`));
    expectFail(/writes PASSKEY_ENFORCEMENT_BLOCKED with scope missing/);
  });

  it("FAILS when a later spread overrides the tenant base", () => {
    write(
      "src/app/api/a/route.ts",
      writer(`    ...tenantAuditBase(req, userId, tenantId),
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,`),
    );
    expectFail(/with scope PERSONAL/);
  });

  it("FAILS when a later tenantId overrides the one given to tenantAuditBase", () => {
    write(
      "src/app/api/a/route.ts",
      writer(`    ...tenantAuditBase(req, userId, tenantId),
    tenantId: undefined,
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,`),
    );
    expectFail(/overrides the tenantId given to tenantAuditBase/);
  });

  it("FAILS for TENANT scope without a tenantId", () => {
    write("src/app/api/a/route.ts", writer(`    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,`));
    expectFail(/sets scope TENANT without a tenantId/);
  });

  it("FAILS when tenantAuditBase is a local function, not the audit helper", () => {
    write(
      "src/app/api/a/route.ts",
      TENANT_WRITER.replace(
        "export async function refuse",
        "function tenantAuditBase(_r: Request, userId: string, _t: string) { return { userId }; }\nexport async function refuse",
      ),
    );
    expectFail(/with scope unresolved spread/);
  });

  it("FAILS for a reference outside an `action:` property", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/c.ts",
      `${IMPORTS}
const action = AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED;
export async function refuse(req: Request, userId: string) {
  await logAuditAsync({ ...personalAuditBase(req, userId), action });
}
`,
    );
    expectFail(/c\.ts:\d+ {2}references PASSKEY_ENFORCEMENT_BLOCKED outside an `action:` property/);
  });

  it("FAILS for a raw string spelling of the action in a personal writer", () => {
    write(
      "src/app/api/a/route.ts",
      writer(`    ...personalAuditBase(req, userId),
    action: "PASSKEY_ENFORCEMENT_BLOCKED",`),
    );
    expectFail(/with scope PERSONAL/);
  });

  it("FAILS when no writer is found", () => {
    write("src/app/api/a/route.ts", `export const x = 1;\n`);
    expectFail(/found no PASSKEY_ENFORCEMENT_BLOCKED writer/);
  });

  it("FAILS when the scan root has no source files", () => {
    rmSync(join(root, "src"), { recursive: true, force: true });
    expectFail(/contributed no source file/);
  });
});
