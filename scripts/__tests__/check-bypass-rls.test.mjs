/**
 * Regression tests for check-bypass-rls.mjs.
 *
 * The guard reads its source tree from `src/` relative to the process cwd
 * (`readdirSync("src", ...)`), so each case runs the real CLI with cwd set to an
 * isolated fixture tree — mirroring the file layout the guard keys off of.
 *
 * Every case here is a mutation that was run by hand during review and found a
 * real defect. They are persisted because this gate's predicates have been
 * wrong four times, each time in a way the previous round's tests could not
 * see: a gate proven once by hand has no tripwire against its own next edit
 * (RT7). The `predicate resolution` block is the newest set — one case per
 * predicate that used to decide a code question from raw text or from a name.
 *
 * Fixtures write the helper's arguments in the real order,
 * `withBypassRls(prisma, fn, grant)`: the gate reads the callback and the
 * grant at their DECLARED positions, so a function or a BYPASS_GRANT.X placed
 * anywhere else is not what it checks. Each fixture tree carries the real
 * grants module, cut down to the members the tree names (grantsFor).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Project } from "ts-morph";

const CHECKER = fileURLToPath(new URL("../checks/check-bypass-rls.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// C3: the gate now builds a real Program (dependency-resolved, via
// tsConfigFilePath) over the fixture tree, and resolves the four helper
// declarations through it before anything else runs — a fixture missing
// either fails named (item 1). Every fixture therefore needs the REAL
// tenant-rls.ts / tenant-context.ts and a minimal tsconfig.json, not
// hand-written stubs (T-F4, F-F3): a stub only the test author wrote could
// drift from the real file's declarations (overloads included) in a way the
// gate would never see on the real tree. `run()` below supplies both to every
// fixture by default; the two cells that deliberately omit one (A-C3-4) call
// spawnSync directly instead, bypassing this scaffold.
const REAL_TENANT_RLS = readFileSync(join(REPO_ROOT, "src/lib/tenant-rls.ts"), "utf8");
const REAL_TENANT_CONTEXT = readFileSync(join(REPO_ROOT, "src/lib/tenant-context.ts"), "utf8");
// tenant-rls.ts imports both: the purposes (a leaf module) and the grant
// registry the gate reads each call's grant from. The real files, as above.
const REAL_GRANTS = readFileSync(join(REPO_ROOT, "src/lib/tenant-rls-grants.ts"), "utf8");
const REAL_PURPOSE = readFileSync(join(REPO_ROOT, "src/lib/tenant-rls-purpose.ts"), "utf8");

/**
 * The real grants module with BYPASS_GRANT cut down to the members a fixture
 * names (plus `keep`). The gate fails a member no call names, and a one-file
 * fixture names one or two of the registry's ~90; everything else in the
 * module — defineGrant, MODEL_TABLE, setBypassGucs, the member initializers —
 * stays the real text.
 */
function grantsFor(sources, keep = []) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("grants.ts", REAL_GRANTS);
  const named = sources.join("\n");
  let literal = sf.getVariableDeclarationOrThrow("BYPASS_GRANT").getInitializerOrThrow();
  while (!literal.getProperties) {
    literal = literal.getArguments ? literal.getArguments()[0] : literal.getExpression();
  }
  for (const prop of literal.getProperties()) {
    const name = prop.getName();
    if (!keep.includes(name) && !new RegExp(`\\b${name}\\b`).test(named)) prop.remove();
  }
  return sf.getFullText();
}

// Fixtures live under mkdtemp with no node_modules above them (T-F2): real
// `@prisma/client` cannot resolve there. Left unresolved, `Prisma.TransactionClient`
// widens to `any`, and that `any` is exactly the callback parameter (`tx`) every
// with*Rls fixture passes around — cascading into a FALSE POSITIVE under C3 item
// 5's any-callee/one-argument branch for any single-argument call the fixture's
// own callback makes with `tx` (`a(tx)`, `queryMember(tx)`, …), unrelated to a
// module load. A minimal ambient stub (per the plan) fixes this at its root — `TransactionClient` resolves to a real (non-`any`) object
// type, so `couldBeStringSpecifier` correctly excludes it — and, measured
// separately, is also the cheaper path: it resolves through `paths` instead of a
// failing filesystem walk for every fixture spawn (see the measurement notes).
// Every model/meta-property access (\`tx.auditOutbox\`, \`tx.$transaction\`,
// \`tx["$executeRaw"]\`, a bracket or template-literal spelling of either) goes
// through the SAME index signature, so it needs to be both a real object (with
// named CRUD methods, so \`tx.auditOutbox.findMany()\` types as a concrete
// Promise, not \`any\`) and CALLABLE (so \`tx.$transaction(fn)\` / a tagged
// \`tx.$executeRaw\`\`...\`\` typecheck as a real call, not a TS error the
// checker silently recovers from AS \`any\`). Recovering as \`any\` is exactly
// the false-positive path: an \`any\`-typed \`tx\` cascades into item 5's
// any-callee/one-argument branch for any single-arg call the fixture's own
// callback makes with it, and into Rule B for any computed index off a query
// result — both unrelated to a module load or a helper reference.
// Hand-authored, with nothing tying it to the installed @prisma/client
// package (finding D, issue-838 follow-ups review). The ONE property this
// stub must keep, whatever else drifts: `tx` (and `prisma`) must NOT widen to
// `any`, because an `any` there spuriously trips item 5's any-callee branch
// and Rule B for code that never touches a module load or a helper reference
// (see the false-positive walkthrough above) — everything else here exists
// only in service of that.
//
// It follows the real generated client where the gate reads it: one named
// getter per model returning that model's own, non-callable delegate type
// (`get user(): Prisma.UserDelegate<...>`), no string index signature. Check 3
// names a model by the PrismaClient member read and, where a query runs, by
// the `<Model>Delegate` type it runs on. A Prisma major-version bump could
// change either; re-derive this stub against the then-current generated
// `.d.ts` rather than assuming it still holds.
// A row's every field reads as a nested row, a string and a row array at once,
// so \`user.email.toLowerCase()\` and \`memberships.filter(...)\` in the real
// tenant-context.ts resolve to library methods — the cross-module pass follows
// the ambient client into those functions and must be able to name each call.
// One getter per schema model, as the generated client declares them: Check 3
// recognises a model access by the PrismaClient member it resolves to.
const MODELS = [...readFileSync(join(REPO_ROOT, "prisma/schema.prisma"), "utf8").matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);
const MODEL_GETTERS = MODELS.map((m) => `    get ${m[0].toLowerCase()}${m.slice(1)}(): Prisma.${m}Delegate;`).join("\n");
// Each delegate declares its own query methods, as the generated client does:
// a method's declaring interface names its model.
const DELEGATE_METHODS = `      findFirst(...args: unknown[]): Promise<Row | null>;
      findMany(...args: unknown[]): Promise<Row[]>;
      findUnique(...args: unknown[]): Promise<Row | null>;
      create(...args: unknown[]): Promise<Row>;
      update(...args: unknown[]): Promise<Row>;
      updateMany(...args: unknown[]): Promise<{ count: number }>;
      delete(...args: unknown[]): Promise<Row>;
      deleteMany(...args: unknown[]): Promise<{ count: number }>;
      upsert(...args: unknown[]): Promise<Row>;
      count(...args: unknown[]): Promise<number>;
      createMany(...args: unknown[]): Promise<{ count: number }>;
      aggregate(...args: unknown[]): Promise<Row>;
      groupBy(...args: unknown[]): Promise<Row[]>;`;
const MODEL_DELEGATES = MODELS.map((m) => `    interface ${m}Delegate {\n${DELEGATE_METHODS}\n    }`).join("\n");
const PRISMA_CLIENT_STUB = `declare module "@prisma/client" {
  interface Row { [field: string]: Field }
  type Field = Row & string & Row[];
  interface PrismaModelDelegate {
    findFirst(...args: unknown[]): Promise<Row | null>;
    findMany(...args: unknown[]): Promise<Row[]>;
    findUnique(...args: unknown[]): Promise<Row | null>;
    create(...args: unknown[]): Promise<Row>;
    update(...args: unknown[]): Promise<Row>;
    updateMany(...args: unknown[]): Promise<{ count: number }>;
    delete(...args: unknown[]): Promise<Row>;
    deleteMany(...args: unknown[]): Promise<{ count: number }>;
    upsert(...args: unknown[]): Promise<Row>;
    count(...args: unknown[]): Promise<number>;
    createMany(...args: unknown[]): Promise<{ count: number }>;
    aggregate(...args: unknown[]): Promise<Row>;
    groupBy(...args: unknown[]): Promise<Row[]>;
  }
  export class PrismaClient {
${MODEL_GETTERS}
    $connect(): Promise<void>;
    $on(event: string, cb: () => void): void;
    $transaction<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T>;
    $transaction<T>(batch: Promise<T>[]): Promise<T[]>;
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
    $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  }
  export namespace Prisma {
    // The generated client's shape: a mapped Omit over the full client.
    type TransactionClient = Omit<PrismaClient, "$connect" | "$on">;
${MODEL_DELEGATES}
  }
}
// Fixtures use \`prisma\` without importing it; typed so its accesses resolve.
declare const prisma: import("@prisma/client").PrismaClient;
// The client type fixtures annotate helper parameters with, as real code must.
type TX = import("@prisma/client").PrismaClient;
`;
const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2020",
    module: "esnext",
    moduleResolution: "bundler",
    allowJs: true,
    jsx: "react-jsx",
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
    paths: {
      "@/*": ["./src/*"],
      "@prisma/client": ["./types/prisma-client-stub.d.ts"],
    },
  },
  include: ["**/*.ts", "**/*.tsx"],
});

// Stubs for what the real tenant-rls.ts / tenant-context.ts import, so the
// cross-module pass can name every call it follows into them. Typed, so nothing
// widens to \`any\` and reads as an unfollowable callee.
const MODULE_STUBS = {
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
  // The relations Check 3 follows a query's argument through.
  "prisma/schema.prisma": readFileSync(join(REPO_ROOT, "prisma/schema.prisma"), "utf8"),
  // Re-exported by the real tenant-context.ts; a fixture that tests it writes
  // its own.
  "src/lib/tenant/stranded-rows.ts": readFileSync(join(REPO_ROOT, "src/lib/tenant/stranded-rows.ts"), "utf8"),
  "types/node-stub.d.ts": `declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, fn: () => R): R;
  }
}
`,
};

const SHARED_GRANT_NAMER = "scripts/manual-tests/zz-shared-grants.ts";

function writeModuleStubs(written, keepGrants = []) {
  for (const [relPath, source] of Object.entries(MODULE_STUBS)) {
    if (written.has(relPath)) continue;
    mkdirSync(join(dir, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(dir, relPath), source, "utf8");
  }
  mkdirSync(join(dir, "src/lib"), { recursive: true });
  if (!written.has("src/lib/tenant-rls-purpose.ts")) {
    writeFileSync(join(dir, "src/lib/tenant-rls-purpose.ts"), REAL_PURPOSE, "utf8");
  }
  if (!written.has("src/lib/tenant-context.ts") && !written.has(SHARED_GRANT_NAMER)) {
    // The copied real tenant-context.ts names grants the real tree shares with
    // call sites this tree lacks, and that reach models tenant-context.ts does
    // not: judged here, those would read as stale. A hand-run manual test names
    // them instead — named, not judged — unless the fixture names one itself.
    const own = [...written].map((rel) => readFileSync(join(dir, rel), "utf8")).join("\n");
    const shared = [...new Set([...REAL_TENANT_CONTEXT.matchAll(/BYPASS_GRANT\.(\w+)/g)].map((m) => m[1]))]
      .filter((name) => !new RegExp(`\\b${name}\\b`).test(own));
    if (shared.length > 0) {
      mkdirSync(join(dir, "scripts/manual-tests"), { recursive: true });
      writeFileSync(join(dir, SHARED_GRANT_NAMER), `import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export const named = () => [${shared.map((g) => `withBypassRls(prisma, async (tx) => tx, BYPASS_GRANT.${g})`).join(", ")}];
`, "utf8");
    }
  }
  if (!written.has("src/lib/tenant-rls-grants.ts")) {
    // Every grant some file in the tree names — the fixture's own and the
    // copied real tenant-context.ts's — and no other.
    const sources = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.[cm]?[jt]sx?$/.test(e.name) && !/^tenant-rls-(purpose|grants)\.ts$/.test(e.name))
      .map((e) => readFileSync(join(e.parentPath ?? e.path, e.name), "utf8"));
    writeFileSync(join(dir, "src/lib/tenant-rls-grants.ts"), grantsFor(sources, keepGrants), "utf8");
  }
}

/**
 * The one harness helper T-F4/F-F3 asks for: a fixture that writes its OWN
 * `src/lib/tenant-context.ts` (TENANT_CONTEXT_ALLOWED below) appends the REAL
 * file's `withUserTenantRls` / `withTeamTenantRls` declarations — overload
 * signatures and implementation alike — to its own body, read via ts-morph
 * rather than a hand-copied string, so no fixture carries a divergent copy of
 * what the real file declares.
 */
