/**
 * Self-test for scripts/checks/check-passkey-blocked-audit-scope.mjs — every
 * PASSKEY_ENFORCEMENT_BLOCKED writer must produce a TENANT-scoped row.
 *
 * RT7: red-proven by a writer that spreads personalAuditBase (the shape eight
 * writers shipped with, #976) and by one that sets no scope at all. The
 * relative-import cell was green on the first version of the gate, which
 * matched import specifiers by spelling and so never saw the reference.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-passkey-blocked-audit-scope.mjs");

// Every writer in the tree today. A writer the gate stops recognising — a
// moved helper, a new import spelling — drops this count while the run stays
// green, so the exact number is pinned; update it when a writer is added or
// removed on purpose.
const REAL_TREE_WRITERS = 9;

let root;

function runGuard(scanRoot = root) {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, PASSKEY_BLOCKED_AUDIT_SCOPE_ROOT: scanRoot },
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
export const AUDIT_SCOPE = { PERSONAL: "PERSONAL", TEAM: "TEAM", TENANT: "TENANT" } as const;
`,
  );
  write("src/lib/constants/index.ts", `export { AUDIT_ACTION, AUDIT_SCOPE } from "./audit/audit";\n`);
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

  it("FAILS for a personal writer that imports AUDIT_ACTION by a relative path", () => {
    // The src/lib/proxy import style. Matched by spelling, this file has no
    // AUDIT_ACTION import at all and its writer goes unseen.
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/proxy/x.ts",
      `import { logAuditAsync, personalAuditBase } from "../audit/audit";
import { AUDIT_ACTION } from "../constants/audit/audit";
export async function refuse(req: Request, userId: string) {
  await logAuditAsync({ ...personalAuditBase(req, userId), action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    expectFail(/src\/lib\/proxy\/x\.ts:\d+ {2}writes PASSKEY_ENFORCEMENT_BLOCKED with scope PERSONAL/);
  });

  it("passes for a writer that imports through the @/lib/constants barrel under an alias", () => {
    write(
      "src/app/api/a/route.ts",
      `import { logAuditAsync, tenantAuditBase as base } from "@/lib/audit/audit";
import { AUDIT_ACTION as ACTIONS } from "@/lib/constants";
export async function refuse(req: Request, userId: string, tenantId: string) {
  await logAuditAsync({ ...base(req, userId, tenantId), action: ACTIONS.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    const { exitCode, out } = runGuard();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("writers=1");
  });

  it("FAILS for an aliased barrel import in a personal writer", () => {
    write(
      "src/app/api/a/route.ts",
      `import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION as ACTIONS } from "@/lib/constants";
export async function refuse(req: Request, userId: string) {
  await logAuditAsync({ ...personalAuditBase(req, userId), action: ACTIONS.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    expectFail(/route\.ts:\d+ {2}writes PASSKEY_ENFORCEMENT_BLOCKED with scope PERSONAL/);
  });

  it("FAILS for a named import of AUDIT_ACTION from a module that does not define it", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/c.ts",
      `import { AUDIT_ACTION } from "@/lib/elsewhere";
export const label = AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED;
`,
    );
    expectFail(/c\.ts:\d+ {2}imports AUDIT_ACTION from "@\/lib\/elsewhere"/);
  });

  it("FAILS for element access with the action's name in a personal writer", () => {
    write(
      "src/app/api/a/route.ts",
      writer(`    ...personalAuditBase(req, userId),
    tenantId,
    action: AUDIT_ACTION["PASSKEY_ENFORCEMENT_BLOCKED"],`),
    );
    expectFail(/route\.ts:\d+ {2}writes PASSKEY_ENFORCEMENT_BLOCKED with scope PERSONAL/);
  });

  it("FAILS for the action destructured out of AUDIT_ACTION", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/c.ts",
      `${IMPORTS}
const { PASSKEY_ENFORCEMENT_BLOCKED } = AUDIT_ACTION;
export async function refuse(req: Request, userId: string) {
  await logAuditAsync({ ...personalAuditBase(req, userId), action: PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    expectFail(/c\.ts:\d+ {2}uses AUDIT_ACTION other than as `AUDIT_ACTION\.<member>`/);
  });

  it("passes when the tenant base is spread through a const", () => {
    write(
      "src/app/api/a/route.ts",
      `${IMPORTS}
export async function refuse(req: Request, userId: string, tenantId: string) {
  const base = tenantAuditBase(req, userId, tenantId);
  await logAuditAsync({ ...base, action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    const { exitCode, out } = runGuard();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("writers=1");
  });

  it("FAILS when the personal base is spread through a const", () => {
    write(
      "src/app/api/a/route.ts",
      `${IMPORTS}
export async function refuse(req: Request, userId: string, tenantId: string) {
  const base = personalAuditBase(req, userId);
  await logAuditAsync({ ...base, tenantId, action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    expectFail(/with scope PERSONAL/);
  });

  it('FAILS for scope: "PERSONAL" spelled as a string', () => {
    write(
      "src/app/api/a/route.ts",
      writer(`    scope: "PERSONAL",
    userId,
    tenantId,
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,`),
    );
    expectFail(/with scope PERSONAL/);
  });

  it("FAILS for a spread object literal that sets TENANT scope but no tenantId", () => {
    // Only a tenantAuditBase call brings a tenantId with it; a literal's
    // spread carries exactly the properties it has.
    write(
      "src/app/api/a/route.ts",
      writer(`    ...{ scope: AUDIT_SCOPE.TENANT },
    userId,
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,`),
    );
    expectFail(/sets scope TENANT without a tenantId/);
  });

  it("FAILS when no writer is found", () => {
    write("src/app/api/a/route.ts", `export const x = 1;\n`);
    expectFail(/found no PASSKEY_ENFORCEMENT_BLOCKED writer/);
  });

  it("FAILS when the scan root has no source files", () => {
    rmSync(join(root, "src"), { recursive: true, force: true });
    expectFail(/contributed no source file/);
  });

  it("finds every writer in the real tree", () => {
    const { exitCode, out } = runGuard(REPO_ROOT);
    expect(exitCode, out).toBe(0);
    expect(Number(out.match(/ writers=(\d+)\n/)?.[1]), out).toBe(REAL_TREE_WRITERS);
  });

  it("is wired into scripts/pre-pr.sh", () => {
    // Anchored at line start so a commented-out `# queue_step …` does not count.
    const prePr = readFileSync(join(REPO_ROOT, "scripts/pre-pr.sh"), "utf8");
    expect(prePr).toMatch(/^queue_step .*check-passkey-blocked-audit-scope\.mjs\s*$/m);
  });
});
