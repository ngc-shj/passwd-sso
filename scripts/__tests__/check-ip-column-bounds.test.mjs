/**
 * Self-test for check-ip-column-bounds.mjs.
 *
 * The gate exists because a hand-list failed at this exact class twice: the
 * audit emitter was bounded on its own, and two independent reviews of that fix
 * each enumerated a different, incomplete subset of the remaining writers. So
 * the arms below are per-SHAPE, not per-file — each of the three shapes the gate
 * recognises gets its own deny case, because one case covering all three passes
 * on a gate that models only one of them.
 *
 * Every case runs against a SYNTHETIC root, so none depends on the real tree and
 * none can be made green by editing a real write site.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const GATE = join(REPO_ROOT, "scripts/checks/check-ip-column-bounds.mjs");

const roots = [];

/** A synthetic src/ tree holding exactly the files given. */
function makeRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "ip-column-bounds-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, "src", rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return root;
}

function runGate(root, extraEnv = {}) {
  const res = spawnSync("node", [GATE], {
    encoding: "utf8",
    env: {
      ...process.env,
      IP_COLUMN_BOUNDS_ROOT: root,
      IP_COLUMN_BOUNDS_FIXTURE_MODE: "1",
      ...extraEnv,
    },
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Shape (a): a Prisma write on one of the three bounded models. */
const prismaWrite = (value) => `
export async function f(tx: any, ip: string | null) {
  await tx.shareAccessLog.create({ data: { shareId: "s", ip: ${value} } });
}
`;

/** Shape (b): an object literal returned from a `: AuditOutboxPayload` function. */
const payloadBuilder = (value) => `
import type { AuditOutboxPayload } from "@/lib/audit/audit-outbox";
export function build(ip: string | null): AuditOutboxPayload {
  return { scope: "PERSONAL", ip: ${value} } as AuditOutboxPayload;
}
`;

/** Shape (c): an object-literal argument to an `enqueueAudit*` call. */
const enqueueArg = (value) => `
declare function enqueueAuditInWorkerTx(tx: any, t: string, p: any): Promise<void>;
export async function f(tx: any, ip: string | null) {
  await enqueueAuditInWorkerTx(tx, "t", { scope: "TENANT", ip: ${value} });
}
`;

const BOUND = "ip?.slice(0, SHARE_ACCESS_IP_MAX_LENGTH) ?? null";
const AUDIT_BOUND = "ip?.slice(0, AUDIT_IP_MAX_LENGTH) ?? null";

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("check-ip-column-bounds", () => {
  it("PASSES when every recognised shape slices to a named column-width constant", () => {
    // The allow arm, and it carries all three shapes: every deny case below is
    // satisfiable by a gate that refuses unconditionally.
    const r = runGate(
      makeRoot({
        "a.ts": prismaWrite(BOUND),
        "b.ts": payloadBuilder(AUDIT_BOUND),
        "c.ts": enqueueArg(AUDIT_BOUND),
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("3 write site(s)");
    expect(r.stdout).toContain("3 ip propert(ies)");
  });

  it("CATCHES an unbounded ip in a Prisma write on a bounded model", () => {
    const r = runGate(makeRoot({ "a.ts": prismaWrite("ip") }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("a.ts");
    expect(r.stderr).toContain("unbounded IP write");
  });

  it("CATCHES an unbounded ip in an AuditOutboxPayload builder", () => {
    // The shape the audit emitter itself has. A gate anchored only on Prisma
    // writes reports OK here — which is the site the whole class started at.
    const r = runGate(makeRoot({ "b.ts": payloadBuilder("ip") }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("b.ts");
  });

  it("CATCHES an unbounded ip in an enqueueAudit* argument object", () => {
    // The retention sweep's shape: a payload assembled at the call site and
    // handed straight to the worker enqueue, never passing the emitter.
    const r = runGate(makeRoot({ "c.ts": enqueueArg("ip") }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("c.ts");
  });

  it("CATCHES a slice to a bare number, which is the tie to the schema being cut", () => {
    // `.slice(0, 45)` bounds the value and passes review; it also detaches the
    // number from the column, so widening the column leaves the write clamped
    // at the old width with nothing pointing at the reason.
    const r = runGate(makeRoot({ "a.ts": prismaWrite("ip?.slice(0, 45) ?? null") }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("a.ts");
  });

  it("PASSES a literal null, which is not an IP the caller supplied", () => {
    // The boundary-adjacent allow case for the clause above: several real write
    // sites pass `ip: null` outright, and a gate that demanded a slice there
    // would be refusing correct code.
    const r = runGate(makeRoot({ "a.ts": prismaWrite("null"), "c.ts": enqueueArg(AUDIT_BOUND) }));
    expect(r.status).toBe(0);
  });

  it("IGNORES a Prisma write on a model with no bounded IP column", () => {
    // Scope, stated as a case: `users` has no VarChar(45) IP, and a gate that
    // fired on every `ip:` anywhere would be un-adoptable noise.
    const r = runGate(
      makeRoot({
        "d.ts": `export async function f(tx: any, ip: string) {
          await tx.user.create({ data: { ip } });
        }`,
        "c.ts": enqueueArg(AUDIT_BOUND),
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 write site(s)");
  });

  it("REFUSES when it recognises no write site, rather than passing vacuously", () => {
    // The floor. A file with no recognised shape leaves the violation list
    // empty — which is indistinguishable from a clean tree unless the count of
    // things EXAMINED is checked too.
    const r = runGate(makeRoot({ "e.ts": "export const x = 1;\n" }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("recognised 0 write sites");
  });

  it("REFUSES when it recognises write sites but no ip property, naming that separately", () => {
    // The second floor, and it must be its own message: the field being renamed
    // is a different failure from the write shape moving, and a summed floor
    // cannot tell them apart.
    const r = runGate(
      makeRoot({
        "f.ts": `export async function f(tx: any) {
          await tx.session.create({ data: { userId: "u" } });
        }`,
      }),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("0 ip properties");
  });

  it("REFUSES when the scan root holds no source files", () => {
    const root = mkdtempSync(join(tmpdir(), "ip-column-bounds-empty-"));
    roots.push(root);
    const r = runGate(root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("scanned 0 source files");
  });

  it("REFUSES a scan-root override in CI without fixture mode", () => {
    // The env-pollution guard. Without a case it is never entered, because
    // every other case here sets fixture mode.
    const res = spawnSync("node", [GATE], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "true",
        IP_COLUMN_BOUNDS_ROOT: makeRoot({ "a.ts": prismaWrite(BOUND) }),
        IP_COLUMN_BOUNDS_FIXTURE_MODE: "",
      },
      timeout: 60_000,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("IP_COLUMN_BOUNDS_ROOT must not be set");
  });

  it("is wired into scripts/pre-pr.sh", () => {
    // The gate's only execution path. Anchored at line start so a commented-out
    // `# DISABLED: queue_step …` does not satisfy it — that is disarming, not
    // deletion, and `toContain` returns true for both.
    const prePr = readFileSync(join(REPO_ROOT, "scripts/pre-pr.sh"), "utf8");
    expect(prePr).toMatch(/^queue_step .*check-ip-column-bounds\.mjs\s*$/m);
  });
});
