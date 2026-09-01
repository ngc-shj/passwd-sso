/**
 * Self-test for check-ip-column-bounds.mjs.
 *
 * The gate exists because a hand-list failed at this class four times, so the
 * arms here are PER MEMBER rather than per shape: every (model, property) pair
 * the gate watches gets its own deny case and its own floor case, generated from
 * the manifest below. A single case covering several members proves none of
 * them — that is the defect the first version of this file shipped with, where
 * no fixture spelled `ipAddress` at all and deleting it from the gate left both
 * the self-test and the real tree green.
 *
 * MEMBERS below is deliberately a SECOND statement of the gate's own manifest,
 * not an import of it. A test that reads the subject's list can only ever agree
 * with it; the last case asserts the two agree exactly, so a member added to one
 * and not the other is a failure rather than a silent gap.
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

/** member → the constant that member's column must be sliced to. */
const MEMBERS = {
  "auditLog.ip": "AUDIT_IP_MAX_LENGTH",
  "auditLog.userAgent": "USER_AGENT_MAX_LENGTH",
  "shareAccessLog.ip": "SHARE_ACCESS_IP_MAX_LENGTH",
  "shareAccessLog.userAgent": "USER_AGENT_MAX_LENGTH",
  "session.ipAddress": "SESSION_IP_MAX_LENGTH",
  "session.userAgent": "USER_AGENT_MAX_LENGTH",
  "extensionBridgeCode.ip": "EXTENSION_BRIDGE_CODE_IP_MAX_LENGTH",
  "extensionBridgeCode.userAgent": "EXTENSION_BRIDGE_CODE_USER_AGENT_MAX_LENGTH",
  "mobileBridgeCode.ip": "MOBILE_BRIDGE_CODE_IP_MAX_LENGTH",
  "mobileBridgeCode.userAgent": "MOBILE_BRIDGE_CODE_USER_AGENT_MAX_LENGTH",
  "extensionToken.lastUsedIp": "EXTENSION_TOKEN_LAST_USED_IP_MAX_LENGTH",
  "payload.ip": "AUDIT_IP_MAX_LENGTH",
  "payload.userAgent": "USER_AGENT_MAX_LENGTH",
};
const MEMBER_NAMES = Object.keys(MEMBERS);

/**
 * Every fixture imports the constants from the real module path, because the
 * gate now requires the slice bound to RESOLVE there and not merely to be
 * spelled right. A fixture that omitted this would read as unbounded
 * everywhere — which is how this line came to exist.
 */
const CONSTANT_IMPORT =
  `import {\n${[...new Set(Object.values(MEMBERS))].map((c) => `  ${c},`).join("\n")}\n} from "@/lib/validations/common.server";\n`;

const roots = [];

function propsFor(model, { unbound, omit } = {}) {
  return MEMBER_NAMES.filter((m) => m.startsWith(`${model}.`))
    .filter((m) => m !== omit)
    .map((m) => {
      const prop = m.slice(model.length + 1);
      if (m === unbound) return `${prop}: raw`;
      return `${prop}: raw?.slice(0, ${MEMBERS[m]}) ?? null`;
    })
    .join(", ");
}

/**
 * A synthetic src/ tree carrying every member exactly once, with at most one
 * member either unbounded or omitted.
 */
