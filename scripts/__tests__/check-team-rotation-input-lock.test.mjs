import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "..", "checks", "check-team-rotation-input-lock.mjs");
const SUBJECT = "src/lib/team/subject.ts";

/** The exempted site, so a synthetic root keeps the exemption matched (1 member write). */
const EXEMPT_FILES = {
  "src/app/api/teams/[teamId]/rotate-key/route.ts": `
export const rotate = withTenantRls(prisma, tenantId, async (tx) => {
  await tx.teamMember.updateMany({ where: { teamId }, data: { keyDistributed: false } });
});
`,
};

let root;

function run({ writes = 1, tenantWrites = 0, admissions = 0 } = {}) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [GATE], {
        encoding: "utf8",
        env: {
          ...process.env,
          TEAM_ROTATION_INPUT_LOCK_ROOT: root,
          TEAM_ROTATION_INPUT_LOCK_WRITES: String(writes),
          TEAM_ROTATION_INPUT_LOCK_TENANT_WRITES: String(tenantWrites),
          TEAM_ROTATION_INPUT_LOCK_ADMISSIONS: String(admissions),
        },
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "team-rotation-input-lock-"));
  // A target that contributes no source file reads as missing, so each one
  // carries a file with no sites.
  write("src/app/layout.ts", "export {};\n");
  write("src/lib/util.ts", "export {};\n");
  write("src/workers/worker.ts", "export {};\n");
  write("src/auth.ts", "export {};\n");
  for (const [rel, body] of Object.entries(EXEMPT_FILES)) write(rel, body);
});

