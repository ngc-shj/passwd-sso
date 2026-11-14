import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "..", "checks", "check-team-rotation-input-lock.mjs");
const SUBJECT = "src/lib/team/subject.ts";

/**
 * The exempted sites, so a synthetic root keeps every exemption matched: 1
 * member write, and EXEMPT_ADMISSIONS admissions and EXEMPT_GRANTS grants that
 * run() adds to the counts a test passes.
 */
const EXEMPT_FILES = {
  "src/app/api/teams/[teamId]/rotate-key/route.ts": `
export const rotate = withTenantRls(prisma, tenantId, async (tx) => {
  await tx.teamMember.updateMany({ where: { teamId }, data: { keyDistributed: false } });
  await tx.teamMemberKey.createMany({ data: memberKeys.map((k) => ({ teamId, userId: k.userId })) });
});
`,
  "src/app/api/teams/[teamId]/members/route.ts": `
export const add = withTenantRls(prisma, tenantId, async (tx) => {
  await tx.teamMember.update({ where: { id: existing.id }, data: { role } });
});
`,
  "src/app/api/teams/invitations/accept/route.ts": `
export const accept = withTenantRls(prisma, tenantId, async (tx) => {
  await lockTenantRows(tx, tenantId, [userId], "share");
  await tx.teamMember.upsert({ where, create: {}, update: { role: invitation.role } });
});
`,
  "src/lib/services/scim-group-service.ts": `
export async function applyAddOperations(tx, ids, teamId, previousRole, role) {
  await tx.teamMember.updateManyAndReturn({ where: { id: { in: ids }, teamId, role: previousRole, deactivatedAt: null }, data: { role } });
}
`,
  "src/app/api/teams/[teamId]/route.ts": `
export const patch = withTeamTenantRls(teamId, async () => prisma.team.update({ where: { id: teamId }, data: updateData }));
`,
  // The transfer arm is covered through the helper; the role change's
  // conjunction is exempted. Their shared key takes each payload's text.
  "src/app/api/teams/[teamId]/members/[memberId]/route.ts": `
async function targetIsLeftover(tx, memberId) {
  const locked = await tx.teamMember.findFirst({ where: { id: memberId } });
  const rows = await readTenantRows(tx, tenantId, [locked.userId]);
  return actorDepartedSinceAdmission(rows.get(locked.userId), locked.admittedAt);
}
export const transfer = withTeamTenantRls(teamId, async (tenantId, tx) => {
  if (await targetIsLeftover(tx, memberId)) throw new MemberChangedError();
  await tx.teamMember.updateMany({ where: { id: memberId, teamId }, data: { role: TEAM_ROLE.OWNER } });
});
export const change = withTeamTenantRls(teamId, async (tenantId, tx) => {
  if (isRoleAbove(result.data.role, target.role) && await targetIsLeftover(tx, memberId)) throw new MemberChangedError();
  await tx.teamMember.updateMany({ where: { id: memberId, teamId }, data: { role: result.data.role } });
});
`,
  "src/app/api/tenant/policy/route.ts": `
export const put = withTenantRls(prisma, tenantId, async (tx) => tx.tenant.update({ where: { id: tenantId }, data: updateData }));
`,
  "src/lib/auth/session/auth-adapter.ts": `
export const adapter = {
  async updateUser(data) {
    const { id, ...rest } = data;
    return withBypassRls(prisma, async (tx) => tx.user.update({ where: { id }, data: rest }));
  },
};
`,
  "src/lib/vault/rotate-key-server.ts": `
export async function applyVaultRotation(tx, userId, payload) {
  await tx.user.update({ where: { id: userId }, data: { keyVersion: 2, ...(payload.v ? { passphraseVerifierVersion: 1 } : {}) } });
}
`,
};
const EXEMPT_ADMISSIONS = 1;
const EXEMPT_GRANTS = 10;

let root;