function makeRoot(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "ip-column-bounds-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });

  const prismaModels = ["auditLog", "shareAccessLog", "session", "extensionBridgeCode", "mobileBridgeCode", "extensionToken"];
  const writes = prismaModels
    .map((m) => {
      const props = propsFor(m, opts);
      return props ? `  await tx.${m}.create({ data: { ${props} } });` : "";
    })
    .filter(Boolean)
    .join("\n");
  writeFileSync(
    join(root, "src/a.ts"),
    `${CONSTANT_IMPORT}export async function f(tx: any, raw: string | null) {\n${writes}\n}\n`,
    "utf8",
  );

  const payloadProps = propsFor("payload", opts);
  writeFileSync(
    join(root, "src/b.ts"),
    CONSTANT_IMPORT +
      `import type { AuditOutboxPayload } from "@/lib/audit/audit-outbox";\n` +
      `export function build(raw: string | null): AuditOutboxPayload {\n` +
      `  return { scope: "PERSONAL"${payloadProps ? `, ${payloadProps}` : ""} } as AuditOutboxPayload;\n}\n`,
    "utf8",
  );
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

/** A one-file root for the shape cases, which do not need every member. */
function makeShapeRoot(body, { withPayload = true, withConstantImport = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ip-column-shape-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/shape.ts"), (withConstantImport ? CONSTANT_IMPORT : "") + body, "utf8");
  if (withPayload) {
    // The floors demand every member be seen; the shape cases are about one
    // property, so the rest of the manifest is supplied here.
    const prismaModels = ["auditLog", "shareAccessLog", "session", "extensionBridgeCode", "mobileBridgeCode", "extensionToken"];
    const writes = prismaModels
      .map((m) => `  await tx.${m}.create({ data: { ${propsFor(m)} } });`)
      .join("\n");
    writeFileSync(
      join(root, "src/rest.ts"),
      CONSTANT_IMPORT +
        `import type { AuditOutboxPayload } from "@/lib/audit/audit-outbox";\n` +
        `export async function f(tx: any, raw: string | null) {\n${writes}\n}\n` +
        `export function build(raw: string | null): AuditOutboxPayload {\n` +
        `  return { ${propsFor("payload")} } as AuditOutboxPayload;\n}\n`,
      "utf8",
    );
  }
  return root;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("check-ip-column-bounds", () => {
  it("PASSES when every member slices to its own column's constant", () => {
    // The allow arm. Every deny arm below is satisfiable by a gate that refuses
    // unconditionally, and every floor by one that refuses on any absence.
    const r = runGate(makeRoot());
    expect(r.status).toBe(0);
    for (const m of MEMBER_NAMES) expect(r.stdout).toContain(`${m} 1`);
  });

  it.each(MEMBER_NAMES)("CATCHES an unbounded %s", (member) => {
    const r = runGate(makeRoot({ unbound: member }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(member);
    expect(r.stderr).toContain(MEMBERS[member]);
    // Scoped: only the mutated member is reported, so the cases are separable.
    expect(r.stderr).toContain("1 unbounded write(s)");
  });

  it.each(MEMBER_NAMES)("REFUSES when %s is never seen, naming that member", (member) => {
    // The per-member floor. A summed floor passes every one of these: the other
    // twelve members keep the total non-zero, which is exactly how the first
    // version of this gate stayed green with a whole model unwatched.
    const r = runGate(makeRoot({ omit: member }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("never saw");
    expect(r.stderr).toContain(member);
  });

  it("CATCHES a slice to a SIBLING column's constant, not just a missing one", () => {
    // The three 45-wide constants are equal today. Accepting any of them makes
    // them decorative and defeats the reason they are separate: the day one
    // column widens, the mis-sliced write is a 22001 the gate approved.
    const r = runGate(
      makeShapeRoot(
        `export async function f(tx: any, raw: string | null) {\n` +
          `  await tx.shareAccessLog.create({ data: { ip: raw?.slice(0, SESSION_IP_MAX_LENGTH) ?? null } });\n}\n`,
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("shareAccessLog.ip");
    expect(r.stderr).toContain("SHARE_ACCESS_IP_MAX_LENGTH");
  });

  it("CATCHES a slice to a bare number, which is the tie to the schema being cut", () => {
    const r = runGate(
      makeShapeRoot(
        `export async function f(tx: any, raw: string | null) {\n` +
          `  await tx.session.create({ data: { ipAddress: raw?.slice(0, 45) ?? null } });\n}\n`,
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("session.ipAddress");
  });

  it("CATCHES a ternary with only ONE bounded arm", () => {
    // A descendant search for `.slice(` accepts this — the slice IS somewhere
    // underneath — while one path through the value reaches the column raw.
    const r = runGate(
      makeShapeRoot(
        `export async function f(tx: any, raw: string | null, flag: boolean) {\n` +
          `  await tx.session.create({ data: { ipAddress: flag ? raw : raw?.slice(0, SESSION_IP_MAX_LENGTH) ?? null } });\n}\n`,
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("session.ipAddress");
  });

  it("PASSES a conditional whose every arm is bounded", () => {
    // The boundary-adjacent allow case for the clause above, and a real shape:
    // sweep.ts writes `cond ? String(x).slice(0, C) : null`.
    const r = runGate(
      makeShapeRoot(
        `export async function f(tx: any, raw: string | null) {\n` +
          `  await tx.session.create({ data: { ipAddress: raw != null ? String(raw).slice(0, SESSION_IP_MAX_LENGTH) : null } });\n}\n`,
      ),
    );
    expect(r.status).toBe(0);
  });

  it("CATCHES a shorthand property, whose binding it cannot see", () => {
    const r = runGate(
      makeShapeRoot(
        `export async function f(tx: any, ipAddress: string | null) {\n` +
          `  await tx.session.create({ data: { ipAddress } });\n}\n`,
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("shorthand");
  });

  it("PASSES an authored string literal, which is not a request-derived value", () => {
    // sweep.ts writes `userAgent: "retention-gc-worker"`. A constant in the
    // source is neither caller-controlled nor able to change at runtime;
    // demanding a slice there would be refusing correct code.
    const r = runGate(
      makeShapeRoot(
        `export async function f(tx: any) {\n` +
          `  await tx.session.create({ data: { userAgent: "retention-gc-worker" } });\n}\n`,
      ),
    );
    expect(r.status).toBe(0);
  });

  it("reads upsert's create and update, which carry no `data` key", () => {
    const r = runGate(
      makeShapeRoot(
        `export async function f(tx: any, raw: string | null) {\n` +
          `  await tx.session.upsert({ where: { id: "x" }, create: { ipAddress: raw }, update: { ipAddress: raw } });\n}\n`,
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("2 unbounded write(s)");
  });

  it("reads createMany's array elements", () => {
    const r = runGate(
      makeShapeRoot(
        `export async function f(tx: any, raw: string | null) {\n` +
          `  await tx.session.createMany({ data: [{ ipAddress: raw }, { ipAddress: raw }] });\n}\n`,
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("2 unbounded write(s)");
  });

  it("CATCHES an unbounded value in an enqueueAudit* argument object", () => {
    const r = runGate(
      makeShapeRoot(
        `declare function enqueueAuditInWorkerTx(tx: any, t: string, p: any): Promise<void>;\n` +
          `export async function f(tx: any, raw: string | null) {\n` +
          `  await enqueueAuditInWorkerTx(tx, "t", { ip: raw });\n}\n`,
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("payload.ip");
  });

  it("resolves `data: <identifier>` built from a local const plus later assignments", () => {
    // The shape validate-token-dpop.ts uses, and the one the first rewrite
    // skipped: reverting that file's slice left the gate at exit 0, because the
    // per-member floor still saw the property at three OTHER sites.
    const r = runGate(
      makeShapeRoot(
        `import { SESSION_IP_MAX_LENGTH } from "@/lib/validations/common.server";\n` +
          `export async function f(tx: any, raw: string | null) {\n` +
          `  const updateData: Record<string, unknown> = { userAgent: null };\n` +
          `  updateData.ipAddress = raw;\n` +
          `  await tx.session.update({ where: { id: "x" }, data: updateData });\n}\n`,
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("session.ipAddress");
  });

  it("PASSES the same shape when the assignment IS bounded", () => {
    // The allow arm: resolution must not turn every indirected write into a
    // violation, or the fix is a refusal dressed as coverage.
    const r = runGate(
      makeShapeRoot(
        `import { SESSION_IP_MAX_LENGTH } from "@/lib/validations/common.server";\n` +
          `export async function f(tx: any, raw: string | null) {\n` +
          `  const updateData: Record<string, unknown> = { userAgent: null };\n` +
          `  updateData.ipAddress = raw?.slice(0, SESSION_IP_MAX_LENGTH) ?? null;\n` +
          `  await tx.session.update({ where: { id: "x" }, data: updateData });\n}\n`,
      ),
    );
    expect(r.status).toBe(0);
  });

  it("REFUSES a data object it cannot resolve, rather than skipping the site", () => {
    // "I looked and it was wrong" and "I could not look" need different repairs.
    // Skipping was the first rewrite's behaviour and it is what hid the site
    // above.
    const r = runGate(
      makeShapeRoot(
        `declare const build: () => Record<string, unknown>;\n` +
          `export async function f(tx: any) {\n` +
          `  await tx.session.update({ where: { id: "x" }, data: build() });\n}\n`,
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not read the row data");
  });

  it("CATCHES a same-named constant that is declared locally rather than imported", () => {
    // The name is necessary and not sufficient. Accepting any binding spelled
    // right makes the per-column constants decorative — a local
    // `const SESSION_IP_MAX_LENGTH = 100000` would license any width at all.
    const r = runGate(
      makeShapeRoot(
        `const SESSION_IP_MAX_LENGTH = 100000;\n` +
          `export async function f(tx: any, raw: string | null) {\n` +
          `  await tx.session.create({ data: { ipAddress: raw?.slice(0, SESSION_IP_MAX_LENGTH) ?? null } });\n}\n`,
        { withConstantImport: false },
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("session.ipAddress");
  });

  it("IGNORES a write to a model with no length-bounded request column", () => {
    // Scope, stated as a case: a gate that fired on every `ip:` anywhere would
    // be un-adoptable noise.
    const r = runGate(
      makeShapeRoot(
        `export async function f(tx: any, ip: string) {\n  await tx.user.create({ data: { ip } });\n}\n`,
      ),
    );
    expect(r.status).toBe(0);
  });

  it("REFUSES when it recognises no write site at all", () => {
    const r = runGate(makeShapeRoot("export const x = 1;\n", { withPayload: false }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("recognised 0 write sites");
  });

  it("REFUSES when the scan root holds no source files", () => {
    const root = mkdtempSync(join(tmpdir(), "ip-column-bounds-empty-"));
    roots.push(root);
    const r = runGate(root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("scanned 0 source files");
  });

  it("REFUSES a scan-ROOT override in CI without fixture mode", () => {
    const res = spawnSync("node", [GATE], {
      encoding: "utf8",
      env: { ...process.env, CI: "true", IP_COLUMN_BOUNDS_ROOT: makeRoot(), IP_COLUMN_BOUNDS_FIXTURE_MODE: "" },
      timeout: 60_000,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("must not be set in CI");
  });

  it("REFUSES a scan-DIRS override in CI without fixture mode", () => {
    // The second override, and the half the first version of this guard omitted.
    // Narrowing is the same attack as redirecting: pointing CI at a handful of
    // files satisfies every floor and prints OK.
    const res = spawnSync("node", [GATE], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "true",
        IP_COLUMN_BOUNDS_DIRS: "src/lib/auth/session",
        IP_COLUMN_BOUNDS_FIXTURE_MODE: "",
      },
      timeout: 60_000,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("must not be set in CI");
  });

  it("still runs under CI when fixture mode is set — the override exists for this file", () => {
    // The allow arm for both guard clauses. A guard that refused unconditionally
    // in CI would make every case above unrunnable there.
    const r = runGate(makeRoot(), { CI: "true" });
    expect(r.status).toBe(0);
  });

  it("watches exactly the members this file knows about", () => {
    // The two manifests are stated independently; this is what makes the
    // duplication load-bearing rather than redundant. A member added to the gate
    // without a case here fails, and vice versa.
    const r = runGate(makeRoot());
    expect(r.status).toBe(0);
    // Anchored past `write site(s)` — an unanchored `\(([^)]+)\)` matches that
    // literal `(s)` first and compares the manifest against ["s"].
    const printed = (r.stdout.match(/write site\(s\) \(([^)]+)\)/)?.[1] ?? "")
      .split(", ")
      .map((s) => s.replace(/ \d+$/, ""))
      .sort();
    expect(printed).toEqual([...MEMBER_NAMES].sort());
  });

  it("is wired into scripts/pre-pr.sh", () => {
    // The gate's only execution path. Anchored at line start so a commented-out
    // `# DISABLED: queue_step …` does not satisfy it.
    const prePr = readFileSync(join(REPO_ROOT, "scripts/pre-pr.sh"), "utf8");
    expect(prePr).toMatch(/^queue_step .*check-ip-column-bounds\.mjs\s*$/m);
  });
});