/** A deny: the gate fails (exit 1) AND names the reason. */
function expectDenied(result, pattern) {
  expect(result.code).toBe(1);
  expect(result.out).toMatch(pattern);
}

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-team-rotation-input-lock", () => {
  it("passes a root with only the exempted site", () => {
    expect(run().code).toBe(0);
  });

  it("fails when a scan target is missing", () => {
    rmSync(join(root, "src/workers"), { recursive: true, force: true });
    expectDenied(run(), /scan target not found/);
  });

  describe("rule 1: member-set writes follow a team lock", () => {
    it("refuses a member key delete with no lock", () => {
      write(SUBJECT, `export async function remove(tx) { await tx.teamMemberKey.deleteMany({ where: { teamId } }); }`);
      const r = run({ writes: 2 });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/member-write::src\/lib\/team\/subject\.ts::remove::teamMemberKey\.deleteMany/);
    });

    it("accepts the same delete after lockTeamsAgainstRotation", () => {
      write(SUBJECT, `export async function remove(tx) { await lockTeamsAgainstRotation(tx, [teamId]); await tx.teamMemberKey.deleteMany({ where: { teamId } }); }`);
      expect(run({ writes: 2 }).code).toBe(0);
    });

    it("refuses a lock taken AFTER the write", () => {
      write(SUBJECT, `export async function remove(tx) { await tx.teamMember.deleteMany({ where: { teamId } }); await lockTeamsAgainstRotation(tx, [teamId]); }`);
      expect(run({ writes: 2 }).code).toBe(1);
    });

    it("counts an update whose data cannot be read (identifier)", () => {
      write(SUBJECT, `export async function upd(tx, data) { await tx.teamMember.updateMany({ where: { teamId }, data }); }`);
      expect(run({ writes: 2 }).code).toBe(1);
    });

    it("ignores a role-only update", () => {
      write(SUBJECT, `export async function upd(tx) { await tx.teamMember.update({ where: { id }, data: { role: "ADMIN" } }); }`);
      expect(run().code).toBe(0);
    });

    it("covers a write through every same-file caller's lock", () => {
      write(SUBJECT, `
async function inner(tx) { await tx.teamMember.updateMany({ where: { id }, data: { deactivatedAt: new Date() } }); }
export async function outer(tx) { await lockTeamsAgainstRotation(tx, [teamId]); await inner(tx); }
`);
      expect(run({ writes: 2 }).code).toBe(0);
    });

    it("refuses an upsert whose update arm deactivates, with no lock", () => {
      write(SUBJECT, `export async function up(tx) { await tx.teamMember.upsert({ where, create: {}, update: { deactivatedAt: new Date() } }); }`);
      expectDenied(run({ writes: 2 }), /member-write::src\/lib\/team\/subject\.ts::up::teamMember\.upsert/);
    });

    it("refuses a raw UPDATE of team_member_keys with no lock", () => {
      write(SUBJECT, "export async function bump(tx) { await tx.$executeRaw`UPDATE team_member_keys SET key_version = 2 WHERE team_id = ${teamId}::uuid`; }");
      expectDenied(run({ writes: 2 }), /team_member_keys\.raw/);
    });

    it("refuses a writer one of whose two same-file callers takes no lock", () => {
      write(SUBJECT, `
async function inner(tx) { await tx.teamMember.updateMany({ where: { id }, data: { deactivatedAt: new Date() } }); }
export async function locked(tx) { await lockTeamsAgainstRotation(tx, [teamId]); await inner(tx); }
export async function unlocked(tx) { await inner(tx); }
`);
      expectDenied(run({ writes: 2 }), /member-write::src\/lib\/team\/subject\.ts::inner::teamMember\.updateMany/);
    });

    it("refuses a second matching write inside the exempted rotation function (the exemption must match one site)", () => {
      write("src/app/api/teams/[teamId]/rotate-key/route.ts", `
export const rotate = withTenantRls(prisma, tenantId, async (tx) => {
  await tx.teamMember.updateMany({ where: { teamId }, data: { keyDistributed: false } });
  await tx.teamMember.updateMany({ where: { teamId }, data: { deactivatedAt: new Date() } });
});
`);
      expectDenied(run({ writes: 2 }), /exemption\(s\) matching no site, or several/);
    });

    it("refuses the exempted shape in a sibling file", () => {
      write("src/app/api/teams/[teamId]/rotate-key/sibling.ts", `
export const rotate = withTenantRls(prisma, tenantId, async (tx) => {
  await tx.teamMember.updateMany({ where: { teamId }, data: { keyDistributed: false } });
});
`);
      expectDenied(run({ writes: 2 }), /rotate-key\/sibling\.ts::<anonymous>::teamMember\.updateMany/);
    });

    it("refuses a raw DELETE FROM team_members with no lock", () => {
      write(SUBJECT, "export async function del(tx) { await tx.$executeRaw`DELETE FROM team_members WHERE team_id = ${teamId}::uuid`; }");
      expect(run({ writes: 2 }).code).toBe(1);
    });
  });

  describe("rule 2: tenant active state moves only in team-departure.ts", () => {
    it("refuses a tenantMember update naming deactivatedAt", () => {
      write(SUBJECT, `export async function off(tx) { await lockTenantRows(tx, t, [u], "update"); await tx.tenantMember.update({ where: { id }, data: { deactivatedAt: new Date() } }); }`);
      const r = run({ tenantWrites: 1 });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/tenant-state::src\/lib\/team\/subject\.ts::off::tenantMember\.update/);
    });

    it("refuses a shorthand deactivatedAt (unreadable value)", () => {
      write(SUBJECT, `export async function off(tx, deactivatedAt) { await tx.tenantMember.updateMany({ where: { id }, data: { deactivatedAt } }); }`);
      expect(run({ tenantWrites: 1 }).code).toBe(1);
    });

    it("ignores a tenantMember update not naming deactivatedAt", () => {
      write(SUBJECT, `export async function sync(tx) { await tx.tenantMember.update({ where: { id }, data: { lastScimSyncedAt: new Date() } }); }`);
      expect(run().code).toBe(0);
    });

    it("accepts a create-deactivated arm with the creation lock before and the departure after", () => {
      write(SUBJECT, `export async function create(tx) {
  await lockTenantMemberCreation(tx, t, u);
  await tx.tenantMember.create({ data: { tenantId: t, userId: u, deactivatedAt: new Date() } });
  await departCreatedMembership(tx, t, u, { actor });
}`);
      expect(run({ tenantWrites: 1 }).code).toBe(0);
    });

    it("refuses a create-deactivated arm without the departure after it", () => {
      write(SUBJECT, `export async function create(tx) {
  await lockTenantMemberCreation(tx, t, u);
  await tx.tenantMember.create({ data: { tenantId: t, userId: u, deactivatedAt: new Date() } });
}`);
      expect(run({ tenantWrites: 1 }).code).toBe(1);
    });

    it("refuses a create-deactivated arm without the creation lock before it", () => {
      write(SUBJECT, `export async function create(tx) {
  await tx.tenantMember.create({ data: { tenantId: t, userId: u, deactivatedAt: new Date() } });
  await departCreatedMembership(tx, t, u, { actor });
}`);
      expect(run({ tenantWrites: 1 }).code).toBe(1);
    });

    it("refuses a raw UPDATE of tenant_members.deactivated_at", () => {
      write(SUBJECT, "export async function off(tx) { await tx.$executeRaw`UPDATE tenant_members SET deactivated_at = now() WHERE id = ${id}::uuid`; }");
      expectDenied(run(), /raw write of tenant_members\.deactivated_at/);
    });
  });

  describe("rule 3: admissions follow a tenant-row lock", () => {
    it("refuses an invitation create with no tenant-row lock", () => {
      write(SUBJECT, `export async function invite(tx) { await tx.teamInvitation.create({ data: { teamId } }); }`);
      const r = run({ admissions: 1 });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/admission::src\/lib\/team\/subject\.ts::invite::teamInvitation\.create/);
    });

    it("accepts the same create after lockTenantRows", () => {
      write(SUBJECT, `export async function invite(tx) { await lockTenantRows(tx, t, [u], "share"); await tx.teamInvitation.create({ data: { teamId } }); }`);
      expect(run({ admissions: 1 }).code).toBe(0);
    });

    it("refuses a createMany of memberships with no tenant-row lock", () => {
      write(SUBJECT, `export async function add(tx) { await tx.teamMember.createMany({ data: [{ teamId, userId }] }); }`);
      expectDenied(run({ admissions: 1 }), /admission::src\/lib\/team\/subject\.ts::add::teamMember\.createMany/);
    });

    it("refuses a nested team membership create with no lock", () => {
      write(SUBJECT, `export async function make(tx) { await tx.team.create({ data: { name, members: { create: { userId } } } }); }`);
      expect(run({ admissions: 1 }).code).toBe(1);
    });

    it("counts a reactivation (deactivatedAt: null) as an admission, not a deactivation", () => {
      write(SUBJECT, `export async function back(tx) {
  await lockTenantRows(tx, t, [u], "share");
  await lockTeamsAgainstRotation(tx, [teamId]);
  await tx.teamMember.update({ where: { id }, data: { deactivatedAt: null } });
}`);
      expect(run({ writes: 2, admissions: 1 }).code).toBe(0);
    });

    it("does not count a deactivation (deactivatedAt: new Date()) as an admission", () => {
      write(SUBJECT, `export async function off(tx) { await lockTeamsAgainstRotation(tx, [teamId]); await tx.teamMember.updateMany({ where: { id }, data: { deactivatedAt: new Date() } }); }`);
      expect(run({ writes: 2, admissions: 0 }).code).toBe(0);
    });
  });

  describe("rule 4: lock order", () => {
    it("refuses two tenant-row lock calls in one function", () => {
      write(SUBJECT, `export async function twice(tx) { await lockTenantRows(tx, t, [a], "update"); await lockTenantRows(tx, t, [b], "update"); }`);
      expectDenied(run(), /2 tenant-row lock calls in one function/);
    });

    it("refuses a tenant-row lock inside a loop", () => {
      write(SUBJECT, `export async function each(tx) { for (const u of users) { await lockTenantRows(tx, t, [u], "update"); } }`);
      expectDenied(run(), /tenant-row lock inside a loop/);
    });

    it("refuses a tenant-row lock after a team lock", () => {
      write(SUBJECT, `export async function late(tx) { await lockTeamsAgainstRotation(tx, [teamId]); await lockTenantRows(tx, t, [u], "share"); }`);
      expectDenied(run(), /tenant-row lock after a team lock/);
    });

    it("refuses a transition next to a tenant-row lock without alreadyLocked", () => {
      write(SUBJECT, `export async function off(tx) { await lockTenantRows(tx, t, [u], "update"); await departFromTenant(tx, t, [u], { actor }); }`);
      expectDenied(run(), /departFromTenant next to a tenant-row lock without alreadyLocked: true/);
    });

    it("accepts alreadyLocked: true through a same-function variable", () => {
      write(SUBJECT, `export async function off(tx) {
  await lockTenantRows(tx, t, [u], "update");
  const transition = { actor, alreadyLocked: true };
  await returnToTenant(tx, t, [u], transition);
}`);
      expect(run().code).toBe(0);
    });
  });

  describe("rules 5 and 6", () => {
    it("refuses a call of deleteUser", () => {
      write(SUBJECT, `export async function purge() { await adapter.deleteUser(id); }`);
      expectDenied(run(), /calls deleteUser/);
    });

    it("refuses a Prisma write of tenantMemberDeparture", () => {
      write(SUBJECT, `export async function rec(tx) { await tx.tenantMemberDeparture.upsert({ where, create, update }); }`);
      expectDenied(run(), /tenantMemberDeparture\.upsert/);
    });

    it("refuses a raw DELETE of tenant_member_departures, even in deactivateScimUser", () => {
      write("src/lib/services/scim-user-service.ts", "export async function deactivateScimUser(tx) { await tx.$executeRaw`DELETE FROM tenant_member_departures WHERE user_id = ${u}::uuid`; }");
      expectDenied(run(), /DELETE FROM tenant_member_departures/);
    });

    it("accepts the record's INSERT inside deactivateScimUser's transaction callback", () => {
      write("src/lib/services/scim-user-service.ts", "export async function deactivateScimUser() { await prisma.$transaction(async (tx) => { await tx.$executeRaw`INSERT INTO tenant_member_departures (tenant_id, user_id, departed_at) VALUES (${t}::uuid, ${u}::uuid, clock_timestamp())`; }); }");
      expect(run().code).toBe(0);
    });

    it("refuses the same INSERT anywhere else", () => {
      write(SUBJECT, "export async function rec(tx) { await tx.$executeRaw`INSERT INTO tenant_member_departures (tenant_id, user_id, departed_at) VALUES (${t}::uuid, ${u}::uuid, clock_timestamp())`; }");
      expectDenied(run(), /INSERT INTO tenant_member_departures in rec/);
    });
  });

  it("fails when an exemption matches no site", () => {
    rmSync(join(root, "src/app/api/teams/[teamId]/rotate-key/route.ts"));
    expectDenied(run({ writes: 0 }), /exemption\(s\) matching no site/);
  });

  it("fails when the site counts differ from the pinned ones", () => {
    expectDenied(run({ writes: 2 }), /differ from the pinned/);
  });
});
