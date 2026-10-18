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
import { Project, SyntaxKind } from "ts-morph";

const CHECKER = fileURLToPath(new URL("../checks/check-rls-nesting.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const REAL_FILES = ["src/lib/tenant-rls.ts", "src/lib/tenant-context.ts"];

// Stubs for what the two real files import. Typed, so nothing they call
// widens to `any` and reads as an unresolvable callee.
// One getter per schema model, as the generated client declares them.
const MODELS = [...readFileSync(join(REPO_ROOT, "prisma/schema.prisma"), "utf8").matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);
const MODEL_GETTERS = MODELS.map((m) => `    get ${m[0].toLowerCase()}${m.slice(1)}(): Prisma.${m}Delegate;`).join("\n");
const MODEL_DELEGATES = MODELS.map((m) => `    interface ${m}Delegate extends Delegate {}`).join("\n");

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
  // As generated: one getter per model, no string index signature, and a
  // transaction client that is the client minus its runtime methods.
  export class PrismaClient {
${MODEL_GETTERS}
    $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: unknown): Promise<T>;
    $executeRaw(...args: unknown[]): Promise<number>;
  }
  export namespace Prisma {
    type TransactionClient = Omit<PrismaClient, "$transaction">;
${MODEL_DELEGATES}
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
    strict: true,
    noImplicitAny: false,
    allowJs: true, // as the real tsconfig: own JavaScript resolves, and must be refused as such
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
    expect(stderr).toContain("src/app/tbl.ts:8  G1: write of a function through a key no declaration names");
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
    expect(stderr).toContain("member resolve with no body and no member of that name");
  });

  it("passes a call through a listed SDK-shaped interface", () => {
    // Both shapes the real file lists, each called through, so neither entry is stale.
    const { code, stdout } = run([["src/lib/key-provider/aws-sm-provider.ts", `${HEAD}
interface SmClient { send(command: unknown): Promise<unknown> }
interface AwsSmModule { SecretsManagerClient: new (config: { region: string }) => SmClient }
export const f = (c: SmClient, m: AwsSmModule) => withTenantRls(prisma, T, async () => { new m.SecretsManagerClient({ region: "r" }); return c.send({}); });`]]);
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
    ["a member assigned after the initializer", "const ops = { run: async () => 0 };\nexport function arm() { ops.run = opener; }", "await ops.run();", /src\/app\/wt\.ts:\d+  G1: write to member run, which may hold a function/],
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let hook: any = null;
// A rest parameter's position depends on how many arguments precede it.
export function setHooks(...hs: unknown[]) { hook = hs; }
export function arm() { setHooks(opener); }
export const f = () => withTenantRls(prisma, T, async () => { await hook?.(); });`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("rest parameter");
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
    expect(stderr).toContain("production code imports scripts/env-allowlist.ts, which is declared non-production");
  });

  it("fails listed tooling that imports the RLS helpers", () => {
    const { code, stderr } = run([["scripts/env-allowlist.ts", `import { withTenantRls } from "../src/lib/tenant-rls";\nexport const w = withTenantRls;\n`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("scripts/env-allowlist.ts is listed as non-production tooling but its imports reach src/lib/tenant-rls.ts");
  });
});

describe("check-rls-nesting: round 3", () => {
  it.each([
    ["an object member handed to a library", "new ReadableStream({ start: () => { void opener(); } });"],
    ["an array element", "await Promise.all([async () => opener()].map((f) => f()));"],
    ["a class static block", "class X { static { void opener(); } } void X;"],
    ["a class static field", "class Y { static p = opener(); } void Y;"],
  ])("fails an opener inside %s", (_label, body) => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/lx.ts", `${USE_OPENER}
export const f = () => withTenantRls(prisma, T, async () => { ${body} });`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
  });

  it("fails an opener behind a nullable library value read under strict", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/app/ns.ts", `${USE_OPENER}
const registry = new Map<string, VoidFunction>([["a", () => void opener()]]);
export const f = () => withTenantRls(prisma, T, async () => { const h = registry.get("a"); if (h) h(); });`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("function returned by a library call");
  });

  it("fails the conditional opener when a spread may override tx", () => {
    const { code, stderr } = run([
      ["src/lib/auth/policy/passkey-enforcement.ts", `${HEAD}
export async function derivePasskeyState(p: { userId: string; tx?: unknown }) {
  return p.tx ? true : withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUTH_FLOW);
}`],
      ["src/lib/mcp/oauth-server.ts", `${HEAD}
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
export const g = () => withBypassRls(prisma, async (tx) => derivePasskeyState({ userId: "u", tx }), BYPASS_PURPOSE.AUTH_FLOW);
export const f = (c: boolean) => withBypassRls(prisma, async (tx) => derivePasskeyState({ userId: "u", tx, ...(c ? { tx: undefined } : {}) }), BYPASS_PURPOSE.AUTH_FLOW);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/lib\/mcp\/oauth-server\.ts:8 .* calls derivePasskeyState/);
  });

  it("passes a library method bound to a receiver (raw-sql's captured intrinsics)", () => {
    const { code, stdout } = run([["src/app/lb.ts", `${HEAD}
const registry = new WeakMap<object, string>();
const registryGet = WeakMap.prototype.get.bind(registry);
export const f = () => withTenantRls(prisma, T, async () => registryGet({}));`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("fails production code that re-exports a listed tooling script", () => {
    const { code, stderr } = run([
      ["scripts/env-allowlist.ts", "export const ALLOW = [] as string[];\n"],
      ["src/app/tool.ts", `export * from "../../scripts/env-allowlist";\n`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("production code imports scripts/env-allowlist.ts");
  });

  it("fails production code that loads a listed tooling script dynamically", () => {
    const { code, stderr } = run([
      ["scripts/env-allowlist.ts", "export const ALLOW = [] as string[];\n"],
      ["src/app/tool.ts", `export const load = () => import("../../scripts/env-allowlist");\n`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("production code imports scripts/env-allowlist.ts");
  });
});

describe("check-rls-nesting: real repo", () => {
  it("names only files that exist in its allowlists", async () => {
    // The stale-entry checks skip an entry whose file is absent (fixture trees
    // lack them), so absence is asserted here against the real tree. The lists
    // are read as values (imported, or off the gate's syntax tree), not by
    // matching their text.
    const { EXTERNAL_SHAPE_ALLOWLIST } = await import("../checks/lib/function-resolver.mjs");
    const { FUNCTION_FLOW_ALLOWLIST, NON_LITERAL_LOAD_ALLOWLIST } = await import("../checks/lib/soundness.mjs");
    const gate = new Project({ useInMemoryFileSystem: true }).createSourceFile("gate.ts", readFileSync(CHECKER, "utf8"));
    const entries = gate
      .getVariableDeclarationOrThrow("CONDITIONAL_OPENER_ALLOWLIST")
      .getInitializerIfKindOrThrow(SyntaxKind.ArrayLiteralExpression)
      .getElements();
    const conditionalFiles = entries.flatMap((e) =>
      ["file", "calleeFile"].map((k) => e.asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getPropertyOrThrow(k).getInitializer().getLiteralText()),
    );
    const files = [
      ...[...EXTERNAL_SHAPE_ALLOWLIST.keys(), ...FUNCTION_FLOW_ALLOWLIST.keys()].map((k) => k.split("::")[0]),
      ...NON_LITERAL_LOAD_ALLOWLIST.keys(),
      ...conditionalFiles,
    ];
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(files.length).toBe(EXTERNAL_SHAPE_ALLOWLIST.size + FUNCTION_FLOW_ALLOWLIST.size + NON_LITERAL_LOAD_ALLOWLIST.size + 2 * entries.length);
    expect(files.filter((f) => !existsSync(join(REPO_ROOT, f)))).toEqual([]);
  });
});

// ─── Round 4: a decidable subset, refused outside it ────────────────────────
//
// The resolver names a function by its declaration; lib/soundness.mjs refuses
// every way to put a different function where a declaration says (G1-G5), and
// the scan set is the production import closure. Each deny case below passed
// the round-3 gate; each allow case is real code that must keep passing.

const FLOW = "A function is put somewhere its declaration does not say";
const BOUNDARY = "The production boundary does not hold";
const R4 = (body) => ["src/app/r4.ts", `${USE_OPENER}${body}`];

describe("check-rls-nesting: round 4 — a member holds what its declaration says (G1-G5)", () => {
  it.each([
    ["a function written into an any object", "const o: any = {};\nexport function arm() { o.run = opener; }", "src/app/r4.ts:7  G1: write of a function through a key no declaration names"],
    ["a destructuring assignment onto a member", "const ops = { run: async () => 0 };\nexport function arm(o: { run: () => Promise<number> }) { ({ run: ops.run } = o); }", "src/app/r4.ts:7  G1: write to member run"],
    ["a field set in the constructor", "export class Job { run: () => Promise<number> = async () => 0;\n  constructor(f: () => Promise<number>) { this.run = f; } }", "src/app/r4.ts:7  G1: write to member run"],
    ["Object.assign onto this", "export class Job { run: () => Promise<number> = async () => 0;\n  constructor(o: Partial<Job>) { Object.assign(this, o); } }", "src/app/r4.ts:7  G2: object mutator"],
    ["Object.assign through a renamed alias", "const put = Object.assign;\nconst ops = { run: async () => 0 };\nexport function arm() { put(ops, { run: opener }); }", "src/app/r4.ts:6  G2: object mutator ObjectConstructor.assign used other than by a direct call"],
    ["Object.defineProperty onto a fresh literal", "export const o = Object.defineProperty({ run: async () => 0 }, \"run\", { value: opener });", "src/app/r4.ts:6  G2: object mutator"],
    ["Reflect.set", "const ops = { run: async () => 0 };\nexport function arm() { Reflect.set(ops, \"run\", opener); }", "src/app/r4.ts:7  G2: object mutator"],
    ["a computed-key member", "const k = String(Date.now());\nexport const t = { [k]: opener };", "src/app/r4.ts:7  G3: computed-key member holding a function"],
    ["a callable parameter property", "export class P { constructor(private cb: () => Promise<number>) {} go() { return this.cb(); } }", "src/app/r4.ts:6  G4: constructor parameter property holding a function"],
    ["a class expression that extends", "class A { run() { return 0; } }\nexport const B = class extends A {};", "src/app/r4.ts:7  G5: class expression with extends"],
    ["a mixin base", "class A { run() { return 0; } }\nconst mix = <T extends new () => object>(b: T) => b;\nexport class C extends mix(A) {}", "src/app/r4.ts:8  G5: extends an expression that is not a class name"],
  ])("refuses %s", (_label, body, message) => {
    const { code, stderr } = run([OPENER_MODULE, R4(body)]);
    expect(code).toBe(1);
    expect(stderr).toContain(FLOW);
    expect(stderr).toContain(message);
  });

  it("passes object mutators on data, and Object.assign onto a fresh literal", () => {
    // The fresh literal holds a function member; Object.assign's sources keep
    // their member names, so the result's run is still a declared member.
    const { code, stdout } = run([OPENER_MODULE, R4(`const data: { a: number; b?: string } = { a: 1 };
export function fill() { Object.assign(data, { b: "x" }); return Object.assign({ run: async () => 0 }, { run: opener }); }`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("passes a function written into a member a library declares", () => {
    const { code, stdout } = run([OPENER_MODULE, ["types/img.d.ts", `declare module "imglib" {
  export interface Img { onload: (() => void) | null }
  export function makeImg(): Img;
}`], R4(`import { makeImg } from "imglib";
export function load() { const img = makeImg(); img.onload = () => {}; return img; }`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 4 — an interface member is every production member of its name", () => {
  it("fails an opener behind an object literal that implements the interface only structurally", () => {
    const { code, stderr } = run([OPENER_MODULE, R4(`interface Runner { run(): Promise<number> }
const structural = { run: opener };
export function use(r: Runner) { return withTenantRls(prisma, T, async () => r.run()); }
export const x = use(structural);`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toMatch(/src\/app\/r4\.ts:8 .*opener/);
  });

  it("fails an opener behind a class that implements the interface only structurally", () => {
    const { code, stderr } = run([OPENER_MODULE, R4(`interface Runner { run(): Promise<number> }
class C { run() { return opener(); } }
export function use(r: Runner) { return withTenantRls(prisma, T, async () => r.run()); }
export const x = use(new C());`)]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/app\/r4\.ts:8 .*calls run .*reaches opener/);
  });

  it("passes an interface member only a test supplies", () => {
    const { code, stdout } = run([OPENER_MODULE, R4(`export interface Hooks { onDone?: () => Promise<number> }
export function use(h: Hooks) { return withTenantRls(prisma, T, async () => h.onDone?.()); }`),
    ["src/app/r4.test.ts", `import { use } from "./r4";\nimport { opener } from "@/lib/opener";\nexport const t = use({ onDone: opener });`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("fails a subclass field that overrides the base's", () => {
    const { code, stderr } = run([OPENER_MODULE, R4(`class A { run: () => Promise<number> = async () => 0; }
class B extends A { override run = opener; }
export const svc: A = new B();
export const f = () => withTenantRls(prisma, T, async () => { await svc.run(); });`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toMatch(/src\/app\/r4\.ts:9 .*opener/);
  });
});

describe("check-rls-nesting: round 4 — values a library holds, returns or is handed", () => {
  const LIB = ["types/r4lib.d.ts", `declare module "r4lib" {
  export interface Box<T> { current: T }
  export function box<T>(v: T): Box<T>;
  export function invoke(f: () => Promise<number>): Promise<number>;
  export function runAll(fns: Array<() => Promise<number>>): Promise<void>;
  export class Stream { constructor(source: { start(): void }); }
  export function first<T>(xs: T[]): NonNullable<T>;
}
declare function require(id: string): any;`];

  it.each([
    ["a function held in a library member typed by what was stored", `import { box } from "r4lib";
const b = box(opener);
export const f = () => withTenantRls(prisma, T, async () => b.current());`, "function held in a library member typed by what its user stored"],
    ["an any-typed function a library returns, invoked later", `const registry = new Map<string, any>([["a", opener]]);
export const f = () => withTenantRls(prisma, T, async () => { const h = registry.get("a"); await h(); });`, "function returned by a library call"],
    ["a library result handed straight to an own invoker", `async function retry(cb: () => Promise<number>) { return cb(); }
const registry = new Map<string, () => Promise<number>>([["a", opener]]);
export const f = () => withTenantRls(prisma, T, async () => retry(registry.get("a")!));`, "function returned by a library call"],
    ["an array of functions handed to a library", `import { runAll } from "r4lib";
const fns = [opener];
export const f = () => withTenantRls(prisma, T, async () => runAll(fns));`, "array of functions handed to library code"],
    ["a function a library builds from the caller's type", `import { first } from "r4lib";
const arr = [opener];
export const f = () => withTenantRls(prisma, T, async () => first(arr)());`, "function returned by a library call"],
  ])("refuses %s", (_label, body, reason) => {
    const { code, stderr } = run([OPENER_MODULE, LIB, R4(body)]);
    expect(code).toBe(1);
    expect(stderr).toContain(UNFOLLOWED);
    expect(stderr).toContain(reason);
  });

  it.each([
    ["an own object handed to a library that calls its members", `import { Stream } from "r4lib";
const source = { start() { void opener(); } };
export const f = () => withTenantRls(prisma, T, async () => { new Stream(source); });`],
    ["a private field handed on", `import { invoke } from "r4lib";
class Svc { #run = opener; go() { return invoke(this.#run); } }
const svc = new Svc();
export const f = () => withTenantRls(prisma, T, async () => svc.go());`],
    ["an element-access receiver of .bind", `import { invoke } from "r4lib";
const TBL = { a: opener };
export const f = () => withTenantRls(prisma, T, async () => invoke(TBL["a"].bind(null)));`],
    ["a function destructured from an own module's import()", `export const f = () => withTenantRls(prisma, T, async () => { const { opener: o } = await import("@/lib/opener"); await o(); });`],
    ["a function destructured from an own module's require()", `export const f = () => withTenantRls(prisma, T, async () => { const { opener: o } = require("../lib/opener"); await o(); });`],
  ])("fails %s", (_label, body) => {
    const { code, stderr } = run([OPENER_MODULE, LIB, R4(body)]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toContain("opener (src/lib/opener.ts");
  });

  it("passes a function destructured from a library module, though typed any", () => {
    const { code, stdout } = run([OPENER_MODULE, LIB, R4(`export const f = () => withTenantRls(prisma, T, async () => { const { join } = require("node:path"); return join("a", "b"); });`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("passes an own invoker that tests its optional callback before calling it", () => {
    const { code, stdout } = run([OPENER_MODULE, R4(`async function invoke(cb?: (op: () => Promise<number>) => Promise<number>) {
  if (cb) return cb(async () => 1);
  return 0;
}
export const f = () => withTenantRls(prisma, T, async () => invoke((op) => op()));`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 4 — the scan set is the production import closure", () => {
  it("scans a module outside src/ and scripts/ that production imports", () => {
    const { code, stderr } = run([OPENER_MODULE, ["root-helper.ts", `import { opener } from "./src/lib/opener";\nexport const helper = () => opener();\n`],
      R4(`import { helper } from "../../root-helper";\nexport const f = () => withTenantRls(prisma, T, async () => helper());`)]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/calls helper \(root-helper\.ts:2\) reaches opener/);
  });

  it("counts an interface member a module outside src/ implements", () => {
    const { code, stderr } = run([OPENER_MODULE, ["root-runner.ts", `import { opener } from "./src/lib/opener";\nexport const runner = { run: opener };\n`],
      R4(`import { runner } from "../../root-runner";
interface Runner { run(): Promise<number> }
export function use(r: Runner) { return withTenantRls(prisma, T, async () => r.run()); }
export const x = use(runner);`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
  });

  it("holds a module outside src/ that production imports to G1-G5", () => {
    const { code, stderr } = run([["root-ops.ts", `export const ops = { run: async () => 0 };\nexport function arm(f: () => Promise<number>) { ops.run = f; }\n`],
      ["src/app/r4.ts", `import { ops } from "../../root-ops";\nexport const y = ops;`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("root-ops.ts:2  G1: write to member run");
  });

  it.each([
    ["own JavaScript", [["src/lib/legacy.js", "export const x = 1;\n"]], `import { x } from "@/lib/legacy.js";\nexport const y = x;`, "loads src/lib/legacy.js, own JavaScript the gates cannot read"],
    ["a declaration over own JavaScript", [["src/lib/shim.js", "export const x = 1;\n"], ["src/lib/shim.d.ts", "export declare const x: number;\n"]], `import { x } from "@/lib/shim";\nexport const y = x;`, "a declaration over own JavaScript (src/lib/shim.js)"],
    ["listed tooling through require()", [["scripts/env-allowlist.ts", "export const ALLOW = [];\n"], ["types/req.d.ts", "declare function require(id: string): any;\n"]], `export const load = () => require("../../scripts/env-allowlist");`, "production code imports scripts/env-allowlist.ts, which is declared non-production"],
    ["a test module through a side-effect import()", [["src/lib/__tests__/helper.ts", "export const h = 1;\n"]], `export const load = () => { void import("../lib/__tests__/helper"); };`, "production code imports src/lib/__tests__/helper.ts, which is declared non-production"],
    ["a non-literal specifier", [], `export const load = (m: string) => import(m);`, "production code loads a module through a non-literal specifier"],
    ["an own specifier that does not resolve", [], `export const load = () => import("@/lib/missing");`, "loads @/lib/missing, which does not resolve"],
  ])("refuses production loading %s", (_label, extra, body, message) => {
    const { code, stderr } = run([...extra, ["src/app/r4.ts", body]]);
    expect(code).toBe(1);
    expect(stderr).toContain(BOUNDARY);
    expect(stderr).toContain(message);
  });

  it("refuses listed tooling whose imports reach the RLS helpers through a re-export", () => {
    const { code, stderr } = run([["src/lib/db.ts", `export { withTenantRls } from "@/lib/tenant-rls";\n`],
      ["scripts/init-env.ts", `import { withTenantRls } from "../src/lib/db";\nexport const w = withTenantRls;\n`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("scripts/init-env.ts is listed as non-production tooling but its imports reach src/lib/tenant-rls.ts");
  });
});

describe("check-rls-nesting: round 4 — the conditional opener exempts one edge", () => {
  const passkey = (extra = "") => ["src/lib/auth/policy/passkey-enforcement.ts", `${HEAD}
export async function derivePasskeyState(p: { userId: string; tx?: unknown }) {
  ${extra}
  return p.tx ? true : withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUTH_FLOW);
}`];
  const OAUTH = (body) => ["src/lib/mcp/oauth-server.ts", `${HEAD}
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
export const f = () => withBypassRls(prisma, async (tx) => { ${body} }, BYPASS_PURPOSE.AUTH_FLOW);`];

  it("fails an unconditional opener added to the exempt callee", () => {
    const { code, stderr } = run([passkey("await withTenantRls(prisma, \"t\", async () => null);"), OAUTH("return derivePasskeyState({ userId: \"u\", tx });")]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/oauth-server\.ts:\d+ .* calls derivePasskeyState .* reaches withTenantRls/);
  });

  it("fails when the callee is also entered without the guard in the same context", () => {
    const { code, stderr } = run([passkey(), OAUTH("await derivePasskeyState({ userId: \"u\", tx }); return derivePasskeyState({ userId: \"u\" });")]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/oauth-server\.ts:\d+ .* calls derivePasskeyState .* reaches withBypassRls/);
  });

  it("fails when the callback's client is reassigned before it is passed", () => {
    const { code, stderr } = run([passkey(), ["src/lib/mcp/oauth-server.ts", `${HEAD}
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
export const f = () => withBypassRls(prisma, async (tx: unknown) => { if (Date.now() < 0) tx = undefined; return derivePasskeyState({ userId: "u", tx }); }, BYPASS_PURPOSE.AUTH_FLOW);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
  });

  it("refuses to run when the guarded opener is gone from the callee", () => {
    const { code, stderr } = run([["src/lib/auth/policy/passkey-enforcement.ts", `${HEAD}
export async function derivePasskeyState(p: { userId: string; tx?: unknown }) {
  return withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUTH_FLOW);
}`], OAUTH("return derivePasskeyState({ userId: \"u\", tx });")]);
    expect(code).toBe(1);
    expect(stderr).toContain("expected one opener guarded by p.tx, found 0");
  });
});

describe("check-rls-nesting: round 4 — each refusal by the clause that makes it", () => {
  const LIB = ["types/r4lib.d.ts", `declare module "r4lib" {
  export const anyThing: any;
  export function pair<T>(v: T): [T];
}
declare function require(id: string): any;`];

  it.each([
    ["Object.defineProperty onto this, in a class with no function members", "export class Job { constructor() { Object.defineProperty(this, \"run\", { value: opener }); } }", "src/app/r4.ts:6  G2: object mutator"],
    ["Object.defineProperty onto an any value", "export function arm(o: any) { Object.defineProperty(o, \"run\", { value: opener }); }", "src/app/r4.ts:6  G2: object mutator"],
  ])("refuses %s", (_label, body, message) => {
    const { code, stderr } = run([OPENER_MODULE, R4(body)]);
    expect(code).toBe(1);
    expect(stderr).toContain(message);
  });

  it("refuses an any-typed library value called as a function", () => {
    const { code, stderr } = run([OPENER_MODULE, LIB, R4(`import { anyThing } from "r4lib";
export const f = () => withTenantRls(prisma, T, async () => anyThing());`)]);
    expect(code).toBe(1);
    expect(stderr).toContain("function value typed any or unknown");
  });

  it("refuses a function taken from an array a library returns built from the caller's value", () => {
    const { code, stderr } = run([OPENER_MODULE, LIB, R4(`import { pair } from "r4lib";
export const f = () => withTenantRls(prisma, T, async () => { const [fn] = pair(opener); await fn(); });`)]);
    expect(code).toBe(1);
    expect(stderr).toContain("function from an array pattern");
  });

  it("passes a chain through a library module's createRequire, typed any", () => {
    const { code, stdout } = run([OPENER_MODULE, LIB, R4(`interface Sdk { make(): number }
export const f = () => withTenantRls(prisma, T, async () => {
  const { createRequire } = require("node:module");
  const req = createRequire("x");
  const sdk = req("some-sdk") as Sdk;
  return sdk;
});`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("refuses a context function named in a value position, though it is then held optionally", () => {
    const { code, stderr } = run([R4(`const w: typeof withTenantRls | undefined = Date.now() > 0 ? withTenantRls : undefined;
export const f = () => [1].forEach(w!);`)]);
    expect(code).toBe(1);
    // Both the name (line 6) and the optional holder handed on (line 7) are reported.
    expect(stderr).toMatch(/src\/app\/r4\.ts:6 .*used as a value; the callback it receives cannot be checked/);
    expect(stderr).toMatch(/src\/app\/r4\.ts:7 .*used as a value; the callback it receives cannot be checked/);
  });

  it("refuses to run when the exempt callee writes its own guard", () => {
    const { code, stderr } = run([["src/lib/auth/policy/passkey-enforcement.ts", `${HEAD}
export async function derivePasskeyState(p: { userId: string; tx?: unknown }) {
  if (p.userId === "") p.tx = undefined;
  return p.tx ? true : withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUTH_FLOW);
}`], ["src/lib/mcp/oauth-server.ts", `${HEAD}
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
export const f = () => withBypassRls(prisma, async (tx) => derivePasskeyState({ userId: "u", tx }), BYPASS_PURPOSE.AUTH_FLOW);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("p.tx is written inside derivePasskeyState");
  });
});

describe("check-rls-nesting: round 4 — reviewed exceptions to G1-G5", () => {
  const RAW = (body) => ["src/lib/prisma/raw-sql.ts", `function throwOnConversion(): never { throw new TypeError("x"); }
${body}`];

  it("passes the listed conversion traps in createGenuineObject", () => {
    const { code, stdout } = run([RAW(`export function createGenuineObject(): object {
  const obj = Object.create(null) as Record<PropertyKey, unknown>;
  obj[Symbol.toPrimitive] = throwOnConversion;
  obj.toJSON = throwOnConversion;
  return obj;
}`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("fails the entry once createGenuineObject writes no function", () => {
    const { code, stderr } = run([RAW(`export function createGenuineObject(): object { return Object.create(null); }`)]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/prisma/raw-sql.ts::function createGenuineObject::G1  FUNCTION_FLOW_ALLOWLIST entry matches no violation");
  });

  it("does not excuse the same write in another function of the file", () => {
    const { code, stderr } = run([RAW(`export function createGenuineObject(): object {
  const obj = Object.create(null) as Record<PropertyKey, unknown>;
  obj[Symbol.toPrimitive] = throwOnConversion;
  obj.toJSON = throwOnConversion;
  return obj;
}
export function other(): object {
  const obj = Object.create(null) as Record<PropertyKey, unknown>;
  obj.toJSON = throwOnConversion;
  return obj;
}`)]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/prisma/raw-sql.ts:10  G1: write of a function through a key no declaration names");
  });
});

// ─── Round 5: what a slot may hold, and how a subclass is found ─────────────

describe("check-rls-nesting: round 5 — a slot loose enough to hold a function (R5-F4 / R5-S1)", () => {
  it.each([
    ["a member declared unknown", "export class Job { handler: unknown = null; }\nexport const job = new Job();\nexport function arm() { job.handler = held as never; }", "src/app/r4.ts:9  G1: write to member handler"],
    ["a member declared any", "export class Job { handler: any = null; }\nexport const job = new Job();\nexport function arm() { job.handler = held as never; }", "src/app/r4.ts:9  G1: write to member handler"],
    ["a member declared object", "export const holder: { slot: object } = { slot: {} };\nexport function arm() { holder.slot = held as never; }", "src/app/r4.ts:8  G1: write to member slot"],
    ["a member declared Function", "export const holder: { slot: Function } = { slot: () => 0 };\nexport function arm() { holder.slot = held as never; }", "src/app/r4.ts:8  G1: write to member slot"],
    ["a member whose type only a function happens to satisfy", "export const job = { meta: { name: \"x\" } as { name: string } };\nexport function arm() { job.meta = opener; }", "src/app/r4.ts:8  G1: write to member meta"],
  ])("refuses a write of a function into %s", (_label, body, message) => {
    // The first four write a value typed never, so only the member's declared
    // type can refuse them; the fifth writes a function into a slot that is not.
    const { code, stderr } = run([OPENER_MODULE, R4(`const held: unknown = opener;\n${body}`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(FLOW);
    expect(stderr).toContain(message);
  });

  it("passes a write of data into a data member", () => {
    const { code, stdout } = run([OPENER_MODULE, R4(`export const stats = { count: 0, label: "x" as unknown };
export function bump() { stats.count = 1; }`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("fails an opener behind an interface member a literal fills with an any-typed value", () => {
    const { code, stderr } = run([OPENER_MODULE, R4(`interface Runner { run(): Promise<number> }
const held: any = opener;
const impl: Runner = { run: held };
export const f = () => withTenantRls(prisma, T, async () => impl.run());`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toContain("opener (src/lib/opener.ts");
  });

  it("fails an opener a getter hands back through an interface member", () => {
    const { code, stderr } = run([OPENER_MODULE, R4(`interface Runner { readonly run: () => Promise<number> }
const viaGetter: Runner = { get run() { return opener; } };
export const f = () => withTenantRls(prisma, T, async () => viaGetter.run());`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toContain("opener (src/lib/opener.ts");
  });
});

describe("check-rls-nesting: round 5 — a subclass is found through its base's name (R5-F5)", () => {
  it("refuses a base reached through a const alias", () => {
    const { code, stderr } = run([OPENER_MODULE, R4(`class Base { run(): unknown { return 0; } }
export const DefaultBase = Base;
export class Scoped extends DefaultBase { override run() { return opener(); } }
const worker: Base = new Scoped();
export const f = () => withBypassRls(prisma, async () => worker.run(), BYPASS_PURPOSE.AUDIT_WRITE);`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(FLOW);
    expect(stderr).toContain("src/app/r4.ts:8  G5: extends DefaultBase, which is not declared as a class");
  });

  it("finds a subclass whose base is an import rename", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/lib/base.ts", `export class Base { run(): unknown { return 0; } }\n`], R4(`import { Base as B } from "@/lib/base";
export class Scoped extends B { override run() { return opener(); } }
const worker: B = new Scoped();
export const f = () => withTenantRls(prisma, T, async () => worker.run());`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toMatch(/calls run \(src\/app\/r4\.ts:7\) reaches opener/);
    expect(stderr).not.toContain(FLOW);
  });

  it("passes a class that extends a library class", () => {
    const { code, stdout } = run([OPENER_MODULE, R4(`export class NotFound extends Error { constructor() { super("x"); } }`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 5 — members of what is handed to library code", () => {
  const KEEP = ["types/keep.d.ts", `declare module "keeplib" { export function keep(o: unknown): void; }`];

  it("fails an opener a library is handed in a member typed unknown", () => {
    const { code, stderr } = run([OPENER_MODULE, KEEP, R4(`import { keep } from "keeplib";
const source: { start: unknown } = { start: opener };
export const f = () => withTenantRls(prisma, T, async () => keep(source));`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toContain("opener (src/lib/opener.ts");
  });

  it("passes plain data, nested empty objects included, handed to library code", () => {
    const { code, stdout } = run([OPENER_MODULE, KEEP, R4(`import { keep } from "keeplib";
const options = { tls: {}, hosts: [] as string[], lazy: true };
export const f = () => withTenantRls(prisma, T, async () => keep(options));`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 5 — a loose value in every G-rule (R5-F4 review)", () => {
  // Each value is typed unknown, so only the loose-type test of its own rule can refuse it.
  it.each([
    ["a loose value written through an index-signature key", "const bag: Record<string, unknown> = {};\nexport function arm() { bag[\"run\"] = heldUnknown; }", "src/app/r4.ts:8  G1: write of a function through a key no declaration names"],
    ["Object.assign onto an object with a slot typed unknown", "const holderWithUnknownSlot: { slot: unknown } = { slot: null };\nexport function arm() { Object.assign(holderWithUnknownSlot, { slot: heldUnknown }); }", "src/app/r4.ts:8  G2: object mutator"],
    ["a computed-key member holding a loose value", "const computedKey = String(Date.now());\nexport const holder = { [computedKey]: heldUnknown };", "src/app/r4.ts:8  G3: computed-key member holding a function"],
    ["a parameter property typed unknown", "export class Job { constructor(public handler: unknown) {} }", "src/app/r4.ts:7  G4: constructor parameter property holding a function"],
  ])("refuses %s", (_label, body, message) => {
    const { code, stderr } = run([OPENER_MODULE, R4(`const heldUnknown: unknown = opener;\n${body}`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(FLOW);
    expect(stderr).toContain(message);
  });

  it("passes the same shapes holding data", () => {
    const { code, stdout } = run([OPENER_MODULE, R4(`const bag: Record<string, number> = {};
export function arm() { bag["run"] = 1; }
const holder: { slot: string } = { slot: "" };
export function fill() { Object.assign(holder, { slot: "x" }); }
const computedKey = String(Date.now());
export const tagged = { [computedKey]: 1 };
export class Job { constructor(public label: string) {} }`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 5 — an object mutator is called directly or not at all (R5-S2)", () => {
  const OPS = "const ops = { run: async () => 0 };\n";
  it.each([
    [".call", "export function arm() { Object.assign.call(null, ops, { run: opener }); }", 7, "ObjectConstructor.assign"],
    [".apply", "export function arm() { Object.assign.apply(null, [ops, { run: opener }]); }", 7, "ObjectConstructor.assign"],
    [".bind", "export const put = Object.assign.bind(Object);", 7, "ObjectConstructor.assign"],
    ["Reflect.apply", "export function arm() { Reflect.apply(Object.defineProperty, null, [ops, \"run\", { value: opener }]); }", 7, "ObjectConstructor.defineProperty"],
    ["a destructure", "const { setPrototypeOf } = Object;\nexport const s = setPrototypeOf;", 7, "ObjectConstructor.setPrototypeOf"],
    ["a string key", "export const put = Object[\"assign\"];", 7, "ObjectConstructor.assign"],
    ["an argument", "export const fns = [1].map(() => Reflect.set);", 7, "Reflect.set"],
  ])("refuses a mutator used through %s", (_label, body, line, name) => {
    const { code, stderr } = run([OPENER_MODULE, R4(`${OPS}${body}`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(`src/app/r4.ts:${line}  G2: object mutator ${name} used other than by a direct call`);
  });

  it("passes a mutator called directly on data", () => {
    const { code, stdout } = run([OPENER_MODULE, R4(`const data: { a: number; b?: string } = { a: 1 };
export function fill() { Object.assign(data, { b: "x" }); return (Object.assign)({}, data); }`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 5 — the exempt callee must not be able to change its guard (R5-ADJ1)", () => {
  const passkey = (pre) => ["src/lib/auth/policy/passkey-enforcement.ts", `${HEAD}
async function reset(_q: { tx?: unknown }) {}
export async function derivePasskeyState(p: { userId: string; tenantId?: string; tx?: unknown }) {
  ${pre}
  return p.tx ? true : withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUTH_FLOW);
}`];
  const OAUTH = ["src/lib/mcp/oauth-server.ts", `${HEAD}
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
export const f = () => withBypassRls(prisma, async (tx) => derivePasskeyState({ userId: "u", tx }), BYPASS_PURPOSE.AUTH_FLOW);`];

  it.each([
    ["delete", "delete p.tx;", "p.tx is written"],
    ["a destructuring assignment", "({ tx: p.tx } = { tx: undefined });", "p.tx is written"],
    ["a compound assignment", "p.tx ??= undefined;", "p.tx is written"],
    ["a computed key", "const k = \"tx\" as string; (p as Record<string, unknown>)[k] = undefined;", "p leaves as a value"],
    ["Object.assign onto the parameter", "Object.assign(p, { tx: undefined });", "p leaves as a value"],
    ["an alias that is then written", "const q = p; q.tx = undefined;", "p leaves as a value"],
    ["the parameter passed on", "await reset(p);", "p leaves as a value"],
    ["the parameter reassigned", "p = { userId: \"x\" };", "p is reassigned"],
  ])("refuses to run when the callee changes its guard through %s", (_label, pre, reason) => {
    const { code, stderr } = run([passkey(pre), OAUTH]);
    expect(code).toBe(1);
    expect(stderr).toContain("CONDITIONAL_OPENER_ALLOWLIST src/lib/mcp/oauth-server.ts::derivePasskeyState: ");
    expect(stderr).toContain(reason);
  });

  it("passes a callee that reads, copies and destructures its parameter, and writes another member", () => {
    const { code, stdout } = run([passkey(`p.tenantId = p.tenantId ?? "t";
  const who = p.userId + (p.tenantId ?? "");
  const copy = { ...p };
  const { userId } = p;
  void [who, copy, userId];`), OAUTH]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 5 — every own file is production unless declared (R5-S5)", () => {
  it("scans an entry file at the root that nothing imports", () => {
    const { code, stderr } = run([["proxy.ts", `${HEAD.replaceAll("@/lib/", "./src/lib/")}
export const handle = () => withBypassRls(prisma, async () => withTenantRls(prisma, T, async () => 1), BYPASS_PURPOSE.SYSTEM_MAINTENANCE);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toMatch(/proxy\.ts:\d+ .*withTenantRls/);
  });

  it("does not scan a file under a declared prefix", () => {
    const { code, stdout } = run([["e2e/helpers/seed.ts", `${HEAD.replaceAll("@/lib/", "../../src/lib/")}
export const seed = () => withBypassRls(prisma, async () => withTenantRls(prisma, T, async () => 1), BYPASS_PURPOSE.SYSTEM_MAINTENANCE);`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("fails a NON_PRODUCTION entry that matches no file", () => {
    const { code, stderr } = run([["scripts/manual-tests/README.md", "notes\n"]]);
    expect(code).toBe(1);
    expect(stderr).toContain("scripts/manual-tests/  NON_PRODUCTION entry matches no file in the Program");
  });

  it("fails a tooling entry that is not in the Program", () => {
    // The fixture tsconfig includes .ts/.tsx only, so a listed .mjs tool is on disk but not read.
    const { code, stderr } = run([["scripts/audit-db-grants.mjs", "export const x = 1;\n"]]);
    expect(code).toBe(1);
    expect(stderr).toContain("scripts/audit-db-grants.mjs  NON_PRODUCTION_SCRIPTS entry is not in the Program");
  });
});

describe("check-rls-nesting: round 5 — a reviewed exception names its declaration and its sites (R5-T11)", () => {
  const RAW = (body) => ["src/lib/prisma/raw-sql.ts", `function throwOnConversion(): never { throw new TypeError("x"); }
${body}`];
  const TRAPS = `  const obj = Object.create(null) as Record<PropertyKey, unknown>;
  obj[Symbol.toPrimitive] = throwOnConversion;
  obj.toJSON = throwOnConversion;`;

  it("does not excuse a class method of the listed function's name", () => {
    const { code, stderr } = run([RAW(`export function createGenuineObject(): object {
${TRAPS}
  return obj;
}
export class K { createGenuineObject(): object { const o = Object.create(null) as Record<PropertyKey, unknown>; o.toJSON = throwOnConversion; return o; } }`)]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/prisma/raw-sql.ts:8  G1: write of a function through a key no declaration names");
  });

  it("fails when the listed function gains another write", () => {
    const { code, stderr } = run([RAW(`export function createGenuineObject(): object {
${TRAPS}
  obj.valueOfDeep = throwOnConversion;
  return obj;
}`)]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/prisma/raw-sql.ts::function createGenuineObject::G1  FUNCTION_FLOW_ALLOWLIST entry excuses 2 site(s), but 3 were found");
  });
});

describe("check-rls-nesting: round 5 — a load's specifier is resolved from its type (R5-T7)", () => {
  it("resolves a const specifier with a literal type, at a path no allowlist names", () => {
    const { code, stdout } = run([OPENER_MODULE, R4(`export async function load() { const moduleName = "hash-wasm"; return import(moduleName); }`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it("follows each own module a literal-union specifier can name", () => {
    const { code, stderr } = run([OPENER_MODULE, ["src/lib/__tests__/helper.ts", "export const h = 1;\n"], R4(`export async function load(which: boolean) {
  const m: "@/lib/opener" | "@/lib/__tests__/helper" = which ? "@/lib/opener" : "@/lib/__tests__/helper";
  return import(m);
}`)]);
    expect(code).toBe(1);
    expect(stderr).toContain("production code imports src/lib/__tests__/helper.ts, which is declared non-production");
  });

  it("fails a NON_LITERAL_LOAD_ALLOWLIST entry whose file has no unnamed load", () => {
    const { code, stderr } = run([["src/i18n/messages.ts", "export const m = 1;\n"]]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/i18n/messages.ts  NON_LITERAL_LOAD_ALLOWLIST entry matches no load the specifier's type leaves unnamed");
  });

  it("passes the listed file's load of a specifier typed string", () => {
    const { code, stdout } = run([["messages/ja/a.json", "{}"], ["src/i18n/messages.ts", "export const load = (ns: string) => import(`../../messages/ja/${ns}.json`);\n"]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

// ─── Round 5 testing review: one fixture per clause that had none ───────────

describe("check-rls-nesting: round 5 — every write form G1-G3 refuses (R5-T2)", () => {
  const OPS = "const ops = { run: async () => 0 };\n";
  it.each([
    ["a logical assignment", "export function arm() { ops.run ??= opener; }", "src/app/r4.ts:7  G1: write to member run"],
    ["a for-of target", "export function arm() { for (ops.run of [opener]) break; }", "src/app/r4.ts:7  G1: write to member run"],
    ["an array-pattern target", "export function arm() { [ops.run] = [opener]; }", "src/app/r4.ts:7  G1: write to member run"],
    ["Object.setPrototypeOf", "export function arm() { Object.setPrototypeOf(ops, { run: opener }); }", "src/app/r4.ts:7  G2: object mutator on a value"],
    ["Object.defineProperties", "export function arm() { Object.defineProperties(ops, { run: { value: opener } }); }", "src/app/r4.ts:7  G2: object mutator on a value"],
    ["Reflect.defineProperty", "export function arm() { Reflect.defineProperty(ops, \"run\", { value: opener }); }", "src/app/r4.ts:7  G2: object mutator on a value"],
    ["a mutator on a union of function holders", "const other = { go: async () => 0 };\nexport function arm(x: typeof ops | typeof other) { Object.assign(x, {}); }", "src/app/r4.ts:8  G2: object mutator on a value"],
    ["a computed-key method", "const k = String(Date.now());\nexport const t = { async [k]() { return opener(); } };", "src/app/r4.ts:8  G3: computed-key member holding a function"],
    ["a computed-key class field", "const k = String(Date.now());\nexport class C { [k] = opener; }", "src/app/r4.ts:8  G3: computed-key member holding a function"],
  ])("refuses %s", (_label, body, message) => {
    const { code, stderr } = run([OPENER_MODULE, R4(`${OPS}${body}`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(message);
  });

  it("passes the same forms on data", () => {
    const { code, stdout } = run([OPENER_MODULE, R4(`const stats: { count?: number; tags: string[] } = { tags: [] };
export function fill() {
  stats.count ??= 0;
  for (const t of ["a"]) stats.tags.push(t);
  Object.setPrototypeOf(stats, null);
  Reflect.defineProperty(stats, "count", { value: 1 });
}`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 5 — the conditional opener's guard is exactly the one listed (R5-T3)", () => {
  const passkey = (body) => ["src/lib/auth/policy/passkey-enforcement.ts", `${HEAD}
export async function derivePasskeyState(p: { userId: string; tx?: unknown }, q: { tx?: unknown } = {}) {
  void q;
  ${body}
}`];
  const OAUTH = (arg) => ["src/lib/mcp/oauth-server.ts", `${HEAD}
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
export const f = () => withBypassRls(prisma, async (tx) => derivePasskeyState(${arg}), BYPASS_PURPOSE.AUTH_FLOW);`];
  const OPENER = "withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUTH_FLOW)";

  it.each([
    ["an inverted branch", `return p.tx ? ${OPENER} : true;`],
    ["a guard read off another parameter", `return q.tx ? true : ${OPENER};`],
    ["a guard read off another member", `return p.userId ? true : ${OPENER};`],
  ])("refuses to run when the guarded opener is %s", (_label, body) => {
    const { code, stderr } = run([passkey(body), OAUTH(`{ userId: "u", tx }`)]);
    expect(code).toBe(1);
    expect(stderr).toContain("expected one opener guarded by p.tx, found 0");
  });

  it("fails a call that names the guard twice", () => {
    const { code, stderr } = run([passkey(`return p.tx ? true : ${OPENER};`), OAUTH(`{ userId: "u", tx, tx: undefined }`)]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/oauth-server\.ts:\d+ .* calls derivePasskeyState .* reaches withBypassRls/);
  });

  it("passes the guard written out as tx: tx", () => {
    const { code, stdout } = run([passkey(`return p.tx ? true : ${OPENER};`), OAUTH(`{ userId: "u", tx: tx }`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 5 — reach clauses that had no test (R5-T4)", () => {
  it("refuses an unnameable function on the right side of ??", () => {
    const { code, stderr } = run([OPENER_MODULE, R4(`const h: (() => Promise<number>) | undefined = undefined;
const registry = new Map<string, () => Promise<number>>([["a", opener]]);
export const f = () => withTenantRls(prisma, T, async () => { const g = h ?? registry.get("a")!; return g(); });`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(UNFOLLOWED);
    expect(stderr).toContain("function returned by a library call");
  });

  const LIB = ["types/keep.d.ts", `declare module "keeplib" { export function keep(o: unknown): void; }`];
  it.each([

    ["an interface member filled by a shorthand", `interface Holder { opener(): Promise<number> }
const s = { opener };
export function use(r: Holder) { return withTenantRls(prisma, T, async () => r.opener()); }
export const x = use(s);`],
    ["an interface member filled by a class field", `interface Runner { run(): Promise<number> }
class C { run = opener; }
export function use(r: Runner) { return withTenantRls(prisma, T, async () => r.run()); }
export const x = use(new C());`],
    ["a nested member of what a library is handed", `import { keep } from "keeplib";
const source = { inner: { start() { void opener(); } } };
export const f = () => withTenantRls(prisma, T, async () => keep(source));`],
    ["a member of a union handed to a library", `import { keep } from "keeplib";
const a = { start() { void opener(); } };
const b = { stop() { return 0; } };
export const f = (pick: boolean) => withTenantRls(prisma, T, async () => keep(pick ? a : b));`],
  ])("fails an opener reached through %s", (_label, body) => {
    const { code, stderr } = run([OPENER_MODULE, LIB, R4(body)]);
    expect(code).toBe(1);
    expect(stderr).toContain(NESTED);
    expect(stderr).toContain("opener (src/lib/opener.ts");
  });
});

describe("check-rls-nesting: round 5 — the boundary's file kinds (R5-T5)", () => {
  it.each([
    ["own .mjs", [["src/lib/legacy.mjs", "export const x = 1;\n"]], `import { x } from "@/lib/legacy.mjs";\nexport const y = x;`, "loads src/lib/legacy.mjs, own JavaScript the gates cannot read"],
    ["a .d.mts over own .mjs", [["src/lib/shim.mjs", "export const x = 1;\n"], ["src/lib/shim.d.mts", "export declare const x: number;\n"]], `import { x } from "@/lib/shim.mjs";\nexport const y = x;`, "loads src/lib/shim.d.mts, a declaration over own JavaScript (src/lib/shim.mjs)"],
  ])("refuses production loading %s", (_label, extra, body, message) => {
    const { code, stderr } = run([...extra, ["src/app/r4.ts", body]]);
    expect(code).toBe(1);
    expect(stderr).toContain(message);
  });

  it("does not let NON_LITERAL_LOAD_ALLOWLIST excuse a literal load of own JavaScript", () => {
    const { code, stderr } = run([["src/lib/legacy.js", "export const x = 1;\n"], ["messages/ja/a.json", "{}"],
      ["src/i18n/messages.ts", "export const load = (ns: string) => import(`../../messages/ja/${ns}.json`);\nexport const legacy = () => import(\"../lib/legacy.js\");\n"]]);
    expect(code).toBe(1);
    expect(stderr).toContain("loads src/lib/legacy.js, own JavaScript the gates cannot read");
  });

  it("passes CSS and JSON imports", () => {
    const { code, stdout } = run([["src/app/globals.css", "body{}\n"], ["src/app/data.json", "{}\n"],
      ["src/app/r4.ts", `import "./globals.css";\nimport data from "./data.json";\nexport const d = data;`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });
});

describe("check-rls-nesting: round 5 review — what a value is, not what it is asserted to be", () => {
  it("refuses a specifier asserted to a literal type", () => {
    const { code, stderr } = run([R4(`export async function load(userInput: string) {
  const moduleName = userInput as "hash-wasm";
  return import(moduleName);
}`), OPENER_MODULE]);
    expect(code).toBe(1);
    expect(stderr).toContain("production code loads a module through a non-literal specifier");
  });

  it("resolves a specifier built from literals through consts and as const", () => {
    const { code, stdout } = run([OPENER_MODULE, R4(`const base = "hash-wasm" as const;
const moduleName = Date.now() > 0 ? base : ("hash-wasm" as string);
export async function load() { return import(moduleName); }`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  it.each([
    ["a const literal key", "const key = \"assign\" as const;\nexport function arm() { Object[key].call(null, ops, { run: opener }); }", "src/app/r4.ts:8  G2: object mutator ObjectConstructor.assign used other than by a direct call"],
    ["a literal-union key", "const key: \"keys\" | \"assign\" = Date.now() > 0 ? \"keys\" : \"assign\";\nexport const put = Object[key];", "src/app/r4.ts:8  G2: object mutator ObjectConstructor.assign used other than by a direct call"],
    ["a keyof key", "export const put = (k: keyof ObjectConstructor) => Object[k];", "src/app/r4.ts:7  G2: object mutator ObjectConstructor.defineProperty used other than by a direct call"],
    ["a key typed string", "export const put = (k: string) => Object[k];", "src/app/r4.ts:7  G2: object mutator ObjectConstructor.assign (by a key that may name it) used other than by a direct call"],
  ])("refuses a mutator reached through %s", (_label, body, message) => {
    const { code, stderr } = run([OPENER_MODULE, R4(`const ops = { run: async () => 0 };\n${body}`)]);
    expect(code).toBe(1);
    expect(stderr).toContain(message);
  });

  it("passes a mutator called directly through a const key, on data", () => {
    const { code, stdout } = run([OPENER_MODULE, R4(`const key = "assign" as const;
const data: { a: number; b?: string } = { a: 1 };
export function fill() { return Object[key](data, { b: "x" }); }`)]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-rls-nesting: OK");
  });

  const passkey = (pre) => ["src/lib/auth/policy/passkey-enforcement.ts", `${HEAD}
export async function derivePasskeyState(p: { userId: string; tx?: unknown; clearGuard(): void }) {
  ${pre}
  return p.tx ? true : withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_PURPOSE.AUTH_FLOW);
}`];
  const OAUTH = ["src/lib/mcp/oauth-server.ts", `${HEAD}
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
export const f = () => withBypassRls(prisma, async (tx) => derivePasskeyState({ userId: "u", tx, clearGuard() {} }), BYPASS_PURPOSE.AUTH_FLOW);`];
  it.each([
    ["a method of the parameter called", "p.clearGuard();"],
    ["a method of the parameter held as a value", "const f = p.clearGuard; f();"],
  ])("refuses to run when the exempt callee has %s", (_label, pre) => {
    const { code, stderr } = run([passkey(pre), OAUTH]);
    expect(code).toBe(1);
    expect(stderr).toContain("p.clearGuard, which may be a function, is read at src/lib/auth/policy/passkey-enforcement.ts:7");
  });
});