function run({ writes = 1, tenantWrites = 0, admissions = 0, grants = 0 } = {}) {
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
          TEAM_ROTATION_INPUT_LOCK_ADMISSIONS: String(admissions + EXEMPT_ADMISSIONS),
          TEAM_ROTATION_INPUT_LOCK_GRANTS: String(grants + EXEMPT_GRANTS),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function writeFile(rel, body) {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const write = writeFile;

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
      write(SUBJECT, `export async function upd(tx, rows, target) {
  if (actorDepartedSinceAdmission(rows.get(target.userId), target.admittedAt)) return;
  await tx.teamMember.update({ where: { id: target.id }, data: { role: "ADMIN" } });
}`);
      expect(run({ grants: 1 }).code).toBe(0);
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
    // The service holds an exempted grant site; each cell keeps it beside its own.
    const write = (rel, body) => writeFile(rel, rel === SERVICE ? `${EXEMPT_FILES[SERVICE]}\n${body}` : body);
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

  describe("rule 8: grant recipients", () => {
    const CHECK = "if (actorDepartedSinceAdmission(rows.get(target.userId), target.admittedAt ?? target.createdAt)) return;";
    const GRANT_KEY = /grant::src\/lib\/team\/subject\.ts::promote::/;

    it("refuses an unchecked role update", () => {
      write(SUBJECT, `export async function promote(tx, target) { await tx.teamMember.update({ where: { id: target.id }, data: { role: "ADMIN" } }); }`);
      expectDenied(run({ grants: 1 }), /grant::src\/lib\/team\/subject\.ts::promote::teamMember\.update\b/);
    });

    it("refuses an unchecked keyDistributed: true", () => {
      write(SUBJECT, `export async function promote(tx, target) {
  await lockTeamsAgainstRotation(tx, [teamId]);
  await tx.teamMember.updateMany({ where: { id: target.id, deactivatedAt: null }, data: { keyDistributed: true } });
}`);
      expectDenied(run({ writes: 2, grants: 1 }), /grant::src\/lib\/team\/subject\.ts::promote::teamMember\.updateMany/);
    });

    it("refuses an unchecked teamMemberKey.create", () => {
      write(SUBJECT, `export async function promote(tx, target) { await tx.teamMemberKey.create({ data: { teamId, userId: target.userId } }); }`);
      expectDenied(run({ grants: 1 }), /grant::src\/lib\/team\/subject\.ts::promote::teamMemberKey\.create/);
    });

    it("refuses an unchecked raw UPDATE team_members SET role", () => {
      write(SUBJECT, "export async function promote(tx, target) { await lockTeamsAgainstRotation(tx, [teamId]); await tx.$executeRaw`UPDATE team_members SET role = 'ADMIN' WHERE id = ${target.id}::uuid`; }");
      expectDenied(run({ writes: 2, grants: 1 }), /grant::src\/lib\/team\/subject\.ts::promote::team_members\.raw/);
    });

    it("refuses an unchecked raw INSERT INTO team_member_keys", () => {
      write(SUBJECT, "export async function promote(tx, target) { await tx.$executeRaw`INSERT INTO team_member_keys (user_id) VALUES (${target.userId}::uuid)`; }");
      expectDenied(run({ grants: 1 }), /grant::src\/lib\/team\/subject\.ts::promote::team_member_keys\.raw/);
    });

    it("accepts the role update after a recipient check in its function", () => {
      write(SUBJECT, `export async function promote(tx, rows, target) {
  ${CHECK}
  await tx.teamMember.update({ where: { id: target.id }, data: { role: "ADMIN" } });
}`);
      expect(run({ grants: 1 }).code).toBe(0);
    });

    it("accepts keyDistributed: true, the key create and the raw grants after a recipient check", () => {
      write(SUBJECT, `export async function promote(tx, rows, target) {
  ${CHECK}
  await lockTeamsAgainstRotation(tx, [teamId]);
  await tx.teamMemberKey.create({ data: { teamId, userId: target.userId } });
  await tx.teamMember.updateMany({ where: { id: target.id, deactivatedAt: null }, data: { keyDistributed: true } });
  await tx.$executeRaw\`UPDATE team_members SET role = 'ADMIN' WHERE id = \${target.id}::uuid\`;
}`);
      expect(run({ writes: 3, grants: 3 }).code).toBe(0);
    });

    it("accepts a check whose declaration names the recipient (confirm-key: the member re-read by memberId)", () => {
      write(SUBJECT, `export async function promote(tx, rows, memberId) {
  const member = await tx.teamMember.findUnique({ where: { id: memberId } });
  if (actorDepartedSinceAdmission(rows.get(member.userId), member.admittedAt)) return;
  await tx.teamMember.update({ where: { id: memberId }, data: { role: "ADMIN" } });
}`);
      expect(run({ grants: 1 }).code).toBe(0);
    });

    it("accepts the grant through every same-file caller's check of the argument it passes", () => {
      write(SUBJECT, `
async function promote(tx, memberId) { await tx.teamMember.update({ where: { id: memberId }, data: { role: "ADMIN" } }); }
export async function outer(tx, rows, target) { ${CHECK} await promote(tx, target.id); }
`);
      expect(run({ grants: 1 }).code).toBe(0);
    });

    it("refuses the grant when one same-file caller checks no recipient", () => {
      write(SUBJECT, `
async function promote(tx, memberId) { await tx.teamMember.update({ where: { id: memberId }, data: { role: "ADMIN" } }); }
export async function outer(tx, rows, target) { ${CHECK} await promote(tx, target.id); }
export async function bare(tx, target) { await promote(tx, target.id); }
`);
      expectDenied(run({ grants: 1 }), GRANT_KEY);
    });

    it("accepts a same-file helper that makes the check, called with the recipient (member PUT's targetIsLeftover)", () => {
      write(SUBJECT, `
async function isLeftover(tx, memberId) {
  const locked = await tx.teamMember.findFirst({ where: { id: memberId } });
  const rows = await readTenantRows(tx, tenantId, [locked.userId]);
  return actorDepartedSinceAdmission(rows.get(locked.userId), locked.admittedAt);
}
export async function promote(tx, memberId) {
  if (await isLeftover(tx, memberId)) return;
  await tx.teamMember.updateMany({ where: { id: memberId, deactivatedAt: null }, data: { role: "ADMIN" } });
}`);
      expect(run({ grants: 1 }).code).toBe(0);
    });

    it("refuses a grant whose only check judges the acting member", () => {
      write(SUBJECT, `export async function promote(tx, rows, target) {
  const actor = await activeTeamAdmission(tx, teamId, session.user.id);
  if (actorDepartedSinceAdmission(rows.get(session.user.id), actor.admittedAt)) return;
  await tx.teamMember.update({ where: { id: target.id }, data: { role: "ADMIN" } });
}`);
      expectDenied(run({ grants: 1 }), GRANT_KEY);
    });

    it("refuses an activeTeamAdmission check of the actor even when not keyed by session.user.id (rotate-key)", () => {
      write(SUBJECT, `export async function promote(tx, actorRows, userId, target) {
  const actor = await activeTeamAdmission(tx, teamId, userId);
  if (actorDepartedSinceAdmission(actorRows.get(userId), actor.admittedAt)) return;
  await tx.teamMember.update({ where: { id: target.id }, data: { role: "ADMIN" } });
}`);
      expectDenied(run({ grants: 1 }), GRANT_KEY);
    });

    it("refuses a grant whose only check judges another member (the owner route's active-OWNER check)", () => {
      write(SUBJECT, `export async function promote(tx, ownerRows, owners, target) {
  if (owners.some((o) => !actorDepartedSinceAdmission(ownerRows.get(o.userId), o.admittedAt))) return;
  await tx.teamMember.update({ where: { id: target.id }, data: { role: TEAM_ROLE.OWNER } });
}`);
      expectDenied(run({ grants: 1 }), GRANT_KEY);
    });

    it("refuses a self-grant whose only check is the actor's activeTeamAdmission re-read (never a recipient check)", () => {
      write(SUBJECT, `export async function promote(tx, actorRows, userId) {
  const actor = await activeTeamAdmission(tx, teamId, userId);
  if (actorDepartedSinceAdmission(actorRows.get(userId), actor.admittedAt)) return;
  await tx.teamMember.updateMany({ where: { teamId, userId }, data: { role: "ADMIN" } });
}`);
      expectDenied(run({ grants: 1 }), GRANT_KEY);
    });

    it("refuses a self-grant whose only check is keyed by session.user.id (never a recipient check)", () => {
      write(SUBJECT, `export async function promote(tx, rows) {
  const approver = await tx.teamMember.findFirst({ where: { teamId, userId: session.user.id } });
  if (actorDepartedSinceAdmission(rows.get(session.user.id), approver.admittedAt)) return;
  await tx.teamMember.updateMany({ where: { teamId, userId: session.user.id }, data: { role: "ADMIN" } });
}`);
      expectDenied(run({ grants: 1 }), GRANT_KEY);
    });

    it("does not tie an actor-row check to the target through a shared tenant-row lock", () => {
      write(SUBJECT, `export async function promote(tx, tenantId, target) {
  const rows = await lockTenantRows(tx, tenantId, [session.user.id, target.userId], "share");
  const approver = await tx.teamMember.findFirst({ where: { teamId, userId: session.user.id } });
  if (actorDepartedSinceAdmission(rows.get(approver.userId), approver.admittedAt)) return;
  await tx.teamMember.update({ where: { id: target.id }, data: { role: "ADMIN" } });
}`);
      expectDenied(run({ grants: 1 }), GRANT_KEY);
    });

    it("refuses a check that comes after the grant", () => {
      write(SUBJECT, `export async function promote(tx, rows, target) {
  await tx.teamMember.update({ where: { id: target.id }, data: { role: "ADMIN" } });
  ${CHECK}
}`);
      expectDenied(run({ grants: 1 }), GRANT_KEY);
    });

    it("does not count a literal demotion (OWNER to ADMIN), but counts the promotion", () => {
      write(SUBJECT, `export async function demote(tx, id) {
  await tx.teamMember.updateMany({ where: { id, role: TEAM_ROLE.OWNER }, data: { role: TEAM_ROLE.ADMIN } });
}`);
      expect(run().code).toBe(0);
      write(SUBJECT, `export async function promote(tx, id) {
  await tx.teamMember.updateMany({ where: { id, role: TEAM_ROLE.ADMIN }, data: { role: TEAM_ROLE.OWNER } });
}`);
      expectDenied(run({ grants: 1 }), GRANT_KEY);
    });

    it("still classifies the owner route's demotion of every other OWNER (id: { not }) as a demotion", () => {
      write(SUBJECT, `export async function demote(tx, target) {
  await tx.teamMember.updateMany({ where: { teamId, role: TEAM_ROLE.OWNER, id: { not: target.id } }, data: { role: TEAM_ROLE.ADMIN } });
}`);
      expect(run().code).toBe(0);
    });

    it("does not count an update that reaches no active row", () => {
      write(SUBJECT, `export async function hold(tx, ids, role) {
  await tx.teamMember.updateMany({ where: { id: { in: ids }, deactivatedAt: { not: null } }, data: { role } });
  await tx.teamMember.updateMany({ where: { id: { in: ids }, scimApprovalPending: true }, data: { role } });
}`);
      expect(run().code).toBe(0);
    });

    it("does not count keyDistributed: false", () => {
      write(SUBJECT, `export async function clear(tx, id) {
  await lockTeamsAgainstRotation(tx, [teamId]);
  await tx.teamMember.updateMany({ where: { id }, data: { keyDistributed: false } });
}`);
      expect(run({ writes: 2 }).code).toBe(0);
    });

    it("refuses an exempted grant's shape in a sibling file", () => {
      write("src/app/api/teams/[teamId]/members/sibling.ts", EXEMPT_FILES["src/app/api/teams/[teamId]/members/route.ts"]);
      expectDenied(run({ grants: 1 }), /grant::src\/app\/api\/teams\/\[teamId\]\/members\/sibling\.ts::<anonymous>::teamMember\.update/);
    });

    it("fails when a grant exemption matches no site", () => {
      rmSync(join(root, "src/app/api/teams/[teamId]/members/route.ts"));
      expectDenied(run({ grants: -1 }), /exemption\(s\) matching no site, or several[^\n]*\n {2}grant::src\/app\/api\/teams\/\[teamId\]\/members\/route\.ts/);
    });

    it("fails the count when a grant site is added", () => {
      write(SUBJECT, `export async function promote(tx, rows, target) {
  ${CHECK}
  await tx.teamMember.update({ where: { id: target.id }, data: { role: "ADMIN" } });
}`);
      expectDenied(run({ grants: 0 }), /differ from the pinned/);
    });

    // RT10 twins: each grant arm, unchecked (denied on its own site key in the
    // uncovered list) and the same body behind a recipient check (accepted).
    const uncovered = (site) => new RegExp(`sites without their lock[^]*grant::src/lib/team/subject\\.ts::promote::${site.replace(/\./g, "\\.")}\\n`);
    const LOCK = "await lockTeamsAgainstRotation(tx, [teamId]);";
    const ARMS = [
      // T8: the nested-relation, key-write and equal-rank arms.
      { label: "team.update nested memberKeys.create", site: "team.update", grant: "await tx.team.update({ where: { id: teamId }, data: { memberKeys: { create: [{ userId: target.userId, keyVersion: 2 }] } } });" },
      { label: "team.update nested members.update", site: "team.update", grant: "await tx.team.update({ where: { id: teamId }, data: { members: { update: { where: { id: target.id }, data: { role: \"ADMIN\" } } } } });" },
      { label: "team.update nested members.create", site: "team.update", grant: "await tx.team.update({ where: { id: teamId }, data: { members: { create: { userId: target.userId, role: \"ADMIN\" } } } });" },
      { label: "teamMemberKey.createManyAndReturn", site: "teamMemberKey.createManyAndReturn", grant: "await tx.teamMemberKey.createManyAndReturn({ data: [{ teamId, userId: target.userId }] });" },
      { label: "teamMemberKey.upsert", site: "teamMemberKey.upsert", grant: "await tx.teamMemberKey.upsert({ where: { teamId_userId_keyVersion: { teamId, userId: target.userId, keyVersion: 2 } }, create: { teamId, userId: target.userId }, update: {} });" },
      { label: "an equal-rank role update (ADMIN to ADMIN)", site: "teamMember.updateMany", grant: "await tx.teamMember.updateMany({ where: { id: target.id, role: \"ADMIN\" }, data: { role: \"ADMIN\" } });" },
      // R3-N2 (a): keyDistributed set to anything but the literal false.
      { label: "keyDistributed set from a variable", site: "teamMember.updateMany", writes: 2, grant: `${LOCK} await tx.teamMember.updateMany({ where: { id: target.id }, data: { keyDistributed: distributed } });` },
      { label: "keyDistributed: !true", site: "teamMember.updateMany", writes: 2, grant: `${LOCK} await tx.teamMember.updateMany({ where: { id: target.id }, data: { keyDistributed: !true } });` },
      // R3-N2 (b): teamMemberKey updates.
      { label: "teamMemberKey.update", site: "teamMemberKey.update", grant: "await tx.teamMemberKey.update({ where: { teamId_userId_keyVersion: { teamId, userId: target.userId, keyVersion: 2 } }, data: { encryptedTeamKey } });" },
      { label: "teamMemberKey.updateMany", site: "teamMemberKey.updateMany", grant: "await tx.teamMemberKey.updateMany({ where: { teamId, userId: target.userId }, data: { encryptedTeamKey } });" },
      { label: "teamMemberKey.updateManyAndReturn", site: "teamMemberKey.updateManyAndReturn", grant: "await tx.teamMemberKey.updateManyAndReturn({ where: { teamId, userId: target.userId }, data: { encryptedTeamKey } });" },
      // R3-N2 (c): nested writes through user and tenant (schema.prisma relation fields).
      { label: "user.update nested teamMemberships", site: "user.update", grant: "await tx.user.update({ where: { id: target.userId }, data: { teamMemberships: { update: { where: { id: target.id }, data: { role: \"ADMIN\" } } } } });" },
      { label: "user.update nested teamMemberKeys", site: "user.update", grant: "await tx.user.update({ where: { id: target.userId }, data: { teamMemberKeys: { create: { teamId, keyVersion: 2 } } } });" },
      { label: "tenant.update nested teamMembers", site: "tenant.update", grant: "await tx.tenant.update({ where: { id: tenantId }, data: { teamMembers: { update: { where: { id: target.id }, data: { role: \"ADMIN\" } } } } });" },
      { label: "tenant.upsert nested teamMemberKeys", site: "tenant.upsert", grant: "await tx.tenant.upsert({ where: { id: tenantId }, create: {}, update: { teamMemberKeys: { create: { teamId, userId: target.userId } } } });" },
      // R3-N2 (d): a computed key cannot be read, so it counts.
      { label: "role behind a computed key", site: "teamMember.update", grant: "await tx.teamMember.update({ where: { id: target.id }, data: { [\"role\"]: \"ADMIN\" } });" },
    ];
    for (const { label, site, grant, writes = 1 } of ARMS) {
      it(`refuses an unchecked ${label}`, () => {
        write(SUBJECT, `export async function promote(tx, rows, target) {\n  ${grant}\n}`);
        expectDenied(run({ writes, grants: 1 }), uncovered(site));
      });

      it(`accepts the same ${label} after a recipient check`, () => {
        write(SUBJECT, `export async function promote(tx, rows, target) {\n  ${CHECK}\n  ${grant}\n}`);
        expect(run({ writes, grants: 1 }).code).toBe(0);
      });
    }

    // R3-N1: only a plain value, `equals` or a one-element `in` names the
    // recipient; everyone-but or one-of-several is covered by no check. Each
    // deny follows the same check its allow twin is covered by.
    const NAMED = [
      ["a plain id", "{ id: target.id }"],
      ["equals", "{ id: { equals: target.id } }"],
      ["a one-element in", "{ id: { in: [target.id] } }"],
      ["a plain userId", "{ teamId, userId: target.userId }"],
    ];
    const NEGATED = [
      ["not", "{ teamId, id: { not: target.id } }"],
      ["notIn", "{ teamId, userId: { notIn: [target.userId] } }"],
      ["NOT", "{ teamId, NOT: { id: target.id } }"],
      ["OR", "{ teamId, OR: [{ id: target.id }, { id: other.id }] }"],
      ["a wider in", "{ id: { in: [target.id, other.id] } }"],
      ["an operator object with a spread", "{ id: { ...filter } }"],
    ];
    it("refuses a grant naming target beside a negated recipient (the parent is target, the rows everyone else's)", () => {
      const grant = "await tx.user.update({ where: { id: target.userId }, data: { teamMemberships: { updateMany: { where: { id: { not: target.id } }, data: { role: \"ADMIN\" } } } } });";
      write(SUBJECT, `export async function promote(tx, rows, target) {\n  ${CHECK}\n  ${grant}\n}`);
      expectDenied(run({ grants: 1 }), uncovered("user.update"));
    });

    // A check counts only when its TRUE outcome exits before the grant on
    // every path: each deny below has an allow twin differing in that alone.
    const PRED = "actorDepartedSinceAdmission(rows.get(target.userId), target.admittedAt)";
    const GRANT = 'await tx.teamMember.update({ where: { id: target.id }, data: { role: "ADMIN" } });';
    const GUARDS = [
      ["a bare call whose result is ignored", `${PRED};`, `if (${PRED}) return;`],
      ["an inverted check (!pred)", `if (!${PRED}) return;`, `if (${PRED}) return;`],
      ["a conjunction (x && pred)", `if (isRoleAbove(a, b) && ${PRED}) throw new Error();`, `if (isRoleAbove(a, b) || ${PRED}) throw new Error();`],
      ["a check in a branch the grant is outside of", `if (cond) { if (${PRED}) return; }`, `if (cond) { if (${PRED}) return; ${GRANT} return; }`],
      ["a check in a loop body the grant is outside of", `for (const r of rs) { if (${PRED}) return; }`, `for (const r of rs) { if (${PRED}) return; ${GRANT} }`],
      ["a consequent that does not exit", `if (${PRED}) { log(); }`, `if (${PRED}) { return; }`],
      ["a consequent whose first statement does not exit", `if (${PRED}) { log(); return; }`, `if (${PRED}) { throw new Error(); }`],
      ["a ternary", `const next = ${PRED} ? null : target;`, `if (${PRED}) return;`],
      ["a stored result", `const leftover = ${PRED}; if (leftover) throw new Error();`, `if (${PRED}) throw new Error();`],
    ];
    for (const [label, deny, allow] of GUARDS) {
      it(`refuses a grant after ${label}`, () => {
        write(SUBJECT, `export async function promote(tx, rows, target, a, b, cond, rs) {\n  ${deny}\n  ${GRANT}\n}`);
        expectDenied(run({ grants: 1 }), uncovered("teamMember.update"));
      });

      it(`accepts the twin of ${label}`, () => {
        // An allow twin that holds the grant itself does not repeat it after.
        const body = allow.includes(GRANT) ? allow : `${allow}\n  ${GRANT}`;
        write(SUBJECT, `export async function promote(tx, rows, target, a, b, cond, rs) {\n  ${body}\n}`);
        expect(run({ grants: 1 }).code).toBe(0);
      });
    }

    const HELPER_PRED = "actorDepartedSinceAdmission(rows.get(locked.userId), locked.admittedAt)";
    const helper = (body) => `
async function isLeftover(tx, memberId) {
  const locked = await tx.teamMember.findFirst({ where: { id: memberId } });
  const rows = await readTenantRows(tx, tenantId, [locked.userId]);
  ${body}
}`;
    const HELPER_GRANT = 'await tx.teamMember.updateMany({ where: { id: memberId }, data: { role: "ADMIN" } });';
    const HELPERS = [
      ["a helper that discards the predicate's result", `${HELPER_PRED}; return false;`, "if (await isLeftover(tx, memberId)) return;"],
      ["a helper that returns the predicate inverted", `return !${HELPER_PRED};`, "if (await isLeftover(tx, memberId)) return;"],
      ["a helper used inverted", `return ${HELPER_PRED};`, "if (!(await isLeftover(tx, memberId))) return;"],
      ["a helper whose result the caller ignores", `return ${HELPER_PRED};`, "await isLeftover(tx, memberId);"],
      ["a helper used in a conjunction", `return ${HELPER_PRED};`, "if (cond && await isLeftover(tx, memberId)) throw new Error();"],
    ];
    for (const [label, body, use] of HELPERS) {
      it(`refuses a grant after ${label}`, () => {
        write(SUBJECT, `${helper(body)}\nexport async function promote(tx, memberId, cond) {\n  ${use}\n  ${HELPER_GRANT}\n}`);
        expectDenied(run({ grants: 1 }), uncovered("teamMember.updateMany"));
      });
    }

    it("accepts a helper returning the predicate, used fail-closed", () => {
      write(SUBJECT, `${helper(`return ${HELPER_PRED};`)}\nexport async function promote(tx, memberId) {\n  if (await isLeftover(tx, memberId)) return;\n  ${HELPER_GRANT}\n}`);
      expect(run({ grants: 1 }).code).toBe(0);
    });

    it("accepts a helper returning a disjunction with the predicate, used as a disjunct of a throwing if", () => {
      write(SUBJECT, `${helper(`return !locked || ${HELPER_PRED};`)}\nexport async function promote(tx, memberId, cond) {\n  if (cond || await isLeftover(tx, memberId)) throw new Error();\n  ${HELPER_GRANT}\n}`);
      expect(run({ grants: 1 }).code).toBe(0);
    });

    // Every recipient a grant names needs its own check; a set the gate
    // cannot list one by one is UNRESOLVED (only an exemption covers it).
    const CHECK_OTHER = "if (actorDepartedSinceAdmission(rows.get(other.userId), other.admittedAt ?? other.createdAt)) return;";
    const MULTI = [
      ["teamMemberKey.createMany to two recipients", "teamMemberKey.createMany", "await tx.teamMemberKey.createMany({ data: [{ teamId, userId: target.userId }, { teamId, userId: other.userId }] });"],
      ["team.update nested members.create of two recipients", "team.update", "await tx.team.update({ where: { id: teamId }, data: { members: { create: [{ userId: target.userId, role: \"ADMIN\" }, { userId: other.userId, role: \"ADMIN\" }] } } });"],
    ];
    for (const [label, site, grant] of MULTI) {
      it(`refuses a ${label} with only one checked`, () => {
        write(SUBJECT, `export async function promote(tx, rows, target, other) {\n  ${CHECK}\n  ${grant}\n}`);
        expectDenied(run({ grants: 1 }), uncovered(site));
      });

      it(`accepts a ${label} with both checked`, () => {
        write(SUBJECT, `export async function promote(tx, rows, target, other) {\n  ${CHECK}\n  ${CHECK_OTHER}\n  ${grant}\n}`);
        expect(run({ grants: 1 }).code).toBe(0);
      });
    }

    const PICKED = "await tx.teamMember.updateMany({ where: { id: pick(target, other).id }, data: { role: \"ADMIN\" } });";
    it("refuses a recipient named by an expression over two variables when no one check names them all", () => {
      write(SUBJECT, `export async function promote(tx, rows, target, other) {\n  ${CHECK}\n  ${CHECK_OTHER}\n  ${PICKED}\n}`);
      expectDenied(run({ grants: 1 }), uncovered("teamMember.updateMany"));
    });

    it("accepts the same recipient after one check naming every variable it is named by", () => {
      write(SUBJECT, `export async function promote(tx, rows, target, other) {
  if (actorDepartedSinceAdmission(rows.get(pick(target, other).userId), pick(target, other).admittedAt)) return;
  ${PICKED}
}`);
      expect(run({ grants: 1 }).code).toBe(0);
    });

    const UNRESOLVED_SETS = [
      // The callback parameter shadows the checked `target`: one element's check is not the set's.
      ["createMany over a mapped array", "teamMemberKey.createMany", "await tx.teamMemberKey.createMany({ data: targets.map((target) => ({ teamId, userId: target.userId })) });"],
      ["createMany over an array held in a variable", "teamMemberKey.createMany", "await tx.teamMemberKey.createMany({ data: keys });"],
      ["create whose data is a spread", "teamMemberKey.create", "await tx.teamMemberKey.create({ data: { ...key, userId: target.userId } });"],
      ["role update over an unbounded in", "teamMember.updateMany", "await tx.teamMember.updateMany({ where: { id: { in: target.teamMemberIds } }, data: { role: \"ADMIN\" } });"],
      ["role update whose where has a spread", "teamMember.updateMany", "await tx.teamMember.updateMany({ where: { ...filter, id: target.id }, data: { role: \"ADMIN\" } });"],
      ["role update naming no recipient (the whole team)", "teamMember.updateMany", "await tx.teamMember.updateMany({ where: { teamId }, data: { role: \"ADMIN\" } });"],
      ["nested members.create whose payload is a variable, beside a named update", "team.update", "await tx.team.update({ where: { id: teamId }, data: { members: { create: rows, update: { where: { id: target.id }, data: { role: \"ADMIN\" } } } } });"],
    ];
    for (const [label, site, grant] of UNRESOLVED_SETS) {
      it(`refuses a ${label} even after a check of target (UNRESOLVED)`, () => {
        write(SUBJECT, `export async function promote(tx, rows, target, targets, keys, key, ids, filter) {\n  ${CHECK}\n  ${grant}\n}`);
        expectDenied(run({ grants: 1 }), uncovered(site));
      });
    }

    it("accepts the createMany twin over a literal array of checked recipients", () => {
      write(SUBJECT, `export async function promote(tx, rows, target) {\n  ${CHECK}\n  await tx.teamMemberKey.createMany({ data: [{ teamId, userId: target.userId }] });\n}`);
      expect(run({ grants: 1 }).code).toBe(0);
    });

    it("accepts the in twin with one checked element", () => {
      write(SUBJECT, `export async function promote(tx, rows, target) {\n  ${CHECK}\n  await tx.teamMember.updateMany({ where: { id: { in: [target.id] } }, data: { role: "ADMIN" } });\n}`);
      expect(run({ grants: 1 }).code).toBe(0);
    });

    it("accepts the team-wide twin naming its row", () => {
      write(SUBJECT, `export async function promote(tx, rows, target) {\n  ${CHECK}\n  await tx.teamMember.updateMany({ where: { teamId, id: target.id }, data: { role: "ADMIN" } });\n}`);
      expect(run({ grants: 1 }).code).toBe(0);
    });

    for (const [label, where] of NAMED) {
      it(`ties a check of target to ${label}`, () => {
        write(SUBJECT, `export async function promote(tx, rows, target, other) {\n  ${CHECK}\n  await tx.teamMember.updateMany({ where: ${where}, data: { role: "ADMIN" } });\n}`);
        expect(run({ grants: 1 }).code).toBe(0);
      });
    }
    for (const [label, where] of NEGATED) {
      it(`does not tie a check of target to ${label}`, () => {
        write(SUBJECT, `export async function promote(tx, rows, target, other) {\n  ${CHECK}\n  await tx.teamMember.updateMany({ where: ${where}, data: { role: "ADMIN" } });\n}`);
        expectDenied(run({ grants: 1 }), uncovered("teamMember.updateMany"));
      });
    }

    const RETURN_LOCKS = "await lockTenantRows(tx, t, [target.userId], \"share\"); await lockTeamsAgainstRotation(tx, [teamId]);";

    it("does not count a role update whose data deactivates the row (deactivatedAt: new Date())", () => {
      write(SUBJECT, `export async function promote(tx, rows, target) {
  ${RETURN_LOCKS}
  await tx.teamMember.update({ where: { id: target.id }, data: { deactivatedAt: new Date(), role: "ADMIN" } });
}`);
      expect(run({ writes: 2 }).code).toBe(0);
    });

    it("counts the same role update with deactivatedAt: null", () => {
      write(SUBJECT, `export async function promote(tx, rows, target) {
  ${RETURN_LOCKS}
  await tx.teamMember.update({ where: { id: target.id }, data: { deactivatedAt: null, role: "ADMIN" } });
}`);
      expectDenied(run({ writes: 2, admissions: 1, grants: 1 }), uncovered("teamMember.update"));
    });

    it("fails the count when a grant site disappears", () => {
      expectDenied(run({ grants: 1 }), /differ from the pinned/);
    });
  });
});
