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
    expect(run().code).toBe(1);
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
    expect(run().code).toBe(1);
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
    expect(run().code).toBe(1);
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
    expect(run().code).toBe(1);
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
    expect(run().code).toBe(1);
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

