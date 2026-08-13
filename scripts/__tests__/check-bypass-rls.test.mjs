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
 * Fixtures below write the helper's arguments in whichever order reads clearly;
 * the real signature is `withBypassRls(prisma, fn, purpose)`, and the gate finds
 * the callback by kind rather than by position, so both orders exercise it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
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

// The sanctioned shape: tenant-context.ts is in F3_UNUSED_TX_ALLOWLIST,
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
    // long callback into a violation. The unrelated prisma.user call AFTER the
    // callback is what gives this test teeth — without it, a scan that runs to
    // end-of-file unconditionally passes too (finding T3).
    const filler = Array.from({ length: 30 }, (_, i) => `      const pad${i} = ${i};`).join("\n");
    const { code } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => {
${filler}
      return tx.auditOutbox.findMany({ where: { status: "PENDING" } });
  });
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
    expect(stderr).not.toContain("could not be parsed");
  });

  it("ignores a call-shaped mention inside a string literal", () => {
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
const HELP = "see withBypassRls(prisma, purpose, cb) for the pattern";
export async function drain() {
  return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => tx.auditOutbox.findMany());
}`);
    expect(code).toBe(0);
    expect(stderr).not.toContain("could not be parsed");
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

  it("is not blinded by a regex literal whose character class holds a slash", () => {
    // `/[/*]/` — the `/` needs no escaping inside a character class. A
    // lookahead-based comment detector reads the `/*` as opening a block
    // comment and blanks the rest of the file, taking the call site with it.
    // The parser knows a regex literal when it sees one.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
const GLOB_RE = /[/*]/;
export async function drain() {
  return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => {
      return tx.tenantMember.findFirst({ where: { id: "x" } });
  });
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("sees a model reference inside a template interpolation", () => {
    // `${await tx.model.count()}` is code, not string body. Blanking template
    // literals wholesale hid it — a regression the raw-text scan did not have.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain(id) {
  return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => {
      log(\`members=\${await tx.tenantMember.count()}\`);
      return tx.auditOutbox.findMany();
  });
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => {
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
import { withBypassRls as wb, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function sneaky() {
  return wb(prisma, async (tx) => tx.tenantMember.findFirst({}), BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (db) => db.tenantMember.findFirst({}), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("catches a model reached through a nested $transaction client", () => {
    // A nested $transaction inherits the bypass context through the Proxy, so
    // its own callback parameter is a bypassed client too. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    return tx.$transaction(async (inner) => inner.tenantMember.findFirst({}));
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("catches a model inside a callback passed by name", () => {
    // Scanning only the call's own subtree saw nothing when the callback was a
    // local const passed by reference — the shape
    // src/lib/auth/policy/passkey-enforcement.ts uses. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  const job = async (tx) => tx.tenantMember.findFirst({});
  return withBypassRls(prisma, job, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("names a callback it cannot resolve instead of scanning nothing and passing", () => {
    // A callback that is the enclosing function's own parameter is invisible
    // from this file. Examining nothing must not be spelled like finding
    // nothing. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain(job) {
  return withBypassRls(prisma, job, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be resolved");
    expect(stderr).toContain("src/lib/audit/audit-outbox.ts:4");
  });

  it("flags a genuinely tx-less callback, and names the call's own line", () => {
    // The allow-side companions below are what stop this from being satisfied
    // by a predicate that always fires.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async () => prisma.auditOutbox.findMany(), BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    // legacy shape was withBypassRls(prisma, () => prisma.auditOutbox.findMany(), p)
    return tx.auditOutbox.findMany();
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("passes a healthy file that mentions the helper only in prose", () => {
    // A file whose bypass call was removed but whose explanatory comment and
    // allowlist entry remain — an ordinary cleanup. Round 3 reported it as
    // unparseable, naming a file that parsed perfectly. Prior verdict: exit 1.
    const { code, stdout, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";
// This used to call withBypassRls(prisma, cb, BYPASS_PURPOSE.AUDIT) before the refactor.
export const purpose = BYPASS_PURPOSE.AUDIT;`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
    expect(stderr).not.toContain("could not be parsed");
  });

  it("passes a compliant call in a file whose string quotes an eslint-disable", () => {
    // The F3 scan matched its trigger words in raw text, so the same words
    // inside a string literal counted — and it never checked whether `tx` was
    // actually unused. Prior verdict: exit 1.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
const DOC = "eslint-disable-next-line @typescript-eslint/no-unused-vars";
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.auditOutbox.findMany(), BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
const banner = \`unterminated on purpose

export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.tenantMember.findFirst({}), BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function bad(job) {
  return withBypassRls(prisma, job, BYPASS_PURPOSE.AUDIT);
}
function unrelated() {
  const job = async (tx) => tx.auditOutbox.findMany();
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function bad() {
  return withBypassRls(prisma, job, BYPASS_PURPOSE.AUDIT);
}
function unrelated() {
  const job = async (tx) => tx.auditOutbox.findMany();
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
const job = async (tx) => tx.auditOutbox.findMany();
export async function bad(job) {
  return withBypassRls(prisma, job, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
const job = async (tx) => tx.auditOutbox.findMany();
export async function bad({ job }) {
  return withBypassRls(prisma, job, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be resolved");
  });

  it("refuses a callback parameter's default value, which no caller need supply", () => {
    // `getInitializer()` on a Parameter is its DEFAULT. Scanning it answers a
    // question nobody asked: every call that passes an argument runs something
    // else — here a `prisma.user.deleteMany()` the gate would never see.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain(job = async (tx) => tx.auditOutbox.findMany()) {
  return withBypassRls(prisma, job, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain(flag) {
  let job = async (tx) => tx.auditOutbox.findMany();
  if (flag) job = async (tx) => tx.user.deleteMany();
  return withBypassRls(prisma, job, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not be resolved");
  });

  it("follows a client aliased to another name", () => {
    // `const db = tx` — the value is the bypassed client whatever it is called
    // next. Tracking only the parameter's own name is the same
    // decides-by-spelling habit, one assignment along.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const db = tx;
    return db.tenantMember.findMany();
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows a chain of client aliases", () => {
    // One hop is a special case; the resolution runs to a fixpoint so the
    // chain's length cannot be the thing that hides an access.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const a = tx;
    const b = a;
    return b.tenantMember.findMany();
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows an alias declared before the client it derives from", () => {
    // Source order is not resolution order: `c = b` is read before `b = tx`
    // exists, so one pass over the declarations misses it. This is what the
    // fixpoint is for — a forward chain would resolve without it.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    function inner() {
      const c = b;
      return c.tenantMember.findMany();
    }
    const b = tx;
    return inner();
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("catches a delegate destructured off the client in the callback body", () => {
    // `const { tenantMember } = tx` lifts the delegate out, so no
    // `<client>.<model>` access ever appears for the property scan to find.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const { tenantMember } = tx;
    return tenantMember.findMany();
  }, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
const db = prisma;
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    await tx.auditOutbox.findMany();
    return db.tenantMember.findMany();
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows a client assigned after its declaration", () => {
    // `let db; db = tx;` — a binding is not a different value for having been
    // filled in on the next line, so plain assignments count, not only
    // initializers.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    let db;
    db = tx;
    return db.tenantMember.findMany();
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows a client through a conditional expression", () => {
    // `cond ? tx : prisma` is a choice between clients, so the result is one.
    // Note the deliberate limit this pairs with: an expression that merely
    // MENTIONS a client is not a flow — `await tx.user.find()` yields a row.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain(flag) {
  return withBypassRls(prisma, async (tx) => {
    const db = flag ? tx : prisma;
    return db.tenantMember.findMany();
  }, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    return tx.$transaction(async ({ tenantMember }) => tenantMember.findMany());
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("passes an outer alias and a nested $transaction that stay within the allowlist", () => {
    // The allow side for both of the above: following the value further must
    // not turn a compliant callback into a violation.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
const db = prisma;
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    await db.auditOutbox.findMany();
    return tx.$transaction(async ({ auditOutbox }) => auditOutbox.count());
  }, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { prisma as db } from "@/lib/prisma";
export async function drain() {
  return withBypassRls(db, async (tx) => {
    await tx.auditOutbox.findMany();
    return db.tenantMember.findMany();
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("sees through a type-level wrapper on the client argument", () => {
    // `db as typeof db` is the same value wearing a cast. Requiring a bare
    // Identifier there loses the client origin to a no-op annotation.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { prisma as db } from "@/lib/prisma";
export async function drain() {
  return withBypassRls(db as typeof db, async (tx) => {
    await tx.auditOutbox.findMany();
    return db.tenantMember.findMany();
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("tracks a client reached through a namespace import", () => {
    // `clients.prisma` is a member access, so a client set of bare names cannot
    // hold it. Clients are identified by expression text for exactly this.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import * as clients from "@/lib/prisma";
export async function drain() {
  return withBypassRls(clients.prisma, async (tx) => {
    await tx.auditOutbox.findMany();
    return clients.prisma.tenantMember.findMany();
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("passes a namespace-import client that stays within the allowlist", () => {
    // The allow side: a member-access client must not make every access through
    // it a violation.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import * as clients from "@/lib/prisma";
export async function drain() {
  return withBypassRls(clients.prisma, async (tx) => {
    await tx.auditOutbox.findMany();
    return clients.prisma.auditOutbox.count();
  }, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import * as clients from "@/lib/prisma";
export async function drain() {
  return withBypassRls(clients . prisma, async (tx) => {
    await tx.auditOutbox.findMany();
    return clients.prisma.tenantMember.findMany();
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("reduces a type wrapper on the model RECEIVER, not only on the argument", () => {
    // The reduction has to run on both sides. Applying it to the client
    // argument alone left `(tx as typeof tx).model` unseen.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => (tx as typeof tx).tenantMember.findMany(), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("reads a model indexed by a static string", () => {
    // `tx["tenantMember"]` is `tx.tenantMember` written the other way.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx["tenantMember"].findMany(), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("catches a delegate lifted by a destructuring ASSIGNMENT", () => {
    // `({ model } = tx)` does what `const { model } = tx` does, but its left
    // side is an object literal rather than a binding pattern.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    let tenantMember;
    ({ tenantMember } = tx);
    return tenantMember.findMany();
  }, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    let auditOutbox;
    ({ auditOutbox } = tx);
    await (tx as typeof tx).auditOutbox.findMany();
    return tx["auditOutbox"].count();
  }, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const model = "tenantMember" as const;
    return tx[model].findMany();
  }, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const key = "tenantMember" as const;
    ${source}
  }, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function innerJob(inner) {
  return inner.tenantMember.findMany();
}
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction(innerJob), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("analyses a named nested callback's own body, not just its parameter", () => {
    // Depth one was handled by adding the resolved callback to the scan; its
    // OWN destructuring was still judged "outside the callback", because the
    // inside-test looked only at the outermost one.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function job(inner) {
  const { tenantMember } = inner;
  return tenantMember.findMany();
}
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction(job), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("follows nested $transaction callbacks to any depth", () => {
    // Three levels, each resolved by name. A worklist is depth-N by
    // construction; the previous shape handled exactly one level, which is why
    // every round found the next one.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function l3(d) { return d.tenantMember.findMany(); }
async function l2(c) { return c.$transaction(l3); }
async function l1(b) { return b.$transaction(l2); }
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction(l1), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("terminates on mutually recursive callbacks and still reports", () => {
    // The visited set has to make a cycle finish, and finishing must not mean
    // giving up: the disallowed model is reached on the way round.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function ping(a) {
  return a.$transaction(pong);
}
async function pong(b) {
  await b.$transaction(ping);
  return b.tenantMember.findMany();
}
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction(ping), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("passes a deep callback chain that stays within the allowlist", () => {
    // The allow side at depth: following further must not make every nested
    // transaction a violation.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function deepJob(deep) {
  const { auditOutbox } = deep;
  return auditOutbox.count();
}
async function job(inner) {
  return inner.$transaction(deepJob);
}
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction(job), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("passes a named nested $transaction callback within the allowlist", () => {
    // The allow side: resolving the nested callback must not make every one of
    // them a violation.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function innerJob(inner) {
  return inner.auditOutbox.count();
}
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction(innerJob), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("follows a client passed to a same-file helper", () => {
    // The header used to excuse this as "helpers are usually imported, which
    // needs a Program". True of imported ones; a same-file function resolves
    // through the binding index the gate already has.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function queryMember(db) {
  return db.tenantMember.findMany();
}
export async function drain() {
  return withBypassRls(prisma, async (tx) => queryMember(tx), BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function inner2(id, client) { return client.tenantMember.findMany({ where: { id } }); }
async function inner1(db, id) { return inner2(id, db); }
export async function drain() {
  return withBypassRls(prisma, async (tx) => inner1(tx, "x"), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("resolves the innermost binding when a local function shadows a module one", () => {
    // JavaScript picks the innermost binding. Requiring "exactly one visible
    // declaration" resolved to neither and skipped the call in silence — the
    // shadowed outer function reaches only allowed models, so nothing else
    // would have noticed.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function query(db) { return db.auditOutbox.findMany(); }
export function drain() {
  async function query(db) { return db.tenantMember.findMany(); }
  return withBypassRls(prisma, (tx) => query(tx), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("picks the shadowing binding rather than reporting the shadowed one", () => {
    // The mirror: the INNER function is the compliant one, so resolving the
    // outer would be a false positive. Both directions pin the same rule.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function query(db) { return db.tenantMember.findMany(); }
export function drain() {
  async function query(db) { return db.auditOutbox.findMany(); }
  return withBypassRls(prisma, (tx) => query(tx), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("resolves an object-literal method and a .call invocation", () => {
    // Neither is the declared imported-helper gap: both bind locally. `.call`
    // also shifts its arguments by one, so resolving the function without that
    // offset binds the wrong parameter — a wrong answer, not a missing one.
    for (const source of [
      `const helpers = { query: async (db) => db.tenantMember.findMany() };
export async function drain() {
  return withBypassRls(prisma, async (tx) => helpers.query(tx), BYPASS_PURPOSE.AUDIT);
}`,
      `async function query(db) { return db.tenantMember.findMany(); }
export async function drain() {
  return withBypassRls(prisma, async (tx) => query.call(null, tx), BYPASS_PURPOSE.AUDIT);
}`,
    ]) {
      const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function query(db) { return db.tenantMember.findMany(); }
${chain}
export async function drain() {
  return withBypassRls(prisma, async (tx) => f8(tx), BYPASS_PURPOSE.AUDIT);
}`);
    expect(deep.code).toBe(1);
    expect(deep.stderr).toContain("prisma.tenantMember");

    const cyclic = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
const a = b;
const b = a;
export async function drain() {
  return withBypassRls(prisma, async (tx) => a(tx), BYPASS_PURPOSE.AUDIT);
}`);
    expect(cyclic.code).toBe(0);
  });

  it("treats the right operand of && as the client it yields", () => {
    // `a ?? tx` and `a || tx` can yield either side; `a && tx` yields the right
    // one when it yields at all.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function query(db) {
  if (db) return db.tenantMember.findMany();
}
export async function drain(enabled) {
  return withBypassRls(prisma, async (tx) => query(enabled && tx), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("recognises an aliased client as a helper argument", () => {
    // The graph walk and the client flow used to be two phases: the alias was
    // learned by the flow pass, which ran after the only scan that could have
    // used it. They are one fixpoint now.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function queryMember(db) { return db.tenantMember.findMany(); }
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const alias = tx;
    return queryMember(alias);
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("recognises a choice between clients as a helper argument", () => {
    // The argument test is the same predicate the flow pass uses, so
    // `flag ? tx : prisma` counts here exactly as it does in an assignment.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function queryMember(db) { return db.tenantMember.findMany(); }
export async function drain(flag) {
  return withBypassRls(prisma, async (tx) => queryMember(flag ? tx : prisma), BYPASS_PURPOSE.AUDIT);
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
  return withBypassRls(prisma, async (tx) => aliasedQuery(tx), BYPASS_PURPOSE.AUDIT);
}`,
      `export async function drain() {
  return withBypassRls(prisma, async (tx) => (async (db) => db.tenantMember.findMany())(tx), BYPASS_PURPOSE.AUDIT);
}`,
    ]) {
      const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function query(db) { return db.tenantMember.findMany(); }
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function job(first, second) {
  if (second) return second.auditOutbox.count();
  return first.tenantMember.findMany();
}
export async function drain(meta) {
  return withBypassRls(prisma, async (tx) => {
    ${first}
    ${second}
  }, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function pick(meta, db) {
  if (meta.kind === "x") return null;
  return db.auditOutbox.count();
}
export async function drain(meta) {
  return withBypassRls(prisma, async (tx) => pick(meta, tx), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("passes a same-file helper that stays within the allowlist", () => {
    // The allow side: following the client into helpers must not make every
    // helper call a violation.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function queryOutbox(db) { return db.auditOutbox.findMany(); }
export async function drain() {
  return withBypassRls(prisma, async (tx) => queryOutbox(tx), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("does not fail loud on an imported helper, which is the declared gap", () => {
    // The boundary of the case above. An imported callee cannot be resolved
    // without a Program, and 38 such call sites exist today — reporting them
    // would red the build on the shape the header documents as uncovered.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { queryMember } from "@/lib/elsewhere";
export async function drain() {
  return withBypassRls(prisma, async (tx) => queryMember(tx), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("accepts a parenthesised batch $transaction", () => {
    // `$transaction(([...]))` is the batch form wearing parentheses. Testing
    // the argument's kind without unwrapping read it as a missing callback and
    // reported a compliant call — the false-positive direction.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx.$transaction((
    [tx.auditOutbox.findMany(), tx.auditOutbox.count()]
  )), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("does not demand a callback from the batch form of $transaction", () => {
    // `$transaction([...])` takes an array of promises, not a callback. The
    // boundary for the fail-loud above: no callback expected, so nothing is
    // unresolved and the allowed models inside must simply pass.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) =>
    tx.$transaction([tx.auditOutbox.findMany(), tx.auditOutbox.count()]), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("reads a model indexed by an untagged template literal", () => {
    // `` tx[`tenantMember`] `` is a static name in a third spelling.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => tx[\`tenantMember\`].findMany(), BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    ${source}
  }, BYPASS_PURPOSE.AUDIT);
}`);
      expect(code).toBe(1);
      expect(stderr).toContain("prisma.tenantMember");
    }
  });

  it("inherits the client through a bracket-spelled nested $transaction", () => {
    // `tx["$transaction"]` is `tx.$transaction`. Recognising only the dotted
    // form loses the inner callback's client.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) =>
    tx["$transaction"](async (inner) => inner.tenantMember.findMany()), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("passes every static member spelling when it stays within the allowlist", () => {
    // The allow side for all four above at once: string-key destructuring, a
    // template index, and a bracket-spelled nested transaction.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const { "auditOutbox": ao } = tx;
    await tx[\`auditOutbox\`].findMany();
    return tx["$transaction"](async (inner) => inner.auditOutbox.count()) && ao.count();
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("ignores an index computed from a variable", () => {
    // A client indexed by a non-literal names no model this gate can read, and
    // `row[key]` on a query result must not be invented as one.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain(key: string) {
  return withBypassRls(prisma, async (tx) => {
    const row = await tx.auditOutbox.findFirst();
    return row[key];
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("reports a client argument it cannot name instead of scanning without it", () => {
    // `getClient()` reduces to no name, so the client set is incomplete and any
    // access through the returned value is invisible. Scanning anyway would
    // spell "could not read this callback" as "no violations".
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(getClient(), async (tx) => tx.auditOutbox.findMany(), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("cannot name");
  });

  it("follows a client supplied as a parameter default", () => {
    // `function drain(db = prisma)` — the binding may carry the client, and for
    // a CLIENT over-approximating only reports more models. (callbackOf refuses
    // a parameter default for the opposite reason: guessing which function runs
    // is fail-open. Same construct, different question, different answer.)
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain(db = prisma) {
  return withBypassRls(prisma, async (tx) => {
    await tx.auditOutbox.findMany();
    return db.tenantMember.findMany();
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("passes an aliased-import client and a parameter default within the allowlist", () => {
    // The allow side for both of the above.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { prisma as db } from "@/lib/prisma";
export async function drain(alt = db) {
  return withBypassRls(db, async (tx) => {
    await tx.auditOutbox.findMany();
    return alt.auditOutbox.count();
  }, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const row = await tx.auditOutbox.findFirst();
    return row.tenantMember;
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("passes an alias and a destructured delegate that stay within the allowlist", () => {
    // The allow side for both: following the value must not turn every local
    // binding into a violation.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (tx) => {
    const db = tx;
    const { auditOutbox } = db;
    const rows = await auditOutbox.findMany();
    return db.auditOutbox.count({ where: { id: rows[0]?.id } });
  }, BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("reads models through a rest element rather than reporting the rest name", () => {
    // `...rest` binds the remaining client, so it is a receiver. Treating it as
    // a model both invents `prisma.rest` and hides everything reached through it.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async ({ auditOutbox, ...rest }) => rest.user.deleteMany(), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.user");
    expect(stderr).not.toContain("prisma.rest");
  });

  it("passes a destructured client that only takes allowed delegates", () => {
    // The allow side for both destructuring paths: the named property is an
    // allowed model and the rest binding reaches nothing.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async ({ auditOutbox, ...rest }) => auditOutbox.findMany(), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("resolves a callback declared as a function declaration", () => {
    // `async function job(tx)` is a FunctionDeclaration, not a VariableDeclaration,
    // so round 4's by-name lookup missed it and reported the site as unresolvable
    // — and the remedy it printed (allowlist the file) would have unscanned the
    // whole file. Prior verdict: exit 1, "could not be resolved".
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
async function job(tx) { return tx.tenantMember.findFirst({}); }
export async function drain() {
  return withBypassRls(prisma, job, BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async ({ tenantMember }) => tenantMember.findFirst({}), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("prisma.tenantMember");
  });

  it("flags an unused client parameter whatever it is named", () => {
    // F3 keyed on the spelling `tx`, so renaming the unused parameter defeated
    // the rule that exists to enforce the naming convention. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (db) => legacy(), BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain(cfg) {
  return withBypassRls(prisma, async (tx) => legacy(cfg.tx), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(1);
    expect(stderr).toContain("never uses it");
  });

  it("passes a client parameter that is genuinely used", () => {
    // The allow side for the whole F3 predicate: a used binding must never be
    // reported, whatever it is named.
    const { code, stdout } = run("src/lib/audit/audit-outbox.ts", `
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export async function drain() {
  return withBypassRls(prisma, async (db) => db.auditOutbox.findMany(), BYPASS_PURPOSE.AUDIT);
}`);
    expect(code).toBe(0);
    expect(stdout).toContain("check-bypass-rls: OK");
  });

  it("catches an aliased import written with a file extension", () => {
    // The alias table keyed on a module-specifier text tail (/tenant-rls$/), so
    // '@/lib/tenant-rls.js' — the same module — resolved no aliases and the call
    // escaped the file allowlist. Prior verdict: exit 0.
    const { code, stderr } = run("src/lib/sneaky/route.ts", `
import { withBypassRls as wb, BYPASS_PURPOSE } from "@/lib/tenant-rls.js";
export async function sneaky() {
  return wb(prisma, async (tx) => tx.tenantMember.findFirst({}), BYPASS_PURPOSE.AUDIT);
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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
export default async function Page() {
  const row = await withBypassRls(prisma, async (tx) => tx.${model}.findFirst({}), BYPASS_PURPOSE.SHARE);
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