function withRealTenantContextHelperDeclarations(source) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("tenant-context.ts", REAL_TENANT_CONTEXT);
  const decls = sf
    .getFunctions()
    .filter((fn) => fn.getName() === "withUserTenantRls" || fn.getName() === "withTeamTenantRls")
    .map((fn) => fn.getFullText().trim())
    .join("\n\n");
  return `${source}\n\n${decls}\n`;
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bypass-rls-check-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(relPath, source) {
  mkdirSync(join(dir, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(dir, relPath), source, "utf8");
  writeFileSync(join(dir, "tsconfig.json"), FIXTURE_TSCONFIG, "utf8");
  mkdirSync(join(dir, "types"), { recursive: true });
  writeFileSync(join(dir, "types/prisma-client-stub.d.ts"), PRISMA_CLIENT_STUB, "utf8");
  mkdirSync(join(dir, "src/lib"), { recursive: true });
  // The fixture's own file at one of these two paths is the real declaration
  // source for that file — never overwritten by the scaffold copy.
  if (relPath !== "src/lib/tenant-rls.ts") {
    writeFileSync(join(dir, "src/lib/tenant-rls.ts"), REAL_TENANT_RLS, "utf8");
  }
  if (relPath !== "src/lib/tenant-context.ts") {
    writeFileSync(join(dir, "src/lib/tenant-context.ts"), REAL_TENANT_CONTEXT, "utf8");
  }
  writeModuleStubs(new Set([relPath]));
  // spawnSync, not execFileSync: the latter surfaces stderr only on the throw
  // path, so a `expect(stderr).not.toContain(...)` paired with `code === 0` was
  // asserting against a hardcoded "" and could never fail. Both streams come
  // from the process on both paths.
  const r = spawnSync("node", [CHECKER], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Like `run`, but for a fixture needing more than one file of its own (a
 * barrel plus its consumer, say) — `files` is a `[relPath, source]` array,
 * all written before the one spawn. The scaffold (tsconfig, Prisma stub, the
 * two real helper-declaring files) is added the same way `run` adds it.
 */
function runMulti(files, checker = CHECKER, { keepGrants = [] } = {}) {
  for (const [relPath, source] of files) {
    mkdirSync(join(dir, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(dir, relPath), source, "utf8");
  }
  writeFileSync(join(dir, "tsconfig.json"), FIXTURE_TSCONFIG, "utf8");
  mkdirSync(join(dir, "types"), { recursive: true });
  writeFileSync(join(dir, "types/prisma-client-stub.d.ts"), PRISMA_CLIENT_STUB, "utf8");
  mkdirSync(join(dir, "src/lib"), { recursive: true });
  const written = new Set(files.map(([relPath]) => relPath));
  if (!written.has("src/lib/tenant-rls.ts")) {
    writeFileSync(join(dir, "src/lib/tenant-rls.ts"), REAL_TENANT_RLS, "utf8");
  }
  if (!written.has("src/lib/tenant-context.ts")) {
    writeFileSync(join(dir, "src/lib/tenant-context.ts"), REAL_TENANT_CONTEXT, "utf8");
  }
  writeModuleStubs(written, keepGrants);
  const r = spawnSync("node", [checker], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Bare spawnSync with no scaffold at all — the two A-C3-4 cells need a fixture tree missing a piece of it. */
function runBare() {
  const r = spawnSync("node", [CHECKER], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// F3 violation, isolated: the file IS on the file allowlist (audit-outbox.ts,
// grant: auditOutbox only) so it does NOT trip the "not on the allowlist" check —
// the ONLY thing wrong is the eslint-disable(no-unused-vars) on an unused `tx`.
// This pins that F3 fires on its own, not just as a side effect of an
// unallowlisted file.
const F3_UNUSED_TX_ON_ALLOWLISTED_FILE = `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function h() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return withBypassRls(prisma, async (tx) => drain(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`;

// The sanctioned shape: tenant-context.ts is in F3_UNUSED_TX_ALLOWLIST,
// so its unused-tx delegating wrapper (fn(tenantId) public contract) is allowed.
// A sibling real (tx) => tx.x callback confirms the file's calls still stay
// within their grants (tenantMember, team, user).
const TENANT_CONTEXT_ALLOWED = withRealTenantContextHelperDeclarations(`
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function withTenantContext(tenantId) {
  return withBypassRls(prisma, async (tx) => {
    return tx.tenantMember.findFirst({ where: { tenantId }, select: { user: { select: { email: true } } } });
  }, BYPASS_GRANT.TENANT_MEMBERSHIP_LOOKUP);
}
export async function withTeamContext(tenantId, fn) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return withBypassRls(prisma, async (tx) => fn(tenantId), BYPASS_GRANT.TENANT_MEMBERSHIP_LOOKUP);
}
// Mirrors resolveTeamTenantId: one grant per call, each reached in full —
// through relations too — see "grant over-breadth" below.
export async function resolveTeamTenantId(teamId) {
  return withBypassRls(prisma, async (tx) =>
    tx.team.findUnique({ where: { id: teamId }, include: { tenant: true } }), BYPASS_GRANT.TEAM_TENANT_LOOKUP);
}
// Mirrors existingUserIdsByEmail, for the same reason.
export async function existingUserIdsByEmail(emails) {
  return withBypassRls(prisma, async (tx) =>
    tx.user.findMany({ where: { email: { in: emails } }, select: { id: true, tenantMemberships: { select: { tenantId: true } } } }), BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP);
}`);

// A brand-new (non-allowlisted) file that suppresses an unused tx — trips BOTH
// the file allowlist and F3. Confirms F3 detects the drift even on a file
// the guard would reject for other reasons.
const F3_UNUSED_TX_ON_NEW_FILE = `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function h() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return withBypassRls(prisma, async (tx) => doThing(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`;

describe("check-bypass-rls F3 unused-tx anti-drift", () => {
  it("fails an allowlisted file that suppresses an unused tx on a with*Rls callback", () => {
    const r = run("src/lib/audit/audit-outbox.ts", F3_UNUSED_TX_ON_ALLOWLISTED_FILE);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("never uses it");
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
    expect(r.stderr).toContain("never uses it");
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
// audit-outbox.ts is used as the subject throughout: its calls name
// AUDIT_WRITE_DIRECT_OUTBOX (`auditOutbox` only), so any other model inside a
// callback must be reported.

describe("call-extent scanning", () => {
  it("reads a model reference far past the old fixed 10-line radius", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `      const pad${i} = ${i};`).join("\n");
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
${filler}
      return tx.tenantMember.findFirst({ where: { id: "x" } });
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("still passes a long callback that only touches allowed models", () => {
    // The allow side of the case above: widening the window must not turn every
    // long callback into a violation. The unrelated prisma.user call AFTER the
    // callback is what gives this test teeth — without it, a scan that runs to
    // end-of-file unconditionally passes too (finding T3).
    const filler = Array.from({ length: 30 }, (_, i) => `      const pad${i} = ${i};`).join("\n");
    const { code } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
${filler}
      return tx.auditOutbox.findMany({ where: { status: "PENDING" } });
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}
export async function unrelated() {
  return prisma.user.findFirst({ where: { id: "x" } });
}`);
    expect(code).toBe(0);
  });

  it("scans a real call whose line also contains a string holding '//'", () => {
    // The regression that made this suite necessary: judging "is this a
    // comment?" from raw text let a string containing "//" hide a real call
    // site, so it was scanned by nothing at all — worse than a short window,
    // because it also escaped the undeterminable-extent report.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  log("fallback path // see runbook"); return withBypassRls(prisma, async (tx) => {
      return tx.tenantMember.findFirst({ where: { id: "x" } });
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("ignores a call-shaped mention inside a comment", () => {
    // src/auth.ts carries exactly this in prose. It must not be treated as a
    // call site — and must not be reported as an undeterminable extent either.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
// Emitting here would run logAuditAsync -> withBypassRls (nested: TX), an R9 shape.
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.auditOutbox.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stderr).not.toContain("could not be parsed");
  });

  it("ignores a call-shaped mention inside a string literal", () => {
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const HELP = "see withBypassRls(prisma, purpose, cb) for the pattern";
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.auditOutbox.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stderr).not.toContain("could not be parsed");
  });

  it("is not fooled by a paren inside a string or a template interpolation", () => {
    // A ")" in string text must not close the call early, and a call expression
    // inside `${...}` must not be counted either — both would end the extent
    // before the offending model reference below.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain(id) {
  return withBypassRls(prisma, async (tx) => {
      log("closing paren ) inside a string");
      log(\`key:\${hash(id)}\`);
      return tx.tenantMember.findFirst({ where: { id } });
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("is not blinded by a regex literal whose character class holds a slash", () => {
    // `/[/*]/` — the `/` needs no escaping inside a character class. A
    // lookahead-based comment detector reads the `/*` as opening a block
    // comment and blanks the rest of the file, taking the call site with it.
    // The parser knows a regex literal when it sees one.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const GLOB_RE = /[/*]/;
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
      return tx.tenantMember.findFirst({ where: { id: "x" } });
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("sees a model reference inside a template interpolation", () => {
    // `${await tx.model.count()}` is code, not string body. Blanking template
    // literals wholesale hid it — a regression the raw-text scan did not have.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain(id) {
  return withBypassRls(prisma, async (tx) => {
      log(\`members=\${await tx.tenantMember.count()}\`);
      return tx.auditOutbox.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("reports a truncated file as unscanned rather than trusting the recovered tree", () => {
    // The parser recovers from truncation and yields *a* tree, but a recovered
    // tree is not evidence: the same recovery can drop the call this gate exists
    // to find — see "a syntax error that swallows a real call" below, where it
    // drops exactly that. So the verdict comes from whether the parse reported
    // diagnostics, not from what happened to survive it.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
      return tx.tenantMember.findFirst({ where: { id: "x" } });
`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be parsed");
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts");
  });

  it("reports a file that names the helper but whose code the parse lost", () => {
    // The fail-loud net, kept for the case the parser cannot recover from at
    // all: text calls withBypassRls, yet no such identifier survives in the
    // tree, so nothing was scanned. "Examined nothing" must not read like
    // "found nothing".
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts",
      "\u0000withBypassRls(prisma, p, async (tx) => tx.tenantMember.f());");
    expect(code).toBe(1);
    expect(stderr).toContain("could not be parsed");
  });
});

// ─── Predicate resolution ─────────────────────────────────────────────────────
//
// The round-3 rewrite moved the model scan onto the parse tree but left four
// sibling predicates deciding code questions from raw text or from a name:
// which files to check, which calls are calls, which identifier is the client,
// and whether a callback takes one. Each case below was demonstrated against
// the shipped gate before it was written — the stated prior verdict is what the
// round-3 implementation actually returned, not what it was expected to.
//
// The real signature is `withBypassRls(prisma, fn, purpose)`; the gate finds
// the callback by kind rather than by position, which the mixed argument orders
// across these fixtures and the ones above exercise.

describe("predicate resolution", () => {
  it("catches a call reached through an aliased import, in a file not on the allowlist", () => {
    // The file filter required the literal text `withBypassRls(`, which
    // `import { withBypassRls as wb }` … `wb(...)` does not contain. The file
    // was skipped whole, so it escaped the FILE allowlist too, not just the
    // model one. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/sneaky/route.ts", `
import { withBypassRls as wb } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function sneaky() {
  return wb(prisma, async (tx) => tx.tenantMember.findFirst({}), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("not on the allowlist");
    expect(stderr).toContain("src/lib/sneaky/route.ts");
  });

  it("catches a model reached through a callback parameter not named tx", () => {
    // The receiver test was `=== "tx" || === "prisma"`, so renaming the
    // callback's parameter removed the file from the model allowlist's view
    // with a one-token edit. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (db: TX) => db.tenantMember.findFirst({}), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("catches a model reached through a nested $transaction client", () => {
    // A nested $transaction inherits the bypass context through the Proxy, so
    // its own callback parameter is a bypassed client too. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    return tx.$transaction(async (inner: TX) => inner.tenantMember.findFirst({}));
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("catches a model inside a callback passed by name", () => {
    // Scanning only the call's own subtree saw nothing when the callback was a
    // local const passed by reference — the shape
    // src/lib/auth/policy/passkey-enforcement.ts uses. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  const job = async (tx: TX) => tx.tenantMember.findFirst({});
  return withBypassRls(prisma, job, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("names a callback it cannot resolve instead of scanning nothing and passing", () => {
    // A callback that is the enclosing function's own parameter is invisible
    // from this file. Examining nothing must not be spelled like finding
    // nothing. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain(job) {
  return withBypassRls(prisma, job, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be resolved");
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:4");
  });

  it("flags a genuinely tx-less callback, and names the call's own line", () => {
    // The allow-side companions below are what stop this from being satisfied
    // by a predicate that always fires.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async () => prisma.auditOutbox.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("tx-less form");
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:4");
  });

  it("flags a tx-less withTenantRls callback in a file with no model allowlist", () => {
    // withTenantRls has no per-file allowlist, so this check is the only one
    // that reaches it — it used to run in a separate raw-text sweep of its own.
    const { code, stderr } = run("src/app/api/y/route.ts", `
import { withTenantRls } from "@/lib/tenant-rls";
export async function GET(tenantId) {
  return withTenantRls(prisma, tenantId, async () => prisma.user.findFirst({}));
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("tx-less form");
  });

  it("passes a compliant call whose comment quotes the banned tx-less form", () => {
    // The allow side of the two tests above. Round 3 moved this check from
    // comment-blanked text to raw text, so documenting the banned shape next to
    // the call — which is this repo's own comment style — reddened the build.
    // Prior verdict: exit 1.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    // legacy shape was withBypassRls(prisma, () => prisma.auditOutbox.findMany(), p)
    return tx.auditOutbox.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("reports a file that mentions the helper only in prose as a stale entry, not as unparseable", () => {
    // A file whose bypass call was removed while its explanatory comment and
    // allowlist entry remain. Round 3 reported it as unparseable, naming a file
    // that parsed perfectly. It is a stale allowlist entry, and that is what it
    // must be reported as.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";
// This used to call withBypassRls(prisma, cb, purpose) before the refactor.
export const purpose = BYPASS_PURPOSE.AUDIT;`);
    expect(code).toBe(1);
    expect(stderr).not.toContain("could not be parsed");
    expect(stderr).toContain("makes no withBypassRls call");
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts");
  });

  it("passes a compliant call in a file whose string quotes an eslint-disable", () => {
    // The F3 scan matched its trigger words in raw text, so the same words
    // inside a string literal counted — and it never checked whether `tx` was
    // actually unused. Prior verdict: exit 1.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const DOC = "eslint-disable-next-line @typescript-eslint/no-unused-vars";
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.auditOutbox.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("reports a syntax error that swallows a real call, instead of passing", () => {
    // The round-3 fail-loud net asked whether any `withBypassRls` identifier
    // survived the parse. The import specifier is one, so the net could never
    // fire for a file that imports the helper — which is every real call site.
    // Here an unterminated template swallows the call: no call expression
    // survives, and the unlisted model inside was never seen. Prior verdict:
    // exit 0, "check-bypass-rls: OK".
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const banner = \`unterminated on purpose

export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.tenantMember.findFirst({}), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be parsed");
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts");
  });

  it("reports a by-name callback it cannot resolve even when the file holds a same-named function", () => {
    // Round 4 resolved a by-name callback against every function-valued binding
    // in the FILE. Here `job` is the enclosing function's own parameter, and an
    // unrelated `job` in a sibling function made the whole-file lookup succeed:
    // the gate scanned a body this call never runs and printed OK. The decoy is
    // what this test turns on — remove the `unrelated` function and round 4
    // reports correctly. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function bad(job) {
  return withBypassRls(prisma, job, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}
function unrelated() {
  const job = async (tx: TX) => tx.auditOutbox.findMany();
  return job;
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be resolved");
  });

  it("reports a by-name callback whose only same-named binding is out of scope", () => {
    // The scope-visibility filter alone, with nothing else to make the name
    // ambiguous: one binding, in a sibling function, touching an ALLOWED model
    // so the model check cannot supply the verdict. Without the filter the gate
    // resolves a body this call never runs and exits 0.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function bad() {
  return withBypassRls(prisma, job, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}
function unrelated() {
  const job = async (tx: TX) => tx.auditOutbox.findMany();
  return job;
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be resolved");
  });

  it("reports a by-name callback shadowed by a parameter of the calling function", () => {
    // Indexing parameters is what makes this ambiguous. Index only the
    // function-valued bindings and the module-level const looks unique, so the
    // gate scans it — though the name at the call refers to the parameter.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const job = async (tx: TX) => tx.auditOutbox.findMany();
export async function bad(job) {
  return withBypassRls(prisma, job, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be resolved");
  });

  it("reports a by-name callback shadowed by a DESTRUCTURED parameter", () => {
    // `getName()` on a binding pattern returns the pattern text ("{ job }"), so
    // indexing by it leaves `job` looking unbound and the module-level const
    // resolves as unique — the same getName()-on-a-pattern mistake this file
    // fixed in two other predicates.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const job = async (tx: TX) => tx.auditOutbox.findMany();
export async function bad({ job }) {
  return withBypassRls(prisma, job, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be resolved");
  });

  it("refuses a callback parameter's default value, which no caller need supply", () => {
    // `getInitializer()` on a Parameter is its DEFAULT. Scanning it answers a
    // question nobody asked: every call that passes an argument runs something
    // else — here a `prisma.user.deleteMany()` the gate would never see.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain(job = async (tx: TX) => tx.auditOutbox.findMany()) {
  return withBypassRls(prisma, job, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}
export async function caller() {
  return drain(async (tx) => tx.user.deleteMany());
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be resolved");
  });

  it("refuses a reassignable callback binding", () => {
    // A `let` can hold a different function at the call than at its
    // declaration, so the initializer is not the answer.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain(flag) {
  let job = async (tx: TX) => tx.auditOutbox.findMany();
  if (flag) job = async (tx: TX) => tx.user.deleteMany();
  return withBypassRls(prisma, job, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be resolved");
  });

  it("follows a client aliased to another name", () => {
    // `const db = tx` — the value is the bypassed client whatever it is called
    // next. Tracking only the parameter's own name is the same
    // decides-by-spelling habit, one assignment along.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const db = tx;
    return db.tenantMember.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows a chain of client aliases", () => {
    // One hop is a special case; the resolution runs to a fixpoint so the
    // chain's length cannot be the thing that hides an access.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const a = tx;
    const b = a;
    return b.tenantMember.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows an alias declared before the client it derives from", () => {
    // Source order is not resolution order: `c = b` is read before `b = tx`
    // exists, so one pass over the declarations misses it. This is what the
    // fixpoint is for — a forward chain would resolve without it.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    function inner() {
      const c = b;
      return c.tenantMember.findMany();
    }
    const b = tx;
    return inner();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("catches a delegate destructured off the client in the callback body", () => {
    // `const { tenantMember } = tx` lifts the delegate out, so no
    // `<client>.<model>` access ever appears for the property scan to find.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const { tenantMember } = tx;
    return tenantMember.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows a client aliased OUTSIDE the callback", () => {
    // `prisma` is a Proxy that reads the bypass context out of
    // AsyncLocalStorage, so a module-level alias of it is a bypassed client
    // inside the callback too. Following assignments only within the callback
    // misses it entirely.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const db = prisma;
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    await tx.auditOutbox.findMany();
    return db.tenantMember.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows a client assigned after its declaration", () => {
    // `let db; db = tx;` — a binding is not a different value for having been
    // filled in on the next line, so plain assignments count, not only
    // initializers.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    let db;
    db = tx;
    return db.tenantMember.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows a client through a conditional expression", () => {
    // `cond ? tx : prisma` is a choice between clients, so the result is one.
    // Note the deliberate limit this pairs with: an expression that merely
    // MENTIONS a client is not a flow — `await tx.user.find()` yields a row.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain(flag) {
  return withBypassRls(prisma, async (tx) => {
    const db = flag ? tx : prisma;
    return db.tenantMember.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("catches a delegate destructured in a nested $transaction parameter", () => {
    // A nested transaction inherits the bypass, and its callback parameter gets
    // the same treatment as the outer one — taking getName() there returns the
    // pattern text and registers "{ tenantMember }" as a client name while the
    // model itself goes unrecorded.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    return tx.$transaction(async ({ tenantMember }) => tenantMember.findMany());
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("passes an outer alias and a nested $transaction that stay within the allowlist", () => {
    // The allow side for both of the above: following the value further must
    // not turn a compliant callback into a violation.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const db = prisma;
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    await db.auditOutbox.findMany();
    return tx.$transaction(async ({ auditOutbox }) => auditOutbox.count());
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("takes the client from the call's own first argument", () => {
    // `import { prisma as db }` hands the helper a client under a name this
    // file has never seen. Seeding the client set from the literal string
    // "prisma" alone misses it — but the helper's signature says the first
    // argument IS the client, so no inference is needed.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { prisma as db } from "@/lib/prisma";
export async function drain() {
  return withBypassRls(db, async (tx) => {
    await tx.auditOutbox.findMany();
    return db.tenantMember.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("sees through a type-level wrapper on the client argument", () => {
    // `db as typeof db` is the same value wearing a cast. Requiring a bare
    // Identifier there loses the client origin to a no-op annotation.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { prisma as db } from "@/lib/prisma";
export async function drain() {
  return withBypassRls(db as typeof db, async (tx) => {
    await tx.auditOutbox.findMany();
    return db.tenantMember.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("tracks a client reached through a namespace import", () => {
    // `clients.prisma` is a member access, so a client set of bare names cannot
    // hold it. Clients are identified by expression text for exactly this.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import * as clients from "@/lib/prisma";
export async function drain() {
  return withBypassRls(clients.prisma, async (tx) => {
    await tx.auditOutbox.findMany();
    return clients.prisma.tenantMember.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("passes a namespace-import client that stays within the allowlist", () => {
    // The allow side: a member-access client must not make every access through
    // it a violation.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import * as clients from "@/lib/prisma";
export async function drain() {
  return withBypassRls(clients.prisma, async (tx) => {
    await tx.auditOutbox.findMany();
    return clients.prisma.auditOutbox.count();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("names a client the same way however it is spaced", () => {
    // `clients . prisma` and `clients.prisma` are one value under two source
    // strings. Comparing `getText()` carries the trivia between tokens, so a
    // single space defeated the match — the client argument and the model
    // receiver disagreed about the same expression.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import * as clients from "@/lib/prisma";
export async function drain() {
  return withBypassRls(clients . prisma, async (tx) => {
    await tx.auditOutbox.findMany();
    return clients.prisma.tenantMember.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("reduces a type wrapper on the model RECEIVER, not only on the argument", () => {
    // The reduction has to run on both sides. Applying it to the client
    // argument alone left `(tx as typeof tx).model` unseen.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => (tx as typeof tx).tenantMember.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("reads a model indexed by a static string", () => {
    // `tx["tenantMember"]` is `tx.tenantMember` written the other way.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx["tenantMember"].findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("catches a delegate lifted by a destructuring ASSIGNMENT", () => {
    // `({ model } = tx)` does what `const { model } = tx` does, but its left
    // side is an object literal rather than a binding pattern.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    let tenantMember;
    ({ tenantMember } = tx);
    return tenantMember.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("passes all three access spellings when they stay within the allowlist", () => {
    // The allow side for the cast receiver, the static index and the
    // destructuring assignment at once. This case also runs the assignment
    // branch at all — an earlier edit left it calling an undefined helper, and
    // the real tree never takes that branch, so the gate stayed green while
    // crashing on any file that did.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    let auditOutbox;
    ({ auditOutbox } = tx);
    await (tx as typeof tx).auditOutbox.findMany();
    return tx["auditOutbox"].count();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("reports a bypassed client indexed by a name it cannot resolve", () => {
    // `tx[model]` reaches SOME model and the gate cannot say which, so it must
    // say that. Dropping an unreadable index before checking whose index it is
    // discarded exactly this case. Note what it must NOT do: an identifier in
    // an index position is a variable, not a name — a first attempt reported a
    // model literally called "model", which is a confident wrong answer where
    // the honest one is "unknown".
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const model = "tenantMember" as const;
    return tx[model].findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("cannot resolve");
    expect(stderr).toContain("tx[model]");
    expect(stderr).not.toContain("prisma.model");
  });

  it("reports a computed destructuring key it cannot resolve", () => {
    // `const { [key]: tm } = tx` lifts SOME delegate out of a bypassed client
    // and the gate cannot say which — the same situation as `tx[model]`, which
    // is reported, so this must be too rather than quietly yielding nothing.
    for (const source of [
      `const { [key]: tm } = tx;
    return tm.findMany();`,
      `let tm;
    ({ [key]: tm } = tx);
    return tm.findMany();`,
    ]) {
      const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const key = "tenantMember" as const;
    ${source}
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
      expect(code).toBe(1);
      expect(stderr).toContain("cannot resolve");
    }
  });

  it("scans a nested $transaction callback passed by name", () => {
    // The outer callback is resolved by name when it has to be; the nested one
    // was not, so a `$transaction(innerJob)` lost both the inner client and the
    // body it runs. Same resolution, same visibility rule, same fallback.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function innerJob(inner: TX) {
  return inner.tenantMember.findMany();
}
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction(innerJob), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("analyses a named nested callback's own body, not just its parameter", () => {
    // Depth one was handled by adding the resolved callback to the scan; its
    // OWN destructuring was still judged "outside the callback", because the
    // inside-test looked only at the outermost one.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function job(inner: TX) {
  const { tenantMember } = inner;
  return tenantMember.findMany();
}
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction(job), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows nested $transaction callbacks to any depth", () => {
    // Three levels, each resolved by name. A worklist is depth-N by
    // construction; the previous shape handled exactly one level, which is why
    // every round found the next one.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function l3(d: TX) { return d.tenantMember.findMany(); }
async function l2(c: TX) { return c.$transaction(l3); }
async function l1(b: TX) { return b.$transaction(l2); }
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction(l1), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("terminates on mutually recursive callbacks and still reports", () => {
    // The visited set has to make a cycle finish, and finishing must not mean
    // giving up: the disallowed model is reached on the way round.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function ping(a: TX) {
  return a.$transaction(pong);
}
async function pong(b: TX) {
  await b.$transaction(ping);
  return b.tenantMember.findMany();
}
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction(ping), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("passes a deep callback chain that stays within the allowlist", () => {
    // The allow side at depth: following further must not make every nested
    // transaction a violation.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function deepJob(deep: TX) {
  const { auditOutbox } = deep;
  return auditOutbox.count();
}
async function job(inner: TX) {
  return inner.$transaction(deepJob);
}
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction(job), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("passes a named nested $transaction callback within the allowlist", () => {
    // The allow side: resolving the nested callback must not make every one of
    // them a violation.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function innerJob(inner: TX) {
  return inner.auditOutbox.count();
}
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction(innerJob), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("follows a client passed to a same-file helper", () => {
    // The header used to excuse this as "helpers are usually imported, which
    // needs a Program". True of imported ones; a same-file function resolves
    // through the binding index the gate already has.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function queryMember(db: TX) {
  return db.tenantMember.findMany();
}
export async function drain() {
  return withBypassRls(prisma, async (tx) => queryMember(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("binds the helper parameter in the position the client was passed", () => {
    // The client is argument 0 at one call and argument 1 at the next, so a
    // fixed position would lose it. Also two hops, which the worklist handles.
    //
    // The parameter names differ deliberately: a first version called both
    // `db`, and since clients are tracked by name the collision made a
    // wrong-position binding land on the right name anyway — the fixture
    // passed under the mutation it was written to catch.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function inner2(id, client: TX) { return client.tenantMember.findMany({ where: { id } }); }
async function inner1(db: TX, id) { return inner2(id, db); }
export async function drain() {
  return withBypassRls(prisma, async (tx) => inner1(tx, "x"), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("refuses an object binding it cannot prove, rather than analysing another one", () => {
    // Choosing the binding must come BEFORE asking what it holds. Filtering
    // candidates to object literals first dropped an inner `const helpers =
    // actual` — its initializer is an identifier — so the OUTER object was
    // analysed: a wrong answer in both directions. Same for a `let` reassigned
    // after its initializer.
    //
    // A binding this file cannot prove goes to the Program. A `const` alias is
    // resolved through its type to the object it names; a reassigned `let` is
    // refused, because the checker answers from the DECLARED type — the first
    // object — and following it would analyse the wrong function.
    const aliasedShadow = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const helpers = { query: (db: TX) => db.tenantMember.findMany() };
const actual = { query: (db: TX) => db.auditOutbox.findMany() };
export function drain() {
  const helpers = actual;
  return withBypassRls(prisma, (tx) => helpers.query(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(aliasedShadow.code).toBe(0);
    expect(aliasedShadow.stdout).toContain("check-bypass-rls: OK");

    const reassigned = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export function drain() {
  let helpers = { query: (db: TX) => db.tenantMember.findMany() };
  helpers = { query: (db: TX) => db.auditOutbox.findMany() };
  return withBypassRls(prisma, (tx) => helpers.query(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(reassigned.code).toBe(1);
    expect(reassigned.stderr).toContain("handed to a callee this gate cannot follow");
    // Not the first object's model: that would be the wrong answer this refuses.
    expect(reassigned.stderr).not.toContain("prisma.tenantMember");
  });

  it("resolves the innermost object literal when a local one shadows a module one", () => {
    // The sibling of the function-shadowing rule, and it was fixed for
    // functions only. Taking the first visible declaration analysed the OUTER
    // object: it missed the shadowing object's models, and reported the
    // shadowed one's — a miss and a false positive from the same line, which is
    // why both directions are asserted here.
    const forbiddenInner = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const helpers = { query: async (db: TX) => db.auditOutbox.findMany() };
export function drain() {
  const helpers = { query: async (db: TX) => db.tenantMember.findMany() };
  return withBypassRls(prisma, (tx) => helpers.query(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(forbiddenInner.code).toBe(1);
    expect(forbiddenInner.stderr).toContain("prisma.tenantMember");

    const allowedInner = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const helpers = { query: async (db: TX) => db.tenantMember.findMany() };
export function drain() {
  const helpers = { query: async (db: TX) => db.auditOutbox.findMany() };
  return withBypassRls(prisma, (tx) => helpers.query(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(allowedInner.code).toBe(0);
    expect(allowedInner.stdout).toContain("check-bypass-rls: OK");
  });

  it("resolves the innermost binding when a local function shadows a module one", () => {
    // JavaScript picks the innermost binding. Requiring "exactly one visible
    // declaration" resolved to neither and skipped the call in silence — the
    // shadowed outer function reaches only allowed models, so nothing else
    // would have noticed.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function query(db: TX) { return db.auditOutbox.findMany(); }
export function drain() {
  async function query(db: TX) { return db.tenantMember.findMany(); }
  return withBypassRls(prisma, (tx) => query(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("picks the shadowing binding rather than reporting the shadowed one", () => {
    // The mirror: the INNER function is the compliant one, so resolving the
    // outer would be a false positive. Both directions pin the same rule.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function query(db: TX) { return db.tenantMember.findMany(); }
export function drain() {
  async function query(db: TX) { return db.auditOutbox.findMany(); }
  return withBypassRls(prisma, (tx) => query(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("resolves an object-literal method and a .call invocation", () => {
    // Neither is the declared imported-helper gap: both bind locally. `.call`
    // also shifts its arguments by one, so resolving the function without that
    // offset binds the wrong parameter — a wrong answer, not a missing one.
    for (const source of [
      `const helpers = { query: async (db: TX) => db.tenantMember.findMany() };
export async function drain() {
  return withBypassRls(prisma, async (tx) => helpers.query(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`,
      `async function query(db: TX) { return db.tenantMember.findMany(); }
export async function drain() {
  return withBypassRls(prisma, async (tx) => query.call(null, tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`,
    ]) {
      const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
${source}`);
      expect(code).toBe(1);
      expect(stderr).toContain("prisma.tenantMember");
    }
  });

  it("follows an alias chain longer than any fixed depth, and stops on a cycle", () => {
    // A depth limit is a number an attacker can exceed; a visited set of
    // declarations is not. The cycle case must terminate rather than recurse.
    const chain = Array.from({ length: 9 }, (_, i) => `const f${i} = ${i === 0 ? "query" : `f${i - 1}`};`).join("\n");
    const deep = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function query(db: TX) { return db.tenantMember.findMany(); }
${chain}
export async function drain() {
  return withBypassRls(prisma, async (tx) => f8(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(deep.code).toBe(1);
    expect(deep.stderr).toContain("prisma.tenantMember");

    const cyclic = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const a = b;
const b = a;
export async function drain() {
  return withBypassRls(prisma, async (tx) => a(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    // Terminates, and a cycle names no function, so the hand-off is refused.
    expect(cyclic.code).toBe(1);
    expect(cyclic.stderr).toContain("handed to a callee this gate cannot follow");
  });

  it("treats the right operand of && as the client it yields", () => {
    // `a ?? tx` and `a || tx` can yield either side; `a && tx` yields the right
    // one when it yields at all.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function query(db: TX) {
  if (db) return db.tenantMember.findMany();
}
export async function drain(enabled) {
  return withBypassRls(prisma, async (tx) => query(enabled && tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("recognises an aliased client as a helper argument", () => {
    // The graph walk and the client flow used to be two phases: the alias was
    // learned by the flow pass, which ran after the only scan that could have
    // used it. They are one fixpoint now.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function queryMember(db: TX) { return db.tenantMember.findMany(); }
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const alias = tx;
    return queryMember(alias);
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("recognises a choice between clients as a helper argument", () => {
    // The argument test is the same predicate the flow pass uses, so
    // `flag ? tx : prisma` counts here exactly as it does in an assignment.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function queryMember(db: TX) { return db.tenantMember.findMany(); }
export async function drain(flag) {
  return withBypassRls(prisma, async (tx) => queryMember(flag ? tx : prisma), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows a function alias and an inline callee", () => {
    // `const aliasedQuery = query` names a function without being one, and an
    // IIFE is a callee that is already the function. Both resolve from the tree.
    for (const source of [
      `const aliasedQuery = query;
export async function drain() {
  return withBypassRls(prisma, async (tx) => aliasedQuery(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`,
      `export async function drain() {
  return withBypassRls(prisma, async (tx) => (async (db: TX) => db.tenantMember.findMany())(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`,
    ]) {
      const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function query(db: TX) { return db.tenantMember.findMany(); }
${source}`);
      expect(code).toBe(1);
      expect(stderr).toContain("prisma.tenantMember");
    }
  });

  it("does not let the order of two calls decide a function's client position", () => {
    // The same function used as an ordinary helper and as a transaction
    // callback binds a different parameter each time. Keying the visited set by
    // function alone let whichever call was seen first settle it, so this
    // reported or not depending on the order the two calls appear in.
    const body = (first, second) => `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function job(first: TX, second?: TX) {
  if (second) return second.auditOutbox.count();
  return first.tenantMember.findMany();
}
export async function drain(meta) {
  return withBypassRls(prisma, async (tx) => {
    ${first}
    ${second}
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`;
    for (const source of [
      body("await job(meta, tx);", "return tx.$transaction(job);"),
      body("await tx.$transaction(job);", "return job(meta, tx);"),
    ]) {
      const { code, stderr } = run("src/lib/audit/audit-outbox.ts", source);
      expect(code).toBe(1);
      expect(stderr).toContain("prisma.tenantMember");
    }
  });

  it("does not treat a helper's unrelated first parameter as a client", () => {
    // A `$transaction` callback takes the client as parameter 0; a helper does
    // not. Binding parameter 0 blindly made `pick(meta, tx)` register `meta` as
    // a client, and every `meta.<prop>` in the file then read as a model
    // access. Caught by the coverage differential — the real tree grew phantom
    // `prisma.kind` and `prisma.id` entries — not by any deny fixture, because
    // a false positive is invisible to a test that only asserts exit 1.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function pick(meta, db: TX) {
  if (meta.kind === "x") return null;
  return db.auditOutbox.count();
}
export async function drain(meta) {
  return withBypassRls(prisma, async (tx) => pick(meta, tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("passes a same-file helper that stays within the allowlist", () => {
    // The allow side: following the client into helpers must not make every
    // helper call a violation.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function queryOutbox(db: TX) { return db.auditOutbox.findMany(); }
export async function drain() {
  return withBypassRls(prisma, async (tx) => queryOutbox(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("follows an imported helper into its module and judges what it reaches", () => {
    // Formerly the declared gap: 42 call sites handed the client across a
    // module boundary and were exempted. The Program resolves them now.
    const { code, stderr } = runMulti([
      ["src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { queryMember } from "@/lib/elsewhere";
export async function drain() {
  return withBypassRls(prisma, async (tx) => queryMember(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`],
      ["src/lib/elsewhere.ts", `export async function queryMember(db: TX) { return db.tenantMember.findMany(); }`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember  (reached in src/lib/elsewhere.ts:1)");
  });

  it("fails an imported helper the Program cannot resolve to a body", () => {
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { queryMember } from "@/lib/missing";
export async function drain() {
  return withBypassRls(prisma, async (tx) => queryMember(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("handed to a callee this gate cannot follow");
    expect(stderr).toMatch(/src\/lib\/audit\/audit-outbox\.ts:5 +(callee has no declaration|import with no resolvable declaration|callee has no symbol)/);
  });

  it("follows every implementation of an injected interface member", () => {
    const { code, stderr } = runMulti([
      ["src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { run, type Deps } from "@/lib/core";
const deps: Deps = { count: (db: TX) => db.tenantMember.count() };
export async function drain() {
  return withBypassRls(prisma, async (tx) => run(deps, tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`],
      ["src/lib/core.ts", `
export interface Deps { count(db: unknown): Promise<number> }
export async function run(deps: Deps, tx: unknown) { return deps.count(tx); }`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows a non-literal index into a const table as every member", () => {
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { TABLE } from "@/lib/table";
export async function drain(key: keyof typeof TABLE) {
  return withBypassRls(prisma, async (tx) => TABLE[key](tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    // The table's module is absent from this tree, so the index is refused.
    expect(code).toBe(1);
    expect(stderr).toContain("handed to a callee this gate cannot follow");
    const followed = runMulti([
      ["src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { TABLE } from "@/lib/table";
export async function drain(key: keyof typeof TABLE) {
  return withBypassRls(prisma, async (tx) => TABLE[key](tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`],
      ["src/lib/table.ts", `
export const TABLE = {
  outbox: (db: TX) => db.auditOutbox.count(),
  member: (db: TX) => db.tenantMember.count(),
};`],
    ]);
    expect(followed.code).toBe(1);
    expect(followed.stderr).toContain("prisma.tenantMember  (reached in src/lib/table.ts:4)");
    expect(followed.stderr).not.toContain("prisma.auditOutbox");
  });

  it("judges what runs, however the client is bound: `.call`'s this, after a spread", () => {
    // Reach is by what runs and models by type, so a client bound to `this` or
    // placed after a spread is no blind spot: the function runs, and the model
    // it reads is charged.
    for (const body of ["async (tx) => query.call(tx)", "async (tx) => query(...rest, tx)"]) {
      const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const rest: unknown[] = [];
async function query(db: TX) { return db.tenantMember.findMany(); }
export async function drain() {
  return withBypassRls(prisma, ${body}, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
      expect(code).toBe(1);
      expect(stderr).toContain("prisma.tenantMember  (reached in src/lib/audit/audit-outbox.ts:4)");
    }
  });

  it("accepts a parenthesised batch $transaction", () => {
    // `$transaction(([...]))` is the batch form wearing parentheses. Testing
    // the argument's kind without unwrapping read it as a missing callback and
    // reported a compliant call — the false-positive direction.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction((
    [tx.auditOutbox.findMany(), tx.auditOutbox.count()]
  )), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("does not demand a callback from the batch form of $transaction", () => {
    // `$transaction([...])` takes an array of promises, not a callback. The
    // boundary for the fail-loud above: no callback expected, so nothing is
    // unresolved and the allowed models inside must simply pass.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) =>
    tx.$transaction([tx.auditOutbox.findMany(), tx.auditOutbox.count()]), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("reads a model indexed by an untagged template literal", () => {
    // `` tx[`tenantMember`] `` is a static name in a third spelling.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx[\`tenantMember\`].findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("catches a delegate destructured under a string key", () => {
    // `{ "tenantMember": tm }` renames through a string, in both the assignment
    // and the declaration form — the property-name reducer has to accept it.
    for (const source of [
      `let tm;
    ({ "tenantMember": tm } = tx);
    return tm.findMany();`,
      `const { "tenantMember": tm } = tx;
    return tm.findMany();`,
    ]) {
      const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    ${source}
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
      expect(code).toBe(1);
      expect(stderr).toContain("prisma.tenantMember");
    }
  });

  it("inherits the client through a bracket-spelled nested $transaction", () => {
    // `tx["$transaction"]` is `tx.$transaction`. Recognising only the dotted
    // form loses the inner callback's client.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) =>
    tx["$transaction"](async (inner: TX) => inner.tenantMember.findMany()), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("passes every static member spelling when it stays within the allowlist", () => {
    // The allow side for all four above at once: string-key destructuring, a
    // template index, and a bracket-spelled nested transaction.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const { "auditOutbox": ao } = tx;
    await tx[\`auditOutbox\`].findMany();
    return tx["$transaction"](async (inner: TX) => inner.auditOutbox.count()) && ao.count();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("ignores an index computed from a variable", () => {
    // A client indexed by a non-literal names no model this gate can read, and
    // `row[key]` on a query result must not be invented as one.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain(key: string) {
  return withBypassRls(prisma, async (tx) => {
    const row = await tx.auditOutbox.findFirst();
    return row[key];
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("judges the callback's models by type whatever the client argument is", () => {
    // `getClient()` reduces to no name. No name is tracked any more: the
    // callback's own parameter is typed by withBypassRls, so its models read.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
declare function getClient(): import("@prisma/client").PrismaClient;
export async function drain() {
  return withBypassRls(getClient(), async (tx) => tx.tenantMember.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows a client supplied as a parameter default", () => {
    // `function drain(db = prisma)` — the binding may carry the client, and for
    // a CLIENT over-approximating only reports more models. (callbackOf refuses
    // a parameter default for the opposite reason: guessing which function runs
    // is fail-open. Same construct, different question, different answer.)
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain(db = prisma) {
  return withBypassRls(prisma, async (tx) => {
    await tx.auditOutbox.findMany();
    return db.tenantMember.findMany();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("passes an aliased-import client and a parameter default within the allowlist", () => {
    // The allow side for both of the above.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { prisma as db } from "@/lib/prisma";
export async function drain(alt = db) {
  return withBypassRls(db, async (tx) => {
    await tx.auditOutbox.findMany();
    return alt.auditOutbox.count();
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("does not treat a query result as a client", () => {
    // The boundary that makes the flow analysis usable: `await tx.user.find()`
    // mentions a client and yields a row. 131 lines in this tree have that
    // shape, so a mention-based rule would report every ordinary query — here
    // `row.tenantMember` must NOT be read as a bypassed model access.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const row = await tx.auditOutbox.findFirst();
    return row.tenantMember;
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("passes an alias and a destructured delegate that stay within the allowlist", () => {
    // The allow side for both: following the value must not turn every local
    // binding into a violation.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const db = tx;
    const { auditOutbox } = db;
    const rows = await auditOutbox.findMany();
    return db.auditOutbox.count({ where: { id: rows[0]?.id } });
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("reads models through a rest element rather than reporting the rest name", () => {
    // `...rest` binds the remaining client, so it is a receiver. Treating it as
    // a model both invents `prisma.rest` and hides everything reached through it.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async ({ auditOutbox, ...rest }) => rest.user.deleteMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.user");
    expect(stderr).not.toContain("prisma.rest");
  });

  it("passes a destructured client that only takes allowed delegates", () => {
    // The allow side for both destructuring paths: the named property is an
    // allowed model and the rest binding reaches nothing.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async ({ auditOutbox, ...rest }) => auditOutbox.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("resolves a callback declared as a function declaration", () => {
    // `async function job(tx: TX)` is a FunctionDeclaration, not a VariableDeclaration,
    // so round 4's by-name lookup missed it and reported the site as unresolvable
    // — and the remedy it printed (allowlist the file) would have unscanned the
    // whole file. Prior verdict: exit 1, "could not be resolved".
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
async function job(tx: TX) { return tx.tenantMember.findFirst({}); }
export async function drain() {
  return withBypassRls(prisma, job, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
    expect(stderr).not.toContain("could not be resolved");
  });

  it("catches a model reached through a destructured client parameter", () => {
    // `async ({ tenantMember }) => …` writes no receiver, so the property-access
    // scan sees nothing, and getName() on a binding pattern returns the pattern
    // text, which no identifier can equal. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async ({ tenantMember }) => tenantMember.findFirst({}), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("flags an unused client parameter whatever it is named", () => {
    // F3 keyed on the spelling `tx`, so renaming the unused parameter defeated
    // the rule that exists to enforce the naming convention. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (db: TX) => legacy(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("never uses it");
  });

  it("does not count a same-named property access as a use of the parameter", () => {
    // `cfg.tx` is a property name, not a reference to the binding, so this
    // callback's `tx` is unused and must still be flagged. Counting identifier
    // text alone would read `cfg.tx` as a use and let the violation through —
    // the fail-open direction of the same text-equality habit.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain(cfg) {
  return withBypassRls(prisma, async (tx) => legacy(cfg.tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("never uses it");
  });

  it("passes a client parameter that is genuinely used", () => {
    // The allow side for the whole F3 predicate: a used binding must never be
    // reported, whatever it is named.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function drain() {
  return withBypassRls(prisma, async (db: TX) => db.auditOutbox.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("catches an aliased import written with a file extension", () => {
    // The alias table keyed on a module-specifier text tail (/tenant-rls$/), so
    // '@/lib/tenant-rls.js' — the same module — resolved no aliases and the call
    // escaped the file allowlist. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/sneaky/route.ts", `
import { withBypassRls as wb } from "@/lib/tenant-rls.js"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function sneaky() {
  return wb(prisma, async (tx) => tx.tenantMember.findFirst({}), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("not on the allowlist");
  });

  it("refuses to report OK when src/ exists but holds no source files", () => {
    // Corpus-level "examined nothing must not be spelled found nothing".
    // readdirSync throws for a MISSING src/; this is the present-but-empty case
    // it cannot see. Prior verdict: exit 0, "check-bypass-rls: OK".
    mkdirSync(join(dir, "src"), { recursive: true });
    const r = spawnSync("node", [CHECKER], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no .ts/.tsx source files found");
  });

  it("scans .tsx call sites, and passes one that only touches allowed models", () => {
    // Two allowlisted call sites are .tsx. Scanning became parse-dependent in
    // round 3, so dropping .tsx from the scan set — or misparsing JSX — would
    // silently unscan both, and neither the suite nor the real tree would say so.
    const source = (model) => `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export default async function Page() {
  const row = await withBypassRls(prisma, async (tx) => tx.${model}.findFirst({}), BYPASS_GRANT.SHARE_LINK_PUBLIC_ACCESS);
  // shareAccessLog is the grant's other model; a fixture that reached only one
  // of the two would trip the stale-model check below.
  await withBypassRls(prisma, async (tx) => tx.shareAccessLog.create({}), BYPASS_GRANT.SHARE_LINK_PUBLIC_ACCESS);
  return <div className="p">{row?.id}</div>;
}`;
    const denied = run("src/app/s/[token]/page.tsx", source("tenantMember"));
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("page.tsx");
    expect(denied.stderr).toContain("prisma.tenantMember");

    const allowed = run("src/app/s/[token]/page.tsx", source("passwordShare"));
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain("check-bypass-rls: OK");
  });
});

// ─── the reverse direction: a permission nothing uses ────────────────────────
//
// The allowlist had been read for two rounds as the documented bypass scope of
// each file, and six entries named models their file had stopped reaching. The
// forward check cannot see that: it only asks whether what IS reached was
// permitted. The permission now lives in the grant, shared by every call that
// names it, so it is judged across all of them.

const SESSION_CAP = "src/lib/auth/session/session-concurrency.ts";

describe("grant over-breadth", () => {
  it("fails a grant model no call naming the grant reaches", () => {
    // AUTH_SESSION_CAPPING lists session + tenant. This fixture reaches only
    // the second, so the first is a permission with nothing behind it.
    const { code, stderr } = run(SESSION_CAP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const id = "t";
export async function GET() {
  return withBypassRls(prisma, async (tx) => tx.tenant.findUnique({ where: { id } }), BYPASS_GRANT.AUTH_SESSION_CAPPING);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("lists a model no call naming it reaches");
    expect(stderr).toMatch(/src\/lib\/tenant-rls-grants\.ts:\d+  BYPASS_GRANT\.AUTH_SESSION_CAPPING  prisma\.session\n/);
    // The one it DOES reach must not be reported alongside it, or the message
    // stops naming what to remove.
    expect(stderr).not.toContain("prisma.tenant\n");
  });

  it("passes when every model of the grant is reached", () => {
    const { code, stdout } = run(SESSION_CAP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
const id = "t";
export async function GET() {
  return withBypassRls(prisma, async (tx) => {
    await tx.tenant.findUnique({ where: { id } });
    return tx.session.findMany({});
  }, BYPASS_GRANT.AUTH_SESSION_CAPPING);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("judges a shared grant across every call that names it", () => {
    // Neither call reaches both models; together they do. A grant is stale
    // only when NO call naming it reaches the model.
    const { code, stdout } = run(SESSION_CAP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export const a = () => withBypassRls(prisma, async (tx) => tx.tenant.count(), BYPASS_GRANT.AUTH_SESSION_CAPPING);
export const b = () => withBypassRls(prisma, async (tx) => tx.session.count(), BYPASS_GRANT.AUTH_SESSION_CAPPING);`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("counts a model reached in an imported callee as reached by the call", () => {
    // Formerly exempted: the callee could reach any permitted model, so "never
    // reached" meant "not seen". `notification.ts` was the case — its `user`
    // read had moved into the adjudicator it hands `tx` to. Followed now, the
    // callee's read keeps the permission alive.
    const { code, stdout } = runMulti([
      [SESSION_CAP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { resolveSomething } from "@/lib/elsewhere";
const id = "t";
export async function GET() {
  return withBypassRls(prisma, async (tx) => {
    await tx.tenant.findUnique({ where: { id } });
    return resolveSomething(tx, id);
  }, BYPASS_GRANT.AUTH_SESSION_CAPPING);
}`],
      ["src/lib/elsewhere.ts", `export async function resolveSomething(db: TX, id) { return db.session.findMany({}); }`],
    ]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/[1-9]\d* bypass callback\(s\) followed through [1-9]\d* reached function\(s\)/);
  });

  it("does not fire on a grant whose calls reach no model at all", () => {
    // A raw-SQL bypass touches no model. Reporting every listed model as
    // unused there would make the check fire loudest where it knows least.
    const { code, stdout } = run(SESSION_CAP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function GET() {
  return withBypassRls(prisma, async (tx) => tx.$executeRaw\`SELECT 1\`, BYPASS_GRANT.AUTH_SESSION_CAPPING);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("does not judge a grant one of whose calls also reaches raw SQL", () => {
    // auth.ts's tenant merge reaches audit_logs through a SECURITY DEFINER
    // procedure its grant must list; the raw statement names no model, so the
    // listed model would read as stale. Its deny partner is the first cell.
    const { code, stdout } = run(SESSION_CAP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export async function GET() {
  return withBypassRls(prisma, async (tx) => {
    await tx.tenant.count();
    await tx.$executeRaw\`CALL some_definer_procedure()\`;
  }, BYPASS_GRANT.AUTH_SESSION_CAPPING);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("fails a grant no call or self-setting site names", () => {
    const { code, stderr } = runMulti([[SESSION_CAP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export const a = () => withBypassRls(prisma, async (tx) => { await tx.tenant.count(); await tx.session.count(); }, BYPASS_GRANT.AUTH_SESSION_CAPPING);`]],
    CHECKER, { keepGrants: ["WEBHOOK_SECRET_MIGRATION"] });
    expect(code).toBe(1);
    expect(stderr).toContain("stale grant: a BYPASS_GRANT member no withBypassRls call or self-setting site names.");
    expect(stderr).toMatch(/src\/lib\/tenant-rls-grants\.ts:\d+  BYPASS_GRANT\.WEBHOOK_SECRET_MIGRATION\n/);
    expect(stderr).not.toContain("BYPASS_GRANT.AUTH_SESSION_CAPPING");
  });

  it("counts a grant handed to setBypassGucs as named, through an own wrapper too", () => {
    // A self-setting site (the workers, the retention sweep's inSweepTx): the
    // grant is used, and its reach is the database's to report.
    const { code, stdout } = runMulti([[SESSION_CAP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export const a = () => withBypassRls(prisma, async (tx) => { await tx.tenant.count(); await tx.session.count(); }, BYPASS_GRANT.AUTH_SESSION_CAPPING);`],
    ["src/workers/zz-worker.ts", `import { BYPASS_GRANT, setBypassGucs, type BypassGrant } from "@/lib/tenant-rls-grants";
async function inTx(db: TX, grant: BypassGrant | null) { if (grant) await setBypassGucs(db, grant); }
export const run = (db: TX) => inTx(db, BYPASS_GRANT.WEBHOOK_SECRET_MIGRATION);
export const direct = (db: TX) => setBypassGucs(db, BYPASS_GRANT.OUTBOX_DEPTH_READ);`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("refuses a self-setting site handed a grant it cannot read", () => {
    const { code, stderr } = runMulti([[SESSION_CAP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export const a = () => withBypassRls(prisma, async (tx) => { await tx.tenant.count(); await tx.session.count(); }, BYPASS_GRANT.AUTH_SESSION_CAPPING);`],
    ["src/workers/zz-worker.ts", `import { defineGrant, setBypassGucs } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";
export const run = (db: TX) => setBypassGucs(db, defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["auditLog"]));`]]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/workers\/zz-worker\.ts:3  setBypassGucs is handed a grant that is not a BYPASS_GRANT\.\* member/);
  });

  it("fails an entry whose file makes no withBypassRls call at all", () => {
    // The widest member of the over-breadth class, which the per-model check skips
    // under a comment that called it "Check 1's business" — Check 1 fires only in
    // the other direction. The real tree held two: the MCP token route and the 410
    // DCR-cleanup stub, neither of which bypasses anything now.
    const { code, stderr } = run(SESSION_CAP, `
export async function GET() {
  return new Response(null, { status: 410 });
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("makes no withBypassRls call");
    expect(stderr).toContain("src/lib/auth/session/session-concurrency.ts");
  });

  it("does not judge an entry whose file turns the bypass on through setBypassGucs", () => {
    // A real bypass this gate does not follow (a self-setting site). Flagging
    // the entry would delete the only record here that the file bypasses.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { BYPASS_GRANT, setBypassGucs } from "@/lib/tenant-rls-grants";
export async function drain(tx: TX) {
  await setBypassGucs(tx, BYPASS_GRANT.AUDIT_OUTBOX_ENQUEUE);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("names only files that exist, in the real repo's allowlist", () => {
    // Absence is not judged by the gate — it runs on one-file fixture trees, where
    // every other allowlisted file is absent by construction — so it is asserted
    // here against the real tree. A deleted file's entry must not outlive it.
    const repoRoot = join(dirname(CHECKER), "..", "..");
    const source = readFileSync(CHECKER, "utf8");
    const start = source.indexOf("const ALLOWED_USAGE = new Set([");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, source.indexOf("]);", start));
    const files = [...block.matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
    // "Parsed nothing" must not read as "nothing missing".
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => !existsSync(join(repoRoot, f)))).toEqual([]);
  });

  it("names every real BYPASS_GRANT member at some call or self-setting site", { timeout: 600_000 }, () => {
    // The fixture trees prune the registry to the members they name, so the
    // unnamed-grant rule is held against the real registry here, by running
    // the gate on the real tree.
    const repoRoot = join(dirname(CHECKER), "..", "..");
    const r = spawnSync("node", [CHECKER], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(r.stderr).not.toContain("stale grant: a BYPASS_GRANT member no withBypassRls call or self-setting site names.");
    // The rule ran: the whole run reached its verdict over the real registry.
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("check-bypass-rls: OK");
  });
});

// ─── Operator CLI scope and call-scoped grants ────────────────────────────────
//
// scripts/tenant-domain.ts is outside `src/` and was examined by nothing. It is
// now scanned, and its grants' purpose is pinned to SYSTEM_MAINTENANCE
// (ALLOWED_PURPOSES). Check 2 used to be satisfied by ONE `BYPASS_PURPOSE.X`
// anywhere in the file; it is now checked per call, against the call's grant.

const TENANT_DOMAIN = "scripts/tenant-domain.ts";

/** A tenant-domain.ts body reaching every model of its grant, plus `extra` calls. */
function tenantDomainSource(extra = "") {
  return `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT, type BypassGrant } from "@/lib/tenant-rls-grants";
export async function list() {
  return withBypassRls(prisma, async (tx) => {
    await tx.tenant.count();
    await tx.tenantClaim.count();
  }, BYPASS_GRANT.TENANT_CLAIM_LIST);
}
${extra}`;
}

describe("operator CLI scope and call-scoped grants", () => {
  it("passes tenant-domain.ts reaching its grant's models under SYSTEM_MAINTENANCE", () => {
    const { code, stdout } = run(TENANT_DOMAIN, tenantDomainSource());
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("fails a model outside the call's grant, so the file is really scanned", () => {
    const { code, stderr } = run(TENANT_DOMAIN, tenantDomainSource(`
export async function leak() {
  return withBypassRls(prisma, async (tx) => tx.teamPasswordEntry.findMany({}), BYPASS_GRANT.TENANT_CLAIM_LIST);
}`));
    expect(code).toBe(1);
    expect(stderr).toContain(`${TENANT_DOMAIN}:`);
    expect(stderr).toContain("prisma.teamPasswordEntry  not in BYPASS_GRANT.TENANT_CLAIM_LIST");
  });

  it("fails a grant whose purpose is outside ALLOWED_PURPOSES for tenant-domain.ts", () => {
    const { code, stderr } = run(TENANT_DOMAIN, tenantDomainSource(`
export async function lookup() {
  return withBypassRls(prisma, async (tx) => tx.tenant.findMany({}), BYPASS_GRANT.TENANT_POLICY_LOOKUP);
}`));
    expect(code).toBe(1);
    expect(stderr).toContain("BYPASS_GRANT.TENANT_POLICY_LOOKUP runs under BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, not in ALLOWED_PURPOSES (SYSTEM_MAINTENANCE)");
  });

  it("holds a forwarder's callers in a pinned file to ALLOWED_PURPOSES", () => {
    const forwarder = `
export async function lookup(grant: BypassGrant) {
  return withBypassRls(prisma, async (tx) => tx.tenant.findMany({}), grant);
}`;
    const denied = run(TENANT_DOMAIN, tenantDomainSource(`${forwarder}
export const viaForwarder = () => lookup(BYPASS_GRANT.TENANT_POLICY_LOOKUP);`));
    expect(denied.code).toBe(1);
    expect(denied.stderr).toMatch(/scripts\/tenant-domain\.ts:\d+  BYPASS_GRANT\.TENANT_POLICY_LOOKUP runs under BYPASS_PURPOSE\.CROSS_TENANT_LOOKUP, not in ALLOWED_PURPOSES \(SYSTEM_MAINTENANCE\)/);

    const allowed = run(TENANT_DOMAIN, tenantDomainSource(`${forwarder}
export const viaForwarder = () => lookup(BYPASS_GRANT.SYSTEM_MAINTENANCE_TENANT_LOOKUP);`));
    expect(allowed.code).toBe(0);
  });

  it("fails a call with a string-literal grant even when another call in the file names BYPASS_GRANT", () => {
    // The file-scoped form passed this: the first call's BYPASS_PURPOSE.X
    // satisfied the check for the second.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export const a = () => withBypassRls(prisma, async (tx) => tx.auditOutbox.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
export const b = () => withBypassRls(prisma, async (tx) => tx.auditOutbox.count(), "audit_write");
`);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:4  the grant is not a BYPASS_GRANT.* member");
    expect(stderr).not.toContain("src/lib/audit/audit-outbox.ts:3");
  });

  it("passes a helper forwarding its own BypassGrant-typed parameter", () => {
    const { code, stdout } = run("src/lib/audit/audit-user-lookup.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { type BypassGrant } from "@/lib/tenant-rls-grants";
export async function fetchUsers(ids: string[], grant: BypassGrant) {
  return withBypassRls(prisma, (tx) => tx.user.findMany({ where: { id: { in: ids } } }), grant);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("fails a forwarded parameter whose type is not BypassGrant", () => {
    const { code, stderr } = run("src/lib/audit/audit-user-lookup.ts", `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export const tag = BYPASS_GRANT.AUDIT_USER_DISPLAY_LOOKUP;
export async function fetchUsers(ids: string[], grant: string) {
  return withBypassRls(prisma, (tx) => tx.user.findMany({ where: { id: { in: ids } } }), grant);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/audit/audit-user-lookup.ts:5  the grant is not a BYPASS_GRANT.* member");
  });

  it("names only files that exist, in the real repo's NON_PRODUCTION_SCRIPTS", () => {
    // A listed tooling script that was renamed would leave its new name
    // classified as production (the fail-closed direction), but the stale name
    // would read as a reviewed exclusion — so absence is asserted here.
    const repoRoot = join(dirname(CHECKER), "..", "..");
    const source = readFileSync(join(repoRoot, "scripts/checks/lib/function-resolver.mjs"), "utf8");
    const match = source.match(/export const NON_PRODUCTION_SCRIPTS = \[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const files = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => !existsSync(join(repoRoot, f)))).toEqual([]);
  });
});

// ─── Shapes found by the round-1 code review, each executed as a bypass first ─

const OUTBOX = "src/lib/audit/audit-outbox.ts"; // allowlisted; its fixtures name AUDIT_WRITE_DIRECT_OUTBOX (auditOutbox only)
const USER_LOOKUP = "src/lib/audit/audit-user-lookup.ts"; // allowlisted
const HEAD_RLS = `import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";\n`;

describe("round-1 review: client reach the cross-module pass used to miss", () => {
  it("charges every file that enters a cycle with the whole cycle's models", () => {
    // cycA and cycB call each other. Memoising cycB's result while cycA was
    // still open dropped cycA's model for whichever file entered at cycB.
    const files = [
      ["src/lib/zz/ma.ts", `import { cycB } from "./mb";
export async function cycA(tx: TX, n: number): Promise<unknown> { await tx.session.count(); return n ? cycB(tx, n - 1) : null; }`],
      ["src/lib/zz/mb.ts", `import { cycA } from "./ma";
export async function cycB(tx: TX, n: number): Promise<unknown> { await tx.tenant.count(); return n ? cycA(tx, n - 1) : null; }`],
      [OUTBOX, `${HEAD_RLS}import { cycA } from "@/lib/zz/ma";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return cycA(tx, 2); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
      [USER_LOOKUP, `${HEAD_RLS}import { cycB } from "@/lib/zz/mb";
export const g = () => withBypassRls(prisma, async (tx) => { await tx.user.count(); return cycB(tx, 2); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ];
    const { code, stderr } = runMulti(files);
    expect(code).toBe(1);
    for (const file of [OUTBOX, USER_LOOKUP]) {
      const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(stderr).toMatch(new RegExp(`${escaped}:\\d+  prisma\\.session`));
      expect(stderr).toMatch(new RegExp(`${escaped}:\\d+  prisma\\.tenant`));
    }
  });

  it("ignores an interface implementation that only a test file supplies", () => {
    const files = [
      ["src/lib/zz/counter.ts", `export interface Counter { run(tx: TX): Promise<number> }
export const realCounter: Counter = { run: (tx: TX) => tx.auditOutbox.count() };`],
      [OUTBOX, `${HEAD_RLS}import { realCounter, type Counter } from "@/lib/zz/counter";
const c: Counter = realCounter;
export const f = () => withBypassRls(prisma, async (tx) => c.run(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ];
    expect(runMulti(files).code).toBe(0);
    // A test double reaching another model is not production reach.
    const withMock = runMulti([...files, ["src/lib/zz/counter.test.ts", `import type { Counter } from "./counter";
export const fake: Counter = { run: (tx: TX) => tx.tenantMember.count() };`]]);
    expect(withMock.code).toBe(0);
    expect(withMock.stdout).toContain("check-bypass-rls: OK");
  });

  it("follows an own callee that reaches the ambient prisma without being handed a client", () => {
    const crossModule = runMulti([
      ["src/lib/zz/amb.ts", `import { prisma } from "@/lib/prisma";
export async function ambientCount() { return prisma.session.count(); }`],
      [OUTBOX, `${HEAD_RLS}import { ambientCount } from "@/lib/zz/amb";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return ambientCount(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(crossModule.code).toBe(1);
    expect(crossModule.stderr).toContain("prisma.session  (reached in src/lib/zz/amb.ts:2)");

    const sameFile = run(OUTBOX, `${HEAD_RLS}import { prisma } from "@/lib/prisma";
async function ambientCount() { return prisma.session.count(); }
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return ambientCount(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(sameFile.code).toBe(1);
    expect(sameFile.stderr).toContain("prisma.session");
  });

  it("refuses a const table that gains a member after its initializer", () => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/tbl.ts", `export const TBL: Record<string, (tx) => Promise<number>> = { a: (tx) => tx.auditOutbox.count() };
TBL.b = (tx) => tx.session.count();`],
      [OUTBOX, `${HEAD_RLS}import { TBL } from "@/lib/zz/tbl";
export const f = (k: string) => withBypassRls(prisma, async (tx) => TBL[k](tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/zz/tbl.ts:2  G1: write of a function through a key no declaration names");
  });

  it.each([
    ["a property of an object argument", "wrapped({ db: tx })", "export async function wrapped({ db }: { db: TX }) { return db.tenantMember.count(); }"],
    ["a shorthand property", "wrapped({ tx })", "export async function wrapped(p: { tx: TX }) { return p.tx.tenantMember.count(); }"],
  ])("follows a client handed on as %s", (_label, call, callee) => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/w.ts", callee],
      [OUTBOX, `${HEAD_RLS}import { wrapped } from "@/lib/zz/w";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return ${call}; }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember  (reached in src/lib/zz/w.ts:1)");
  });

  it.each([
    ["a constructor", "new Repo(tx).list()"],
    ["an array", "takeAll([tx])"],
    ["a nested object", "takeAll({ deps: { tx } })"],
  ])("follows a client handed to %s into what it reaches", (_label, expr) => {
    // Formerly refused because a name-keyed client set could not bind them.
    // Reach and types follow them: the model read inside is charged.
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}
import type { Prisma } from "@prisma/client";
class Repo { constructor(private readonly db: Prisma.TransactionClient) {} list() { return this.db.tenantMember.count(); } }
function takeAll(x: { deps: { tx: Prisma.TransactionClient } } | Prisma.TransactionClient[]) {
  return Array.isArray(x) ? x[0].tenantMember.count() : x.deps.tx.tenantMember.count();
}
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return ${expr}; }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows a subclass override reached through a base-typed receiver", () => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/svc.ts", `export class Base { async run(tx: TX): Promise<number> { return tx.auditOutbox.count(); } }
export class Derived extends Base { async run(tx: TX): Promise<number> { return tx.tenantMember.count(); } }
export const svc: Base = new Derived();`],
      [OUTBOX, `${HEAD_RLS}import { svc } from "@/lib/zz/svc";
export const f = () => withBypassRls(prisma, async (tx) => svc.run(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember  (reached in src/lib/zz/svc.ts:2)");
  });
});

describe("round-1 review: the grant is the real BYPASS_GRANT, wherever it is named", () => {
  it("refuses a local object that shadows BYPASS_GRANT", () => {
    const { code, stderr } = run(TENANT_DOMAIN, tenantDomainSource(`
export const shadowed = () => {
  const BYPASS_GRANT = { SYSTEM_MAINTENANCE_TENANT_LOOKUP: { purpose: "auth_flow", models: ["tenant"], tables: "tenants" } as const };
  return withBypassRls(prisma, async (tx) => tx.tenant.count(), BYPASS_GRANT.SYSTEM_MAINTENANCE_TENANT_LOOKUP);
};`));
    expect(code).toBe(1);
    expect(stderr).toMatch(/scripts\/tenant-domain\.ts:\d+  the grant is not a BYPASS_GRANT\.\* member: BYPASS_GRANT\.SYSTEM_MAINTENANCE_TENANT_LOOKUP/);
  });

  it("accepts BYPASS_GRANT destructured from a dynamic import of the grants module", () => {
    const { code, stdout } = run(OUTBOX, `
export async function f() {
  const { withBypassRls } = await import("@/lib/tenant-rls");
  const { BYPASS_GRANT } = await import("@/lib/tenant-rls-grants");
  return withBypassRls(prisma, async (tx) => tx.auditOutbox.count(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("resolves a renamed import of BYPASS_GRANT, and a literal-keyed member read", () => {
    const { code, stdout } = run(OUTBOX, `import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT as G } from "@/lib/tenant-rls-grants";
export const f = () => withBypassRls(prisma, async (tx) => tx.auditOutbox.count(), G.AUDIT_WRITE_DIRECT_OUTBOX);
export const g = () => withBypassRls(prisma, async (tx) => tx.auditOutbox.count(), (G)["AUDIT_WRITE_DIRECT_OUTBOX"]);`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it.each([
    ["an inline defineGrant", `defineGrant(BYPASS_PURPOSE.AUDIT_WRITE, ["auditOutbox"])`],
    ["a conditional", `(Math.random() > 0.5 ? BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX : BYPASS_GRANT.OUTBOX_DEPTH_READ)`],
    ["a cast", `({ purpose: "audit_write", models: ["auditOutbox"], tables: "audit_outbox" } as BypassGrant)`],
    ["a cast of a real member", `(BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX as BypassGrant)`],
    ["a const holding a member", `held`],
    ["an object spread of a member", `{ ...BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX }`],
  ])("refuses a grant spelled as %s", (_label, grant) => {
    const { code, stderr } = run(OUTBOX, `import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT, defineGrant, type BypassGrant } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";
const held = BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX;
export const f = () => withBypassRls(prisma, async (tx) => tx.auditOutbox.count(), ${grant});`);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:4  the grant is not a BYPASS_GRANT.* member");
  });

  it("refuses a spread argument list that covers the grant position", () => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}
const rest = [BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX] as const;
export const f = () => withBypassRls(prisma, async (tx) => tx.auditOutbox.count(), ...rest);`);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:4  the grant is not a BYPASS_GRANT.* member: a spread argument");
  });

  it("accepts a forwarder typed with the exported BypassGrant alias, its caller naming a grant that covers it", () => {
    const { code, stdout } = run(USER_LOOKUP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT, type BypassGrant } from "@/lib/tenant-rls-grants";
export async function fetchUsers(ids: string[], grant: BypassGrant) {
  return withBypassRls(prisma, (tx) => tx.user.findMany({ where: { id: { in: ids } } }), grant);
}
export const caller = () => fetchUsers([], BYPASS_GRANT.AUDIT_USER_DISPLAY_LOOKUP);`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("charges a forwarder's reach to its caller's grant", () => {
    // fetchUserDisplayMap / fetchUserContact take the grant from each caller:
    // what the forwarded call reaches is judged against what the caller names.
    const { code, stderr } = runMulti([
      [USER_LOOKUP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { type BypassGrant } from "@/lib/tenant-rls-grants";
export async function fetchUsers(ids: string[], grant: BypassGrant) {
  return withBypassRls(prisma, (tx) => tx.user.findMany({ where: { id: { in: ids } } }), grant);
}`],
      ["src/app/zz/route.ts", `import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { fetchUsers } from "@/lib/audit/audit-user-lookup";
export const GET = () => fetchUsers([], BYPASS_GRANT.OUTBOX_DEPTH_READ);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/app/zz/route.ts:3  prisma.user  (reached in src/lib/audit/audit-user-lookup.ts:4)  not in BYPASS_GRANT.OUTBOX_DEPTH_READ  (through fetchUsers (src/lib/audit/audit-user-lookup.ts))");
  });

  it("refuses a raw string literal passed through a forwarder", () => {
    const { code, stderr } = run(USER_LOOKUP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { type BypassGrant } from "@/lib/tenant-rls-grants";
export async function fetchUsers(ids: string[], grant: BypassGrant) {
  return withBypassRls(prisma, (tx) => tx.user.findMany({ where: { id: { in: ids } } }), grant);
}
export const caller = () => fetchUsers([], "audit_write");`);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/lib\/audit\/audit-user-lookup\.ts:6  fetchUsers called without a BYPASS_GRANT\.\* argument/);
  });
});

describe("round-1 review: production scope is src/ and scripts/", () => {
  it("fails a bypass in an unlisted production script", () => {
    const { code, stderr } = run("scripts/new-job.ts", `${HEAD_RLS}
export const f = () => withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP);`);
    expect(code).toBe(1);
    expect(stderr).toContain("withBypassRls usage found in files not on the allowlist");
    expect(stderr).toContain("scripts/new-job.ts");
  });

  it("does not scan scripts/manual-tests/probe.ts, which is not production", () => {
    const { code, stdout } = run("scripts/manual-tests/probe.ts", `${HEAD_RLS}
export const f = () => withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP);`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("refuses listed tooling that reaches the RLS helpers, instead of scanning it as production", () => {
    // Tooling is excluded on the premise that it opens no RLS context; one that
    // imports the helpers breaks the premise, and is refused as that.
    const { code, stderr } = run("scripts/check-env-docs.ts", `${HEAD_RLS}
export const f = () => withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP);`);
    expect(code).toBe(1);
    expect(stderr).toContain("scripts/check-env-docs.ts is listed as non-production tooling but its imports reach src/lib/tenant-rls.ts");
    expect(stderr).not.toContain("not on the allowlist");
  });
});

// ─── Round 2 / user review: shapes a name-keyed client set missed ───────────
//
// Check 3 now reaches what runs and reads models by type, so none of these
// depend on how the client is spelled. Each was executed as a bypass of the
// previous mechanism first.

describe("round 2: any spelling of the client is charged by type", () => {
  it.each([
    ["the container is destructured", "async function helper(p: Box) { const { db } = p; return db.tenantMember.count(); }", "helper({ db: tx })"],
    ["the container is aliased", "async function helper(p: Box) { const q = p; return q.db.tenantMember.count(); }", "helper({ db: tx })"],
    ["the container is passed on under another name", "async function inner(q: Box) { return q.db.tenantMember.count(); }\nasync function helper(p: Box) { return inner(p); }", "helper({ db: tx })"],
    ["the object is built first", "async function helper(p: Box) { return p.db.tenantMember.count(); }", "(() => { const args = { db: tx }; return helper(args); })()"],
  ])("charges a model when %s", (_label, decls, call) => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}import type { Prisma } from "@prisma/client";
type Box = { db: Prisma.TransactionClient };
${decls}
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return ${call}; }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it.each([
    ["an import alias", 'import { prisma as db } from "@/lib/prisma";', "db.session.count()"],
    ["a namespace import", 'import * as P from "@/lib/prisma";', "P.prisma.session.count()"],
  ])("charges the ambient client reached through %s", (_label, imp, use) => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/amb2.ts", `${imp}\nexport async function readIt() { return ${use}; }`],
      [OUTBOX, `${HEAD_RLS}import { readIt } from "@/lib/zz/amb2";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return readIt(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.session  (reached in src/lib/zz/amb2.ts:2)");
  });

  it.each([
    ["Array.prototype.map", "return [1].map(readSession);"],
    ["Promise.all over a mapped array", "return Promise.all(['a'].map(readSession));"],
  ])("charges an own function handed to %s as a value", (_label, body) => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/rs.ts", `import { prisma } from "@/lib/prisma";\nexport const readSession = () => prisma.session.count();`],
      [OUTBOX, `${HEAD_RLS}import { readSession } from "@/lib/zz/rs";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); ${body} }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.session  (reached in src/lib/zz/rs.ts:2)");
  });

  it("refuses a member written after its initializer", () => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/ops.ts", `import type { Prisma } from "@prisma/client";
export const ops = { run: async (t: Prisma.TransactionClient) => t.auditOutbox.count() };
export function arm() { ops.run = async (t: Prisma.TransactionClient) => t.user.deleteMany({}); }`],
      [OUTBOX, `${HEAD_RLS}import { ops } from "@/lib/zz/ops";
export const f = () => withBypassRls(prisma, async (tx) => ops.run(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/zz/ops.ts:3  G1: write to member run, which may hold a function");
  });

  it("charges a model an inherited constructor reaches through the ambient client", () => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/base.ts", `import { prisma } from "@/lib/prisma";
export class Base { constructor() { void prisma.session.count(); } }
export class Child extends Base {}`],
      [OUTBOX, `${HEAD_RLS}import { Child } from "@/lib/zz/base";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); new Child(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.session  (reached in src/lib/zz/base.ts:2)");
  });
});

describe("round 2: callback and grant are read at their declared positions", () => {
  it("refuses a registered grant placed after the grant position", () => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}
export const f = () => withBypassRls(
  prisma,
  async (tx) => tx.auditOutbox.count(),
  "not_a_registered_grant" as never,
  BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX as never,
);`);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/lib\/audit\/audit-outbox\.ts:3  the grant is not a BYPASS_GRANT\.\* member/);
  });

  it("does not take a function outside the callback position as the callback", () => {
    // The real callback reaches tenantMember; a decoy function after the
    // purpose must not stand in for it.
    // The real callback is passed by reference and the decoy is a literal, so
    // "the first function-looking argument" would pick the decoy.
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}
import type { Prisma } from "@prisma/client";
const cb = async (tx: Prisma.TransactionClient) => tx.tenantMember.count();
export const f = () => withBypassRls(
  prisma,
  cb,
  BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX,
  (async (tx: Prisma.TransactionClient) => tx.auditOutbox.count()) as never,
);`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });
});

describe("round 2: the tx-less check reads the callback at its declared position", () => {
  it("refuses a tx-less callback passed by reference even when a decoy literal follows", () => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}
import type { Prisma } from "@prisma/client";
const cb = async () => prisma.auditOutbox.count();
export const f = () => withBypassRls(
  prisma,
  cb,
  BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX,
  (async (tx: Prisma.TransactionClient) => tx.auditOutbox.count()) as never,
);`);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/lib\/audit\/audit-outbox\.ts:5/);
    expect(stderr).toContain("tx");
  });
});

describe("round 2: purpose pins hold across forwarders", () => {
  const FORWARDER = `
export async function fwd(g: BypassGrant) {
  return withBypassRls(prisma, async (tx) => tx.tenant.count(), g);
}`;
  it("holds a pinned file's own forwarder to its pin when called from an unpinned file", () => {
    const { code, stderr } = runMulti([
      [TENANT_DOMAIN, tenantDomainSource(FORWARDER)],
      ["src/app/caller.ts", `import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { fwd } from "../../scripts/tenant-domain";
export const c = () => fwd(BYPASS_GRANT.TOKEN_TENANT_LOOKUP);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("BYPASS_GRANT.TOKEN_TENANT_LOOKUP runs under BYPASS_PURPOSE.TOKEN_LIFECYCLE, not in ALLOWED_PURPOSES (SYSTEM_MAINTENANCE) (forwarded into scripts/tenant-domain.ts)");
  });

  it("holds a chain of forwarders to the pin, and passes the allowed grant through it", () => {
    const chain = (grant) => tenantDomainSource(`${FORWARDER}
export async function outer(q: BypassGrant) { return fwd(q); }
export const c = () => outer(BYPASS_GRANT.${grant});`);
    const denied = run(TENANT_DOMAIN, chain("TENANT_POLICY_LOOKUP"));
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("BYPASS_GRANT.TENANT_POLICY_LOOKUP runs under BYPASS_PURPOSE.CROSS_TENANT_LOOKUP, not in ALLOWED_PURPOSES (SYSTEM_MAINTENANCE)");
    expect(run(TENANT_DOMAIN, chain("SYSTEM_MAINTENANCE_TENANT_LOOKUP")).code).toBe(0);
  });

  it("refuses a forwarder reached through an alias", () => {
    const { code, stderr } = run(TENANT_DOMAIN, tenantDomainSource(`${FORWARDER}
const alias = fwd;
export const c = () => alias(BYPASS_GRANT.SYSTEM_MAINTENANCE_TENANT_LOOKUP);`));
    expect(code).toBe(1);
    expect(stderr).toContain("fwd forwards a bypass grant and is used other than by a direct call");
  });
});

describe("round 2: a model reached in another module is charged to the call's grant", () => {
  // ALLOWED_VIA used to excuse a model when its access sat in a named module;
  // a grant has no such exemption. What another module reaches under the call
  // is the call's reach, and its grant must list it.
  const other = ["src/lib/zz/other.ts", `import type { Prisma } from "@prisma/client";\nexport const wipe = (tx: Prisma.TransactionClient) => tx.vaultKey.deleteMany({});`];
  const caller = (grant) => [OUTBOX, `${HEAD_RLS}import { wipe } from "@/lib/zz/other";
export const f = () => withBypassRls(prisma, async (tx) => {
  await tx.passwordEntry.count(); await tx.attachment.count(); await wipe(tx);
}, BYPASS_GRANT.${grant});`];

  it("refuses a model another module reaches when the grant does not list it", () => {
    const { code, stderr } = runMulti([other, caller("VAULT_RESET_COUNT")]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.vaultKey  (reached in src/lib/zz/other.ts:2)  not in BYPASS_GRANT.VAULT_RESET_COUNT");
  });

  it("passes the same reach under a grant that lists it", () => {
    // VAULT_RESET_SCOPE_CHECK lists more than this call reaches; keep its
    // other models reached so the stale-model rule has nothing to say.
    const { code, stdout } = runMulti([other, [OUTBOX, `${HEAD_RLS}import { wipe } from "@/lib/zz/other";
export const f = () => withBypassRls(prisma, async (tx) => {
  await tx.passwordEntry.count(); await tx.attachment.count(); await tx.emergencyAccessGrant.count();
  await tx.folder.count(); await tx.passwordShare.count(); await tx.tag.count(); await wipe(tx);
}, BYPASS_GRANT.VAULT_RESET_SCOPE_CHECK);`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });
});

// ─── Round 3: lexical floor, callability under strict, typed clients only ──

describe("round 3: everything written inside a reached function counts", () => {
  it.each([
    ["an object member handed to a library", "new ReadableStream({ start: () => { void tx.tenantMember.deleteMany({}); } });"],
    ["an array element", "await Promise.all([async () => tx.tenantMember.count()].map((f) => f()));"],
    ["a class static block", "class X { static { void tx.tenantMember.deleteMany({}); } } void X;"],
    ["a class static field", "class Y { static p = tx.tenantMember.deleteMany({}); } void Y;"],
  ])("charges a model inside %s", (_label, body) => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); ${body} }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });
});

describe("round 3: a client is recognised by type only", () => {
  it.each([
    ["an indexed member", `return db["auditOutbox"].count();`],
    ["$ API and a destructured delegate", `const { auditOutbox } = db; await auditOutbox.count(); return db.$queryRawUnsafe("select 1");`],
    ["a $-named method of an own object", `const h: any = { $run: () => 1 }; return h.$run();`],
  ])("fails closed on a call through an any-typed value: %s", (_label, body) => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const f = () => withBypassRls(prisma, async (tx) => { const db: any = tx; ${body} }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(1);
    expect(stderr).toContain("handed to a callee this gate cannot follow");
  });

  it("charges a delegate destructured off an own type that holds one", () => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}import type { PrismaClient } from "@prisma/client";
type Db = { tenantMember: PrismaClient["tenantMember"] };
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); const { tenantMember } = tx as unknown as Db; return tenantMember.findMany(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("does not charge an own type's member that is not a delegate", () => {
    const { code, stdout } = run(OUTBOX, `${HEAD_RLS}
type Meta = { tenantMember: { id: string } };
export const f = (m: Meta) => withBypassRls(prisma, async (tx) => { void m.tenantMember.id; return tx.auditOutbox.count(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });
});

describe("round 3: values a library hands back, under strict", () => {
  it.each([
    ["Map.get with optional call", "registry.get('a')?.();"],
    ["Map.get narrowed then called", "const h = registry.get('a'); if (h) h();"],
  ])("refuses an own function read back through %s", (_label, body) => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/reg.ts", `import { prisma } from "@/lib/prisma";\nexport const registry = new Map<string, VoidFunction>([["a", () => { void prisma.session.count(); }]]);`],
      [OUTBOX, `${HEAD_RLS}import { registry } from "@/lib/zz/reg";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); ${body} }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("function returned by a library call");
  });

  it("refuses a function returned by Reflect.get and invoked", () => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}
const o = { f: () => 1 };
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return Reflect.get(o, "f")(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(1);
    expect(stderr).toContain("function returned by a library call");
  });
});

describe("round 3: more of what runs is followed", () => {
  it("refuses a function value a library returns as any and the code invokes", () => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}
export const f = (raw: string) => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return JSON.parse(raw)(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(1);
    expect(stderr).toContain("function returned by a library call");
  });

  it("refuses what an own invoker passes when it cannot be named", () => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/run2.ts", `import { prisma } from "@/lib/prisma";
const registry = new Map<string, () => Promise<number>>([["a", () => prisma.session.count()]]);
export function run<T>(c: (op: () => Promise<number>) => T) { return c(registry.get("a")!); }`],
      [OUTBOX, `${HEAD_RLS}import { run } from "@/lib/zz/run2";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return run((op) => op()); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("function returned by a library call");
  });

  it("charges a class field's function on an instance built outside the callback", () => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/svc3.ts", `import { prisma } from "@/lib/prisma";
export class S { run = () => prisma.session.count(); }
export const s = new S();`],
      [OUTBOX, `${HEAD_RLS}import { s } from "@/lib/zz/svc3";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return s.run(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.session");
  });

  it("follows what an own invoker passes to an inline callback", () => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/run.ts", `import { prisma } from "@/lib/prisma";
const readSession = () => prisma.session.count();
export function run<T>(c: (op: () => Promise<number>) => T) { return c(readSession); }`],
      [OUTBOX, `${HEAD_RLS}import { run } from "@/lib/zz/run";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return run((op) => op()); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.session");
  });

  it("follows a module-level bound function into its target", () => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/b.ts", `import { prisma } from "@/lib/prisma";
function readSession() { return prisma.session.count(); }
export const bound = readSession.bind(null);`],
      [OUTBOX, `${HEAD_RLS}import { bound } from "@/lib/zz/b";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return bound(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.session");
  });

  it.each([
    ["a literal key", `[1].map(TBL["a"])`],
    ["a computed key", `[1].map(TBL[k])`],
  ])("follows a function value read off a table by %s", (_label, expr) => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/tbl2.ts", `import { prisma } from "@/lib/prisma";\nexport const TBL = { a: () => prisma.session.count() };`],
      [OUTBOX, `${HEAD_RLS}import { TBL } from "@/lib/zz/tbl2";
export const f = (k: keyof typeof TBL) => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return ${expr}; }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.session");
  });

  it("charges a model a class field holding a function reaches", () => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/svc2.ts", `import { prisma } from "@/lib/prisma";\nexport class S { run = () => prisma.session.count(); }`],
      [OUTBOX, `${HEAD_RLS}import { S } from "@/lib/zz/svc2";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return new S().run(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.session");
  });

  it("re-queues a function reached by a call when it is later handed to a library", () => {
    const shape = (fn) => [
      ["src/lib/zz/rs.ts", `import { prisma } from "@/lib/prisma";\nexport const readSession = async () => prisma.session.count();\nexport const readOutbox = async () => prisma.auditOutbox.count();`],
      ["src/lib/zz/h.ts", `import { ${fn} } from "./rs";
export const list = [${fn}];
export function h(cb: () => unknown) { return cb(); }
export async function g() { list.forEach(h); }`],
      [OUTBOX, `${HEAD_RLS}import { h, g } from "@/lib/zz/h";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); h(() => 0); await g(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ];
    // `h` is first reached by a direct call, then handed to forEach by value:
    // the second reach must re-examine it, and what forEach passes cannot be
    // named — so the run fails closed rather than passing on the first visit.
    const denied = runMulti(shape("readSession"));
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("function referenced other than by a direct call");
  });

  it("follows a wrapper's own callback parameter run inside its bypass callback", () => {
    const shape = (model) => run(OUTBOX, `${HEAD_RLS}import type { Prisma } from "@prisma/client";
async function inBypass<T>(cb: (tx: Prisma.TransactionClient) => Promise<T>) { return withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return cb(tx); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX); }
export const f = () => inBypass(async (tx) => tx.${model}.count());`);
    const denied = shape("tenantMember");
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("prisma.tenantMember");
    expect(shape("auditOutbox").code).toBe(0);
  });

  it("refuses a wrapper that hands withBypassRls its own callback parameter", () => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}import type { Prisma } from "@prisma/client";
async function inBypass<T>(cb: (tx: Prisma.TransactionClient) => Promise<T>) { return withBypassRls(prisma, cb, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX); }
export const f = () => inBypass(async (tx) => tx.auditOutbox.count());`);
    expect(code).toBe(1);
    expect(stderr).toContain("with(Bypass|Tenant)Rls callback could not be resolved to a function in the");
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:3  withBypassRls");
  });

  it("passes a function made by an own factory invoked through .call", () => {
    // `make.call(null)` returns what `make` returns. Read as a library call it
    // would be an unnameable function and fail the run.
    const { code, stdout } = run(OUTBOX, `${HEAD_RLS}
function make() { return async () => prisma.auditOutbox.count(); }
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); const g = make.call(null); return g(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("charges an own function a library call holds when the result is typed Function", () => {
    // \`Function\` has no call signatures, so the result is not judged as a
    // returned function; the own argument it was built from is what runs.
    const { code, stderr } = runMulti([
      ["types/lazy.d.ts", `declare module "lazy" {
  export function lazy(f: () => Promise<number>): Function;
}`],
      ["src/lib/zz/lazy-use.ts", `import { prisma } from "@/lib/prisma";
import { lazy } from "lazy";
export const g = lazy(() => prisma.session.count());`],
      [OUTBOX, `${HEAD_RLS}import { g } from "@/lib/zz/lazy-use";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return g(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.session");
  });

  it("refuses a client handed to library code", () => {
    const { code, stderr } = runMulti([
      ["types/paginator.d.ts", `declare module "paginator" {
  export function paginate(db: import("@prisma/client").Prisma.TransactionClient, model: string): Promise<unknown>;
}`],
      [OUTBOX, `${HEAD_RLS}import { paginate } from "paginator";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return paginate(tx, "session"); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("client handed to library code");
  });
});

describe("round 3: writes to an object's members, however made", () => {
  const OPS = (arm) => ["src/lib/zz/ops.ts", `import type { Prisma } from "@prisma/client";
export const ops = { run: async (t: Prisma.TransactionClient): Promise<unknown> => t.auditOutbox.count() };
${arm}`];
  const USE = [OUTBOX, `${HEAD_RLS}import { ops } from "@/lib/zz/ops";
export const f = () => withBypassRls(prisma, async (tx) => ops.run(tx), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`];
  it.each([
    ["Object.assign", `export function arm() { Object.assign(ops, { run: async (t: Prisma.TransactionClient) => t.user.deleteMany({}) }); }`, "src/lib/zz/ops.ts:3  G2: object mutator"],
    ["Object.assign on an alias", `export function arm() { const alias = ops; Object.assign(alias, {}); }`, "src/lib/zz/ops.ts:3  G2: object mutator"],
    ["Object.assign on a parameter it is handed to", `function patch(o: typeof ops) { Object.assign(o, {}); }\nexport function arm() { patch(ops); }`, "src/lib/zz/ops.ts:3  G2: object mutator"],
    ["a computed key", `export function arm(k: string) { ops[k as "run"] = async (t: Prisma.TransactionClient) => t.user.deleteMany({}); }`, "src/lib/zz/ops.ts:3  G1: write of a function through a key no declaration names"],
  ])("refuses a member written through %s", (_label, arm, reason) => {
    const { code, stderr } = runMulti([OPS(arm), USE]);
    expect(code).toBe(1);
    expect(stderr).toContain(reason);
  });

  it("refuses a member written through a string key", () => {
    const { code, stderr } = runMulti([OPS(`export function arm() { ops["run"] = async (t: Prisma.TransactionClient) => t.user.deleteMany({}); }`), USE]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/zz/ops.ts:3  G1: write to member run, which may hold a function");
  });

  it("passes an object whose members are only read and enumerated", () => {
    const { code, stdout } = runMulti([OPS(`export const names = Object.keys(ops);`), USE]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });
});

describe("round 3: argument positions refuse a spread", () => {
  it("refuses a spread before the callback position", () => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}
const args = [prisma, async () => null, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX] as const;
export const f = () => withBypassRls(...args);`);
    expect(code).toBe(1);
    expect(stderr).toContain("with(Bypass|Tenant)Rls callback could not be resolved to a function in the");
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:4  withBypassRls");
  });

  it("does not read the grant off a position a spread has shifted", () => {
    // The spread fills positions 0 and 1, so the helper's grant is the first
    // listed member, not the one at index 3.
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}
const head = [prisma, async (tx: TX) => tx.auditOutbox.count()] as const;
export const f = () => withBypassRls(...head, BYPASS_GRANT.OUTBOX_DEPTH_READ, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:4  the grant is not a BYPASS_GRANT.* member: a spread argument");
  });

  it("refuses a spread where a forwarder takes its grant", () => {
    const { code, stderr } = run(USER_LOOKUP, `
import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT, type BypassGrant } from "@/lib/tenant-rls-grants";
export async function fetchUsers(ids: string[], grant: BypassGrant) {
  return withBypassRls(prisma, (tx) => tx.user.findMany({ where: { id: { in: ids } } }), grant);
}
export const caller = () => fetchUsers(...([[], BYPASS_GRANT.AUDIT_USER_DISPLAY_LOOKUP] as const));`);
    expect(code).toBe(1);
    expect(stderr).toContain("spread argument where fetchUsers takes its grant");
  });
});

describe("round 3: helper positions are read off the declarations", () => {
  const SIGNATURE =
    "  fn: (tx: Prisma.TransactionClient) => Promise<T>,\n  // The purpose and the tables this bypass may reach (src/lib/tenant-rls-grants.ts).\n  grant: BypassGrant,";
  const withSignature = (replacement) => {
    expect(REAL_TENANT_RLS.split(SIGNATURE).length).toBe(2);
    return REAL_TENANT_RLS.replace(SIGNATURE, replacement);
  };
  const USE_SITE = [OUTBOX, `${HEAD_RLS}export const f = () => withBypassRls(prisma, async (tx) => tx.auditOutbox.count(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`];

  it("refuses to run when withBypassRls declares no callback parameter", () => {
    const { code, stderr } = runMulti([
      ["src/lib/tenant-rls.ts", withSignature("  fn: unknown,\n  grant: BypassGrant,")],
      USE_SITE,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("PROGRAM_BUILD_FAILED: withBypassRls declares no callback parameter");
  });

  it("refuses to run when withBypassRls declares no BypassGrant parameter", () => {
    const { code, stderr } = runMulti([
      ["src/lib/tenant-rls.ts", withSignature("  fn: (tx: Prisma.TransactionClient) => Promise<T>,\n  grant: string,")],
      USE_SITE,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("PROGRAM_BUILD_FAILED: withBypassRls declares no BypassGrant parameter");
  });
});

describe("a helper reference the gate cannot follow as a direct call is refused (audit-tenant-adjudicator round 13)", () => {
  // Every one of these escaped Check 1: a file on no allowlist passed with "OK".
  // Only a direct call reached helperCallsIn; the gate matched the callee's
  // spelling. The rule is now the other way round: a helper referenced anywhere
  // but a direct callee or a type position is reported, whatever its spelling.
  const IMPORT = `import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";\nimport * as rls from "@/lib/tenant-rls";\n`;
  const CB = "async (tx) => tx.user.findMany()";
  const P = "BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP";
  const REFUSAL = "referenced in a form this gate cannot follow as a direct call";

  it.each([
    ["a namespace element access", `rls["withBypassRls"](prisma, ${CB}, ${P})`],
    ["a non-null callee", `withBypassRls!(prisma, ${CB}, ${P})`],
    ["a parenthesized callee", `(withBypassRls)(prisma, ${CB}, ${P})`],
    ["an `as` callee", `(withBypassRls as typeof withBypassRls)(prisma, ${CB}, ${P})`],
    ["a `satisfies` callee", `(withBypassRls satisfies unknown as typeof withBypassRls)(prisma, ${CB}, ${P})`],
    ["an angle-bracket callee", `(<typeof withBypassRls>withBypassRls)(prisma, ${CB}, ${P})`],
    ["a comma callee", `(0, withBypassRls)(prisma, ${CB}, ${P})`],
    [".call", `withBypassRls.call(null, prisma, ${CB}, ${P})`],
    [".apply", `withBypassRls.apply(null, [prisma, ${CB}, ${P}])`],
    [".bind", `withBypassRls.bind(null)(prisma, ${CB}, ${P})`],
    ["a local alias", `(() => { const wb = withBypassRls; return wb(prisma, ${CB}, ${P}); })()`],
    ["a destructured namespace member", `(() => { const { withBypassRls: wb } = rls; return wb(prisma, ${CB}, ${P}); })()`],
    ["the helper passed to another function", `run(withBypassRls, prisma, ${CB})`],
    ["the helper stored in an object", `({ open: withBypassRls }).open(prisma, ${CB}, ${P})`],
    ["a conditional callee", `(flag ? withBypassRls : other)(prisma, ${CB}, ${P})`],
    ["the namespace object itself", `(() => { const r = rls; return r.withBypassRls(prisma, ${CB}, ${P}); })()`],
  ])("refuses %s in a file on no allowlist", (_label, expr) => {
    const { code, stderr } = run("src/lib/probe.ts", `${IMPORT}export const f = () => ${expr};\n`);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(REFUSAL);
    expect(stderr).toContain("src/lib/probe.ts:");
  });

  it("refuses an indirect reference in an allowlisted file too: its callback's model access is not scanned", () => {
    const { code, stderr } = run(
      "src/lib/audit/audit-outbox.ts",
      `${IMPORT}export const f = () => (withBypassRls)(prisma, async (tx) => tx.auditOutbox.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);\n`,
    );
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(REFUSAL);
    expect(stderr).not.toContain("makes no withBypassRls call");
  });

  it("passes the same allowlisted file calling the helper directly (control)", () => {
    const { code, stdout, stderr } = run(
      "src/lib/audit/audit-outbox.ts",
      `${IMPORT}export const f = () => withBypassRls(prisma, async (tx) => tx.auditOutbox.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);\n`,
    );
    expect(code, `${stdout}${stderr}`).toBe(0);
    expect(stderr).not.toContain(REFUSAL);
  });

  it("passes a helper named only in a type position", () => {
    const { code, stdout, stderr } = run(
      "src/lib/probe.ts",
      `import { withBypassRls } from "@/lib/tenant-rls";\nexport type Opener = typeof withBypassRls;\n`,
    );
    expect(code, `${stdout}${stderr}`).toBe(0);
  });

  it("passes a property that only shares the helper's name", () => {
    // Not the imported binding: an object key and a member of some other object.
    const { code, stdout, stderr } = run(
      "src/lib/probe.ts",
      `// with*Rls names below are plain keys\nexport const shape = { withBypassRls: 1 };\nexport const read = (o) => o.withBypassRls;\n`,
    );
    expect(code, `${stdout}${stderr}`).toBe(0);
  });
});

describe("a helper module loaded at run time is followed like an import (audit-tenant-adjudicator round 13)", () => {
  // Two vault routes destructure `await import("@/lib/tenant-rls")`. The gate took
  // helper names from static imports only, so a renamed destructured binding, an
  // element access on the loaded module, or the module used unbound reached no check.
  const CB = "async (tx) => tx.user.findMany()";
  const P = "BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP";
  const REFUSAL = "referenced in a form this gate cannot follow as a direct call";
  const NOT_ALLOWLISTED = "withBypassRls usage found in files not on the allowlist";
  const inAsync = (body) => `export async function f() {\n  ${body}\n}\n`;

  it("counts a destructured dynamic import's direct call: a file on no allowlist is refused", () => {
    const { code, stderr } = run(
      "src/lib/probe.ts",
      inAsync(`const { withBypassRls, BYPASS_PURPOSE } = await import("@/lib/tenant-rls");\n  return withBypassRls(prisma, ${CB}, ${P});`),
    );
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(NOT_ALLOWLISTED);
    expect(stderr).not.toContain(REFUSAL);
  });

  it("counts a call through a renamed destructured binding", () => {
    const { code, stderr } = run(
      "src/lib/probe.ts",
      inAsync(`const { withBypassRls: wb, BYPASS_PURPOSE } = await import("@/lib/tenant-rls");\n  return wb(prisma, ${CB}, ${P});`),
    );
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(NOT_ALLOWLISTED);
    expect(stderr).not.toContain(REFUSAL);
  });

  it("passes a destructured dynamic import called directly in an allowlisted file", () => {
    const { code, stdout, stderr } = run(
      "src/lib/audit/audit-outbox.ts",
      inAsync(`const { withBypassRls } = await import("@/lib/tenant-rls");\n  const { BYPASS_GRANT } = await import("@/lib/tenant-rls-grants");\n  return withBypassRls(prisma, async (tx) => tx.auditOutbox.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`),
    );
    expect(code, `${stdout}${stderr}`).toBe(0);
  });

  it.each([
    ["an element access on the loaded module", `const rls = await import("@/lib/tenant-rls");\n  return rls["withBypassRls"](prisma, ${CB}, ${P});`],
    ["the loaded module used without a binding", `return import("@/lib/tenant-rls").then((m) => m.withBypassRls(prisma, ${CB}, ${P}));`],
    ["a rest element holding the helpers", `const { ...rls } = await import("@/lib/tenant-rls");\n  return rls.withBypassRls(prisma, ${CB}, ${P});`],
    ["a required module's helper through a wrapped callee", `const { withBypassRls: wb } = require("@/lib/tenant-rls");\n  return (wb)(prisma, ${CB}, ${P});`],
  ])("refuses %s", (_label, body) => {
    const { code, stderr } = run("src/lib/probe.ts", inAsync(body));
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(REFUSAL);
  });
});

describe("a name bound to two helpers, an import-equals alias, and the branches round 13 left unpinned (audit-tenant-adjudicator round 14)", () => {
  const CB = "async (tx) => tx.user.findMany()";
  const P = "BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP";
  const REFUSAL = "referenced in a form this gate cannot follow as a direct call";
  const AMBIGUOUS = "bound to more than one RLS helper in this file";
  const NOT_ALLOWLISTED = "withBypassRls usage found in files not on the allowlist";
  const IMPORTS = `import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";\nimport * as rls from "@/lib/tenant-rls";\n`;
  const SHADOW = (name) =>
    `export async function g() {\n  const { withTenantRls: ${name} } = await import("@/lib/tenant-rls");\n  return null;\n}\n`;

  // S-R14-1: the helper-name map was file-wide, so a destructured load binding a
  // different helper under a name already in use reclassified every call spelled with
  // it, and the real bypass call reached none of the checks.
  it.each([
    ["the canonical name", `${IMPORTS}${SHADOW("withBypassRls")}export const f = () => withBypassRls(prisma, ${CB}, ${P});\n`],
    ["a static alias", `import { withBypassRls as run, BYPASS_PURPOSE } from "@/lib/tenant-rls";\n${SHADOW("run")}export const f = () => run(prisma, ${CB}, ${P});\n`],
    [
      "two run-time loads",
      `${SHADOW("open")}export async function f() {\n  const { withBypassRls: open, BYPASS_PURPOSE } = await import("@/lib/tenant-rls");\n  return open(prisma, ${CB}, ${P});\n}\n`,
    ],
  ])("refuses a name bound to two helpers through %s, in a file on no allowlist", (_label, source) => {
    const { code, stderr } = run("src/lib/probe.ts", source);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(AMBIGUOUS);
  });

  it("refuses the same shadow in an allowlisted file, and does not call its entry stale", () => {
    const { code, stderr } = run(
      "src/lib/audit/audit-outbox.ts",
      `${IMPORTS}${SHADOW("withBypassRls")}export const f = () => withBypassRls(prisma, async (tx) => tx.user.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);\n`,
    );
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(AMBIGUOUS);
    expect(stderr).not.toContain("makes no withBypassRls call");
  });

  it("passes a name bound to the same helper twice", () => {
    const { code, stdout, stderr } = run(
      "src/lib/audit/audit-outbox.ts",
      `import { withBypassRls } from "@/lib/tenant-rls"; import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";\nexport async function g() {\n  const { withBypassRls } = await import("@/lib/tenant-rls");\n  return withBypassRls(prisma, async (tx) => tx.auditOutbox.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);\n}\nexport const f = () => withBypassRls(prisma, async (tx) => tx.auditOutbox.count(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);\n`,
    );
    expect(code, `${stdout}${stderr}`).toBe(0);
  });

  // F-R14-1: `import wb = rls.withBypassRls` was skipped as a type position.
  it.each([
    ["an import-equals alias", `${IMPORTS}import wb = rls.withBypassRls;\nexport const f = () => wb(prisma, ${CB}, ${P});\n`],
    ["an exported import-equals alias", `${IMPORTS}export import wb = rls.withBypassRls;\nexport const f = () => wb(prisma, ${CB}, ${P});\n`],
  ])("refuses %s", (_label, source) => {
    const { code, stderr } = run("src/lib/probe.ts", source);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(REFUSAL);
  });

  it("passes a qualified helper name in a type position and an import-equals alias of a non-helper member", () => {
    const { code, stdout, stderr } = run(
      "src/lib/probe.ts",
      `import * as rls from "@/lib/tenant-rls";\nexport type Opener = typeof rls.withBypassRls;\nimport Purpose = rls.BYPASS_PURPOSE;\nexport const p = Purpose;\n`,
    );
    expect(code, `${stdout}${stderr}`).toBe(0);
  });

  // T-R14-1: three branches no round-13 cell reached.
  it.each([
    ["a computed namespace member", `(() => { const k = "withBypassRls"; return rls[k](prisma, ${CB}, ${P}); })()`],
    ["a namespace member read as a value", `(() => { const g = rls.withBypassRls; return g(prisma, ${CB}, ${P}); })()`],
    ["a namespace member's .call", `rls.withBypassRls.call(null, prisma, ${CB}, ${P})`],
  ])("refuses %s", (_label, expr) => {
    const { code, stderr } = run("src/lib/probe.ts", `${IMPORTS}export const f = () => ${expr};\n`);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(REFUSAL);
  });

  it.each([["a relative specifier", "./tenant-rls"], ["a .js specifier", "@/lib/tenant-rls.js"]])(
    "counts a renamed destructured load through %s",
    (_label, specifier) => {
      const { code, stderr } = run(
        "src/lib/probe.ts",
        `export async function f() {\n  const { withBypassRls: wb, BYPASS_PURPOSE } = await import("${specifier}");\n  return wb(prisma, ${CB}, ${P});\n}\n`,
      );
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(NOT_ALLOWLISTED);
      expect(stderr).not.toContain(REFUSAL);
    },
  );

  // T-R14-2: a namespace member that is not a helper is not a reference to one.
  it("passes a non-helper namespace member read as a value in an allowlisted file", () => {
    const { code, stdout, stderr } = run(
      "src/lib/audit/audit-outbox.ts",
      `import * as rls from "@/lib/tenant-rls";\nimport { BYPASS_GRANT } from "@/lib/tenant-rls-grants";\nexport const purposes = rls.BYPASS_PURPOSE;\nexport const f = () => rls.withBypassRls(prisma, async (tx) => tx.auditOutbox.findMany(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);\n`,
    );
    expect(code, `${stdout}${stderr}`).toBe(0);
  });
});

// ─── C3: Program-backed reference cross-check ──────────────────────────────
//
// One deny cell per spelling named in #838 (A-C3-1), each naming which item
// decides it; the allow cells the acceptance criteria name alongside them
// (A-C3-2, A-C3-2b, A-C3-2c); and the two named-failure cells for a Program
// that cannot be built at all (A-C3-4). The real tree's own pass (A-C3-3) and
// the pre-change-gate pass of every deny cell here (A-C3-1's own "run once
// against the pre-change gate" ask, T-F5) are recorded separately, by command
// and output, in the branch's review artifact — not re-asserted as a test
// here, since the pre-change gate is not what CI runs.
describe("C3 Program-backed reference cross-check", () => {
  const CROSS_CHECK = "form this gate does not analyse";
  const STAR_EXPORT = "`export *` re-exports a module that exports a with*Rls helper";
  const DESTRUCTURING_KEY = "destructuring key is not a plain identifier";
  const RULE_A = "literal-named property access or literal-keyed element access";
  const RULE_B = "receiver whose key is not a string-literal";
  const MODULE_LOAD = "module load specifier could not be proven safe";
  // The pre-existing round-13 check (indirectHelperReferencesIn) fires
  // independently of the rule under test whenever a fixture's own text
  // references the helper-carrying namespace in a form IT does not
  // recognise either — confirmed below to be unavoidable for item 5c's
  // destructuring shape and Rule A's `import(...)`-based LOADER (finding E,
  // issue-838 follow-ups review): forcing the rule-under-test's predicate to
  // return no violations still exits 1 on this message alone. Cells that hit
  // it assert it explicitly rather than excluding it, so the confounding is
  // recorded rather than invisible.
  const ROUND13 = "referenced in a form this gate cannot follow as a direct call";

  describe("item 3: reference cross-check (deny)", () => {
    it("flags a named re-export the consumer imports under a local alias", () => {
      const { code, stderr } = runMulti([
        ["src/lib/barrel/reexport.ts", `export { withBypassRls } from "@/lib/tenant-rls";\n`],
        [
          "src/app/consumer.ts",
          `import { withBypassRls as consumerAlias } from "@/lib/barrel/reexport";\nexport async function run() {\n  return consumerAlias(null, async (tx) => tx.user.findMany(), "x");\n}\n`,
        ],
      ]);
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(CROSS_CHECK);
    });

    it("flags a renamed re-export", () => {
      const { code, stderr } = runMulti([
        ["src/lib/barrel/reexport.ts", `export { withBypassRls as wb } from "@/lib/tenant-rls";\n`],
        [
          "src/app/consumer.ts",
          `import { wb } from "@/lib/barrel/reexport";\nexport async function run() {\n  return wb(null, async (tx) => tx.user.findMany(), "x");\n}\n`,
        ],
      ]);
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(CROSS_CHECK);
    });

    it("flags a member read off an `export * as ns` namespace", () => {
      // A READ, not a call: `x.withBypassRls()` is item 6's own "resolves to a
      // real declaration" shape (filterCallsByReceiverDeclaration), which
      // would ALSO recognise this as a genuine helper call once `ns`'s type is
      // resolvable — folding this cell into Check 1 instead of the cross-check
      // this describe block is naming. A bare property read is never a call,
      // so only the reference cross-check has anything to say about it.
      const { code, stderr } = runMulti([
        ["src/lib/barrel/reexport.ts", `export * as ns from "@/lib/tenant-rls";\n`],
        [
          "src/app/consumer.ts",
          `import { ns } from "@/lib/barrel/reexport";\nexport const captured = ns.withBypassRls;\n`,
        ],
      ]);
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(CROSS_CHECK);
    });

    it("flags a literal-keyed element access on a re-exported namespace", () => {
      const { code, stderr } = runMulti([
        ["src/lib/barrel/reexport.ts", `export * as ns from "@/lib/tenant-rls";\n`],
        [
          "src/app/consumer.ts",
          `import { ns } from "@/lib/barrel/reexport";\nexport async function run() {\n  return ns["withBypassRls"](null, async (tx) => tx.user.findMany(), "x");\n}\n`,
        ],
      ]);
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(CROSS_CHECK);
    });
  });

  describe("item 5b: bare `export *` barrel (deny)", () => {
    it("flags a bare `export *` whose target exports a helper", () => {
      const { code, stderr } = runMulti([
        ["src/lib/barrel/star.ts", `export * from "@/lib/tenant-rls";\n`],
      ]);
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(STAR_EXPORT);
    });

    it("also proves item 4: a barrel whose OWN text names no helper is still parsed", () => {
      // outer.ts's text is `export * from "@/lib/barrelB/inner";` — no
      // "with*Rls" spelling and no "tenant-rls" substring, so HELPER_MENTION_RE
      // does not select it. Only inner.ts (which DOES mention "tenant-rls")
      // would be picked up by the old prefilter; outer.ts is reached only
      // because the Program's export-graph walk (exportsAnyHelper, following
      // export * through inner.ts) put it in programOnlyFiles.
      const outerText = `export * from "@/lib/barrelB/inner";\n`;
      expect(outerText).not.toMatch(/with(?:Bypass|Tenant|UserTenant|TeamTenant)Rls|tenant-rls/);
      const { code, stderr } = runMulti([
        ["src/lib/barrelB/inner.ts", `export * from "@/lib/tenant-rls";\n`],
        ["src/lib/barrelA/outer.ts", outerText],
      ]);
      expect(code, stderr).toBe(1);
      expect(stderr).toContain("src/lib/barrelA/outer.ts");
      expect(stderr).toContain(STAR_EXPORT);
    });
  });

  describe("item 5c: quoted / computed destructuring key (deny)", () => {
    // Both cells also trip round-13 (ROUND13): destructuring `rls` at all —
    // regardless of the key shape 5c decides on — is itself "referencing the
    // namespace in a form round-13 does not recognise as a direct call".
    // Confirmed unavoidable (finding E): forcing `destructuringKeyViolationsIn`
    // to return [] still exits 1 on ROUND13 alone, so it is asserted
    // explicitly here rather than excluded.
    it("flags a quoted destructuring key that resolves to a helper", () => {
      const { code, stderr } = run(
        "src/app/consumer.ts",
        `import * as rls from "@/lib/tenant-rls";\nexport function run() {\n  const { ["withBypassRls"]: quoted } = rls;\n  return quoted;\n}\n`,
      );
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(DESTRUCTURING_KEY);
      expect(stderr).toContain(ROUND13);
    });

    it("flags a computed destructuring key that resolves to a helper", () => {
      const { code, stderr } = run(
        "src/app/consumer.ts",
        `import * as rls from "@/lib/tenant-rls";\nexport function run() {\n  const key = "withBypassRls" as const;\n  const { [key]: computed } = rls;\n  return computed;\n}\n`,
      );
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(DESTRUCTURING_KEY);
      expect(stderr).toContain(ROUND13);
    });
  });

  describe("item 5: module loads judged by specifier TYPE (deny)", () => {
    it("refuses a `string`-typed specifier through a `NodeJS.Require` value", () => {
      const { code, stderr } = run(
        "src/app/consumer.ts",
        `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nexport function loadIt(moduleName: string) {\n  return req(moduleName);\n}\n`,
      );
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(MODULE_LOAD);
    });

    it("refuses an `any` callee with a non-literal one-argument call", () => {
      const { code, stderr } = run(
        "src/app/consumer.ts",
        `declare const req: any;\nexport function loadIt(moduleName: string) {\n  return req(moduleName);\n}\n`,
      );
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(MODULE_LOAD);
    });
  });

  describe("item 6, Rule A: a helper-carrying value outside a literal receiver (deny)", () => {
    // Every cell here loads the module through a GENERIC before the await
    // (`Promise<typeof import(...)>`) rather than a recognised namespace
    // import — the shape item 6's own text calls out as where Rule A (not the
    // pre-existing indirect-reference check) is the one deciding.
    //
    // Every cell also trips ROUND13, unavoidably (finding E): the LOADER's own
    // body performs `import("@/lib/tenant-rls")`, which `indirectHelperReferencesIn`
    // flags on its own, independently of whatever `ruleAViolationsIn` decides —
    // confirmed by forcing `ruleAViolationsIn` to return [] and watching the
    // gate still exit 1 on ROUND13 alone. There is no LOADER shape that reaches
    // the generic-before-await case Rule A exists for without an `import(...)`
    // or `require(...)` expression round-13 also sees, so this is asserted
    // explicitly rather than excluded.
    const LOADER = `async function loader(): Promise<typeof import("@/lib/tenant-rls")> {\n  return import("@/lib/tenant-rls");\n}\n`;

    it("flags `ns[n](…)` on a helper-carrying namespace", () => {
      const { code, stderr } = run(
        "src/app/consumer.ts",
        `${LOADER}export async function run(n: string) {\n  const ns = await loader();\n  return ns[n](null, async (tx) => tx.user.findMany(), "x");\n}\n`,
      );
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(RULE_A);
      expect(stderr).toContain(ROUND13);
    });

    it("flags the same namespace spread", () => {
      const { code, stderr } = run(
        "src/app/consumer.ts",
        `${LOADER}export async function run() {\n  const ns = await loader();\n  return { ...ns };\n}\n`,
      );
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(RULE_A);
      expect(stderr).toContain(ROUND13);
    });

    it("flags the same namespace passed as an argument", () => {
      const { code, stderr } = run(
        "src/app/consumer.ts",
        `${LOADER}function sink(x: unknown) { return x; }\nexport async function run() {\n  const ns = await loader();\n  return sink(ns);\n}\n`,
      );
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(RULE_A);
      expect(stderr).toContain(ROUND13);
    });

    it("flags the same namespace read through Reflect.get", () => {
      const { code, stderr } = run(
        "src/app/consumer.ts",
        `${LOADER}export async function run() {\n  const ns = await loader();\n  return Reflect.get(ns, "withBypassRls");\n}\n`,
      );
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(RULE_A);
      expect(stderr).toContain(ROUND13);
    });

    it("flags the same namespace assigned to globalThis", () => {
      const { code, stderr } = run(
        "src/app/consumer.ts",
        `${LOADER}export async function run() {\n  const ns = await loader();\n  globalThis.leaked = ns;\n}\n`,
      );
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(RULE_A);
      expect(stderr).toContain(ROUND13);
    });
  });

  describe("item 6, Rule B: any/unknown receiver, non-literal key (deny)", () => {
    it("flags an any-typed receiver with a non-literal-union key", () => {
      const { code, stderr } = run(
        "src/app/consumer.ts",
        `export function pick(data: any, key: string) {\n  return data[key];\n}\n`,
      );
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(RULE_B);
    });
  });

  // ─── A-C3-2: allow cells ────────────────────────────────────────────────
  describe("allow cells (A-C3-2)", () => {
    it("passes a local unrelated function named withBypassRls that is never called", () => {
      const { code, stdout, stderr } = run(
        "src/app/consumer.ts",
        `function withBypassRls(x: number) { return x + 1; }\nexport const unrelated = true;\n`,
      );
      expect(code, `${stdout}${stderr}`).toBe(0);
    });

    it("passes a re-export of a NON-helper from tenant-context.ts", () => {
      const { code, stdout, stderr } = run(
        "src/app/consumer.ts",
        `export { realignOwningTenantColumn } from "@/lib/tenant-context";\n`,
      );
      expect(code, `${stdout}${stderr}`).toBe(0);
    });

    it("passes a resolvable receiver whose helper-named member is a different declaration", () => {
      const { code, stdout, stderr } = run(
        "src/app/consumer.ts",
        `const x = { withBypassRls: () => 0 };\nexport const r = x.withBypassRls();\n`,
      );
      expect(code, `${stdout}${stderr}`).toBe(0);
    });
  });

  // ─── A-C3-2b: allow cells from the real tree's own shapes ──────────────
  describe("allow cells from the real tree's own shapes (A-C3-2b)", () => {
    it("passes a template specifier whose static head resolves outside the Program source set (messages.ts shape)", () => {
      const { code, stdout, stderr } = runMulti([
        ["data/x/a.json", "{}"],
        [
          // At the real path: a non-literal load is refused anywhere NON_LITERAL_LOAD_ALLOWLIST does not name.
          "src/i18n/messages.ts",
          "export async function load(ns: string) {\n  const mod = await import(`../../data/${ns}/a.json`);\n  return mod;\n}\n",
        ],
      ]);
      expect(code, `${stdout}${stderr}`).toBe(0);
    });

    it("passes an identifier specifier with a literal type (crypto-client.ts shape)", () => {
      // Not file-keyed: the specifier's literal type names the module.
      const { code, stdout, stderr } = run(
        "src/app/consumer.ts",
        `export async function load() {\n  const moduleName = "hash-wasm";\n  const mod = await import(/* webpackIgnore: true */ moduleName);\n  return mod;\n}\n`,
      );
      expect(code, `${stdout}${stderr}`).toBe(0);
    });

    it("passes an any callee with a literal argument (key-provider shape)", () => {
      const { code, stdout, stderr } = run(
        "src/app/consumer.ts",
        `declare const req: any;\nexport function loadSdk() {\n  return req("@aws-sdk/client-s3");\n}\n`,
      );
      expect(code, `${stdout}${stderr}`).toBe(0);
    });

    it("passes an any-typed receiver with a literal-union key (auth-gate.ts shape)", () => {
      const { code, stdout, stderr } = run(
        "src/app/consumer.ts",
        `type Field = "a" | "b" | "c";\nexport function pick(data: any, field: Field) {\n  return data?.[field];\n}\n`,
      );
      expect(code, `${stdout}${stderr}`).toBe(0);
    });
  });

  // ─── A-C3-2c: allow cells for the refusals 5b and 5c bring ─────────────
  describe("allow cells for 5b and 5c (A-C3-2c)", () => {
    it("passes `export *` of a module that exports no helper", () => {
      const { code, stdout, stderr } = runMulti([
        ["src/lib/other/thing.ts", `export function notAHelper() { return 1; }\n`],
        ["src/lib/barrel/star.ts", `export * from "@/lib/other/thing";\n`],
      ]);
      expect(code, `${stdout}${stderr}`).toBe(0);
    });

    it("passes a quoted and a computed destructuring key that resolve to a non-helper property", () => {
      const { code, stdout, stderr } = runMulti([
        ["src/lib/barrel/star.ts", `export type TenantRlsNs = typeof import("@/lib/tenant-rls");\n`],
        [
          "src/app/consumer.ts",
          `import type { TenantRlsNs } from "@/lib/barrel/star";\nexport function runQuoted(ns: TenantRlsNs) {\n  const { ["advisoryXactLock"]: notHelper } = ns;\n  return notHelper;\n}\nexport function runComputed(ns: TenantRlsNs) {\n  const key = "advisoryXactLock" as const;\n  const { [key]: notHelper } = ns;\n  return notHelper;\n}\n`,
        ],
      ]);
      expect(code, `${stdout}${stderr}`).toBe(0);
    });
  });

  // ─── A-C3-4: a fixture missing what item 1/2 requires fails NAMED ───────
  describe("Program build failures are named, not silent (A-C3-4)", () => {
    it("fails named when the fixture has no tsconfig.json", () => {
      mkdirSync(join(dir, "src/lib"), { recursive: true });
      writeFileSync(join(dir, "src/lib/tenant-rls.ts"), REAL_TENANT_RLS, "utf8");
      writeFileSync(join(dir, "src/lib/tenant-context.ts"), REAL_TENANT_CONTEXT, "utf8");
      const { code, stderr } = runBare();
      expect(code).toBe(1);
      expect(stderr).toContain("PROGRAM_BUILD_FAILED");
      expect(stderr).toContain("no tsconfig.json found");
    });

    it("fails named when tenant-rls.ts is missing a helper declaration", () => {
      mkdirSync(join(dir, "src/lib"), { recursive: true });
      mkdirSync(join(dir, "types"), { recursive: true });
      writeFileSync(join(dir, "tsconfig.json"), FIXTURE_TSCONFIG, "utf8");
      writeFileSync(join(dir, "types/prisma-client-stub.d.ts"), PRISMA_CLIENT_STUB, "utf8");
      writeFileSync(join(dir, "src/lib/tenant-context.ts"), REAL_TENANT_CONTEXT, "utf8");
      // A tenant-rls.ts that defines BYPASS_PURPOSE but not withBypassRls itself.
      writeFileSync(
        join(dir, "src/lib/tenant-rls.ts"),
        `export const BYPASS_PURPOSE = { AUDIT: "audit" } as const;\n`,
        "utf8",
      );
      const { code, stderr } = runBare();
      expect(code).toBe(1);
      expect(stderr).toContain("PROGRAM_BUILD_FAILED");
      expect(stderr).toContain("helper declaration not found: withBypassRls");
    });
  });
});


// ─── Round 4: charged where the query runs; refused where it cannot be seen ──

describe("round 4: a model is charged where its query runs, by the delegate's type", () => {
  it("charges a delegate whose read was erased to any, once it is typed again", () => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}import type { Prisma } from "@prisma/client";
export const f = () => withBypassRls(prisma, async (tx) => {
  await tx.auditOutbox.count();
  const users: Prisma.UserDelegate = (tx as any).user;
  return users.deleteMany({});
}, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:6  prisma.user");
  });

  it("charges a delegate another module hands back to the module that queries it", () => {
    const REALIGN = "src/lib/tenant/tenant-realignment.ts";
    const { code, stderr } = runMulti([
      ["src/lib/zz/handout.ts", `export function strandedDelegate(db: TX) { return db.session; }`],
      [REALIGN, `${HEAD_RLS}import { strandedDelegate } from "@/lib/zz/handout";
export const f = () => withBypassRls(prisma, async (tx) => {
  await tx.tenantMember.count();
  await strandedDelegate(tx).deleteMany({});
}, BYPASS_GRANT.TENANT_MEMBERSHIP_LOOKUP);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain(`${REALIGN}:5  prisma.session`);
  });

  it("charges a delegate held in an own object", () => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/repo.ts", `import { prisma } from "@/lib/prisma";\nexport const repo = { user: prisma.user };`],
      [OUTBOX, `${HEAD_RLS}import { repo } from "@/lib/zz/repo";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return repo.user.count(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:3  prisma.user");
  });

  it("does not charge a member named like a model whose type is not a delegate", () => {
    const { code, stdout } = runMulti([
      ["src/lib/zz/repo.ts", `export const repo = { user: "x" };`],
      [OUTBOX, `${HEAD_RLS}import { repo } from "@/lib/zz/repo";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return repo.user.length; }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });
});

describe("round 4: a client handed to library code, however it is carried", () => {
  const ORM = ["types/orm.d.ts", `declare module "orm" {
  export function runWith(o: { db: unknown }): Promise<void>;
  export function runLazy(f: () => unknown): Promise<void>;
  export function runMany(cs: unknown[]): Promise<void>;
  export function runDirect(c: unknown): Promise<void>;
}`];
  it.each([
    ["inside an object", "await runWith({ db: tx });"],
    ["returned by a closure", "await runLazy(() => tx);"],
    ["in an array", "await runMany([tx]);"],
    ["as an optional value", "const maybe: typeof tx | undefined = tx; await runDirect(maybe);"],
    ["as a delegate", "await runDirect(tx.auditOutbox);"],
    ["through a callee that may be own or library", "const own = async (_c: unknown) => {}; const exec = Date.now() > 0 ? own : runDirect; await exec(tx);"],
  ])("refuses a client handed %s", (_label, body) => {
    const { code, stderr } = runMulti([ORM, [OUTBOX, `${HEAD_RLS}import { runWith, runLazy, runMany, runDirect } from "orm";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); ${body} }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("client handed to library code");
  });

  it("passes a library call that is handed no client", () => {
    const { code, stdout } = runMulti([ORM, [OUTBOX, `${HEAD_RLS}import { runWith } from "orm";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); await runWith({ db: 1 }); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`]]);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });
});

describe("round 4: a grant and a callback are read as written", () => {
  it("refuses a forwarder that rewrites its grant parameter", () => {
    const { code, stderr } = run(TENANT_DOMAIN, tenantDomainSource(`
export async function fwd(grant: BypassGrant) {
  grant = BYPASS_GRANT.TENANT_POLICY_LOOKUP;
  return withBypassRls(prisma, async (tx) => tx.tenant.findMany({}), grant);
}
export const c = () => fwd(BYPASS_GRANT.SYSTEM_MAINTENANCE_TENANT_LOOKUP);`));
    expect(code).toBe(1);
    expect(stderr).toContain("grant parameter grant is reassigned before it reaches withBypassRls");
  });

  it("refuses a file on both INDIRECT_CALLBACK_ALLOWLIST and ALLOWED_USAGE", () => {
    // Check 3 reads only callbacks C2 located, so a file excused from C2 would
    // have its bypass callbacks judged by nothing. Run against a copy of the
    // gate with OUTBOX added to the indirect list.
    const gateDir = mkdtempSync(join(tmpdir(), "bypass-gate-"));
    try {
      cpSync(dirname(CHECKER), join(gateDir, "checks"), { recursive: true });
      symlinkSync(join(REPO_ROOT, "node_modules"), join(gateDir, "node_modules"));
      const gate = join(gateDir, "checks/check-bypass-rls.mjs");
      const source = readFileSync(gate, "utf8");
      const patched = source.replace("const INDIRECT_CALLBACK_ALLOWLIST = new Set([", `const INDIRECT_CALLBACK_ALLOWLIST = new Set([\n  "${OUTBOX}",`);
      expect(patched).not.toBe(source);
      writeFileSync(gate, patched, "utf8");
      const { code, stderr } = runMulti([[OUTBOX, `${HEAD_RLS}
export const f = () => withBypassRls(prisma, async (tx) => tx.auditOutbox.count(), BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`]], gate);
      expect(code).toBe(1);
      expect(stderr).toContain("A file is on both INDIRECT_CALLBACK_ALLOWLIST and ALLOWED_USAGE");
      expect(stderr).toContain(`  ${OUTBOX}`);
    } finally {
      rmSync(gateDir, { recursive: true, force: true });
    }
  });
});

describe("round 4: a value whose type is callable only once undefined is removed", () => {
  it("reaches an optional function handed on by name", () => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/h.ts", `import { prisma } from "@/lib/prisma";
export const h: (() => Promise<number>) | undefined = Date.now() > 0 ? async () => prisma.session.count() : undefined;`],
      [OUTBOX, `${HEAD_RLS}import { h } from "@/lib/zz/h";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); [1].forEach(h!); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.session  (reached in src/lib/zz/h.ts:2)");
  });

  it("reaches an optional function handed on through an element access", () => {
    const { code, stderr } = runMulti([
      ["src/lib/zz/t.ts", `import { prisma } from "@/lib/prisma";
export const TBL: { a: (() => Promise<number>) | undefined } = { a: async () => prisma.session.count() };`],
      [OUTBOX, `${HEAD_RLS}import { TBL } from "@/lib/zz/t";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); [1].forEach(TBL["a"]!); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.session  (reached in src/lib/zz/t.ts:2)");
  });
});

describe("round 4: the scan set and a delegate union", () => {
  it("scans a module outside src/ and scripts/ that production imports", () => {
    const { code, stderr } = runMulti([
      ["root-job.ts", `import { prisma } from "./src/lib/prisma";
import { withBypassRls } from "./src/lib/tenant-rls"; import { BYPASS_GRANT } from "./src/lib/tenant-rls-grants";
export const job = () => withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP);`],
      ["src/app/uses-root.ts", `import { job } from "../../root-job";\nexport const run = () => job();`],
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("withBypassRls usage found in files not on the allowlist");
    expect(stderr).toContain("root-job.ts");
  });

  it("charges each model a union of delegates may be", () => {
    // The reads are erased to any, so only the query, by its union type, names the models.
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}import type { Prisma } from "@prisma/client";
export const f = () => withBypassRls(prisma, async (tx) => {
  await tx.auditOutbox.count();
  const d = (Date.now() > 0 ? (tx as any).user : (tx as any).session) as Prisma.UserDelegate | Prisma.SessionDelegate;
  return d.count();
}, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:6  prisma.user");
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:6  prisma.session");
    // Each member is named, so the query is not refused as unnameable.
    expect(stderr).not.toContain("indexed by a name this gate cannot resolve");
  });

  it("charges a delegate wrapped in another type by the interface that declares its method", () => {
    // Read outside the bypass, so the query is the only place the model is named.
    const { code, stderr } = runMulti([["src/lib/zz/wrapped.ts", `import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
export const users = prisma.user as Prisma.UserDelegate & { tag?: 1 };`],
      [OUTBOX, `${HEAD_RLS}import { users } from "@/lib/zz/wrapped";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return users.count(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:3  prisma.user");
  });

  it("refuses a query on a delegate-shaped value whose model nothing names", () => {
    const { code, stderr } = runMulti([["types/orm.d.ts", `declare module "orm" {
  export interface GenericDelegate { findMany(...a: unknown[]): Promise<unknown[]>; count(...a: unknown[]): Promise<number> }
  export function table(name: string): GenericDelegate;
}`], [OUTBOX, `${HEAD_RLS}import { table } from "orm";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); const d = table("x"); return d.count(); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("indexed by a name this gate cannot resolve");
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:3  d.count  (in src/lib/audit/audit-outbox.ts:3)");
  });
});

describe("round 5: every own file is production unless declared (R5-S5)", () => {
  it("holds an entry file at the root that nothing imports to the allowlist", () => {
    const { code, stderr } = runMulti([["proxy.ts", `import { prisma } from "./src/lib/prisma";
import { withBypassRls } from "./src/lib/tenant-rls"; import { BYPASS_GRANT } from "./src/lib/tenant-rls-grants";
export const handle = () => withBypassRls(prisma, async (tx) => tx.passwordEntry.findMany({}), BYPASS_GRANT.VAULT_ENTRY_CROSS_TENANT_READ);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("withBypassRls usage found in files not on the allowlist");
    expect(stderr).toMatch(/^\s+proxy\.ts$/m);
  });
});

describe("round 5 testing review: one fixture per clause that had none", () => {
  const ORM = ["types/orm.d.ts", `declare module "orm" { export function runDirect(c: unknown): Promise<void>; }`];
  it.each([
    ["a conditional that may be the client", "const maybe = Date.now() > 0 ? tx : undefined; await runDirect(maybe);"],
    ["a parameter typed client-or-undefined", "const g = async (c: typeof tx | undefined) => { await runDirect(c); }; await g(tx);"],
  ])("refuses a client handed to library code as %s (R5-T1)", (_label, body) => {
    const { code, stderr } = runMulti([ORM, [OUTBOX, `${HEAD_RLS}import { runDirect } from "orm";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); ${body} }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("client handed to library code (runDirect)");
  });

  it("charges a query run through a string key on a delegate (R5-T4)", () => {
    const { code, stderr } = run(OUTBOX, `${HEAD_RLS}import type { Prisma } from "@prisma/client";
export const f = () => withBypassRls(prisma, async (tx) => {
  await tx.auditOutbox.count();
  const users = (tx as any).user as Prisma.UserDelegate;
  return users["deleteMany"]({});
}, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:6  prisma.user");
  });

  it("refuses a second-level forwarder that rewrites its grant (R5-T4)", () => {
    const { code, stderr } = run(TENANT_DOMAIN, tenantDomainSource(`
export async function fwd(grant: BypassGrant) {
  return withBypassRls(prisma, async (tx) => tx.tenant.findMany({}), grant);
}
export async function outer(q: BypassGrant) { q = BYPASS_GRANT.TENANT_POLICY_LOOKUP; return fwd(q); }
export const c = () => outer(BYPASS_GRANT.SYSTEM_MAINTENANCE_TENANT_LOOKUP);`));
    expect(code).toBe(1);
    expect(stderr).toContain("grant parameter q is reassigned before it reaches fwd");
  });
});

describe("round 5: a delegate is charged where a member leaves it, and is never erased (R5-F7 / R5-S4)", () => {
  const REALIGN = "src/lib/tenant/tenant-realignment.ts";
  const HANDOUT = ["src/lib/zz/handout.ts", `export function strandedDelegate(db: TX) { return db.session; }`];
  it.each([
    ["destructured", "const { deleteMany } = strandedDelegate(tx); await deleteMany({});"],
    ["bound", "const del = strandedDelegate(tx).deleteMany.bind(strandedDelegate(tx)); await del({});"],
    ["read through a string key", "await strandedDelegate(tx)[\"deleteMany\"]({});"],
  ])("charges another module's delegate method %s to the module that uses it", (_label, body) => {
    const { code, stderr } = runMulti([HANDOUT, [REALIGN, `${HEAD_RLS}import { strandedDelegate } from "@/lib/zz/handout";
export const f = () => withBypassRls(prisma, async (tx) => {
  await tx.tenantMember.count();
  ${body}
}, BYPASS_GRANT.TENANT_MEMBERSHIP_LOOKUP);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain(`${REALIGN}:5  prisma.session`);
  });

  it("charges a delegate narrowed to a Pick of itself by the interface that declares the method", () => {
    const { code, stderr } = runMulti([["src/lib/zz/entries.ts", `import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
export const entries: Pick<Prisma.PasswordEntryDelegate, "deleteMany"> = prisma.passwordEntry;`],
      [OUTBOX, `${HEAD_RLS}import { entries } from "@/lib/zz/entries";
export const f = () => withBypassRls(prisma, async (tx) => { await tx.auditOutbox.count(); return entries.deleteMany({}); }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:3  prisma.passwordEntry");
  });

  it.each([
    ["an own interface", "interface Purger { deleteMany(...a: unknown[]): Promise<unknown> }\nexport const entries: Purger = prisma.passwordEntry;", "a client or delegate erased to Purger"],
    ["an own parameter typed unknown", "export async function run(db: unknown) { return db; }\nexport const go = () => run(prisma);", "a client or delegate erased to unknown"],
    ["a cast", "export const anyTx = prisma as unknown;", "a client or delegate erased to unknown"],
    // R6-S2: `$transaction` hands its callback a client; only the raw-query methods are raw SQL's.
    ["an own type holding $transaction", "type Runner = { $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };\nexport const runner: Runner = prisma;", "a client or delegate erased to Runner"],
  ])("refuses a client erased to %s", (_label, body, message) => {
    const { code, stderr } = run("src/lib/zz/erase.ts", `import { prisma } from "@/lib/prisma";\n${body}`);
    expect(code).toBe(1);
    expect(stderr).toContain(message);
  });

  it("passes a client narrowed to a Pick of itself, and to its raw-query API", () => {
    const { code, stdout } = run("src/lib/zz/erase.ts", `import { prisma } from "@/lib/prisma";
import type { PrismaClient } from "@prisma/client";
type RawExecutor = { $executeRaw: PrismaClient["$executeRaw"] };
export async function lookup(db: Pick<typeof prisma, "user">) { return db.user.count(); }
export async function raw(db: RawExecutor) { return db; }
export const go = () => [lookup(prisma), raw(prisma)];`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });
});

// ─── Writer, pool and function rules (C4) ─────────────────────────────────────
//
// The database adjudicates a bypass against `app.bypass_tables`, so these keep
// the settings behind the registry: only setBypassGucs writes them, only the
// pool factory builds a pool (whose listener logs the reports), and no routine
// is created outside the migrations. Each spelling below is one a regex over
// `set_config(` or a statement-leading `SET` would miss or misread.

const WRITER = "src/workers/zz-writer.ts";
const PG_TYPES = ["types/pg.d.ts", `declare module "pg" {
  export class Pool { constructor(c?: unknown); query(q: string): Promise<unknown> }
  export class Client { constructor(c?: unknown); query(q: string): Promise<unknown> }
  const pg: { Pool: typeof Pool; Client: typeof Client };
  export default pg;
}
declare module "@prisma/adapter-pg" { export class PrismaPg { constructor(p: unknown) } }`];

describe("writer rule: raw SQL that writes a session setting", () => {
  const writer = (statement) => runMulti([PG_TYPES, [WRITER, `import { Prisma } from "@prisma/client";
import pg from "pg";
declare const client: pg.Client;
export const f = async (tx: TX) => {
  ${statement};
};`]]);

  it.each([
    ["set_config with an upper-case GUC name", "await tx.$executeRaw`SELECT set_config('APP.BYPASS_RLS', 'on', true)`", "set_config"],
    ["a quoted GUC name after SET", "await tx.$executeRawUnsafe(`SET LOCAL \"app\".\"bypass_rls\" = 'on'`)", "statement-leading SET"],
    ["a spaced GUC name after SET", "await tx.$executeRawUnsafe('SET LOCAL app . bypass_rls = on')", "statement-leading SET"],
    ["a concatenation that splits the function name", "await tx.$executeRawUnsafe(\"SELECT set_\" + \"config('app.bypass_rls', 'on', true)\")", "set_config"],
    ["a 't'::boolean local flag", "await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', 't'::boolean)`", "set_config"],
    ["a quoted \"set_config\"", "await tx.$executeRaw`SELECT \"set_config\"('app.bypass_rls', 'on', true)`", "set_config"],
    ["pg_catalog.set_config", "await tx.$executeRaw`SELECT pg_catalog.set_config('app.bypass_rls', 'on', true)`", "set_config"],
    ["whitespace and a comment before the paren", "await tx.$executeRaw`SELECT set_config /* x */ ('app.bypass_rls', 'on', true)`", "set_config"],
    ["a U&-escaped identifier", "await tx.$executeRawUnsafe('SELECT U&\"\\\\0073et_config\"(\\'app.bypass_rls\\', \\'on\\', true)')", "set_config"],
    ["a U&-escaped identifier with UESCAPE", "await tx.$executeRawUnsafe(\"SELECT U&\\\"!0073et_config\\\" UESCAPE '!'('app.bypass_rls', 'on', true)\")", "set_config"],
    ["DO + EXECUTE built by concatenation", "await tx.$executeRawUnsafe(\"DO $$ BEGIN EXECUTE \" + \"'SET app.bypass_rls = on'\" + \"; END $$\")", "DO block"],
    ["a statement-leading RESET", "await tx.$executeRawUnsafe('RESET app.bypass_tables')", "statement-leading RESET"],
    ["ALTER … SET", "await tx.$executeRawUnsafe(\"ALTER ROLE passwd_app SET app.bypass_rls = 'on'\")", "ALTER … SET/RESET"],
    ["EXECUTE of a prepared statement", "await tx.$executeRawUnsafe('EXECUTE set_bypass')", "EXECUTE"],
    ["a second statement after a harmless one", "await tx.$executeRawUnsafe('SELECT 1; SET app.bypass_rls = on')", "statement-leading SET"],
    ["a Prisma.sql fragment", "void Prisma.sql`SELECT set_config('app.bypass_rls', 'on', true)`", "set_config"],
    ["a Prisma.raw fragment inside a tagged query", "await tx.$executeRaw`SELECT ${Prisma.raw(\"set_config('app.bypass_rls', 'on', true)\")}`", "set_config"],
    ["a pg query call", "await client.query('SET app.bypass_rls = on')", "statement-leading SET"],
    ["a pg query config object", "await client.query({ text: 'SET app.bypass_rls = on' } as never)", "statement-leading SET"],
    ["a const holding the statement", "const SQL = 'SET app.bypass_tables = ' + \"'users'\"; await tx.$executeRawUnsafe(SQL)", "statement-leading SET"],
  ])("refuses %s", (_label, statement, finding) => {
    const { code, stderr } = writer(statement);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain("raw SQL writes a session setting, or could");
    expect(stderr).toContain(`${WRITER}:5  ${finding}`);
  });

  it("passes reads, updates and privileges that only look like writers", () => {
    const { code, stdout, stderr } = writer([
      "await tx.$queryRaw`SELECT current_setting('app.bypass_rls', true)`",
      "await tx.$executeRaw`UPDATE users SET name = 'x' WHERE id = ${'u'}`",
      "await tx.$executeRaw`INSERT INTO system_settings (key) VALUES ('k') ON CONFLICT (key) DO UPDATE SET key = 'k'`",
      "await client.query('GRANT EXECUTE ON FUNCTION public.f() TO passwd_app')",
      "await tx.$executeRawUnsafe('SELECT ' + 'settings_count FROM t')",
      // A bind parameter is data, not SQL: its value is never lexed.
      "await tx.$executeRaw`SELECT ${'set_config'}`",
    ].join(";\n  "));
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("leaves the two RLS modules' own set_config to them", () => {
    // Every fixture tree holds the real tenant-rls.ts and tenant-rls-grants.ts,
    // both of which write the settings; the control is that this tree passes.
    const { code, stdout } = writer("await tx.$queryRaw`SELECT 1`");
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("does not judge a test file's raw SQL", () => {
    const { code } = runMulti([PG_TYPES, ["src/workers/zz-writer.test.ts", "export const f = (tx: TX) => tx.$executeRawUnsafe('SET app.bypass_rls = on');"]]);
    expect(code).toBe(0);
  });
});

describe("pool rule: pools are built by the factory", () => {
  it.each([
    ["new pg.Pool", `import pg from "pg";\nexport const p = new pg.Pool({});`],
    ["new pg.Client", `import pg from "pg";\nexport const p = new pg.Client({});`],
    ["a named Pool import", `import { Pool } from "pg";\nexport const p = new Pool({});`],
    ["a renamed Client import", `import { Client as C } from "pg";\nexport const p = new C({});`],
    ["a namespace import", `import * as postgres from "pg";\nexport const p = new postgres.default.Pool({});`],
    ["a required Pool", `const { Pool } = require("pg");\nexport const p = new Pool({});`],
    ["new PrismaPg", `import { PrismaPg } from "@prisma/adapter-pg";\nexport const a = new PrismaPg({});`],
    ["a renamed PrismaPg import", `import { PrismaPg as Adapter } from "@prisma/adapter-pg";\nexport const a = new Adapter({});`],
    ["an alias of the constructor", `import pg from "pg";\nconst P = pg.Pool;\nexport const p = new P({});`],
    ["a subclass", `import { Pool } from "pg";\nexport class Mine extends Pool {}`],
  ])("refuses %s outside the factory", (_label, source) => {
    const { code, stderr } = runMulti([PG_TYPES, ["src/workers/zz-pool.ts", source]]);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain("built outside src/lib/db/pool-factory.ts");
    expect(stderr).toContain("src/workers/zz-pool.ts:");
  });

  it("refuses a pool built in an integration test too", () => {
    const { code, stderr } = runMulti([PG_TYPES, ["src/__tests__/db-integration/zz.integration.test.ts", `import pg from "pg";\nexport const p = new pg.Pool({});`]]);
    expect(code).toBe(1);
    expect(stderr).toContain("src/__tests__/db-integration/zz.integration.test.ts:2  new pg.Pool");
  });

  it("passes the factory itself, and type-only uses elsewhere", () => {
    const { code, stdout, stderr } = runMulti([PG_TYPES,
      ["src/lib/db/pool-factory.ts", `import pg from "pg";\nimport { PrismaPg } from "@prisma/adapter-pg";\nexport const createPool = (c: unknown) => new pg.Pool(c);\nexport const adapt = (p: pg.Pool) => new PrismaPg(p);`],
      ["src/workers/zz-pool.ts", `import type pg from "pg";\nimport type { Client } from "pg";\nexport let held: pg.Pool | Client | null = null;`],
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("passes an allowlisted superuser site, and fails its entry once it builds nothing", () => {
    const site = "src/__tests__/db-integration/setup.ts";
    expect(runMulti([PG_TYPES, [site, `import { Client } from "pg";\nexport const probe = new Client({});`]]).code).toBe(0);
    const stale = runMulti([PG_TYPES, [site, "export const probe = null;"]]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain(`${site}:0  POOL_RULE_ALLOWLIST entry matches no construction`);
  });
});

describe("function rule: routines are created in migrations", () => {
  it.each([
    ["a code string", "src/lib/zz/fn.ts", `export const q = "CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql";`, "src/lib/zz/fn.ts:1  creates f"],
    ["a concatenation", "src/lib/zz/fn.ts", `export const q = "CREATE " + "FUNCTION g() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql";`, "src/lib/zz/fn.ts:1  creates g"],
    ["a function with a SET clause", "src/lib/zz/fn.ts", "export const q = `CREATE FUNCTION h() RETURNS void SET app.bypass_rls = 'on' AS $$ SELECT 1 $$ LANGUAGE sql`;", "src/lib/zz/fn.ts:1  creates h"],
    ["a procedure", "scripts/zz-job.mjs", `export const q = "CREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$";`, "scripts/zz-job.mjs:1  creates p"],
    ["a SQL file", "scripts/zz.sql", "-- setup\nCREATE OR REPLACE FUNCTION public.s() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;\n", "scripts/zz.sql:2  creates s"],
    ["a workflow step", ".github/workflows/zz.yml", "steps:\n  - run: psql -c \"CREATE /* x */ FUNCTION w() RETURNS int AS \\$\\$ SELECT 1 \\$\\$ LANGUAGE sql\"\n", ".github/workflows/zz.yml:2  creates w"],
  ])("refuses %s", (_label, path, text, finding) => {
    const { code, stderr } = runMulti([[path, text]]);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain("a routine is created outside prisma/migrations");
    expect(stderr).toContain(finding);
  });

  it("passes dropping, granting on and naming a function", () => {
    const { code, stdout, stderr } = runMulti([
      ["src/lib/zz/fn.ts", `export const q = ["DROP FUNCTION f()", "GRANT EXECUTE ON FUNCTION public.f() TO r", "SELECT public.f()"];`],
      ["scripts/zz.sql", "DROP FUNCTION IF EXISTS f();\n"],
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("passes the negative test's Case 9 probe and a gate fixture string, and nothing else there", () => {
    const negative = "scripts/rls-cross-tenant-negative-test.sh";
    const probe = "psql <<SQL\n    CREATE OR REPLACE FUNCTION rls_negative_secdef_probe() RETURNS int AS \\$\\$ SELECT 1 \\$\\$ LANGUAGE sql SECURITY DEFINER;\nSQL\n";
    const allowed = runMulti([[negative, probe], ["scripts/__tests__/zz.test.mjs", `export const s = "CREATE FUNCTION fixture() RETURNS int";`]]);
    expect(allowed.code, allowed.stderr).toBe(0);
    const other = runMulti([[negative, `${probe}psql -c "CREATE FUNCTION another() RETURNS int AS 'SELECT 1' LANGUAGE sql"\n`]]);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain(`${negative}:4  creates another`);
  });
});

describe("grants the retention worker builds per entry", () => {
  const SWEEP = ["src/workers/retention-gc-worker/zz-sweep.ts", `import { BYPASS_GRANT, grantForTables, setBypassGucs, type BypassGrant } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";
export function grantForEntry(tables: string[]): BypassGrant | null { return grantForTables(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, tables); }
async function inSweepTx(db: TX, grant: BypassGrant | null) { if (grant) await setBypassGucs(db, grant); }
export const sweep = (db: TX) => inSweepTx(db, grantForEntry(["audit_logs"]));
export const beat = (db: TX) => inSweepTx(db, BYPASS_GRANT.RETENTION_HEARTBEAT);`];

  it("resolves grantForEntry/grantForTables in the retention worker as self-setting sites", () => {
    const { code, stdout, stderr } = runMulti([SWEEP]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("refuses the same dynamic grant anywhere else", () => {
    const { code, stderr } = runMulti([[SWEEP[0].replace("retention-gc-worker", "zz-worker"), SWEEP[1]]]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/src\/workers\/zz-worker\/zz-sweep\.ts:5  inSweepTx is handed a grant that is not a BYPASS_GRANT\.\* member: grantForEntry/);
  });
});

// ─── Relation reach (Check 3) ─────────────────────────────────────────────────
//
// A query's argument reaches the rows of every related model it names — a
// projection, a filter, an ordering or a nested write runs against the related
// table under the same bypass — so those models are charged to the call's
// grant like a delegate read. The grants here are ones the copied real
// tenant-context.ts does not share, so each cell's call is the grant's only one.

describe("relation reach: models a query's argument reaches are charged to the grant", () => {
  const cell = (body, grant) => run(SESSION_CAP, `${HEAD_RLS}export const f = () => withBypassRls(prisma, async (tx) => ${body}, BYPASS_GRANT.${grant});`);

  it.each([
    ["a nested select", `tx.user.findMany({ select: { tenantMemberships: { select: { tenant: true } } } })`, "AUTH_USER_LOOKUP", "tenant", "User.tenantMemberships.tenant"],
    ["an include", `tx.session.findMany({ include: { user: true } })`, "AUTH_SESSION_CAPPING", "user", "Session.user"],
    ["a _count select", `tx.user.findMany({ select: { _count: { select: { sessions: true } } } })`, "AUDIT_USER_DISPLAY_LOOKUP", "session", "User._count.sessions"],
    ["_count: true", `tx.user.findMany({ include: { _count: true } })`, "AUDIT_USER_DISPLAY_LOOKUP", "session", "User._count.sessions"],
    ["a where through is", `tx.tenantMember.findMany({ where: { user: { is: { email: "x" } } } })`, "TOKEN_TENANT_MEMBERSHIP_CHECK", "user", "TenantMember.where.user"],
    ["a where through some, inside OR", `tx.user.findMany({ where: { OR: [{ tenantMemberships: { some: { tenantId: "t" } } }] } })`, "AUDIT_USER_DISPLAY_LOOKUP", "tenantMember", "User.where.OR.tenantMemberships"],
    ["the where of a nested relation", `tx.session.findMany({ select: { user: { where: { tenantMemberships: { none: {} } } } } })`, "AUTH_SESSION_LIFECYCLE", "tenantMember", "Session.user.where.tenantMemberships"],
    ["an orderBy on a relation", `tx.session.findMany({ orderBy: { user: { email: "asc" } } })`, "AUTH_SESSION_CAPPING", "user", "Session.orderBy.user"],
    ["a _count orderBy", `tx.user.findMany({ orderBy: [{ tenantMemberships: { _count: "desc" } }] })`, "AUDIT_USER_DISPLAY_LOOKUP", "tenantMember", "User.orderBy.tenantMemberships"],
    ["a nested create", `tx.user.update({ where: { id: "u" }, data: { sessions: { create: { sessionToken: "s" } } } })`, "AUDIT_USER_DISPLAY_LOOKUP", "session", "User.data.sessions"],
    ["a nested connect", `tx.session.create({ data: { sessionToken: "s", user: { connect: { id: "u" } } } })`, "AUTH_SESSION_CAPPING", "user", "Session.data.user"],
    ["a relation inside a nested create", `tx.user.update({ where: { id: "u" }, data: { tenantMemberships: { create: { tenant: { connect: { id: "t" } } } } } })`, "AUTH_USER_LOOKUP", "tenant", "User.data.tenantMemberships.create.tenant"],
    ["a filter inside a nested write", `tx.user.update({ where: { id: "u" }, data: { tenantMemberships: { deleteMany: { tenant: { slug: "x" } } } } })`, "AUTH_USER_LOOKUP", "tenant", "User.data.tenantMemberships.deleteMany.tenant"],
    ["an argument held by a const", `(() => { const args = { include: { user: true } }; return tx.session.findMany(args); })()`, "AUTH_SESSION_CAPPING", "user", "Session.user"],
  ])("charges a model reached through %s", (_label, body, grant, model, path) => {
    const { code, stderr } = cell(body, grant);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(`${SESSION_CAP}:2  prisma.${model}  (relation ${path})  not in BYPASS_GRANT.${grant}`);
  });

  it("passes the same reach under a grant that lists it", () => {
    const { code, stdout, stderr } = cell(`tx.session.findMany({ include: { user: true } })`, "AUTH_SESSION_LIFECYCLE");
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("keeps a grant model reached only through a relation from reading as stale", () => {
    // AUTH_USER_LOOKUP lists user + tenantMember; only the select reaches the second.
    const allowed = cell(`tx.user.findMany({ select: { tenantMemberships: true } })`, "AUTH_USER_LOOKUP");
    expect(allowed.code, allowed.stderr).toBe(0);
    const denied = cell(`tx.user.findMany({})`, "AUTH_USER_LOOKUP");
    expect(denied.code).toBe(1);
    expect(denied.stderr).toMatch(/BYPASS_GRANT\.AUTH_USER_LOOKUP  prisma\.tenantMember\n/);
  });

  it("does not judge a grant stale when a query's argument cannot be read, and counts the call", () => {
    // The literal partner is the deny half of the cell above.
    // An index-signature type: the keys it can hold are not a known set.
    const { code, stdout, stderr } = run(SESSION_CAP, `${HEAD_RLS}export const f = (w: Record<string, unknown>) => withBypassRls(prisma, async (tx) => tx.user.findMany({ where: w }), BYPASS_GRANT.AUTH_USER_LOOKUP);`);
    expect(code, stderr).toBe(0);
    expect(stdout).toMatch(/; [1-9]\d* call\(s\) run a query whose argument the relation walk cannot read/);
    // Each such call is named, so a reviewer can check its reach by hand.
    expect(stdout).toContain(`  unreadable relation argument: ${SESSION_CAP}:2`);
  });

  it("still charges what it can read beside an unreadable part", () => {
    const { code, stderr } = run(SESSION_CAP, `${HEAD_RLS}export const f = (w: Record<string, unknown>) => withBypassRls(prisma, async (tx) => tx.user.findMany({ where: w, select: { sessions: true } }), BYPASS_GRANT.AUTH_USER_LOOKUP);`);
    expect(code).toBe(1);
    expect(stderr).toContain(`${SESSION_CAP}:2  prisma.session  (relation User.sessions)  not in BYPASS_GRANT.AUTH_USER_LOOKUP`);
  });

  // Issue #926: spreads, and where/data values that are not literals, read by
  // their branches or by their type. The readable/unreadable split is measured
  // through staleness: AUTH_USER_LOOKUP lists user + tenantMember, so a readable
  // `tx.user` call reaching no relation leaves tenantMember stale (exit 1), while
  // an unreadable one is not judged stale and is named on stdout (exit 0).
  const typed = (params, body, grant, typeParams = "") =>
    run(SESSION_CAP, `${HEAD_RLS}export const f = ${typeParams}(${params}) => withBypassRls(prisma, async (tx) => ${body}, BYPASS_GRANT.${grant});`);
  const UNREADABLE = `  unreadable relation argument: ${SESSION_CAP}:2`;
  const STALE_TENANT_MEMBER = /BYPASS_GRANT\.AUTH_USER_LOOKUP  prisma\.tenantMember\n/;
  const expectReadableReachingNothing = ({ code, stdout, stderr }) => {
    expect(code, stderr).toBe(1);
    expect(stderr).toMatch(STALE_TENANT_MEMBER);
    expect(stdout).not.toContain(UNREADABLE);
  };
  const expectUnreadable = ({ code, stdout, stderr }) => {
    expect(code, stderr).toBe(0);
    expect(stdout).toContain(UNREADABLE);
  };

  it.each([
    ["the true branch of a where spread", `tx.session.findMany({ where: { ...(c ? { user: { email: "x" } } : {}) } })`, "user", "Session.where.user"],
    ["the false branch of a where spread", `tx.session.findMany({ where: { ...(c ? undefined : { user: { email: "x" } }) } })`, "user", "Session.where.user"],
    ["a conditional spread in data", `tx.session.create({ data: { sessionToken: "s", ...(c ? { user: { connect: { id: "u" } } } : null) } })`, "user", "Session.data.user"],
    ["a conditional spread in a projection", `tx.session.findMany({ include: { ...(c ? {} : { user: true }) } })`, "user", "Session.user"],
    ["a conditional spread of the argument itself", `tx.session.findMany({ ...(c ? { include: { user: true } } : {}) })`, "user", "Session.user"],
    ["a const bound to a conditional, spread", `(() => { const extra = c ? { user: { email: "x" } } : {}; return tx.session.findMany({ where: { ...extra } }); })()`, "user", "Session.where.user"],
    ["a conditional array spread inside OR", `tx.session.findMany({ where: { OR: [...(c ? [{ user: { email: "x" } }] : [])] } })`, "user", "Session.where.OR.user"],
    // An angle-bracket assertion states a type, as `as` does: the literal under it is what is read.
    ["a spread under an angle-bracket assertion", `tx.session.findMany({ where: { ...<{ sessionToken: string }><unknown>{ user: { email: "x" } } } })`, "user", "Session.where.user"],
    ["a const holding an angle-bracket assertion", `(() => { const w = <{ sessionToken: string }><unknown>{ user: { email: "x" } }; return tx.session.findMany({ where: { ...w } }); })()`, "user", "Session.where.user"],
    ["a cursor", `tx.session.findMany({ cursor: { id: "s", user: { email: "x" } } })`, "user", "Session.cursor.user"],
  ])("charges a relation in %s", (_label, body, model, path) => {
    const { code, stderr } = typed("c: boolean", body, "AUTH_SESSION_CAPPING");
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(`${SESSION_CAP}:2  prisma.${model}  (relation ${path})  not in BYPASS_GRANT.AUTH_SESSION_CAPPING`);
  });

  it("reads a conditional spread whose branches are scalar-only, and charges nothing", () => {
    expectReadableReachingNothing(typed("c: boolean", `tx.user.findMany({ where: { ...(c ? { email: "x" } : {}), ...(c ? null : { name: "n" }) } })`, "AUTH_USER_LOOKUP"));
  });

  it.each([
    ["a spread", "w: { email?: string; name: string | null }", `tx.user.findMany({ where: { id: "u", ...w } })`],
    ["an optional spread", "w?: { email: string }", `tx.user.findMany({ where: { ...w } })`],
    ["a whole where", "w: { email: string } | { name: string }", `tx.user.findMany({ where: w })`],
    ["a data spread", "d: { name: string }", `tx.user.update({ where: { id: "u" }, data: { ...d } })`],
    ["a member read off a parameter", "o: { w: { email: string } }", `tx.user.findMany({ where: { ...o.w } })`],
    ["a call with an annotated return type", "c: boolean", `(() => { const mk = (): { email: string } => ({ email: "x" }); return tx.user.findMany({ where: { ...mk() } }); })()`],
  ])("reads %s typed with scalar keys only", (_label, params, body) => {
    expectReadableReachingNothing(typed(params, body, "AUTH_USER_LOOKUP"));
  });

  it.each([
    ["a relation key", "w: { email?: string; tenantMemberships?: { some: { tenantId: string } } }", `tx.user.findMany({ where: { ...w } })`],
    ["a logical key", "w: { OR?: { email: string }[] }", `tx.user.findMany({ where: { ...w } })`],
    ["a relation key in a data spread", "d: { name: string; sessions?: { create: { sessionToken: string } } }", `tx.user.update({ where: { id: "u" }, data: { ...d } })`],
    ["an include key in an argument spread", "a: { include?: { sessions: true } }", `tx.user.findMany({ ...a })`],
    ["any", "w: any", `tx.user.findMany({ where: { ...w } })`],
    ["an index signature beside a named key", "w: { email: string; [k: string]: string }", `tx.user.findMany({ where: { ...w } })`],
    ["an empty object type", "w: {}", `tx.user.findMany({ where: { ...w } })`],
    ["a union with a relation key in one member", "w: { email: string } | { tenantMemberships: { some: { tenantId: string } } }", `tx.user.findMany({ where: { ...w } })`],
    ["a cursor key in an argument spread", "a: { cursor?: { id: string } }", `tx.user.findMany({ ...a })`],
  ])("keeps a spread typed with %s unreadable", (_label, params, body) => {
    expectUnreadable(typed(params, body, "AUTH_USER_LOOKUP"));
  });

  const REL = "{ email: string; tenantMemberships: { some: { tenantId: string } } }";
  // Not a subtype of { email: string }, so a guard for that type narrows it away.
  const REL_ONLY = "{ tenantMemberships: { some: { tenantId: string } } }";
  it.each([
    // T can be instantiated with a relation key; the mapped type's keys are T's.
    ["an inline mapped type over a type parameter", "w: { [K in keyof T]: T[K] }", `tx.user.findMany({ where: { ...w } })`, "<T extends { email: string }>"],
    // An alias with no type arguments of its own, mapping over the enclosing function's T.
    ["a local alias mapping over a type parameter", "_t: T", `(() => { type M = { [K in keyof T]: T[K] }; const g = (w: M) => tx.user.findMany({ where: { ...w } }); return g(null as never); })()`, "<T extends { email: string }>"],
    ["a let rebound to a wider object", `rel: ${REL}`, `(() => { let w = { email: "y" }; w = rel; return tx.user.findMany({ where: { ...w } }); })()`, ""],
    ["a parameter rebound to a wider object", `w: { email: string }, rel: ${REL}`, `(() => { w = rel; return tx.user.findMany({ where: { ...w } }); })()`, ""],
    // The guard narrows to the scalar member; the value is still the declared union.
    ["a value narrowed by a user type guard", `w: { email: string } | { tenantMemberships: { some: { tenantId: string } } }`, `(() => { const isEmail = (x: unknown): x is { email: string } => true; if (!isEmail(w)) return null; return tx.user.findMany({ where: { ...w } }); })()`, ""],
    // A call's inferred return type is whatever its body returned, cast or narrowing included.
    ["a call whose inferred return type is a cast", "c: boolean", `(() => { const mk = () => ({ email: "x", tenantMemberships: { some: { tenantId: "t" } } } as { email: string }); return tx.user.findMany({ where: { ...mk() } }); })()`, ""],
    ["a call returning a narrowed value", `w: { email: string } | ${REL_ONLY}`, `(() => { const isEmail = (x: unknown): x is { email: string } => true; if (!isEmail(w)) return null; const g = () => w; return tx.user.findMany({ where: { ...g() } }); })()`, ""],
    // The member is looked up on the root's declared type, not on the narrowed receiver.
    ["a member read off a receiver narrowed by a type guard", `o: { w: { email: string } } | { w: ${REL_ONLY} }`, `(() => { const isA = (x: unknown): x is { w: { email: string } } => true; if (!isA(o)) return null; return tx.user.findMany({ where: { ...o.w } }); })()`, ""],
    ["a member written through a cast", "o: { w: { email: string } }", `(() => { (o as any).w = { tenantMemberships: { some: { tenantId: "t" } } }; return tx.user.findMany({ where: { ...o.w } }); })()`, ""],
  ])("keeps %s unreadable", (_label, params, body, typeParams) => {
    expectUnreadable(typed(params, body, "AUTH_USER_LOOKUP", typeParams));
  });

  it.each([
    ["a branch that names a relation filter", `tx.user.findMany({ where: { tenantMemberships: { ...(c ? { some: { tenantId: "t" } } : {}) } } })`],
    ["a spread beside a relation filter", `tx.user.findMany({ where: { tenantMemberships: { some: { tenantId: "t" }, ...(c ? { none: {} } : {}) } } })`],
    ["a const that something assigns into", `(() => { const extra = c ? { email: "x" } : {}; (extra as Record<string, unknown>).name = "n"; return tx.user.findMany({ where: { ...extra } }); })()`],
  ])("keeps %s unreadable", (_label, body) => {
    // The relation-filter cells reach tenantMember either way; their point is the unreadable report.
    const { stdout } = typed("c: boolean", body, "AUTH_USER_LOOKUP");
    expect(stdout).toContain(UNREADABLE);
  });

  it("fails named when the tree has no prisma/schema.prisma", () => {
    const { code, stderr } = runMulti([[SESSION_CAP, `${HEAD_RLS}export const f = () => withBypassRls(prisma, async (tx) => tx.user.count(), BYPASS_GRANT.AUDIT_USER_DISPLAY_LOOKUP);`], ["prisma/schema.prisma", ""]]);
    expect(code).toBe(1);
    expect(stderr).toContain("PROGRAM_BUILD_FAILED: parsed zero models from");
  });
});
