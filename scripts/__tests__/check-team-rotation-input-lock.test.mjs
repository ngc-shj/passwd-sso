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

  describe("rule 7: SCIM admission marker", () => {
    const SERVICE = "src/lib/services/scim-group-service.ts";
    const APPROVE = "src/app/api/teams/[teamId]/members/[memberId]/approve/route.ts";

    it("refuses a raw INSERT of team_members in the service", () => {
      write(SERVICE, "export async function add(tx, t, u) { await tx.$executeRaw`INSERT INTO team_members (team_id, user_id) VALUES (${t}::uuid, ${u}::uuid)`; }");
      expectDenied(run(), /raw write of team_members in scim-group-service\.ts/);
    });

    it("refuses a raw UPDATE of team_members in the service", () => {
      write(SERVICE, "export async function bump(tx, id) { await tx.$executeRaw`UPDATE team_members SET role = 'ADMIN' WHERE id = ${id}::uuid`; }");
      expectDenied(run({ writes: 2 }), /raw write of team_members in scim-group-service\.ts/);
    });

    it("refuses an unreadable data on a teamMember.update", () => {
      write(SERVICE, "export async function upd(tx, id, payload) { await tx.teamMember.update({ where: { id }, data: payload }); }");
      expectDenied(run({ writes: 2, admissions: 1 }), /unreadable team_members write payload/);
    });

    it("refuses a createMany .map with a block-body callback", () => {
      write(SERVICE, `export async function add(tx, ids) {
  await tx.teamMember.createMany({ data: ids.map((uid) => { return { userId: uid }; }) });
}`);
      expectDenied(run({ admissions: 1 }), /unreadable team_members write payload/);
    });

    it("refuses a create without the pending marker", () => {
      write(SERVICE, "export async function add(tx, teamId, userId, role) { await tx.teamMember.create({ data: { teamId, userId, role } }); }");
      expectDenied(run({ admissions: 1 }), /creating team_members payload missing scimApprovalPending: true and a non-null deactivatedAt/);
    });

    it("refuses an upsert.create without the pending marker", () => {
      write(SERVICE, `export async function add(tx, where, teamId, userId, role) {
  await tx.teamMember.upsert({ where, create: { teamId, userId, role }, update: { role } });
}`);
      expectDenied(run({ admissions: 1 }), /creating team_members payload missing scimApprovalPending: true and a non-null deactivatedAt/);
    });

    it("refuses a nested members.create without the pending marker", () => {
      write(SERVICE, `export async function build(tx, name, userId, role) {
  await tx.team.create({ data: { name, members: { create: { userId, role } } } });
}`);
      expectDenied(run({ admissions: 1 }), /creating team_members payload missing scimApprovalPending: true and a non-null deactivatedAt/);
    });

    it("refuses a create naming deactivatedAt: null", () => {
      write(SERVICE, `export async function add(tx, teamId, userId, role) {
  await tx.teamMember.create({ data: { teamId, userId, role, scimApprovalPending: true, deactivatedAt: null } });
}`);
      expectDenied(run({ admissions: 1 }), /team_members payload names deactivatedAt: null/);
    });

    it("refuses an upsert update arm naming deactivatedAt: null", () => {
      write(SERVICE, `export async function add(tx, where, teamId, userId, role) {
  await tx.teamMember.upsert({
    where,
    create: { teamId, userId, role, scimApprovalPending: true, deactivatedAt: new Date() },
    update: { deactivatedAt: null },
  });
}`);
      expectDenied(run({ writes: 2, admissions: 1 }), /team_members payload names deactivatedAt: null/);
    });

    it("refuses a createManyAndReturn without the pending marker", () => {
      write(SERVICE, "export async function add(tx, teamId, userId, role) { await tx.teamMember.createManyAndReturn({ data: [{ teamId, userId, role }] }); }");
      expectDenied(run({ admissions: 1 }), /creating team_members payload missing scimApprovalPending: true and a non-null deactivatedAt/);
    });

    it("refuses an updateManyAndReturn naming deactivatedAt: null", () => {
      write(SERVICE, "export async function back(tx, ids) { await tx.teamMember.updateManyAndReturn({ where: { id: { in: ids } }, data: { deactivatedAt: null } }); }");
      expectDenied(run({ writes: 2, admissions: 1 }), /team_members payload names deactivatedAt: null/);
    });

    it("refuses scimApprovalPending: false outside the approve route", () => {
      write(SUBJECT, "export async function off(tx, id) { await tx.teamMember.update({ where: { id }, data: { scimApprovalPending: false } }); }");
      expectDenied(run(), /scimApprovalPending set to something other than the literal true outside the approve route/);
    });

    it("passes scimApprovalPending: false in a where filter outside the approve route", () => {
      write(SUBJECT, "export async function list(tx, teamId) { return tx.teamMember.findMany({ where: { teamId, scimApprovalPending: false } }); }");
      expect(run().code).toBe(0);
    });

    it("refuses a variable value for scimApprovalPending outside the approve route", () => {
      write(SUBJECT, "export async function off(tx, id, pending) { await tx.teamMember.update({ where: { id }, data: { scimApprovalPending: pending } }); }");
      expectDenied(run(), /scimApprovalPending set to something other than the literal true outside the approve route/);
    });

    it("refuses a shorthand scimApprovalPending outside the approve route", () => {
      write(SUBJECT, "export async function off(tx, id, scimApprovalPending) { await tx.teamMember.update({ where: { id }, data: { scimApprovalPending } }); }");
      expectDenied(run(), /scimApprovalPending set to something other than the literal true outside the approve route/);
    });

    it("refuses a quoted scimApprovalPending key outside the approve route", () => {
      write(SUBJECT, 'export async function off(tx, id) { await tx.teamMember.update({ where: { id }, data: { "scimApprovalPending": false } }); }');
      expectDenied(run(), /scimApprovalPending set to something other than the literal true outside the approve route/);
    });

    it("refuses a parameterised raw template naming scim_approval_pending", () => {
      write(SUBJECT, "export function clause(v) { return `scim_approval_pending = ${v}`; }");
      expectDenied(run(), /raw access to scim_approval_pending by column name/);
    });

    it("refuses a Prisma.sql fragment naming scim_approval_pending", () => {
      write(SUBJECT, "export function frag() { return Prisma.sql`scim_approval_pending`; }");
      expectDenied(run(), /raw access to scim_approval_pending by column name/);
    });

    it("refuses the same raw template in team-departure.ts, ahead of the IMPLEMENTATIONS skip", () => {
      write("src/lib/team/team-departure.ts", "export function clause(v) { return `scim_approval_pending = ${v}`; }");
      expectDenied(run(), /raw access to scim_approval_pending by column name/);
    });

    // T10: the gate's negative cells above all withhold the marker; these
    // positive controls prove a correctly-marked create/createMany passes
    // rather than the gate accepting everything regardless of the marker.
    it("passes a create naming the pending marker", () => {
      write(SERVICE, `export async function add(tx, tenantId, teamId, userId, role) {
  await lockGroupWrite(tx, tenantId, teamId, [userId]);
  await tx.teamMember.create({ data: { teamId, userId, role, scimApprovalPending: true, deactivatedAt: new Date() } });
}`);
      expect(run({ admissions: 1 }).code).toBe(0);
    });

    it("passes a createMany .map naming the pending marker", () => {
      write(SERVICE, `export async function add(tx, tenantId, teamId, ids) {
  await lockGroupWrite(tx, tenantId, teamId, ids);
  await tx.teamMember.createMany({ data: ids.map((uid) => ({ userId: uid, scimApprovalPending: true, deactivatedAt: new Date() })) });
}`);
      expect(run({ admissions: 1 }).code).toBe(0);
    });

    it("passes the approve route's CAS (literal true in the where, literal false in the data)", () => {
      write(APPROVE, `export const approve = withTenantRls(prisma, tenantId, async (tx) => {
  await lockTenantRows(tx, tenantId, [approverId, targetId], "share");
  await lockTeamsAgainstRotation(tx, [teamId]);
  await tx.teamMember.updateMany({
    where: { id, teamId, role: expectedRole, scimApprovalPending: true, deactivatedAt: { not: null } },
    data: { deactivatedAt: null, scimApprovalPending: false, keyDistributed: false },
  });
});`);
      expect(run({ writes: 2, admissions: 1 }).code).toBe(0);
    });
  });
});
