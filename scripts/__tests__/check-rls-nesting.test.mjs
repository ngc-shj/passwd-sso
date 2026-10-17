/**
 * Regression tests for check-rls-nesting.mjs.
 *
 * Each case runs the real CLI with cwd set to an isolated fixture tree that
 * carries the REAL src/lib/tenant-rls.ts and src/lib/tenant-context.ts, a
 * minimal tsconfig, and stubs for the modules those two import — so the
 * helpers the gate resolves are the shipped declarations, not hand-written
 * copies that could drift from them.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("../checks/check-rls-nesting.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const REAL_FILES = ["src/lib/tenant-rls.ts", "src/lib/tenant-context.ts"];

// Stubs for what the two real files import. Typed, so nothing they call
// widens to `any` and reads as an unresolvable callee.
const STUBS = {
  // A row's every field reads as a nested row, a string and a row array at
  // once, so \`user.email.toLowerCase()\` and \`memberships.filter(...)\` in
  // the real tenant-context.ts resolve to library methods, as they do against
  // the generated client.
  "types/prisma-client-stub.d.ts": `declare module "@prisma/client" {
  interface Row { [field: string]: Field }
  type Field = Row & string & Row[];
  interface Delegate {
    findMany(...args: unknown[]): Promise<Row[]>;
    findUnique(...args: unknown[]): Promise<Row | null>;
    findFirst(...args: unknown[]): Promise<Row | null>;
    count(...args: unknown[]): Promise<number>;
  }
  export interface TransactionClientLike {
    [model: string]: Delegate;
  }
  export class PrismaClient {
    [model: string]: Delegate;
    $transaction<T>(fn: (tx: TransactionClientLike) => Promise<T>, options?: unknown): Promise<T>;
    $executeRaw(...args: unknown[]): Promise<number>;
  }
  export namespace Prisma {
    type TransactionClient = TransactionClientLike;
  }
}
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, fn: () => R): R;
  }
}
`,
  "src/lib/constants/app.ts": `export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export const SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000001";
export const UUID_RE = /^[0-9a-f-]{36}$/i;
`,
  "src/lib/logger.ts": `export function getLogger() {
  return { error(_f: unknown, _m?: string) {}, warn(_f: unknown, _m?: string) {}, info(_f: unknown, _m?: string) {} };
}
`,
  "src/lib/prisma.ts": `import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient();
`,
  "src/lib/tenant/owning-tenant-rule.ts": `export function owningTenantOf(column: string | null, memberships: { tenantId: string }[]): string | null {
  return memberships[0]?.tenantId ?? column;
}
`,
  "src/lib/tenant/owning-column.ts": `export async function realignOwningTenantColumn(): Promise<string | null> { return null; }
`,
  "src/lib/tenant/stranded-rows.ts": `export const STRANDED_COUNTERS = {};
export async function countStrandedRows(): Promise<Record<string, number>> { return {}; }
`,
};

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "esnext",
    moduleResolution: "bundler",
    strict: false,
    noImplicitAny: false,
    skipLibCheck: true,
    paths: {
      "@/*": ["./src/*"],
      "@prisma/client": ["./types/prisma-client-stub.d.ts"],
    },
  },
  include: ["**/*.ts", "**/*.tsx"],
});

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rls-nesting-check-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(relPath, source) {
  mkdirSync(join(dir, dirname(relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), source, "utf8");
}

/** `files` is a `[relPath, source]` array written over the scaffold. */
function run(files) {
  writeFileSync(join(dir, "tsconfig.json"), FIXTURE_TSCONFIG, "utf8");
  for (const [relPath, source] of Object.entries(STUBS)) write(relPath, source);
  for (const relPath of REAL_FILES) write(relPath, readFileSync(join(REPO_ROOT, relPath), "utf8"));
  for (const [relPath, source] of files) write(relPath, source);
  const r = spawnSync("node", [CHECKER], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const HEAD = `import { prisma } from "@/lib/prisma";
import { withBypassRls, withTenantRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withUserTenantRls, withTeamTenantRls, resolveTeamTenantId } from "@/lib/tenant-context";
const T = "11111111-1111-4111-8111-111111111111";
`;

const NESTED = "An RLS context is opened from inside another one";
const UNFOLLOWED = "A context callback reaches a call this gate cannot follow";

describe("check-rls-nesting: baseline", () => {
  it("passes the scaffold alone, and says what it examined", () => {
    const { code, stdout } = run([]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/check-rls-nesting: OK \(\d+ files, [1-9]\d* openers, [4-9] context functions/);
  });

  it("refuses an empty tree rather than reporting OK", () => {
    writeFileSync(join(dir, "tsconfig.json"), FIXTURE_TSCONFIG, "utf8");
    const r = spawnSync("node", [CHECKER], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Nothing was examined");
  });

  it("refuses a tree whose tenant-rls.ts does not declare the base helpers", () => {
    const { code, stderr } = run([["src/lib/tenant-rls.ts", "export const nothing = 1;\n"]]);
    expect(code).toBe(1);
    expect(stderr).toContain("declares no function withTenantRls");
  });
});

describe("check-rls-nesting: nesting is detected", () => {
  it("fails a base helper opened inside another's callback", () => {
    const { code, stderr } = run([["src/app/a.ts", `${HEAD}
export const f = () => withBypassRls(prisma, async (tx) => {
  await withTenantRls(prisma, T, async () => null);
}, BYPASS_PURPOSE.AUDIT_WRITE);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toMatch(/src\/app\/a\.ts:7 +\(inside the context opened at src\/app\/a\.ts:6\) calls withTenantRls/);
  });

  it("fails an opener in another module and names the chain to the helper", () => {
    const { code, stderr } = run([
      ["src/lib/auth.ts", `import { withTeamTenantRls } from "@/lib/tenant-context";
export async function requireMember(teamId: string) {
  return withTeamTenantRls(teamId, async () => true);
}`],
      ["src/app/b.ts", `${HEAD}
import { requireMember } from "@/lib/auth";
export const f = () => withUserTenantRls("u", async () => requireMember("t"));`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toMatch(/src\/app\/b\.ts:7 .* calls requireMember \(src\/lib\/auth\.ts:2\) calls withTeamTenantRls/);
  });

  it.each([
    ["an alias", "const gate = withTenantRls;", "gate(prisma, T, async () => null)"],
    ["a namespace import", 'import * as rls from "@/lib/tenant-rls";', "rls.withTenantRls(prisma, T, async () => null)"],
    ["a parenthesized callee", "", "(withTenantRls)(prisma, T, async () => null)"],
    ["a computed member", 'import * as rls from "@/lib/tenant-rls";', 'rls["withTenantRls"](prisma, T, async () => null)'],
  ])("fails the nested helper spelled as %s", (_label, decl, call) => {
    const { code, stderr } = run([["src/app/c.ts", `${HEAD}${decl}
export const f = () => withBypassRls(prisma, async (tx) => ${call}, BYPASS_PURPOSE.AUDIT_WRITE);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
  });

  it("fails a nesting whose error the caller swallows", () => {
    // The case the runtime guard cannot surface: the refusal is caught and the
    // side effect is silently skipped.
    const { code, stderr } = run([["src/app/d.ts", `${HEAD}
async function revoke(userId: string) {
  return withBypassRls(prisma, async (tx) => tx.session.count(), BYPASS_PURPOSE.AUDIT_WRITE);
}
export const f = () => withUserTenantRls("u", async () => {
  await revoke("u").catch(() => null);
});`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toContain("calls revoke");
  });

  it("fails an opener run by an inline literal inside the callback", () => {
    const { code, stderr } = run([["src/app/e.ts", `${HEAD}
export const f = (ids: string[]) => withBypassRls(prisma, async (tx) => {
  await Promise.all(ids.map(async (id) => resolveTeamTenantId(id)));
}, BYPASS_PURPOSE.AUDIT_WRITE);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("calls resolveTeamTenantId");
  });

  it("fails an opener handed on by reference inside the callback", () => {
    const { code, stderr } = run([["src/app/f.ts", `${HEAD}
export const f = (ids: string[]) => withBypassRls(prisma, async (tx) => {
  await Promise.all(ids.map(resolveTeamTenantId));
}, BYPASS_PURPOSE.AUDIT_WRITE);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("hands on resolveTeamTenantId");
  });

  it("derives a local wrapper and fails an opener inside its callback", () => {
    const { code, stderr } = run([["src/app/g.ts", `${HEAD}
async function withVault<T>(userId: string, fn: () => Promise<T>) {
  return withUserTenantRls(userId, fn);
}
export const f = () => withVault("u", async () => resolveTeamTenantId("t"));`]]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/app\/g\.ts:9 +\(inside the context opened at src\/app\/g\.ts:9\) calls resolveTeamTenantId/);
  });

  it("fails a function value a production setter installs", () => {
    const { code, stderr } = run([
      ["src/lib/hook.ts", `let hook: (id: string) => Promise<unknown> = async () => null;
export function setHook(h: (id: string) => Promise<unknown>) { hook = h; }
export const runHook = (id: string) => hook(id);`],
      ["src/app/h.ts", `${HEAD}
import { setHook, runHook } from "@/lib/hook";
setHook(resolveTeamTenantId);
export const f = () => withBypassRls(prisma, async (tx) => runHook("t"), BYPASS_PURPOSE.AUDIT_WRITE);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toContain("calls runHook");
  });
});

describe("check-rls-nesting: an unfollowable call fails closed", () => {
  it("fails a callee with no symbol inside the callback", () => {
    const { code, stderr } = run([["src/app/i.ts", `${HEAD}
declare const untyped: any;
export const f = () => withBypassRls(prisma, async (tx) => untyped.run(), BYPASS_PURPOSE.AUDIT_WRITE);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(UNFOLLOWED);
    expect(stderr).toContain("src/app/i.ts:7");
  });

  it("fails a function whose body calls a function a library handed back", () => {
    // `registry.get(k)` may return any function stored with `registry.set`,
    // anywhere: a library cannot name the helpers, but it can return ours.
    const { code, stderr } = run([["src/app/j.ts", `${HEAD}
const registry = new Map<string, () => Promise<unknown>>();
async function dispatch(key: string) {
  const handler = registry.get(key);
  return handler();
}
export const f = () => withBypassRls(prisma, async (tx) => dispatch("k"), BYPASS_PURPOSE.AUDIT_WRITE);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(UNFOLLOWED);
    expect(stderr).toMatch(/calls dispatch \(src\/app\/j\.ts:\d+\), which/);
  });

  it("fails a member called off an object held in a let", () => {
    const { code, stderr } = run([["src/app/k.ts", `${HEAD}
let helpers = { go: async () => null };
export const f = () => withBypassRls(prisma, async (tx) => helpers.go(), BYPASS_PURPOSE.AUDIT_WRITE);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("member of an object that may be rebound");
  });
});

describe("check-rls-nesting: legitimate shapes pass", () => {
  it("passes contexts opened one after another, not inside each other", () => {
    const { code, stdout } = run([["src/app/l.ts", `${HEAD}
export async function f() {
  const tenantId = await resolveTeamTenantId("t");
  await withTenantRls(prisma, tenantId ?? T, async (tx) => tx.passwordEntry.count());
  await withBypassRls(prisma, async (tx) => tx.auditOutbox.count(), BYPASS_PURPOSE.AUDIT_WRITE);
}`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("passes library calls and tx-taking helpers inside a callback", () => {
    const { code, stdout } = run([["src/app/m.ts", `${HEAD}
import type { Prisma } from "@prisma/client";
async function countFor(tx: Prisma.TransactionClient) { return tx.session.count(); }
export const f = (raw: string) => withBypassRls(prisma, async (tx) => {
  const parsed = JSON.parse(raw) as { n: number };
  await countFor(tx);
  return [parsed.n, await tx.user.findMany()].map((x) => String(x));
}, BYPASS_PURPOSE.AUDIT_WRITE);`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("passes a hook only a test installs", () => {
    const { code, stdout } = run([
      ["src/lib/hook.ts", `let hook: (id: string) => Promise<unknown> = async () => null;
export function setHook(h: (id: string) => Promise<unknown>) { hook = h; }
export const runHook = (id: string) => hook(id);`],
      ["src/lib/hook.test.ts", `import { setHook } from "@/lib/hook";
import { resolveTeamTenantId } from "@/lib/tenant-context";
setHook(resolveTeamTenantId);`],
      ["src/app/n.ts", `${HEAD}
import { runHook } from "@/lib/hook";
export const f = () => withBypassRls(prisma, async (tx) => runHook("t"), BYPASS_PURPOSE.AUDIT_WRITE);`],
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("passes an allowlisted conditional opener, and fails the entry once it matches nothing", () => {
    const opener = ["src/lib/auth/policy/passkey-enforcement.ts", `${HEAD}
export async function derivePasskeyState(p: { tx?: unknown }) {
  return p.tx ? true : withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUTH_FLOW);
}`];
    const allowed = run([opener, ["src/lib/mcp/oauth-server.ts", `${HEAD}
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
export const f = () => withBypassRls(prisma, async (tx) => derivePasskeyState({ tx }), BYPASS_PURPOSE.AUTH_FLOW);`]]);
    expect(allowed.code).toBe(0);

    const stale = run([opener, ["src/lib/mcp/oauth-server.ts", `${HEAD}
export const f = () => withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUTH_FLOW);`]]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("src/lib/mcp/oauth-server.ts::derivePasskeyState");
  });
});

describe("check-rls-nesting: real repo", () => {
  it("names only files that exist in its allowlists", () => {
    const source = readFileSync(CHECKER, "utf8");
    const keys = [...source.matchAll(/\["([^"]+)::(\w+)",/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    expect(keys.filter((f) => !existsSync(join(REPO_ROOT, f)))).toEqual([]);
  });
});
