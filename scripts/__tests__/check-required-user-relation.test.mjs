import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const GATE = join(REPO, "scripts", "checks", "check-required-user-relation.mjs");
const MANIFEST_REL = "scripts/checks/required-user-relation-manifest.json";

let root;

function run() {
  try {
    return {
      code: 0,
      out: execFileSync("node", [GATE], {
        encoding: "utf8",
        env: { ...process.env, REQUIRED_USER_RELATION_CHECK_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function write(rel, body) {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function manifest(obj) {
  write(MANIFEST_REL, JSON.stringify(obj, null, 2));
}

/** A refusal names the relation, so a gate that crashes — also exit 1 — does not pass (round 10 T-R10-2). */
function expectRefusal() {
  const { code, out } = run();
  expect(code, out).toBe(1);
  expect(out).toContain("TenantMember.user");
}

/**
 * The gate classifies a relation by what the schema DECLARES — its type and its
 * optionality — so the fixture supplies one. `Share.approver` is the optional
 * relation the gate must leave alone; the others are required.
 */
const SCHEMA = `model User {
  id       String @id
  email    String
  tenantId String
}

model TenantMember {
  id            String    @id
  userId        String
  user          User      @relation(fields: [userId], references: [id])
  deactivatedAt DateTime?
}

model Team {
  id      String       @id
  ownerId String
  owner   User         @relation(fields: [ownerId], references: [id])
  members TeamMember[]
}

model TeamMember {
  id     String @id
  teamId String
  team   Team   @relation(fields: [teamId], references: [id])
  userId String
  user   User   @relation(fields: [userId], references: [id])
}

model Share {
  id         String  @id
  approverId String?
  approver   User?   @relation(fields: [approverId], references: [id])
}
`;

const inTenant = (body) => `export async function f() {\n  return withTenantRls(prisma, tenantId, async (tx) => ${body});\n}\n`;
const inBypass = (body) => `export async function f() {\n  return withBypassRls(prisma, async (tx) => ${body}, PURPOSE);\n}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "required-user-relation-"));
  mkdirSync(join(root, "src"), { recursive: true });
  write("prisma/schema.prisma", SCHEMA);
  manifest({});
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-required-user-relation", () => {
  it("flags a read in a tenant context that includes a required User relation", () => {
    write("src/lib/a.ts", inTenant("tx.tenantMember.findMany({ include: { user: true } })"));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("src/lib/a.ts:");
    expect(out).toContain("TenantMember.user");
  });

  it("flags a read with no opener of its own, because its caller's context is unknown", () => {
    // A service function: fail-closed, the shape every S2 member in a service had.
    write(
      "src/lib/service.ts",
      "export async function f() {\n  return prisma.tenantMember.findFirst({ select: { user: { select: { email: true } } } });\n}\n",
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("src/lib/service.ts:");
  });

  it("passes the same read inside a bypass", () => {
    write("src/lib/a.ts", inBypass("tx.tenantMember.findMany({ include: { user: true } })"));
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain("OK");
  });

  it("passes a read inside a local wrapper that opens a bypass", () => {
    write(
      "src/lib/a.ts",
      "const lookup = (fn) => withBypassRls(prisma, fn, PURPOSE);\n" +
        "export const f = () => lookup(async (tx) => tx.tenantMember.findMany({ include: { user: true } }));\n",
    );
    expect(run().code).toBe(0);
  });

  it("does not trust a wrapper that reaches both a bypass and a tenant opener", () => {
    write(
      "src/lib/a.ts",
      "function either(fn, admin) {\n  return admin ? withBypassRls(prisma, fn, PURPOSE) : withTenantRls(prisma, t, fn);\n}\n" +
        "export const f = () => either(async (tx) => tx.tenantMember.findMany({ include: { user: true } }), false);\n",
    );
    expectRefusal();
  });

  it("flags a count whose where filters through a required User relation", () => {
    // The omission half: the row is dropped from the page AND from the total.
    write("src/lib/a.ts", inTenant("tx.tenantMember.count({ where: { user: { is: { email: { not: null } } } } })"));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TenantMember.where.user<filter>");
  });

  it("follows logical branches and relation filters down to a required User relation", () => {
    write(
      "src/lib/a.ts",
      inTenant('tx.teamMember.findMany({ where: { OR: [{ team: { is: { owner: { email: "x" } } } }] } })'),
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TeamMember.where.OR.team.is.owner<filter>");
  });

  it("follows a nested projection down to a required User relation", () => {
    write("src/lib/a.ts", inTenant("tx.teamMember.findMany({ select: { team: { select: { owner: true } } } })"));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TeamMember.team.owner");
  });

  it("leaves an optional User relation alone", () => {
    write("src/lib/a.ts", inTenant("tx.share.findMany({ include: { approver: true } })"));
    expect(run().code).toBe(0);
  });

  it("flags a write that returns a required User relation", () => {
    write("src/lib/a.ts", inTenant("tx.teamMember.update({ where: { id }, include: { user: true } })"));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("update -> TeamMember.user");
  });

  it("fails closed on a projection spread it cannot read", () => {
    write("src/lib/a.ts", inTenant("tx.tenantMember.findMany({ select: { ...BASE, id: true } })"));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("<spread>");
  });

  it("passes a declared exception whose call count matches", () => {
    write("src/lib/a.ts", inTenant("tx.teamMember.findMany({ include: { user: true } })"));
    manifest({ "src/lib/a.ts": { disposition: "actor", reason: "the requesting user", calls: 1 } });
    expect(run().code).toBe(0);
  });

  it("fails when a call is added to a file whose entry covered fewer", () => {
    // The per-file hole the bypass allowlist names in itself: a new call inside an
    // already-listed file must not be excused by an entry written for another.
    write(
      "src/lib/a.ts",
      inTenant("tx.teamMember.findMany({ include: { user: true } })") +
        "export const g = () => withTenantRls(prisma, t, async (tx) => tx.tenantMember.findFirst({ include: { user: true } }));\n",
    );
    manifest({ "src/lib/a.ts": { disposition: "actor", reason: "the requesting user", calls: 1 } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("manifest covers 1 call(s) but the file has 2");
  });

  it("fails on an entry whose file no longer has a matching call", () => {
    write("src/lib/a.ts", inBypass("tx.tenantMember.findMany({ include: { user: true } })"));
    manifest({ "src/lib/a.ts": { disposition: "actor", reason: "the requesting user", calls: 1 } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("no matching call left");
  });

  it("fails on an entry with no reason or an unknown disposition", () => {
    write("src/lib/a.ts", inTenant("tx.teamMember.findMany({ include: { user: true } })"));
    manifest({ "src/lib/a.ts": { disposition: "trusted", calls: 1 } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain('unknown disposition "trusted"');
    expect(out).toContain("has no reason");
  });

  it("refuses to report clean when it scanned nothing", () => {
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("scanned zero source files");
  });
});

describe("check-required-user-relation — context by scope, not by spelling (round 5 S3/T2)", () => {
  const READ = "tx.tenantMember.findMany({ include: { user: true } })";

  it("does not trust an import aliased to the bypass opener's name", () => {
    write(
      "src/lib/a.ts",
      'import { withTenantRls as withBypassRls } from "@/lib/tenant-rls";\n' +
        `export const f = () => withBypassRls(prisma, async (tx) => ${READ});\n`,
    );
    expectRefusal();
  });

  it("trusts the bypass opener imported under another name", () => {
    write(
      "src/lib/a.ts",
      'import { withBypassRls as runBypassed } from "@/lib/tenant-rls";\n' +
        `export const f = () => runBypassed(prisma, async (tx) => ${READ}, PURPOSE);\n`,
    );
    expect(run().code).toBe(0);
  });

  it("does not trust a parameter that shadows a local bypass wrapper", () => {
    write(
      "src/lib/a.ts",
      "const run = (fn) => withBypassRls(prisma, fn, PURPOSE);\n" +
        `export async function b(run) {\n  return run(async (tx) => ${READ});\n}\n`,
    );
    expectRefusal();
  });

  it("resolves a wrapper name to the declaration in its own function, not a sibling's", () => {
    write(
      "src/lib/a.ts",
      "export function a() {\n  const run = (fn) => withBypassRls(prisma, fn, PURPOSE);\n  return run(async (tx) => tx.share.findMany());\n}\n" +
        `export function b() {\n  const run = (fn) => withTenantRls(prisma, t, fn);\n  return run(async (tx) => ${READ});\n}\n`,
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("src/lib/a.ts:");
  });

  it("does not trust a wrapper that opens a bypass but runs the callback outside it", () => {
    write(
      "src/lib/a.ts",
      "async function guarded(fn) {\n  await withBypassRls(prisma, async (tx) => tx.share.findMany(), PURPOSE);\n  return fn(prisma);\n}\n" +
        `export const f = () => guarded(async (tx) => ${READ});\n`,
    );
    expectRefusal();
  });
});

describe("check-required-user-relation — where given by name, and nested (round 5 T3)", () => {
  it("follows a shorthand where to the const it names", () => {
    write(
      "src/lib/a.ts",
      "export function f() {\n  const where = { user: { is: { email: { not: null } } } };\n" +
        "  return withTenantRls(prisma, t, async (tx) => tx.tenantMember.count({ where }));\n}\n",
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TenantMember.where.user<filter>");
  });

  it("follows a named where to the const it names", () => {
    write(
      "src/lib/a.ts",
      "export function f() {\n  const prismaWhere = { user: { is: { email: { not: null } } } };\n" +
        "  return withTenantRls(prisma, t, async (tx) => tx.tenantMember.count({ where: prismaWhere }));\n}\n",
    );
    // A filter hit names its path through the where (round 11 T-R11-2).
    const { code, out } = run();
    expect(code, out).toBe(1);
    expect(out).toContain("TenantMember.where.user<filter>");
  });

  it("reports a where it cannot read because something assigns into it", () => {
    write(
      "src/lib/a.ts",
      "export function f(email) {\n  const where = { deactivatedAt: null };\n  if (email) where.user = { is: { email } };\n" +
        "  return withTenantRls(prisma, t, async (tx) => tx.tenantMember.count({ where }));\n}\n",
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("<unreadable-where>");
  });

  it("passes a named where that filters only on scalar columns", () => {
    write(
      "src/lib/a.ts",
      "export function f(userId) {\n  const where = { userId, deactivatedAt: null };\n" +
        "  return withTenantRls(prisma, t, async (tx) => tx.tenantMember.count({ where }));\n}\n",
    );
    expect(run().code).toBe(0);
  });

  it("scans the where of a nested relation in a projection", () => {
    write(
      "src/lib/a.ts",
      inTenant('tx.team.findMany({ include: { members: { where: { user: { is: { email: "x" } } } } } })'),
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("Team.members.where.user<filter>");
  });

  it("scans both branches of a conditional where, and passes when both filter on scalars", () => {
    write("src/lib/a.ts", inTenant('tx.teamMember.findMany({ where: userId ? { userId } : { userId: "" } })'));
    expect(run().code).toBe(0);
    write("src/lib/a.ts", inTenant('tx.teamMember.findMany({ where: userId ? { userId } : { user: { is: { email: "x" } } } })'));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TeamMember.where.user<filter>");
  });

  it("accepts a dynamic-where exception whose count matches", () => {
    write(
      "src/lib/a.ts",
      "export function f(email) {\n  const where = { deactivatedAt: null };\n  if (email) where.userId = email;\n" +
        "  return withTenantRls(prisma, t, async (tx) => tx.tenantMember.count({ where }));\n}\n",
    );
    manifest({ "src/lib/a.ts": { disposition: "dynamic-where", reason: "sets deactivatedAt and userId only", calls: 1 } });
    expect(run().code).toBe(0);
  });

  it("scans the where inside _count", () => {
    write(
      "src/lib/a.ts",
      inTenant('tx.team.findMany({ select: { _count: { select: { members: { where: { user: { is: { email: "x" } } } } } } } })'),
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("Team._count.members.where.user<filter>");
  });
});

describe("check-required-user-relation — an opener's context covers its callback only (round 6 R49)", () => {
  const READ = "tx.tenantMember.findMany({ include: { user: true } })";

  it("does not trust a read in withBypassRls's client argument", () => {
    // Evaluated before the bypass opens, in whatever context the caller has.
    write(
      "src/lib/a.ts",
      "export async function f() {\n" +
        "  return withBypassRls(clientFor(await prisma.tenantMember.findFirst({ include: { user: true } })), async (tx) => tx.share.findMany(), PURPOSE);\n}\n",
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TenantMember.user");
  });

  it("does not trust a read in a function handed to withBypassRls's client argument", () => {
    // Inside a function, so only the callback position — not the rule for code
    // evaluated while arguments are built — keeps this out of the bypass.
    write(
      "src/lib/a.ts",
      "export async function f() {\n" +
        "  return withBypassRls(await clientFor(async () => prisma.tenantMember.findFirst({ include: { user: true } })), async (tx) => tx.share.findMany(), PURPOSE);\n}\n",
    );
    expectRefusal();
  });

  it("does not trust a read evaluated while the callback argument is built", () => {
    write(
      "src/lib/a.ts",
      "export async function f() {\n" +
        "  return withBypassRls(prisma, pick(await prisma.tenantMember.findFirst({ include: { user: true } })), PURPOSE);\n}\n",
    );
    expectRefusal();
  });

  it("does not trust an opener whose callback position a spread hides", () => {
    write("src/lib/a.ts", `export async function f(args) {\n  return withBypassRls(...args, async (tx) => ${READ});\n}\n`);
    expectRefusal();
  });

  it("does not trust a local wrapper when a spread hides which parameter receives the callback", () => {
    write(
      "src/lib/a.ts",
      "const run = (client, fn) => withBypassRls(client, fn, PURPOSE);\n" +
        `export const f = (args) => run(...args, async (tx) => ${READ});\n`,
    );
    expectRefusal();
  });

  it("does not let an outer bypass answer for a callback a rest parameter collects", () => {
    // There is no `params[1]`, so the wrapper looked like it had no parameter there
    // (null) and the walk went on to the bypass around the call.
    write(
      "src/lib/a.ts",
      "const run = (...args) => withTenantRls(prisma, t, args[1]);\n" +
        `export const f = () => withBypassRls(prisma, async () => run(prisma, async (tx) => ${READ}), PURPOSE);\n`,
    );
    expectRefusal();
  });
});

describe("check-required-user-relation — every fail-closed branch has a cell (round 6 RT7/RT10)", () => {
  const READ = "tx.tenantMember.findMany({ include: { user: true } })";
  /** A read in a tenant context with a `let` in scope — a value no literal answers for. */
  const withLet = (read) =>
    `export async function f(t, userId) {\n  let built = { id: "1" };\n  return withTenantRls(prisma, t, async (tx) => ${read});\n}\n`;

  it("does not trust a wrapper whose callback parameter is destructured", () => {
    write(
      "src/lib/a.ts",
      "const run = ({ fn }) => withBypassRls(prisma, fn, PURPOSE);\n" +
        `export const f = () => run({ fn: async (tx) => ${READ} });\n`,
    );
    expectRefusal();
  });

  it("does not trust a wrapper whose callback parameter is a rest parameter", () => {
    write(
      "src/lib/a.ts",
      "const run = (...args) => withBypassRls(prisma, args[0], PURPOSE);\n" +
        `export const f = () => run(async (tx) => ${READ});\n`,
    );
    expectRefusal();
  });

  it("does not trust mutually recursive wrappers, and terminates on them", () => {
    write(
      "src/lib/a.ts",
      "function ping(fn) {\n  return pong(fn);\n}\nfunction pong(fn) {\n  return ping(fn);\n}\n" +
        `export const f = () => ping(async (tx) => ${READ});\n`,
    );
    const { code, out } = run();
    expect(code).toBe(1);
    // A report, not a stack overflow: both exit 1.
    expect(out).toContain("TenantMember.user");
  });

  it("does not let an outer bypass answer for a callee bound to a parameter", () => {
    // The one shape where null and UNKNOWN differ: null walks on to the bypass.
    write(
      "src/lib/a.ts",
      `export function f(run) {\n  return withBypassRls(prisma, async () => run(async (tx) => ${READ}), PURPOSE);\n}\n`,
    );
    expectRefusal();
  });

  it("reports a where something deletes from", () => {
    write(
      "src/lib/a.ts",
      "export function f(t, all) {\n  const where = { deactivatedAt: null };\n  if (all) delete where.deactivatedAt;\n" +
        "  return withTenantRls(prisma, t, async (tx) => tx.tenantMember.count({ where }));\n}\n",
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TenantMember.where<unreadable-where>");
  });

  it("reports a where something Object.assigns onto", () => {
    write(
      "src/lib/a.ts",
      "export function f(t, email) {\n  const where = { deactivatedAt: null };\n  if (email) Object.assign(where, { user: { is: { email } } });\n" +
        "  return withTenantRls(prisma, t, async (tx) => tx.tenantMember.count({ where }));\n}\n",
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TenantMember.where<unreadable-where>");
  });

  it("reports a conditional where whose other branch it cannot read", () => {
    write("src/lib/a.ts", withLet("tx.tenantMember.count({ where: userId ? { userId } : built })"));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TenantMember.where<unreadable-where>");
  });

  it("reports a logical branch it cannot read", () => {
    write("src/lib/a.ts", withLet("tx.tenantMember.count({ where: { OR: [built] } })"));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TenantMember.where.OR<unreadable-where>");
  });

  it("reports a relation filter operand it cannot read", () => {
    write("src/lib/a.ts", withLet("tx.teamMember.findMany({ where: { team: { is: built } } })"));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TeamMember.where.team.is<unreadable-where>");
  });

  it("reports a nested relation filter it cannot read", () => {
    write("src/lib/a.ts", withLet("tx.team.findMany({ where: { members: built } })"));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("Team.where.members<unreadable-where>");
  });

  it("reads a where whose name is shared only by a sibling function's deleted binding", () => {
    write(
      "src/lib/a.ts",
      "export function g() {\n  const where = { deactivatedAt: null };\n  delete where.deactivatedAt;\n  return where;\n}\n" +
        "export function f(t, userId) {\n  const where = { userId };\n" +
        "  return withTenantRls(prisma, t, async (tx) => tx.tenantMember.count({ where }));\n}\n",
    );
    const { code, out } = run();
    expect(code, out).toBe(0);
  });
});

describe("check-required-user-relation — a name is resolved where it is written (round 6 R46)", () => {
  it("resolves a name inside a followed where at its own position, not the call's", () => {
    // The calling function declares its own `userFilter`; the OR branch means the
    // module-level one, which filters through the required relation.
    write(
      "src/lib/a.ts",
      'const userFilter = { user: { is: { email: "x" } } };\nconst where = { OR: [userFilter] };\n' +
        'export function f(t) {\n  const userFilter = { id: "1" };\n' +
        "  return withTenantRls(prisma, t, async (tx) => tx.tenantMember.findMany({ where }));\n}\n",
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TenantMember.where.OR.user<filter>");
  });
});

describe("check-required-user-relation — a disposition excuses only its kind of hit (round 6)", () => {
  it("refuses a dynamic-where entry as the excuse for a projection", () => {
    write("src/lib/a.ts", inTenant("tx.teamMember.findMany({ include: { user: true } })"));
    manifest({ "src/lib/a.ts": { disposition: "dynamic-where", reason: "sets teamId only", calls: 1 } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain('disposition "dynamic-where" cannot excuse TeamMember.user');
  });

  it("refuses any other disposition as the excuse for a where it cannot read", () => {
    write(
      "src/lib/a.ts",
      "export function f(email) {\n  const where = { deactivatedAt: null };\n  if (email) where.userId = email;\n" +
        "  return withTenantRls(prisma, t, async (tx) => tx.tenantMember.count({ where }));\n}\n",
    );
    manifest({ "src/lib/a.ts": { disposition: "actor", reason: "the requesting user", calls: 1 } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain('disposition "actor" cannot excuse TenantMember.where<unreadable-where>');
  });
});

describe("check-required-user-relation — a read runs in an opener's context only inside its callback function (round 7 R7-S1/F-R7-1)", () => {
  const READ = "tx.tenantMember.findMany({ include: { user: true } })";
  const EARLY = "prisma.tenantMember.findFirst({ include: { user: true } })";

  it("does not trust a read that IS the callback argument, inside an arrow", () => {
    // Evaluated while the arguments are built. The walk climbed past the call and
    // took the enclosing arrow for the callback.
    write("src/lib/a.ts", `export const f = async () => withBypassRls(prisma, ${EARLY}, PURPOSE);\n`);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("TenantMember.user");
  });

  it("does not trust a read that IS a local bypass wrapper's argument, inside an arrow", () => {
    write(
      "src/lib/a.ts",
      "const inBypass = (fn) => withBypassRls(prisma, fn, PURPOSE);\n" + `export const f = async () => inBypass(${EARLY});\n`,
    );
    expectRefusal();
  });

  it("does not trust an arrow IIFE in the callback position", () => {
    // It runs before withBypassRls is even called.
    write(
      "src/lib/a.ts",
      `export const f = () => withBypassRls(prisma, (() => {\n  const early = ${EARLY};\n  return async (tx) => early;\n})(), PURPOSE);\n`,
    );
    expectRefusal();
  });

  it("does not trust a function-expression IIFE in the callback position", () => {
    write(
      "src/lib/a.ts",
      `export const f = () => withBypassRls(prisma, (function () {\n  const early = ${EARLY};\n  return async (tx) => early;\n})(), PURPOSE);\n`,
    );
    expectRefusal();
  });

  it("does not trust an awaited IIFE in the callback position", () => {
    write(
      "src/lib/a.ts",
      `export async function f() {\n  return withBypassRls(prisma, await (async () => {\n    const early = await ${EARLY};\n    return async (tx) => early;\n  })(), PURPOSE);\n}\n`,
    );
    expectRefusal();
  });

  it("does not trust a function a helper receives inside the callback argument", () => {
    // Whether `pick` runs it before the bypass opens is not in this file.
    write("src/lib/a.ts", `export const f = () => withBypassRls(prisma, pick(async (tx) => ${READ}), PURPOSE);\n`);
    expectRefusal();
  });

  it("does not trust a function passed in withBypassRls's purpose position", () => {
    // Pins the callback position itself: the function IS the argument, so only
    // the opener's position table keeps it out of the bypass.
    write("src/lib/a.ts", `export const f = () => withBypassRls(prisma, cb, async () => ${EARLY});\n`);
    expectRefusal();
  });

  it("passes a callback written with a type assertion", () => {
    write("src/lib/a.ts", `export const f = () => withBypassRls(prisma, (async (tx) => ${READ}) as Fn, PURPOSE);\n`);
    const { code, out } = run();
    expect(code, out).toBe(0);
  });

  it("passes a function-expression callback", () => {
    write("src/lib/a.ts", `export const f = () => withBypassRls(prisma, async function (tx) {\n  return ${READ};\n}, PURPOSE);\n`);
    const { code, out } = run();
    expect(code, out).toBe(0);
  });

  it("does not trust a read in a function nested inside the callback", () => {
    // Round 10: passed through round 9. No nested function is trusted to run in
    // the callback's context; when it runs is decided by its receiver and caller.
    write(
      "src/lib/a.ts",
      `export const f = (ids) => withBypassRls(prisma, async (tx) => Promise.all(ids.map(async (id) => ${READ})), PURPOSE);\n`,
    );
    expectRefusal();
  });

  it("does not trust a read a non-opener helper wraps inside the callback", () => {
    // Round 9 (F-R9-2): passed in round 7. When `helper` and `pick` run their
    // functions is not in this file — either may keep one and call it later,
    // under whatever context that caller has.
    write(
      "src/lib/a.ts",
      `export const f = () => withBypassRls(prisma, async (tx) => helper(pick(async () => ${READ})), PURPOSE);\n`,
    );
    expectRefusal();
  });
});

describe("check-required-user-relation — a wrong null cannot hide behind an outer bypass (round 7 R7-T1)", () => {
  // The round-6 cells for these branches had no outer opener, where a wrong null
  // and a correct UNKNOWN both end in "reported". Inside a bypass, null walks on
  // to it and reads as exempt.
  const READ = "tx.tenantMember.findMany({ include: { user: true } })";
  const inOuterBypass = (inner) => `export const f = (args) => withBypassRls(prisma, async () => ${inner}, PURPOSE);\n`;

  it("does not defer to an outer bypass for a destructured callback parameter", () => {
    write(
      "src/lib/a.ts",
      "const run = ({ fn }) => withTenantRls(prisma, t, fn);\n" + inOuterBypass(`run({ fn: async (tx) => ${READ} })`),
    );
    expectRefusal();
  });

  it("does not defer to an outer bypass for mutually recursive wrappers", () => {
    write(
      "src/lib/a.ts",
      "function ping(fn) {\n  return pong(fn);\n}\nfunction pong(fn) {\n  return ping(fn);\n}\n" +
        inOuterBypass(`ping(async (tx) => ${READ})`),
    );
    expectRefusal();
  });

  it("does not defer to an outer bypass for a rest callback parameter", () => {
    write(
      "src/lib/a.ts",
      "const run = (...args) => withTenantRls(prisma, t, args[0]);\n" + inOuterBypass(`run(async (tx) => ${READ})`),
    );
    expectRefusal();
  });

  it("does not defer to an outer bypass when a spread hides which wrapper parameter receives the callback", () => {
    write(
      "src/lib/a.ts",
      "const run = (client, fn) => withTenantRls(client, t, fn);\n" + inOuterBypass(`run(...args, async (tx) => ${READ})`),
    );
    expectRefusal();
  });
});

describe("check-required-user-relation — spreads that hide nothing (round 7 R7-T4)", () => {
  const READ = "tx.tenantMember.findMany({ include: { user: true } })";

  it("passes a spread into a wrapper that reaches no opener", () => {
    // The read is a value argument, evaluated inside the bypass (round 9: a
    // function argument to `run` is untrusted whatever the spread does), so only
    // the spread's handling decides whether `run` reads as opening something.
    write(
      "src/lib/a.ts",
      "const run = (a, fn) => helper(a, fn);\n" +
        `export const f = (args) => withBypassRls(prisma, async (tx) => run(...args, ${READ}), PURPOSE);\n`,
    );
    const { code, out } = run();
    expect(code, out).toBe(0);
  });

  it("passes a spread after the opener's callback position", () => {
    write("src/lib/a.ts", `export const f = (rest) => withBypassRls(prisma, async (tx) => ${READ}, ...rest);\n`);
    const { code, out } = run();
    expect(code, out).toBe(0);
  });
});

describe("check-required-user-relation — a function that outlives the callback does not run in its context (round 8 R8-S2/T8-2)", () => {
  const READ = "tx.tenantMember.findMany({ include: { user: true } })";
  const inBypass = (body) => `export const f = (ids) => withBypassRls(prisma, async (tx) => ${body}, PURPOSE);\n`;

  it("does not trust a closure returned out of the callback", () => {
    // Called after withBypassRls has resolved, with no context at all.
    write("src/lib/a.ts", inBypass(`() => ${READ}`));
    expectRefusal();
  });

  it("does not trust a closure stored and handed out of the callback", () => {
    write("src/lib/a.ts", inBypass(`{\n  const later = () => ${READ};\n  return later;\n}`));
    expectRefusal();
  });

  it("does not trust an object method built in the callback", () => {
    write("src/lib/a.ts", inBypass(`({ load() {\n  return ${READ};\n} })`));
    expectRefusal();
  });

  it("does not trust a function declared in the callback", () => {
    write("src/lib/a.ts", inBypass(`{\n  function load() {\n    return ${READ};\n  }\n  return load;\n}`));
    expectRefusal();
  });

  it("does not trust a callback handed to a scheduler", () => {
    write("src/lib/a.ts", inBypass(`{\n  setTimeout(() => ${READ}, 0);\n}`));
    expectRefusal();
  });

  it("does not trust a read in an IIFE inside the callback", () => {
    // Round 10: passed in rounds 8 and 9.
    write("src/lib/a.ts", inBypass(`(async () => ${READ})()`));
    expectRefusal();
  });

  it("does not let an outer bypass answer for a function a helper receives inside an inner tenant callback", () => {
    // T8-2: with no outer opener, a wrong NOW and a correct UNKNOWN both refuse.
    // Here a wrong NOW walks on to the bypass and reads as exempt.
    write(
      "src/lib/a.ts",
      `export const f = (t) => withBypassRls(prisma, async () => withTenantRls(prisma, t, pick(async (tx) => ${READ})), PURPOSE);\n`,
    );
    expectRefusal();
  });
});

describe("check-required-user-relation — no function nested inside the callback is trusted (round 10 F-R10-1/S-R10-1/S-R10-2/T-R10-1)", () => {
  const READ = "tx.tenantMember.findMany({ include: { user: true } })";
  const inBypass = (body, prefix = "") =>
    `${prefix}export const f = (ids, p, client, list, emitter) => withBypassRls(prisma, async (tx) => ${body}, PURPOSE);\n`;

  // Control flow is not a function: these run in the callback itself.
  it.each([
    ["an awaited read in a block", `{\n  const rows = await ${READ};\n  return rows;\n}`],
    ["a read in a loop and a branch", `{\n  for (const id of ids) {\n    if (id) {\n      await ${READ};\n    }\n  }\n  return null;\n}`],
    ["a read in try/catch", `{\n  try {\n    return await ${READ};\n  } catch {\n    return null;\n  }\n}`],
  ])("passes %s written directly in the callback", (_label, body) => {
    write("src/lib/a.ts", inBypass(body));
    const { code, out } = run();
    expect(code, out).toBe(0);
  });

  // Rounds 8 and 9 trusted the first group: an allowlist of call shapes that run
  // their function while the callback runs. Round 10 escaped it with the rest.
  it.each([
    ["a sync map callback", `{\n  ids.map((id) => ${READ});\n  return null;\n}`],
    ["an async map handed to an awaited Promise.all", `Promise.all(ids.map(async (id) => ${READ}))`],
    ["an awaited IIFE", `{\n  await (async () => ${READ})();\n  return null;\n}`],
    ["a returned .then callback", `p.then(async () => ${READ})`],
    ["a returned $transaction callback", `client.$transaction(async (t) => ${READ})`],
    ["a Promise executor", `new Promise((resolve) => resolve(${READ}))`],
    ["an object method called at once", `({ load() {\n  return ${READ};\n} }).load()`],
    ["a function declared and called in the callback", `{\n  function load() {\n    return ${READ};\n  }\n  return load();\n}`],
    ["a forEach callback returning a promise nobody awaits", `{\n  ids.forEach((id) => p.then(() => ${READ}));\n  return null;\n}`],
    ["an async executor, after resolve", `new Promise(async (resolve) => {\n  resolve(null);\n  await p;\n  return ${READ};\n})`],
    ["a generator IIFE", `{\n  (function* () {\n    yield ${READ};\n  })();\n  return null;\n}`],
    ["a lazy iterator helper", `{\n  new Set(ids).values().map((id) => ${READ});\n  return null;\n}`],
    ["the executor of a shadowed Promise", `new Promise((resolve) => resolve(${READ}))`, "class Promise {\n  constructor(fn) {\n    this.fn = fn;\n  }\n}\n"],
    ["next/server's after()", `after(() => ${READ})`],
    ["an event listener", `emitter.on("x", () => ${READ})`],
    ["a function pushed onto a list", `{\n  list.push(() => ${READ});\n  return list;\n}`],
    ["setTimeout", `setTimeout(() => ${READ}, 0)`],
    ["a class instance field initializer", `class {\n  rows = ${READ};\n}`],
    ["a class declared in the callback", `{\n  class Rows {\n    rows = ${READ};\n  }\n  return new Rows();\n}`],
    ["an accessor field initializer", `class {\n  accessor rows = ${READ};\n}`],
    ["a class static block", `class {\n  static {\n    ${READ};\n  }\n}`],
    ["a getter", `({ get load() {\n  return ${READ};\n} })`],
    ["a setter", `({ set load(v) {\n  ${READ};\n} })`],
    ["a class constructor", `class {\n  constructor() {\n    ${READ};\n  }\n}`],
  ])("does not trust a read in %s", (_label, body, prefix = "") => {
    write("src/lib/a.ts", inBypass(body, prefix));
    expectRefusal();
  });
});

describe("check-required-user-relation — deferral with no nested function, and where a read is evaluated (round 11 F-R11-1/S-R11-1/T-R11-1)", () => {
  const READ = "tx.tenantMember.findMany({ include: { user: true } })";

  it("does not trust a read in a generator callback", () => {
    // Its body runs when something iterates it, not when withBypassRls calls it.
    write("src/lib/a.ts", `export const f = () => withBypassRls(prisma, function* (tx) {\n  yield ${READ};\n}, PURPOSE);\n`);
    expectRefusal();
  });

  it("does not trust a read in an async generator callback", () => {
    write("src/lib/a.ts", `export const f = () => withBypassRls(prisma, async function* (tx) {\n  yield ${READ};\n}, PURPOSE);\n`);
    expectRefusal();
  });

  it("passes a read that IS an inner opener's callback argument: it runs in the outer bypass", () => {
    // Evaluated before withTenantRls is called, so in the bypass around that call.
    write("src/lib/a.ts", `export const f = (t) => withBypassRls(prisma, async (tx) => withTenantRls(prisma, t, ${READ}), PURPOSE);\n`);
    const { code, out } = run();
    expect(code, out).toBe(0);
  });

  it("passes a read in a value argument of a helper in an inner opener's callback position", () => {
    write("src/lib/a.ts", `export const f = (t) => withBypassRls(prisma, async (tx) => withTenantRls(prisma, t, pick(${READ})), PURPOSE);\n`);
    const { code, out } = run();
    expect(code, out).toBe(0);
  });
});

describe("check-required-user-relation — a class expression passed as the callback is not a function (round 12 F-R12-1/S-R12-1)", () => {
  // Its static parts and `extends` clause run while withBypassRls's arguments are
  // built, before any bypass exists; round 11 answered LATER for them.
  const READ = "tx.tenantMember.findMany({ include: { user: true } })";

  it.each([
    ["a static field", `(class {\n  static rows = ${READ};\n}) as unknown as Fn`],
    ["a static block", `(class {\n  static {\n    ${READ};\n  }\n}) as unknown as Fn`],
    ["an extends clause", `(class extends base(${READ}) {}) as unknown as Fn`],
    ["static field, written without a cast", `class {\n  static rows = ${READ};\n}`],
  ])("does not trust a read in a class expression callback's %s", (_label, callback) => {
    write("src/lib/a.ts", `export const f = () => withBypassRls(prisma, ${callback}, PURPOSE);\n`);
    expectRefusal();
  });
});

describe("check-required-user-relation — every wrapper unwrapExpression strips is pinned (round 13 T-R13-1)", () => {
  // Parentheses and `as` had cells; `satisfies` and non-null had none, so dropping
  // both from unwrapExpression left every cell in the four RLS gate tests green.
  const READ = "tx.tenantMember.findMany({ include: { user: true } })";
  const passes = (source) => {
    write("src/lib/a.ts", source);
    const { code, out } = run();
    expect(code, out).toBe(0);
  };

  it("passes a callback written with `satisfies`", () =>
    passes(`export const f = () => withBypassRls(prisma, (async (tx) => ${READ}) satisfies Fn, PURPOSE);\n`));

  it("passes a callback written with a non-null assertion", () =>
    passes(`export const f = () => withBypassRls(prisma, (async (tx) => ${READ})!, PURPOSE);\n`));

  it("passes a callback through a chain of wrappers", () =>
    passes(`export const f = () => withBypassRls(prisma, ((async (tx) => ${READ}) satisfies Fn) as Fn, PURPOSE);\n`));

  it("passes an opener whose callee carries a non-null assertion", () =>
    passes(`export const f = () => withBypassRls!(prisma, async (tx) => ${READ}, PURPOSE);\n`));

  it("does not trust a generator callback written with `satisfies`", () => {
    write("src/lib/a.ts", `export const f = () => withBypassRls(prisma, (function* (tx) {\n  yield ${READ};\n}) satisfies Fn, PURPOSE);\n`);
    expectRefusal();
  });
});
