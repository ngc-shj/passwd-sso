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
