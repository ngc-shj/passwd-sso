/**
 * Self-test for scripts/checks/check-passkey-blocked-audit-scope.mjs — every
 * PASSKEY_ENFORCEMENT_BLOCKED writer must produce a TENANT-scoped row.
 *
 * RT7: red-proven by a writer that spreads personalAuditBase (the shape eight
 * writers shipped with, #976) and by one that sets no scope at all. The
 * relative-import cell was green on the first version of the gate, which
 * matched import specifiers by spelling and so never saw the reference. The
 * receiver cells (dynamic import, destructured or indexed namespace, a
 * namespace passed as a value) were green on the second, which recognised a
 * reference by its receiver; the gate now anchors on the member name. The
 * quoted / computed `scope` keys and the params-const and BothScopes cells were
 * green on the third, which read keys by spelling and accepted any object
 * literal holding the action.
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

  const NS_IMPORTS = `import { logAuditAsync, personalAuditBase, tenantAuditBase } from "@/lib/audit/audit";
import * as C from "@/lib/constants";
`;

  it("passes for a namespace import used directly with tenantAuditBase", () => {
    write(
      "src/app/api/a/route.ts",
      `${NS_IMPORTS}
export async function refuse(req: Request, userId: string, tenantId: string) {
  await logAuditAsync({ ...tenantAuditBase(req, userId, tenantId), action: C.AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    const { exitCode, out } = runGuard();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("writers=1");
  });

  it("FAILS for a namespace import used directly with personalAuditBase", () => {
    write(
      "src/app/api/a/route.ts",
      `${NS_IMPORTS}
export async function refuse(req: Request, userId: string) {
  await logAuditAsync({ ...personalAuditBase(req, userId), action: C.AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    expectFail(/route\.ts:\d+ {2}writes PASSKEY_ENFORCEMENT_BLOCKED with scope PERSONAL/);
  });

  it("FAILS for the action read off a dynamic import", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/c.ts",
      `import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
export async function refuse(req: Request, userId: string) {
  const K = await import("@/lib/constants");
  await logAuditAsync({ ...personalAuditBase(req, userId), action: K.AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    expectFail(/c\.ts:\d+ {2}references PASSKEY_ENFORCEMENT_BLOCKED through a receiver the gate cannot resolve/);
  });

  it("FAILS for a dynamic import of a module exporting AUDIT_ACTION, even when no member is named", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/c.ts",
      `import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
export async function refuseAll(req: Request, userId: string) {
  const K = await import("../lib/constants/audit/audit");
  for (const action of Object.values(K.AUDIT_ACTION)) {
    await logAuditAsync({ ...personalAuditBase(req, userId), action });
  }
}
`,
    );
    expectFail(/c\.ts:\d+ {2}loads a module exporting AUDIT_ACTION dynamically/);
  });

  it("FAILS for AUDIT_ACTION destructured out of a namespace import", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/c.ts",
      `${NS_IMPORTS}
const { AUDIT_ACTION: A } = C;
export async function refuse(req: Request, userId: string) {
  await logAuditAsync({ ...personalAuditBase(req, userId), action: A.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    expectFail(/c\.ts:\d+ {2}references PASSKEY_ENFORCEMENT_BLOCKED through a receiver the gate cannot resolve/);
  });

  it('FAILS for C["AUDIT_ACTION"].PASSKEY_ENFORCEMENT_BLOCKED', () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/c.ts",
      `${NS_IMPORTS}
export async function refuse(req: Request, userId: string) {
  await logAuditAsync({ ...personalAuditBase(req, userId), action: C["AUDIT_ACTION"].PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    expectFail(/c\.ts:\d+ {2}references PASSKEY_ENFORCEMENT_BLOCKED through a receiver the gate cannot resolve/);
  });

  it("FAILS for a namespace passed as a value and read inside the callee", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/c.ts",
      `${NS_IMPORTS}
function pick(ns: typeof C) {
  return ns.AUDIT_ACTION;
}
export async function refuse(req: Request, userId: string) {
  for (const action of Object.values(pick(C))) {
    await logAuditAsync({ ...personalAuditBase(req, userId), action });
  }
}
`,
    );
    expectFail(/c\.ts:\d+ {2}uses the namespace C other than as `C\.<member>`/);
  });

  it("FAILS for the action destructured from a value the gate cannot trace", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/c.ts",
      `${IMPORTS}
export async function refuse(req: Request, userId: string, actions: Record<string, string>) {
  const { PASSKEY_ENFORCEMENT_BLOCKED: blocked } = actions;
  await logAuditAsync({ ...personalAuditBase(req, userId), action: blocked });
}
`,
    );
    expectFail(/c\.ts:\d+ {2}destructures PASSKEY_ENFORCEMENT_BLOCKED/);
  });

  it("FAILS for a template-literal key in a personal writer", () => {
    write(
      "src/app/api/a/route.ts",
      writer("    ...personalAuditBase(req, userId),\n    tenantId,\n    action: AUDIT_ACTION[`PASSKEY_ENFORCEMENT_BLOCKED`],"),
    );
    expectFail(/route\.ts:\d+ {2}writes PASSKEY_ENFORCEMENT_BLOCKED with scope PERSONAL/);
  });

  it("FAILS for a template-literal spelling of the action in a personal writer", () => {
    write(
      "src/app/api/a/route.ts",
      writer("    ...personalAuditBase(req, userId),\n    action: `PASSKEY_ENFORCEMENT_BLOCKED`,"),
    );
    expectFail(/route\.ts:\d+ {2}writes PASSKEY_ENFORCEMENT_BLOCKED with scope PERSONAL/);
  });

  it("FAILS for a const alias of AUDIT_ACTION", () => {
    write(
      "src/app/api/a/route.ts",
      `${IMPORTS}
const A = AUDIT_ACTION;
export async function refuse(req: Request, userId: string, tenantId: string) {
  await logAuditAsync({ ...tenantAuditBase(req, userId, tenantId), action: A.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    const { exitCode, out } = runGuard();
    expect(exitCode, out).toBe(1);
    expect(out).toMatch(/route\.ts:\d+ {2}uses AUDIT_ACTION other than as `AUDIT_ACTION\.<member>`/);
    expect(out).toMatch(/route\.ts:\d+ {2}references PASSKEY_ENFORCEMENT_BLOCKED through a receiver the gate cannot resolve/);
  });

  it("passes for AUDIT_ACTION from an `export *` barrel", () => {
    write("src/lib/k/index.ts", `export * from "../constants/audit/audit";\n`);
    write(
      "src/app/api/a/route.ts",
      TENANT_WRITER.replace('from "@/lib/constants/audit/audit"', 'from "@/lib/k"'),
    );
    const { exitCode, out } = runGuard();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("writers=1");
  });

  it("passes for AUDIT_ACTION from an import-then-export barrel", () => {
    write("src/lib/j.ts", `import { AUDIT_ACTION } from "@/lib/constants";\nexport { AUDIT_ACTION };\n`);
    write(
      "src/app/api/a/route.ts",
      `import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/j";
export async function refuse(req: Request, userId: string, tenantId: string) {
  await logAuditAsync({ ...tenantAuditBase(req, userId, tenantId), action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    const { exitCode, out } = runGuard();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("writers=1");
  });

  it("FAILS for a re-export of AUDIT_ACTION under another name", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write("src/lib/j.ts", `export { AUDIT_ACTION as ACTIONS } from "@/lib/constants";\n`);
    expectFail(/j\.ts:\d+ {2}re-exports AUDIT_ACTION as ACTIONS/);
  });

  it("FAILS for a namespace re-export of a module exporting AUDIT_ACTION", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write("src/lib/j.ts", `export * as K from "@/lib/constants";\n`);
    expectFail(/j\.ts:\d+ {2}re-exports AUDIT_ACTION inside a namespace/);
  });

  it("passes for scope: AUDIT_SCOPE.TENANT imported through the barrel", () => {
    write(
      "src/app/api/a/route.ts",
      `import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
export async function refuse(userId: string, tenantId: string) {
  await logAuditAsync({ scope: AUDIT_SCOPE.TENANT, userId, tenantId, action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    const { exitCode, out } = runGuard();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("writers=1");
  });

  it("FAILS when a nested spread overrides the tenantId given to tenantAuditBase", () => {
    write(
      "src/app/api/a/route.ts",
      writer(`    ...{ ...tenantAuditBase(req, userId, tenantId), tenantId: undefined },
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,`),
    );
    expectFail(/overrides the tenantId given to tenantAuditBase/);
  });

  it("passes for a non-literal computed key unrelated to a writer", () => {
    // retention-gc's shape: the key is data, so the file cannot name the
    // member and the gate does not guess.
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/c.ts",
      `import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
export const actionFor = (key: keyof typeof AUDIT_ACTION) => AUDIT_ACTION[key];
`,
    );
    const { exitCode, out } = runGuard();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("writers=1");
  });

  it.each([
    ['"scope"', `"scope"`],
    ['["scope"]', `["scope"]`],
    ["[`scope`]", "[`scope`]"],
  ])("FAILS when %s: AUDIT_SCOPE.PERSONAL overrides the tenant base", (_label, key) => {
    write(
      "src/app/api/a/route.ts",
      writer(`    ...tenantAuditBase(req, userId, tenantId),
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
    ${key}: AUDIT_SCOPE.PERSONAL,`),
    );
    expectFail(/route\.ts:\d+ {2}writes PASSKEY_ENFORCEMENT_BLOCKED with scope PERSONAL/);
  });

  it("FAILS for a computed key the file cannot name after the tenant base", () => {
    write(
      "src/app/api/a/route.ts",
      `${IMPORTS}
export async function refuse(req: Request, userId: string, tenantId: string, k: string) {
  await logAuditAsync({
    ...tenantAuditBase(req, userId, tenantId),
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
    [k]: AUDIT_SCOPE.PERSONAL,
  });
}
`,
    );
    expectFail(/route\.ts:\d+ {2}writes PASSKEY_ENFORCEMENT_BLOCKED with scope unresolved \(computed key\)/);
  });

  it('FAILS when "tenantId" overrides the one given to tenantAuditBase', () => {
    write(
      "src/app/api/a/route.ts",
      writer(`    ...tenantAuditBase(req, userId, tenantId),
    "tenantId": undefined,
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,`),
    );
    expectFail(/overrides the tenantId given to tenantAuditBase/);
  });

  it("FAILS for a writer through logAuditAsyncBothScopes", () => {
    write(
      "src/app/api/a/route.ts",
      `import { logAuditAsyncBothScopes, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
export async function refuse(req: Request, userId: string, tenantId: string) {
  await logAuditAsyncBothScopes({ ...tenantAuditBase(req, userId, tenantId), action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    expectFail(/route\.ts:\d+ {2}writes PASSKEY_ENFORCEMENT_BLOCKED in an object that is not the params argument/);
  });

  it("FAILS for a params const re-spread under a personal scope", () => {
    write(
      "src/app/api/a/route.ts",
      `${IMPORTS}
export async function refuse(req: Request, userId: string, tenantId: string) {
  const params = { ...tenantAuditBase(req, userId, tenantId), action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED };
  await logAuditAsync({ ...params, ...personalAuditBase(req, userId) });
}
`,
    );
    expectFail(/route\.ts:\d+ {2}writes PASSKEY_ENFORCEMENT_BLOCKED in an object that is not the params argument/);
  });

  it("FAILS for a params const mutated before the write", () => {
    write(
      "src/app/api/a/route.ts",
      `${IMPORTS}
export async function refuse(req: Request, userId: string, tenantId: string) {
  const params: Record<string, unknown> = { ...tenantAuditBase(req, userId, tenantId), action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED };
  params.scope = AUDIT_SCOPE.PERSONAL;
  await logAuditAsync(params as never);
}
`,
    );
    expectFail(/route\.ts:\d+ {2}writes PASSKEY_ENFORCEMENT_BLOCKED in an object that is not the params argument/);
  });

  it("passes for logAuditAsync and tenantAuditBase imported through a barrel", () => {
    write("src/lib/audit/index.ts", `export { logAuditAsync, tenantAuditBase } from "./audit";\n`);
    write(
      "src/app/api/a/route.ts",
      `import { logAuditAsync as log, tenantAuditBase } from "@/lib/audit";
import { AUDIT_ACTION } from "@/lib/constants";
export async function refuse(req: Request, userId: string, tenantId: string) {
  await log({ ...tenantAuditBase(req, userId, tenantId), action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    const { exitCode, out } = runGuard();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("writers=1");
  });

  it("passes for logAuditInTx with the params literal as its third argument", () => {
    write(
      "src/app/api/a/route.ts",
      `import { logAuditInTx, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
export async function refuse(tx: unknown, req: Request, userId: string, tenantId: string) {
  await logAuditInTx(tx as never, tenantId, { ...tenantAuditBase(req, userId, tenantId), action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED });
}
`,
    );
    const { exitCode, out } = runGuard();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("writers=1");
  });

  it("FAILS for require() of a module exporting AUDIT_ACTION", () => {
    write("src/app/api/a/route.ts", TENANT_WRITER);
    write(
      "src/lib/c.ts",
      `import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
export async function refuseAll(req: Request, userId: string) {
  const K = require("@/lib/constants");
  for (const action of Object.values(K.AUDIT_ACTION)) {
    await logAuditAsync({ ...personalAuditBase(req, userId), action });
  }
}
`,
    );
    expectFail(/c\.ts:\d+ {2}loads a module exporting AUDIT_ACTION dynamically/);
  });

  it("FAILS when no writer is found", () => {
    write("src/app/api/a/route.ts", `export const x = 1;\n`);
    expectFail(/found no PASSKEY_ENFORCEMENT_BLOCKED writer/);
  });

  it("FAILS when the scan root has no source files", () => {
    rmSync(join(root, "src"), { recursive: true, force: true });
    expectFail(/contributed no source file/);
  });

  // Parses the whole of src/ (~1000 files), several seconds under suite load.
  it("finds every writer in the real tree", { timeout: 60_000 }, () => {
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
