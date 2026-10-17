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
const UNFOLLOWED = "A context callback reaches something this gate cannot follow";

describe("check-rls-nesting: baseline", () => {
  it("passes the scaffold alone, and says what it examined", () => {
    const { code, stdout } = run([]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/check-rls-nesting: OK \(\d+ files, [4-9] context functions, [1-9]\d* context calls, [1-9]\d* callbacks checked\)/);
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
    expect(stderr).toMatch(/src\/app\/b\.ts:7 .* calls requireMember \(src\/lib\/auth\.ts:2\) reaches withTeamTenantRls/);
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

});

// ─── Shapes found by the round-1 review, each executed as a bypass first ────

const OPENER_MODULE = ["src/lib/opener.ts", `import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function opener(): Promise<number> {
  return withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUDIT_WRITE);
}
`];
const USE_OPENER = `${HEAD}import { opener } from "@/lib/opener";
`;

describe("check-rls-nesting: values and invocations the round-1 review bypassed with", () => {
  it.each([
    ["an opener inside an array literal", "await Promise.all([opener].map((f) => f()));"],
    ["an opener bound with .bind", "const bound = opener.bind(null); await bound();"],
    ["an opener in an object literal", "const handlers = { run: opener }; await handlers.run();"],
  ])("fails %s inside a callback", (_label, body) => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/v.ts", `${USE_OPENER}
export const f = () => withTenantRls(prisma, T, async () => { ${body} });`]]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/app\/v\.ts:\d+ +\(inside the context opened at src\/app\/v\.ts:\d+\) hands on opener/);
  });

  it("fails a closure that calls the parameter it captured", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/w.ts", `${USE_OPENER}
const makeRunner = (fn: () => Promise<number>) => () => fn();
const runIt = makeRunner(opener);
export const f = () => withTenantRls(prisma, T, async () => { await runIt(); });`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("calls <anonymous>");
    expect(stderr).toContain("reaches opener");
  });

  it("fails a parameter of an inline callback whose value no signature names", () => {
    const { code, stderr } = run([["src/app/x.ts", `${HEAD}
type Job = () => Promise<void>;
export const f = (jobs: Job[]) => withTenantRls(prisma, T, async () => {
  for (const job of jobs) await job();
  jobs.forEach((j) => j());
});`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("function supplied to a callback's parameter");
  });

  it("passes a library-typed callback parameter (Promise's resolve)", () => {
    const { code, stdout } = run([["src/app/y.ts", `${HEAD}
export const f = () => withTenantRls(prisma, T, async () => new Promise<void>((resolve) => resolve()));`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  // Each is reported as an INVOCATION ("calls"), not merely as a value
  // reference, so the case pins the invocation form it names.
  it.each([
    ["a getter", `const svc = { get run() { return opener(); } };`, "await svc.run;", "calls run"],
    ["a tagged template", "const tag = (_s: TemplateStringsArray) => opener();", "await tag`x`;", "calls tag"],
    ["an awaited thenable", "const later = { then(ok: (v: number) => void) { void opener().then(ok); } };", "await later;", "calls then"],
  ])("fails an opener invoked through %s", (_label, decl, body, how) => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/z.ts", `${USE_OPENER}${decl}
export const f = () => withTenantRls(prisma, T, async () => { ${body} });`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toContain(how);
  });

  it("fails a subclass override that opens, reached through the base method", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/cls.ts", `${USE_OPENER}
class Base { async step(): Promise<number> { return 0; } run() { return withTenantRls(prisma, T, async () => this.step()); } }
export class Derived extends Base { async step(): Promise<number> { return opener(); } }`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("calls step");
  });

  it("fails a const table that gains a member after its initializer", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/tbl.ts", `${USE_OPENER}
const TABLE: Record<string, () => Promise<unknown>> = { a: async () => null };
TABLE.b = opener;
export const f = (k: string) => withTenantRls(prisma, T, async () => TABLE[k]());`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("table TABLE is mutated or escapes");
  });

  it("passes a const table that is only read", () => {
    const { code, stdout } = run([["src/app/tbl2.ts", `${HEAD}
const TABLE = { a: async () => 1, b: async () => 2 };
export const f = (k: keyof typeof TABLE) => withTenantRls(prisma, T, async () => {
  for (const key of Object.keys(TABLE) as (keyof typeof TABLE)[]) await TABLE[key]();
  return TABLE[k]();
});`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: a context opened out of sight fails", () => {
  it.each([
    [".apply", "withTenantRls.apply(null, [prisma, T, async () => null]);"],
    [".call", "withTenantRls.call(null, prisma, T, async () => null);"],
    ["a library holding the helper", "await Promise.resolve(withTenantRls);"],
  ])("fails a base helper used through %s", (_label, body) => {
    const { code, stderr } = run([["src/app/ap.ts", `${HEAD}
export async function f() { ${body} }`]]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/context function withTenantRls .* used as a value/);
  });

  it("fails a context call whose callback follows a spread argument", () => {
    const { code, stderr } = run([["src/app/sp.ts", `${HEAD}
export async function f(args: [typeof prisma, string]) {
  return withTenantRls(...args, async () => null);
}`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("context call with a spread argument before its callback position");
  });

  it("checks a callback typed any by its position, not by its type", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/an.ts", `${USE_OPENER}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cb: any = async () => { await opener(); };
export const f = () => withTenantRls(prisma, T, cb);`]]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/app\/an\.ts:\d+ .* calls opener/);
  });
});

describe("check-rls-nesting: production scope beyond src/", () => {
  it("fails a nesting in an operator script under scripts/", () => {
    const { code, stderr } = run([["scripts/tenant-domain.ts", `${HEAD}
export const f = () => withBypassRls(prisma, async () => withTenantRls(prisma, T, async () => null), BYPASS_PURPOSE.SYSTEM_MAINTENANCE);`]]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/scripts\/tenant-domain\.ts:\d+ .* calls withTenantRls/);
  });

  it("counts an opener in a production helper under scripts/lib/", () => {
    const { code, stderr } = run([
      ["scripts/lib/helper.ts", `import { resolveTeamTenantId } from "@/lib/tenant-context";
export const lookup = (id: string) => resolveTeamTenantId(id);`],
      ["scripts/job.ts", `${HEAD}
import { lookup } from "./lib/helper";
export const f = () => withBypassRls(prisma, async () => lookup("t"), BYPASS_PURPOSE.SYSTEM_MAINTENANCE);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("calls lookup (scripts/lib/helper.ts:2)");
  });

  it("does not judge scripts/manual-tests, which are not production", () => {
    const { code, stdout } = run([["scripts/manual-tests/probe.ts", `${HEAD}
export const f = () => withBypassRls(prisma, async () => withTenantRls(prisma, T, async () => null), BYPASS_PURPOSE.SYSTEM_MAINTENANCE);`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: allowlists are exact", () => {
  const PASSKEY = ["src/lib/auth/policy/passkey-enforcement.ts", `${HEAD}
export async function derivePasskeyState(p: { userId: string; tx?: unknown }) {
  return p.tx ? true : withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUTH_FLOW);
}`];
  const OAUTH_ALLOWED = ["src/lib/mcp/oauth-server.ts", `${HEAD}
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
export const f = () => withBypassRls(prisma, async (tx) => derivePasskeyState({ userId: "u", tx }), BYPASS_PURPOSE.AUTH_FLOW);`];

  it("passes the listed conditional opener when the call passes the outer tx", () => {
    const { code, stdout } = run([PASSKEY, OAUTH_ALLOWED]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it.each([
    ["omits tx", "derivePasskeyState({ userId: \"u\" })"],
    ["passes tx: undefined", "derivePasskeyState({ userId: \"u\", tx: undefined })"],
    ["passes a tx that is not an enclosing parameter", "derivePasskeyState({ userId: \"u\", tx: OTHER })"],
  ])("fails the listed conditional opener when the call %s", (_label, call) => {
    const { code, stderr } = run([PASSKEY, ["src/lib/mcp/oauth-server.ts", `${HEAD}
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
const OTHER = {};
export const g = () => withBypassRls(prisma, async (tx) => derivePasskeyState({ userId: "u", tx }), BYPASS_PURPOSE.AUTH_FLOW);
export const f = () => withBypassRls(prisma, async () => ${call}, BYPASS_PURPOSE.AUTH_FLOW);`]]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/lib\/mcp\/oauth-server\.ts:9 .* calls derivePasskeyState/);
  });

  it("fails the conditional opener called with tx from a file the allowlist does not name", () => {
    const { code, stderr } = run([PASSKEY, OAUTH_ALLOWED, ["src/app/other.ts", `${HEAD}
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
export const f = () => withBypassRls(prisma, async (tx) => derivePasskeyState({ userId: "u", tx }), BYPASS_PURPOSE.AUTH_FLOW);`]]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/app\/other\.ts:\d+ .* calls derivePasskeyState/);
  });

  it("fails the conditional allowlist entry once no call satisfies it", () => {
    const { code, stderr } = run([PASSKEY, ["src/lib/mcp/oauth-server.ts", `${HEAD}
export const f = () => withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUTH_FLOW);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/mcp/oauth-server.ts::derivePasskeyState");
  });

  it("refuses a call through an unlisted interface no code implements", () => {
    const { code, stderr } = run([["src/app/res.ts", `${HEAD}
interface Resolver { resolve(id: string): Promise<unknown> }
export const f = (r: Resolver) => withTenantRls(prisma, T, async () => r.resolve("t"));`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("member with no body and no implementation");
  });

  it("passes a call through a listed SDK-shaped interface", () => {
    const { code, stdout } = run([["src/lib/key-provider/aws-sm-provider.ts", `${HEAD}
interface SmClient { send(command: unknown): Promise<unknown> }
export const f = (c: SmClient) => withTenantRls(prisma, T, async () => c.send({}));`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("fails a listed SDK-shaped interface entry once nothing calls through it", () => {
    const { code, stderr } = run([["src/lib/key-provider/aws-sm-provider.ts", `${HEAD}
interface SmClient { send(command: unknown): Promise<unknown> }
export type Unused = SmClient;`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/key-provider/aws-sm-provider.ts::SmClient");
  });
});

// ─── Shapes found by the round-2 review, each executed as a bypass first ────

const WRAPPER = (body) => `${USE_OPENER}
async function withVault<T>(userId: string, fn: () => Promise<T>) {
  return withUserTenantRls(userId, async () => { ${body} });
}
export const f = () => withVault("u", async () => opener());`;

describe("check-rls-nesting: round 2 — a wrapper parameter by any spelling", () => {
  it.each([
    ["called directly", "return fn();"],
    ["aliased", "const g = fn; return g();"],
    ["through .call", "return fn.call(null);"],
    ["held in an object", "const o = { run: fn }; return o.run();"],
  ])("derives the wrapper when its parameter is %s", (_label, body) => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/wr.ts", WRAPPER(body)]]);
    expect(code).toBe(1);
    // Reported at the wrapper's CALL SITE: its literal argument is the root.
    expect(stderr).toMatch(/src\/app\/wr\.ts:10 +\(inside the context opened at src\/app\/wr\.ts:10\) calls opener/);
  });

  it("derives the wrapper for an any-typed callback parameter", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/wa.ts", `${USE_OPENER}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withVault(userId: string, fn: any) {
  return withUserTenantRls(userId, async () => fn());
}
export const f = () => withVault("u", async () => opener());`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("calls opener");
  });
});

describe("check-rls-nesting: user review — a wrapper callback chosen by an expression", () => {
  it("derives every parameter a conditional can select as a wrapper callback position", () => {
    const { code, stderr } = run([["src/app/sel.ts", `${HEAD}
async function withSelected(first: () => Promise<unknown>, second: () => Promise<unknown>, useFirst: boolean) {
  return withTenantRls(prisma, T, useFirst ? first : second);
}
export const f = () => withSelected(async () => null, async () => resolveTeamTenantId("team"), false);`]]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/app\/sel\.ts:9 .* calls resolveTeamTenantId/);
  });

  it("passes when every selectable callback is clean", () => {
    const { code, stdout } = run([["src/app/sel2.ts", `${HEAD}
async function withSelected(first: () => Promise<unknown>, second: () => Promise<unknown>, useFirst: boolean) {
  return withTenantRls(prisma, T, useFirst ? first : second);
}
export const f = () => withSelected(async () => null, async () => 1, false);`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 2 — library-typed values are judged on the declaration", () => {
  it("fails an own function stored behind a library function type and read back by Map.get", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/mg.ts", `${USE_OPENER}
const registry = new Map<string, VoidFunction>([["a", () => void opener()]]);
export const f = () => withTenantRls(prisma, T, async () => { registry.get("a")?.(); });`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("function returned by a library call");
  });

  it("fails an own function reaching a forEach callback parameter through a type parameter", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/fe.ts", `${USE_OPENER}
const list: VoidFunction[] = [() => void opener()];
export const f = () => withTenantRls(prisma, T, async () => { list.forEach((cb) => cb()); });`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("function supplied to a callback's parameter");
  });
});

describe("check-rls-nesting: round 2 — writes the resolver must see, however spelled", () => {
  it.each([
    ["a member assigned after the initializer", "const ops = { run: async () => 0 };\nexport function arm() { ops.run = opener; }", "await ops.run();", /src\/app\/wt\.ts:\d+ .* calls opener/],
    ["a destructuring write", "let fn: () => Promise<number> = async () => 0;\nexport function arm() { [fn] = [opener]; }", "await fn();", /write other than a plain assignment/],
    ["a compound assignment", "let fn: (() => Promise<number>) | null = null;\nexport function arm() { fn ||= opener; }", "await fn?.();", /write other than a plain assignment/],
  ])("fails %s", (_label, decl, body, expected) => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/wt.ts", `${USE_OPENER}${decl}
export const f = () => withTenantRls(prisma, T, async () => { ${body} });`]]);
    expect(code).toBe(1);
    expect(stderr).toMatch(expected);
  });

  it("passes a const object whose members are only read", () => {
    const { code, stdout } = run([["src/app/wr2.ts", `${HEAD}
const ops = { run: async () => 0 };
export const f = () => withTenantRls(prisma, T, async () => ops.run());`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 2 — class construction", () => {
  it.each([
    ["an inherited constructor", "class Base { constructor() { void opener(); } }\nclass Child extends Base {}", "new Child();"],
    ["super()", "class Base { constructor() { void opener(); } }\nclass Child extends Base { constructor() { super(); } }", "new Child();"],
    ["a field initializer", "class Holder { p = opener(); }", "new Holder();"],
  ])("fails an opener run by %s", (_label, decl, body) => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/cc.ts", `${USE_OPENER}${decl}
export const f = () => withTenantRls(prisma, T, async () => { ${body} });`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toContain("reaches opener");
  });

  it("passes constructing a class whose base is a library class", () => {
    const { code, stdout } = run([["src/app/ce.ts", `${HEAD}
class AppError extends Error { constructor(m: string) { super(m); } }
export const f = () => withTenantRls(prisma, T, async () => { throw new AppError("x"); });`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 2 — resolver refusals each name themselves", () => {
  const SETTER = `let hook: (() => Promise<number>) | null = null;
export function setHook(h: () => Promise<number>) { hook = h; }
export function setHooks(...hs: Array<() => Promise<number>>) { hook = hs[0]; }
const runHook = () => hook?.();`;
  it.each([
    ["a setter referenced other than by a direct call", "const s = setHook; s(opener);", "function referenced other than by a direct call"],
    ["a spread at the setter's parameter", "setHook(...([opener] as [() => Promise<number>]));", "spread argument at the parameter's position"],
  ])("fails %s", (_label, arm, reason) => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/rs.ts", `${USE_OPENER}${SETTER}
export function arm() { ${arm} }
export const f = () => withTenantRls(prisma, T, async () => { await runHook(); });`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(reason);
  });

  it("fails a function assigned from a rest parameter", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/rp.ts", `${USE_OPENER}
let hook: (() => Promise<number>) | null = null;
export function setHooks(...hs: Array<() => Promise<number>>) { hook = hs[0]; }
export function arm() { setHooks(opener); }
export const f = () => withTenantRls(prisma, T, async () => { await hook?.(); });`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(UNFOLLOWED);
  });
});

describe("check-rls-nesting: round 2 — remaining invocation forms and allowlist edges", () => {
  it("fails an opener invoked through an own setter", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/st.ts", `${USE_OPENER}
const svc = { set run(_v: number) { void opener(); } };
export const f = () => withTenantRls(prisma, T, async () => { svc.run = 1; });`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("calls run");
  });

  it("fails an awaited object whose then is a property assignment", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/tp.ts", `${USE_OPENER}
const later = { then: (ok: (v: number) => void) => { void opener().then(ok); } };
export const f = () => withTenantRls(prisma, T, async () => { await later; });`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("calls then");
  });

  it("passes a call through a listed SDK shape declared as a type alias", () => {
    const { code, stdout } = run([["scripts/lib/assert-bypass-rls-active.ts", `${HEAD}
type TxProbe = { $queryRawUnsafe<R = unknown>(sql: string): Promise<R> };
export const f = (t: TxProbe) => withTenantRls(prisma, T, async () => t.$queryRawUnsafe("SELECT 1"));`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("fails the conditional opener when tx is an optional parameter of an outer function", () => {
    const { code, stderr } = run([
      ["src/lib/auth/policy/passkey-enforcement.ts", `${HEAD}
export async function derivePasskeyState(p: { userId: string; tx?: unknown }) {
  return p.tx ? true : withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUTH_FLOW);
}`],
      ["src/lib/mcp/oauth-server.ts", `${HEAD}
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
export const g = () => withBypassRls(prisma, async (tx) => derivePasskeyState({ userId: "u", tx }), BYPASS_PURPOSE.AUTH_FLOW);
export async function outer(tx?: unknown) {
  return withBypassRls(prisma, async () => derivePasskeyState({ userId: "u", tx }), BYPASS_PURPOSE.AUTH_FLOW);
}`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/lib\/mcp\/oauth-server\.ts:9 .* calls derivePasskeyState/);
  });

  it("passes a base helper imported under an alias and called directly", () => {
    const { code, stdout } = run([["src/app/al.ts", `import { prisma } from "@/lib/prisma";
import { withTenantRls as runInTenant } from "@/lib/tenant-rls";
export const f = () => runInTenant(prisma, "11111111-1111-4111-8111-111111111111", async () => null);`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 2 — the production boundary", () => {
  it("fails production code that imports a listed tooling script", () => {
    const { code, stderr } = run([
      ["scripts/env-allowlist.ts", "export const ALLOW = [] as string[];\n"],
      ["src/app/tool.ts", `import { ALLOW } from "../../scripts/env-allowlist";\nexport const n = ALLOW.length;\n`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("production code imports scripts/env-allowlist.ts, which is not production");
  });

  it("fails listed tooling that imports the RLS helpers", () => {
    const { code, stderr } = run([["scripts/env-allowlist.ts", `import { withTenantRls } from "../src/lib/tenant-rls";\nexport const w = withTenantRls;\n`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("scripts/env-allowlist.ts is listed as non-production tooling but imports src/lib/tenant-rls.ts");
  });
});

describe("check-rls-nesting: real repo", () => {
  it("names only files that exist in its allowlists", () => {
    // The stale-entry checks skip an entry whose file is absent (fixture trees
    // lack them), so absence is asserted here against the real tree.
    const resolverSource = readFileSync(join(REPO_ROOT, "scripts/checks/lib/function-resolver.mjs"), "utf8");
    const shapeFiles = [...resolverSource.matchAll(/\["([^"]+)::(\w+)",/g)].map((m) => m[1]);
    const conditionalFiles = [...readFileSync(CHECKER, "utf8").matchAll(/\{ file: "([^"]+)", callee: "\w+" \}/g)].map((m) => m[1]);
    expect(shapeFiles.length).toBeGreaterThanOrEqual(4);
    expect(conditionalFiles.length).toBeGreaterThanOrEqual(1);
    expect([...shapeFiles, ...conditionalFiles].filter((f) => !existsSync(join(REPO_ROOT, f)))).toEqual([]);
  });
});
