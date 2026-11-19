import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "..", "checks", "check-team-rotation-input-lock.mjs");
const SUBJECT = "src/lib/team/subject.ts";

/**
 * The exempted sites, so a synthetic root keeps every exemption matched: 1
 * member write, and EXEMPT_TENANT_DELETES tenant-row deletes (seeded in
 * MEMBERSHIP_END_FILES) that run() adds to the counts a test passes.
 */
const EXEMPT_FILES = {
  "src/app/api/teams/[teamId]/rotate-key/route.ts": `
export const rotate = withTenantRls(prisma, tenantId, async (tx) => {
  await tx.teamMember.updateMany({ where: { teamId }, data: { keyDistributed: false } });
});
`,
  "src/lib/auth/session/auth-adapter.ts": `
export const adapter = {
  async createUser(user) {
    return withBypassRls(prisma, async (tx) => {
      await tx.tenantMember.create({ data: { tenantId: tenant.id, userId: createdUser.id, role } });
    });
  },
};
`,
};
const EXEMPT_TENANT_DELETES = 2;
/** departFromTenant's and departCreatedMembership's UPDATEs in the MEMBERSHIP_END_FILES seed. */
const SEEDED_DEPARTURE_WRITERS = 2;
/** The SCIM POST and directory-sync creates in the MEMBERSHIP_END_FILES seed: rule 2 sites, as in the real tree. */
const SEEDED_TENANT_WRITES = 2;

const DEPARTURE = "src/lib/team/team-departure.ts";
const SCIM_USER_SERVICE = "src/lib/services/scim-user-service.ts";
const AUTH = "src/auth.ts";
const SCIM_POST = "src/app/api/scim/v2/Users/route.ts";
const DIRECTORY_SYNC = "src/lib/directory-sync/engine.ts";

/**
 * Rule 9's pinned membership ends (EXPECTED_MEMBERSHIP_ENDS), each revoking
 * after its write and then calling endCreatorFootholdsInTx, and the exempted auth.ts migration shape. The auth.ts and
 * deactivateScimUser deletes are also the two exempted tenant-row deletes,
 * and team-departure.ts's two UPDATEs the SEEDED_DEPARTURE_WRITERS, each with
 * endTeamMemberships after it. writeFile keeps a seeded file's seed and adds
 * to it, so a red cannot pass on a missing pinned site.
 *
 * Rule 10's pinned membership creations (EXPECTED_MEMBERSHIP_CREATIONS) are
 * seeded here too, in production's shape: the SCIM POST and directory-sync
 * creates, whose `deactivatedAt` is conditional, with departCreatedMembership
 * on the deactivated arm and the revocation on the active one (so they are
 * also the SEEDED_TENANT_WRITES), and sign-in's joinClaimedTenant INSERT, each
 * revoking after its write; the migration's create (auth.ts), exempted. The
 * adapter's exempted createUser is in EXEMPT_FILES.
 */
const MEMBERSHIP_END_FILES = {
  [DEPARTURE]: `
export async function departFromTenant(tx, tenantId, userIds, options) {
  const transitioned = await tx.$queryRaw\`
    UPDATE tenant_members SET deactivated_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE tenant_id = \${tenantId}::uuid AND user_id = ANY(\${[...userIds]}::uuid[]) AND deactivated_at IS NULL
    RETURNING user_id\`;
  await endTeamMemberships(tx, tenantId, transitioned, options);
  const revocation = await revokeUsersAuthArtifactsInTx(tx, transitioned, { tenantFilter: { tenantId }, boundedLockWait: true });
  await endCreatorFootholdsInTx(tx, tenantId, transitioned, options.actor);
  return { userIds: transitioned, revocation };
}
export async function departCreatedMembership(tx, tenantId, userIds, options) {
  await tx.$executeRaw\`
    UPDATE tenant_members SET deactivated_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE tenant_id = \${tenantId}::uuid AND user_id = ANY(\${[...userIds]}::uuid[]) AND deactivated_at IS NOT NULL\`;
  await endTeamMemberships(tx, tenantId, userIds, options);
  const revocation = await revokeUsersAuthArtifactsInTx(tx, userIds, { tenantFilter: { tenantId }, boundedLockWait: true });
  await endCreatorFootholdsInTx(tx, tenantId, userIds, options.actor);
  return revocation;
}
`,
  [SCIM_USER_SERVICE]: `
export async function deactivateScimUser(tenantId, userId, actor) {
  return prisma.$transaction(async (tx) => {
    await tx.tenantMember.delete({ where: { tenantId_userId: { tenantId, userId } } });
    const revoked = await revokeUserAuthArtifactsInTx(tx, userId, { tenantFilter: { tenantId }, boundedLockWait: true });
    await endCreatorFootholdsInTx(tx, tenantId, [userId], actor);
    return revoked;
  });
}
`,
  [AUTH]: `
export async function migrateBootstrapTenant(userId, existingTenantId, target) {
  await withBypassRls(prisma, async (tx) => {
    await tx.tenantMember.deleteMany({ where: { userId, tenantId: existingTenantId } });
    await tx.tenantMember.create({ data: { tenantId: target.id, userId, role: TENANT_ROLE.MEMBER } });
  });
}
async function joinClaimedTenant(tx, userId, tenantId) {
  const inserted = await tx.$queryRaw\`
    INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
    VALUES (gen_random_uuid(), \${tenantId}::uuid, \${userId}::uuid, \${TENANT_ROLE.MEMBER}::"TenantRole", clock_timestamp(), clock_timestamp())
    ON CONFLICT (tenant_id, user_id) DO NOTHING
    RETURNING id\`;
  const memberId = inserted[0]?.id ?? (await tx.tenantMember.findUniqueOrThrow({ where, select: { id: true } })).id;
  await realignToMembershipInTx(tx, { userId, memberId, tenantId });
  if (inserted.length === 0) return null;
  return revokeUsersAuthArtifactsInTx(tx, [userId], { tenantFilter: { tenantId }, boundedLockWait: true });
}
`,
  [SCIM_POST]: `
export const createScimUser = withTenantRls(prisma, tenantId, async (tx) => {
  if (active === false) await lockTenantMemberCreation(tx, tenantId, user.id, budget);
  const member = await tx.tenantMember.create({
    data: { tenantId, userId: user.id, role: TENANT_ROLE.MEMBER, deactivatedAt: active === false ? new Date() : null },
  });
  if (active === false) revocation = await departCreatedMembership(tx, tenantId, [user.id], { actor, budget });
  if (existingUserId && active !== false) {
    revocation = await revokeUsersAuthArtifactsInTx(tx, [user.id], { tenantFilter: { tenantId }, boundedLockWait: true });
  }
});
`,
  [DIRECTORY_SYNC]: `
export const apply = withTenantRls(prisma, tenantId, async (tx) => {
  await lockTenantRows(tx, tenantId, userIds, "update", budget);
  for (const pu of toCreate) {
    const createsDeactivated = !pu.active || activeInAnother;
    await tx.tenantMember.create({
      data: { tenantId, userId: pu.userId, role: TENANT_ROLE.MEMBER, deactivatedAt: createsDeactivated ? new Date() : null },
    });
  }
  departures.push({ userIds: createdDeactivated, revocation: await departCreatedMembership(tx, tenantId, createdDeactivated, { actor, budget }) });
  admissions.push({ userIds: createdActive, revocation: await revokeUsersAuthArtifactsInTx(tx, createdActive, { tenantFilter: { tenantId }, boundedLockWait: true }) });
});
`,
};

let root;

function run({ writes = 1, tenantWrites = 0, admissions = 0, departureWriters = 0, tenantDeletes = 0, creations = [] } = {}) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [GATE], {
        encoding: "utf8",
        env: {
          ...process.env,
          TEAM_ROTATION_INPUT_LOCK_ROOT: root,
          TEAM_ROTATION_INPUT_LOCK_WRITES: String(writes),
          TEAM_ROTATION_INPUT_LOCK_TENANT_WRITES: String(tenantWrites + SEEDED_TENANT_WRITES),
          TEAM_ROTATION_INPUT_LOCK_ADMISSIONS: String(admissions),
          TEAM_ROTATION_INPUT_LOCK_DEPARTURE_WRITERS: String(departureWriters + SEEDED_DEPARTURE_WRITERS),
          TEAM_ROTATION_INPUT_LOCK_TENANT_DELETES: String(tenantDeletes + EXEMPT_TENANT_DELETES),
          TEAM_ROTATION_INPUT_LOCK_EXTRA_CREATIONS: JSON.stringify(creations),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Writes `body` as the whole file, dropping any seed. */
function replaceFile(rel, body) {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function writeFile(rel, body) {
  replaceFile(rel, rel in MEMBERSHIP_END_FILES ? `${MEMBERSHIP_END_FILES[rel]}\n${body}` : body);
}

const write = writeFile;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "team-rotation-input-lock-"));
  // A target that contributes no source file reads as missing, so each one
  // carries a file with no sites.
  write("src/app/layout.ts", "export {};\n");
  write("src/lib/util.ts", "export {};\n");
  write("src/workers/worker.ts", "export {};\n");
  write("scripts/x.ts", "export {};\n");
  for (const [rel, body] of Object.entries(EXEMPT_FILES)) write(rel, body);
  for (const [rel, body] of Object.entries(MEMBERSHIP_END_FILES)) replaceFile(rel, body);
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

    it("passes an unchecked role update: the database judges grants (rule 8 retired)", () => {
      write(SUBJECT, `export async function upd(tx, target) {
  await tx.teamMember.update({ where: { id: target.id }, data: { role: "ADMIN" } });
}`);
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

    // Each create is also a rule-10 membership creation, pinned here through
    // `creations`; departCreatedMembership is its revocation.
    const SUBJECT_CREATE = ["membership-create::src/lib/team/subject.ts::create::tenantMember.create"];
    const unlockedCreate = /tenant-state::src\/lib\/team\/subject\.ts::create::tenantMember\.create/;

    it("accepts a create-deactivated arm with the creation lock before and the departure after", () => {
      write(SUBJECT, `export async function create(tx) {
  await lockTenantMemberCreation(tx, t, u);
  await tx.tenantMember.create({ data: { tenantId: t, userId: u, deactivatedAt: new Date() } });
  await departCreatedMembership(tx, t, u, { actor });
}`);
      expect(run({ tenantWrites: 1, creations: SUBJECT_CREATE }).code).toBe(0);
    });

    it("refuses a create-deactivated arm without the departure after it", () => {
      write(SUBJECT, `export async function create(tx) {
  await lockTenantMemberCreation(tx, t, u);
  await tx.tenantMember.create({ data: { tenantId: t, userId: u, deactivatedAt: new Date() } });
}`);
      expectDenied(run({ tenantWrites: 1, creations: SUBJECT_CREATE }), unlockedCreate);
    });

    it("refuses a create-deactivated arm without the creation lock before it", () => {
      write(SUBJECT, `export async function create(tx) {
  await tx.tenantMember.create({ data: { tenantId: t, userId: u, deactivatedAt: new Date() } });
  await departCreatedMembership(tx, t, u, { actor });
}`);
      const r = run({ tenantWrites: 1, creations: SUBJECT_CREATE });
      expectDenied(r, unlockedCreate);
      expect(r.out).not.toMatch(/membership-create/);
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

  describe("departure writers: team-departure.ts's own tenant active-state writes", () => {
    const DEPARTURE = "src/lib/team/team-departure.ts";
    const SITE = /departure-writer::src\/lib\/team\/team-departure\.ts::off::tenant_members\.raw/;
    const rawOff = "await tx.$queryRaw`UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE id = ${id}::uuid`;";

    it("refuses a deactivating UPDATE with no later endTeamMemberships", () => {
      write(DEPARTURE, `export async function off(tx) { ${rawOff} }`);
      expectDenied(run({ departureWriters: 1 }), SITE);
    });

    // A deactivating write is also a rule-9 membership end: it must revoke
    // after it and be a pinned site, so the accepting cells put it in the
    // pinned departFromTenant, in place of the seeded one.
    const REVOKE_AFTER = "await revokeUsersAuthArtifactsInTx(tx, [u], { tenantFilter: { tenantId: t } }); await endCreatorFootholdsInTx(tx, t, [u], actor);";
    const asDepartFromTenant = (body) => MEMBERSHIP_END_FILES[DEPARTURE]
      .replace(/export async function departFromTenant[\s\S]*?\n}\n/, `export async function departFromTenant(tx) { ${body} }\n`);

    it("accepts the same UPDATE with endTeamMemberships after it", () => {
      replaceFile(DEPARTURE, asDepartFromTenant(`${rawOff} await endTeamMemberships(tx, t, [u], options); ${REVOKE_AFTER}`));
      expect(run().code).toBe(0);
    });

    it("refuses the departFromTenant UPDATE when endTeamMemberships is dropped (positive control)", () => {
      replaceFile(DEPARTURE, asDepartFromTenant(`${rawOff} ${REVOKE_AFTER}`));
      expectDenied(run(), /departure-writer::src\/lib\/team\/team-departure\.ts::departFromTenant::tenant_members\.raw/);
    });

    it("refuses an endTeamMemberships call that comes before the write", () => {
      write(DEPARTURE, `export async function off(tx) { await endTeamMemberships(tx, t, [u], options); ${rawOff} }`);
      expectDenied(run({ departureWriters: 1 }), SITE);
    });

    it("refuses an endTeamMemberships call in another function", () => {
      write(DEPARTURE, `export async function off(tx) { ${rawOff} }
export async function other(tx) { await endTeamMemberships(tx, t, [u], options); }`);
      expectDenied(run({ departureWriters: 1 }), SITE);
    });

    it("refuses an endTeamMemberships call nested in a callback of the writer's function", () => {
      write(DEPARTURE, `export async function off(tx) { ${rawOff} const later = async () => { await endTeamMemberships(tx, t, [u], options); }; }`);
      expectDenied(run({ departureWriters: 1 }), SITE);
    });

    it("refuses a Prisma upsert whose create arm deactivates, with no later endTeamMemberships", () => {
      write(DEPARTURE, `export async function off(tx) { await tx.tenantMember.upsert({ where, create: { deactivatedAt: new Date() }, update: {} }); }`);
      expectDenied(run({ departureWriters: 1 }), /departure-writer::src\/lib\/team\/team-departure\.ts::off::tenantMember\.upsert/);
    });

    it("accepts a Prisma upsert whose update arm clears deactivatedAt without the call", () => {
      // The revocation and the pinned key are rule 10's: the upsert may create a row.
      write(DEPARTURE, `export async function back(tx) { await tx.tenantMember.upsert({ where, create: { role }, update: { deactivatedAt: null } }); ${REVOKE_AFTER} }`);
      expect(run({ departureWriters: 1, creations: ["membership-create::src/lib/team/team-departure.ts::back::tenantMember.upsert"] }).code).toBe(0);
    });

    it("refuses a Prisma deactivating write with no later endTeamMemberships", () => {
      write(DEPARTURE, `export async function off(tx) { await tx.tenantMember.update({ where: { id }, data: { deactivatedAt: new Date() } }); }`);
      expectDenied(run({ departureWriters: 1 }), /departure-writer::src\/lib\/team\/team-departure\.ts::off::tenantMember\.update/);
    });

    it("passes the departure-writer rule for a Prisma deactivating write with endTeamMemberships after it, while rule 9 refuses it as an unpinned membership end", () => {
      write(DEPARTURE, `export async function off(tx) { await tx.tenantMember.update({ where: { id }, data: { deactivatedAt: new Date() } }); await endTeamMemberships(tx, t, [u], options); ${REVOKE_AFTER} }`);
      const r = run({ departureWriters: 1 });
      expectDenied(r, /unexpected: membership-end::src\/lib\/team\/team-departure\.ts::off::tenantMember\.update/);
      expect(r.out).not.toMatch(/departure-writer::/);
      expect(r.out).not.toMatch(/ends a tenant membership/);
    });

    it("accepts a Prisma write that clears deactivatedAt without the call", () => {
      write(DEPARTURE, `export async function back(tx) { await tx.tenantMember.updateMany({ where: { id }, data: { deactivatedAt: null } }); }`);
      expect(run({ departureWriters: 1 }).code).toBe(0);
    });

    it("refuses a raw SET to the clock that only has IS NULL in its WHERE", () => {
      write(DEPARTURE, `export async function off(tx) { ${rawOff.replace("WHERE id = ${id}::uuid", "WHERE deactivated_at IS NULL")} }`);
      expectDenied(run({ departureWriters: 1 }), SITE);
    });

    it("accepts a raw SET deactivated_at = NULL without the call", () => {
      write(DEPARTURE, "export async function off(tx) { await tx.$queryRaw`UPDATE tenant_members SET deactivated_at = NULL WHERE deactivated_at IS NOT NULL`; }");
      expect(run({ departureWriters: 1 }).code).toBe(0);
    });

    const writer = (name) => `export async function ${name}(tx) { await tx.$queryRaw\`UPDATE tenant_members SET deactivated_at = NULL WHERE id = \${id}::uuid\`; }`;

    it("accepts the pinned three writers", () => {
      write(DEPARTURE, ["a", "b", "c"].map(writer).join("\n"));
      expect(run({ departureWriters: 3 }).code).toBe(0);
    });

    it("refuses a fourth writer against the pinned three", () => {
      write(DEPARTURE, ["a", "b", "c", "d"].map(writer).join("\n"));
      expectDenied(run({ departureWriters: 3 }), /differ from the pinned/);
    });
  });

  describe("rules 2, 5 and 6 reach the other implementation files", () => {
    for (const file of ["src/lib/team/tenant-row-lock.ts", "src/lib/team/team-key-rotation-lock.ts"]) {
      it(`refuses a tenant active-state write in ${file}`, () => {
        write(file, "export async function off(tx) { await tx.$executeRaw`UPDATE tenant_members SET deactivated_at = now() WHERE id = ${id}::uuid`; }");
        expectDenied(run(), /raw write of tenant_members\.deactivated_at/);
      });

      it(`refuses a Prisma tenant active-state write in ${file}`, () => {
        write(file, "export async function off(tx) { await tx.tenantMember.update({ where: { id }, data: { deactivatedAt: new Date() } }); }");
        expectDenied(run({ tenantWrites: 1 }), /tenant-state::[^\n]*tenantMember\.update/);
      });

      it(`refuses a departure-record write in ${file}`, () => {
        write(file, "export async function rec(tx) { await tx.$executeRaw`INSERT INTO tenant_member_departures (tenant_id, user_id, departed_at) VALUES (${t}::uuid, ${u}::uuid, now())`; }");
        expectDenied(run(), /INSERT INTO tenant_member_departures in rec/);
      });

      it(`refuses a call of deleteUser in ${file}`, () => {
        write(file, "export async function purge() { await adapter.deleteUser(id); }");
        expectDenied(run(), /calls deleteUser/);
      });

      it(`accepts ${file} without them`, () => {
        write(file, "export async function lock(tx) { await tx.$executeRaw`SELECT 1 FROM tenant_members WHERE id = ${id}::uuid FOR UPDATE`; }");
        expect(run().code).toBe(0);
      });
    }
  });

  describe("scripts/ is scanned", () => {
    it("refuses a tenant active-state write in a scripts/ file", () => {
      write("scripts/x.ts", "export async function off(tx) { await tx.$executeRaw`UPDATE tenant_members SET deactivated_at = now() WHERE id = ${id}::uuid`; }");
      expectDenied(run(), /raw write of tenant_members\.deactivated_at/);
    });

    it("accepts a read of tenant_members in a scripts/ file", () => {
      write("scripts/x.ts", "export async function list(tx) { return tx.$queryRaw`SELECT user_id FROM tenant_members WHERE deactivated_at IS NULL`; }");
      expect(run().code).toBe(0);
    });
  });

  describe("tenant-row deletes need a reviewed exemption", () => {
    it("refuses a tenantMember.delete", () => {
      write(SUBJECT, `export async function drop(tx) { await tx.tenantMember.delete({ where }); }`);
      expectDenied(run({ tenantDeletes: 1 }), /tenant-row-delete::src\/lib\/team\/subject\.ts::drop::tenantMember\.delete/);
    });

    it("refuses a tenantMember.deleteMany", () => {
      write(SUBJECT, `export async function drop(tx) { await tx.tenantMember.deleteMany({ where }); }`);
      expectDenied(run({ tenantDeletes: 1 }), /tenant-row-delete::src\/lib\/team\/subject\.ts::drop::tenantMember\.deleteMany/);
    });

    it("refuses a raw DELETE FROM tenant_members, schema-qualified and quoted", () => {
      write(SUBJECT, 'export async function drop(tx) { await tx.$executeRaw`DELETE FROM "public"."tenant_members" WHERE id = ${id}::uuid`; }');
      expectDenied(run({ tenantDeletes: 1 }), /tenant-row-delete::src\/lib\/team\/subject\.ts::drop::tenant_members\.raw/);
    });

    it("accepts the two exempted deletes (src/auth.ts, deactivateScimUser)", () => {
      expect(run().code).toBe(0);
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
    const MODULE = "src/lib/team/scim-admission.ts";
    const write = writeFile;
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
      expectDenied(run(), /scimApprovalPending set to something other than the literal true outside the admission module/);
    });

    it("passes scimApprovalPending: false in a where filter outside the approve route", () => {
      write(SUBJECT, "export async function list(tx, teamId) { return tx.teamMember.findMany({ where: { teamId, scimApprovalPending: false } }); }");
      expect(run().code).toBe(0);
    });

    it("refuses a variable value for scimApprovalPending outside the approve route", () => {
      write(SUBJECT, "export async function off(tx, id, pending) { await tx.teamMember.update({ where: { id }, data: { scimApprovalPending: pending } }); }");
      expectDenied(run(), /scimApprovalPending set to something other than the literal true outside the admission module/);
    });

    it("refuses a shorthand scimApprovalPending outside the approve route", () => {
      write(SUBJECT, "export async function off(tx, id, scimApprovalPending) { await tx.teamMember.update({ where: { id }, data: { scimApprovalPending } }); }");
      expectDenied(run(), /scimApprovalPending set to something other than the literal true outside the admission module/);
    });

    it("refuses a quoted scimApprovalPending key outside the approve route", () => {
      write(SUBJECT, 'export async function off(tx, id) { await tx.teamMember.update({ where: { id }, data: { "scimApprovalPending": false } }); }');
      expectDenied(run(), /scimApprovalPending set to something other than the literal true outside the admission module/);
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

    it("passes the admission module's approve CAS (literal true in the where, literal false in the data)", () => {
      write(MODULE, `export async function approve(tx, tenantId, ctx, targets) {
  await lockTenantRows(tx, tenantId, [actorId, ...userIds], "share");
  await lockTeamsAgainstRotation(tx, [teamId]);
  for (const { memberId, expectedRole } of targets) {
    await tx.teamMember.updateMany({
      where: { id: memberId, teamId, role: expectedRole, scimApprovalPending: true, deactivatedAt: { not: null } },
      data: { deactivatedAt: null, scimApprovalPending: false, keyDistributed: false },
    });
  }
}`);
      expect(run({ writes: 2, admissions: 1 }).code).toBe(0);
    });

    it("passes the admission module's reject delete", () => {
      write(MODULE, `export async function reject(tx, tenantId, ctx, targets) {
  await lockTenantRows(tx, tenantId, [actorId, ...userIds], "share");
  await lockTeamsAgainstRotation(tx, [teamId]);
  for (const { memberId } of targets) {
    await tx.teamMember.deleteMany({ where: { id: memberId, teamId, scimApprovalPending: true } });
  }
}`);
      expect(run({ writes: 2 }).code).toBe(0);
    });

    it("refuses the approve CAS's scimApprovalPending: false in the old home, the approve route", () => {
      write(APPROVE, `export const approve = withTenantRls(prisma, tenantId, async (tx) => {
  await lockTenantRows(tx, tenantId, [approverId, targetId], "share");
  await lockTeamsAgainstRotation(tx, [teamId]);
  await tx.teamMember.updateMany({
    where: { id, teamId, role: expectedRole, scimApprovalPending: true, deactivatedAt: { not: null } },
    data: { deactivatedAt: null, scimApprovalPending: false, keyDistributed: false },
  });
});`);
      expectDenied(run({ writes: 2, admissions: 1 }), /scimApprovalPending set to something other than the literal true outside the admission module/);
    });

    describe("admission module boundary", () => {
      const MEMBERS = "src/app/api/teams/[teamId]/members";
      const ROUTES = [
        `${MEMBERS}/[memberId]/approve/route.ts`,
        `${MEMBERS}/[memberId]/reject/route.ts`,
        `${MEMBERS}/bulk-approve/route.ts`,
        `${MEMBERS}/bulk-reject/route.ts`,
      ];
      const OTHER = "src/lib/other/importer.ts";
      const ROUTE_BODY = `import { extractRequestMeta } from "@/lib/audit/audit";
import { approveScimPending } from "@/lib/team/scim-admission";
export const POST = async (req) => approveScimPending(tx, t, { ...extractRequestMeta(req) }, []);
`;

      it("accepts the four admission routes importing the module and only extractRequestMeta from the audit lib", () => {
        for (const route of ROUTES) write(route, ROUTE_BODY);
        expect(run().code).toBe(0);
      });

      it("accepts a page importing the near-named constants file", () => {
        write("src/app/page.tsx", `import { SCIM_BULK_ADMISSION_MAX } from "@/lib/constants/team/scim-admission";\nexport const max = SCIM_BULK_ADMISSION_MAX;\n`);
        expect(run().code).toBe(0);
      });

      it("refuses a fifth file importing the module by alias", () => {
        write(OTHER, `import { approveScimPending } from "@/lib/team/scim-admission";\nexport const f = approveScimPending;\n`);
        expectDenied(run(), /admission-module  src\/lib\/other\/importer\.ts:1  import of the SCIM admission module outside the four admission routes/);
      });

      it("refuses a fifth file importing the module by relative path", () => {
        write(OTHER, `import { approveScimPending } from "../team/scim-admission";\nexport const f = approveScimPending;\n`);
        expectDenied(run(), /import of the SCIM admission module outside the four admission routes/);
      });

      it("refuses a relative import that spells the extension", () => {
        write(OTHER, `import { approveScimPending } from "../team/scim-admission.js";\nexport const f = approveScimPending;\n`);
        expectDenied(run(), /import of the SCIM admission module outside the four admission routes/);
      });

      it("refuses an alias import that detours through a parent segment", () => {
        write(OTHER, `import { approveScimPending } from "@/lib/team/../team/scim-admission";\nexport const f = approveScimPending;\n`);
        expectDenied(run(), /import of the SCIM admission module outside the four admission routes/);
      });

      it("refuses an alias import that doubles a slash", () => {
        write(OTHER, `import { approveScimPending } from "@/lib//team/scim-admission";\nexport const f = approveScimPending;\n`);
        expectDenied(run(), /import of the SCIM admission module outside the four admission routes/);
      });

      it("refuses a literal import() of the module", () => {
        write(OTHER, `export const load = () => import("@/lib/team/scim-admission");\n`);
        expectDenied(run(), /dynamic import of the SCIM admission module outside the four admission routes/);
      });

      it("refuses a literal require() of the module", () => {
        write(OTHER, `export const load = () => require("../team/scim-admission");\n`);
        expectDenied(run(), /require of the SCIM admission module outside the four admission routes/);
      });

      it("refuses import x = require() of the module outside the four routes", () => {
        write(OTHER, `import m = require("../team/scim-admission");\nexport const f = m;\n`);
        expectDenied(run(), /require of the SCIM admission module outside the four admission routes/);
      });

      it("refuses export * from the module", () => {
        write(OTHER, `export * from "@/lib/team/scim-admission";\n`);
        expectDenied(run(), /re-exports the SCIM admission module/);
      });

      it("refuses export { … } from the module", () => {
        write(OTHER, `export { approveScimPending } from "../team/scim-admission";\n`);
        expectDenied(run(), /re-exports the SCIM admission module/);
      });

      it("refuses a re-export of the module even from an admission route", () => {
        write(ROUTES[2], `export { approveScimPending } from "@/lib/team/scim-admission";\n`);
        expectDenied(run(), /re-exports the SCIM admission module/);
      });

      it("refuses an admission route calling lockTenantRows", () => {
        write(ROUTES[0], `${ROUTE_BODY}export const lock = (tx) => lockTenantRows(tx, t, [u], "share");\n`);
        expectDenied(run(), /admission route calls lockTenantRows/);
      });

      it("accepts lockTenantRows outside the four admission routes", () => {
        write(OTHER, `export const lock = (tx) => lockTenantRows(tx, t, [u], "share");\n`);
        expect(run().code).toBe(0);
      });

      it.each([
        ["logAuditInTx from the audit module", `import { extractRequestMeta, logAuditInTx } from "@/lib/audit/audit";`, /import of logAuditInTx from @\/lib\/audit\/audit/],
        ["logAuditAsyncBothScopes from the audit module", `import { logAuditAsyncBothScopes } from "@/lib/audit/audit";`, /import of logAuditAsyncBothScopes/],
        ["a renamed logAuditInTx", `import { logAuditInTx as emit } from "@/lib/audit/audit";`, /import of logAuditInTx/],
        ["a namespace import of the audit module", `import * as audit from "@/lib/audit/audit";`, /import of \* from/],
        ["enqueueAudit from audit-outbox", `import { enqueueAudit } from "@/lib/audit/audit-outbox";`, /import of @\/lib\/audit\/audit-outbox\b(?!-)/],
        ["enqueueAuditInTx from audit-outbox-in-tx", `import { enqueueAuditInTx } from "@/lib/audit/audit-outbox-in-tx";`, /import of @\/lib\/audit\/audit-outbox-in-tx/],
        ["a relative import of the audit module", `import { logAuditInTx } from "../../../../../../../lib/audit/audit";`, /import of logAuditInTx/],
        ["a namespace import of the bare audit lib directory", `import * as a from "@/lib/audit";`, /admission-audit .*import of @\/lib\/audit\b/],
        ["an alias import of the audit lib that detours through a parent segment", `import { enqueueAudit } from "@/lib/team/../audit/audit-outbox";`, /admission-audit .*import of @\/lib\/team\/\.\.\/audit\/audit-outbox/],
      ])("refuses an admission route importing %s", (_name, line, pattern) => {
        write(ROUTES[1], `${line}\n`);
        expectDenied(run(), pattern);
      });

      it("refuses an admission route loading the audit lib through import()", () => {
        write(ROUTES[3], `export const load = () => import("@/lib/audit/audit");\n`);
        expectDenied(run(), /admission-audit .*dynamic import of @\/lib\/audit\/audit/);
      });

      it("refuses the module importing logAuditAsync", () => {
        write(MODULE, `import { logAuditAsync } from "@/lib/audit/audit";\nexport const f = logAuditAsync;\n`);
        expectDenied(run(), /admission-audit .*import of logAuditAsync from @\/lib\/audit\/audit/);
      });

      it("refuses the module importing extractRequestMeta (not its allowance)", () => {
        write(MODULE, `import { extractRequestMeta } from "@/lib/audit/audit";\nexport const f = extractRequestMeta;\n`);
        expectDenied(run(), /import of extractRequestMeta/);
      });

      it("accepts the module importing logAuditInTx", () => {
        write(MODULE, `import { logAuditInTx } from "@/lib/audit/audit";\nexport const f = logAuditInTx;\n`);
        expect(run().code).toBe(0);
      });

      it("accepts a file outside the boundary importing any audit emitter", () => {
        write(OTHER, `import { logAuditInTx, logAuditAsync } from "@/lib/audit/audit";\nexport const f = [logAuditInTx, logAuditAsync];\n`);
        expect(run().code).toBe(0);
      });
    });
  });

  describe("rule 9: a tenant-membership end revokes in its function", () => {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    /** Rule 9's own violation for the site `fn::site` in `path`. */
    const ended = (fn, site, path = DEPARTURE) =>
      new RegExp(`membership-end  ${esc(path)}:\\d+  membership-end::${esc(path)}::${esc(fn)}::${esc(site)}  ends a tenant membership`);
    const REVOKE = "await revokeUsersAuthArtifactsInTx(tx, ids, { tenantFilter: { tenantId }, boundedLockWait: true });";
    const ENDER = "await endCreatorFootholdsInTx(tx, tenantId, ids, actor);";

    it("passes the pinned sites, each revoking after its write, and the exempted migration", () => {
      const r = run();
      expect(r.code).toBe(0);
      expect(r.out).not.toMatch(/membership-end/);
    });

    // Each red adds one write, with no revocation after it, to the seeded
    // team-departure.ts (an IMPLEMENTATIONS file, so rule 9 runs before the skip).
    const RAW = (sql) => `await tx.$executeRaw\`${sql}\`;`;
    const REDS = [
      ["a Prisma delete", "tenantMember.delete", "await tx.tenantMember.delete({ where: { id } });"],
      ["a Prisma updateMany with deactivatedAt: new Date()", "tenantMember.updateMany", "await tx.tenantMember.updateMany({ where: { tenantId }, data: { deactivatedAt: new Date() } });"],
      ["a Prisma updateManyAndReturn with deactivatedAt: new Date()", "tenantMember.updateManyAndReturn", "await tx.tenantMember.updateManyAndReturn({ where: { tenantId }, data: { deactivatedAt: new Date() } });"],
      ["a Prisma create with deactivatedAt: new Date()", "tenantMember.create", "await tx.tenantMember.create({ data: { tenantId, userId, deactivatedAt: new Date() } });"],
      ["a Prisma update whose data is a spread", "tenantMember.update", "await tx.tenantMember.update({ where: { id }, data: { ...patch } });"],
      ["a column-less INSERT INTO tenant_members VALUES (…)", "tenant_members.raw", RAW("INSERT INTO tenant_members VALUES (${id}::uuid, ${tenantId}::uuid, ${userId}::uuid)")],
      ["an upsert whose INSERT columns name deactivated_at and whose DO UPDATE SET does not", "tenant_members.raw", RAW("INSERT INTO tenant_members (tenant_id, user_id, deactivated_at) VALUES (${tenantId}::uuid, ${userId}::uuid, now()) ON CONFLICT (tenant_id, user_id) DO UPDATE SET updated_at = now()")],
      ["a raw DELETE", "tenant_members.raw", RAW("DELETE FROM tenant_members WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid")],
      ["a raw UPDATE = clock_timestamp()", "tenant_members.raw", RAW("UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE tenant_id = ${tenantId}::uuid")],
      ["a raw UPDATE with an interpolated value", "tenant_members.raw", RAW("UPDATE tenant_members SET updated_at = now(), deactivated_at = ${at} WHERE tenant_id = ${tenantId}::uuid")],
      ["a raw INSERT … deactivated_at", "tenant_members.raw", RAW("INSERT INTO tenant_members (tenant_id, user_id, deactivated_at) VALUES (${tenantId}::uuid, ${userId}::uuid, now())")],
      ["an ON CONFLICT DO UPDATE SET deactivated_at", "tenant_members.raw", RAW("INSERT INTO tenant_members (tenant_id, user_id) VALUES (${tenantId}::uuid, ${userId}::uuid) ON CONFLICT (tenant_id, user_id) DO UPDATE SET deactivated_at = now()")],
      ["a raw UPDATE whose SET list cannot be read (a fragment)", "tenant_members.raw", RAW("UPDATE tenant_members SET ${assignments} WHERE tenant_id = ${tenantId}::uuid")],
      ["a raw UPDATE of a ${…} target", "opaque.raw", RAW("UPDATE ${table} SET role = 'MEMBER' WHERE tenant_id = ${tenantId}::uuid")],
      ["a raw INSERT into a ${…} target", "opaque.raw", RAW("INSERT INTO ${table} (tenant_id, user_id) VALUES (${tenantId}::uuid, ${userId}::uuid)")],
      ["a write word the scanner cannot place, beside tenant_members", "tenant_members.raw", RAW("EXPLAIN ANALYZE UPDATE tenant_members SET role = 'MEMBER' WHERE tenant_id = ${tenantId}::uuid")],
      ["a MERGE whose INSERT arm names deactivated_at", "tenant_members.raw", RAW("MERGE INTO tenant_members t USING incoming s ON t.user_id = s.user_id WHEN NOT MATCHED THEN INSERT (tenant_id, user_id, deactivated_at) VALUES (s.tenant_id, s.user_id, now())")],
      ["a MERGE … THEN DELETE", "tenant_members.raw", RAW("MERGE INTO tenant_members t USING incoming s ON t.user_id = s.user_id WHEN MATCHED THEN DELETE")],
    ];
    for (const [label, site, body] of REDS) {
      it(`refuses ${label} with no revocation after it`, () => {
        write(DEPARTURE, `export async function redEnd(tx, tenantId, userId, id, at, patch, ids, table, assignments) {\n  ${body}\n}`);
        expectDenied(run(), ended("redEnd", site));
      });
    }

    it("refuses a revocation called before the write", () => {
      write(DEPARTURE, `export async function redEnd(tx, tenantId, ids, id) {\n  ${REVOKE}\n  await tx.tenantMember.delete({ where: { id } });\n}`);
      expectDenied(run(), ended("redEnd", "tenantMember.delete"));
    });

    it("refuses a revocation inside a nested callback (not the write's own function)", () => {
      write(DEPARTURE, `export async function redEnd(tx, tenantId, ids, id) {
  await tx.tenantMember.delete({ where: { id } });
  await Promise.all([ids].map(async (batch) => revokeUsersAuthArtifactsInTx(tx, batch, { tenantFilter: { tenantId } })));
}`);
      expectDenied(run(), ended("redEnd", "tenantMember.delete"));
    });

    it("refuses a revocation placed after the $transaction whose callback ends the membership", () => {
      write(SCIM_USER_SERVICE, `export async function deactivateLate(tenantId, userId) {
  await prisma.$transaction(async (tx) => {
    await tx.tenantMember.delete({ where: { tenantId_userId: { tenantId, userId } } });
  });
  await revokeUserAuthArtifactsInTx(prisma, userId, { tenantFilter: { tenantId } });
}`);
      expectDenied(run(), ended("<anonymous>", "tenantMember.delete", SCIM_USER_SERVICE));
    });

    it("refuses a Prisma deleteMany outside the IMPLEMENTATIONS files", () => {
      write(SUBJECT, "export async function purge(tx, tenantId) { await tx.tenantMember.deleteMany({ where: { tenantId } }); }");
      expectDenied(run(), ended("purge", "tenantMember.deleteMany", SUBJECT));
    });

    it("allows the returnToTenant shape (deactivated_at = NULL)", () => {
      write(DEPARTURE, `export async function returnToTenant(tx, tenantId, userIds) {
  await tx.$queryRaw\`
    UPDATE tenant_members SET deactivated_at = NULL, updated_at = clock_timestamp()
     WHERE tenant_id = \${tenantId}::uuid AND user_id = ANY(\${[...userIds]}::uuid[])
       AND deactivated_at IS NOT NULL
    RETURNING user_id\`;
}`);
      // A departureWriters site (#1062), covered by its clearing.
      expect(run({ departureWriters: 1 }).code).toBe(0);
    });

    it("allows a reactivation's deactivatedAt: null in an IMPLEMENTATIONS file", () => {
      write(DEPARTURE, "export async function back(tx, tenantId) { await tx.tenantMember.updateMany({ where: { tenantId }, data: { deactivatedAt: null } }); }");
      expect(run({ departureWriters: 1 }).code).toBe(0);
    });

    const scimPost = (after) => `export const create = withTenantRls(prisma, tenantId, async (tx) => {
  await lockTenantMemberCreation(tx, tenantId, userId);
  await tx.tenantMember.create({ data: { tenantId, userId, deactivatedAt: active ? null : new Date() } });
  ${after}
});`;
    // Rule 10's revocation of the active arm, so only rules 2 and 9 are under test.
    const ACTIVE_ARM_REVOKE = "if (active) await revokeUsersAuthArtifactsInTx(tx, [userId], { tenantFilter: { tenantId }, boundedLockWait: true });";

    it("allows the SCIM-POST shape outside the IMPLEMENTATIONS files (rule 2 adjudicates it)", () => {
      // In place of the seed (one of the SEEDED_TENANT_WRITES), so this create is the pinned rule-10 site.
      replaceFile(SCIM_POST, scimPost(`if (!active) await departCreatedMembership(tx, tenantId, [userId], { actor });\n  ${ACTIVE_ARM_REVOKE}`));
      const r = run();
      expect(r.code).toBe(0);
      expect(r.out).not.toMatch(/membership-end/);
    });

    it("leaves the SCIM-POST shape without departCreatedMembership to rule 2, not rule 9", () => {
      replaceFile(SCIM_POST, scimPost(ACTIVE_ARM_REVOKE));
      const r = run();
      expectDenied(r, /tenant-state::src\/app\/api\/scim\/v2\/Users\/route\.ts::<anonymous>::tenantMember\.create/);
      expect(r.out).not.toMatch(/membership-end/);
    });

    it("fails when a pinned site is missing", () => {
      replaceFile(DEPARTURE, MEMBERSHIP_END_FILES[DEPARTURE].replace(/export async function departCreatedMembership[\s\S]*$/, ""));
      expectDenied(run(), /missing: membership-end::src\/lib\/team\/team-departure\.ts::departCreatedMembership::tenant_members\.raw/);
    });

    it("fails on an unexpected site even when it revokes", () => {
      write(DEPARTURE, `export async function newEnd(tx, tenantId, ids, id) {\n  await tx.tenantMember.delete({ where: { id } });\n  ${REVOKE}\n  ${ENDER}\n}`);
      const r = run();
      expectDenied(r, /unexpected: membership-end::src\/lib\/team\/team-departure\.ts::newEnd::tenantMember\.delete/);
      expect(r.out).not.toMatch(/ends a tenant membership/);
    });

    describe("the creator footholds follow the revoker (foothold-end)", () => {
      /** The foothold-end violation for the site `fn::site` in `path`. */
      const footholdEnded = (fn, site, path = DEPARTURE) =>
        new RegExp(`foothold-end  ${esc(path)}:\\d+  foothold-end::${esc(path)}::${esc(fn)}::${esc(site)}  ends a tenant membership`);
      const ENDER_LINE = "  await endCreatorFootholdsInTx(tx, tenantId, transitioned, options.actor);\n";
      const DEPART = MEMBERSHIP_END_FILES[DEPARTURE];
      const SCIM = MEMBERSHIP_END_FILES[SCIM_USER_SERVICE];
      const SCIM_ENDER = "    await endCreatorFootholdsInTx(tx, tenantId, [userId], actor);\n";

      it("passes the seeded sites, each calling it after its revoker, and the exempted migration", () => {
        const r = run();
        expect(r.code).toBe(0);
        expect(r.out).not.toMatch(/foothold-end/);
      });

      it("refuses a membership end whose function never calls it", () => {
        expect(DEPART).toContain(ENDER_LINE);
        replaceFile(DEPARTURE, DEPART.replace(ENDER_LINE, ""));
        expectDenied(run(), footholdEnded("departFromTenant", "tenant_members.raw"));
      });

      it("refuses the call placed before the revoker", () => {
        const revokeLine = /  const revocation = await revokeUsersAuthArtifactsInTx\(tx, transitioned[^\n]*\n/;
        const revoke = DEPART.match(revokeLine)[0];
        replaceFile(DEPARTURE, DEPART.replace(ENDER_LINE, "").replace(revoke, ENDER_LINE + revoke));
        expectDenied(run(), footholdEnded("departFromTenant", "tenant_members.raw"));
      });

      it("is not satisfied by another family's exemption on the same site", () => {
        // deactivateScimUser's tenant-row-delete is exempted, under its own key prefix.
        expect(SCIM).toContain(SCIM_ENDER);
        replaceFile(SCIM_USER_SERVICE, SCIM.replace(SCIM_ENDER, ""));
        const r = run();
        expectDenied(r, footholdEnded("<anonymous>", "tenantMember.delete", SCIM_USER_SERVICE));
        expect(r.out).not.toMatch(/tenant-row-delete::src\/lib\/services\/scim-user-service\.ts/);
      });

      it("refuses the call in a different branch from the revoker (the deactivateScimUser shape)", () => {
        replaceFile(SCIM_USER_SERVICE, `export async function deactivateScimUser(tenantId, userId, actor) {
  return prisma.$transaction(async (tx) => {
    await tx.tenantMember.delete({ where: { tenantId_userId: { tenantId, userId } } });
    if (actor) {
      return revokeUserAuthArtifactsInTx(tx, userId, { tenantFilter: { tenantId }, boundedLockWait: true });
    }
    await endCreatorFootholdsInTx(tx, tenantId, [userId], actor);
  });
}
`);
        expectDenied(run(), footholdEnded("<anonymous>", "tenantMember.delete", SCIM_USER_SERVICE));
      });

      it("accepts both calls inside one nested block", () => {
        replaceFile(SCIM_USER_SERVICE, `export async function deactivateScimUser(tenantId, userId, actor) {
  return prisma.$transaction(async (tx) => {
    await tx.tenantMember.delete({ where: { tenantId_userId: { tenantId, userId } } });
    if (actor) {
      const revoked = await revokeUserAuthArtifactsInTx(tx, userId, { tenantFilter: { tenantId }, boundedLockWait: true });
      await endCreatorFootholdsInTx(tx, tenantId, [userId], actor);
      return revoked;
    }
  });
}
`);
        expect(run().code).toBe(0);
      });

      it("exempts only the migration: a second migration-shaped delete is not covered by its foothold-end key", () => {
        write(AUTH, `export async function again(userId, tenantId) {
  await withBypassRls(prisma, async (tx) => { await tx.tenantMember.deleteMany({ where: { userId, tenantId } }); });
}`);
        expectDenied(run(), /exemption\(s\) matching no site, or several[\s\S]*foothold-end::src\/auth\.ts::<anonymous>::tenantMember\.deleteMany/);
      });
    });

    it("refuses a second migration-shaped delete beside the exempted one", () => {
      write(AUTH, `export async function again(userId, tenantId) {
  await withBypassRls(prisma, async (tx) => { await tx.tenantMember.deleteMany({ where: { userId, tenantId } }); });
}`);
      expectDenied(run(), /exemption\(s\) matching no site, or several[\s\S]*membership-end::src\/auth\.ts::<anonymous>::tenantMember\.deleteMany/);
    });
  });

  describe("rule 10: a tenant-membership creation revokes in its function", () => {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const key = (fn, site, path = SUBJECT) => `membership-create::${path}::${fn}::${site}`;
    /** Rule 10's own violation for the site `fn::site` in `path`. */
    const created = (fn, site, path = SUBJECT) =>
      new RegExp(`membership-create  ${esc(path)}:\\d+  ${esc(key(fn, site, path))}  creates a tenant membership`);
    const REVOKE = "await revokeUsersAuthArtifactsInTx(tx, ids, { tenantFilter: { tenantId }, boundedLockWait: true });";
    const RAW = (sql) => `await tx.$executeRaw\`${sql}\`;`;

    it("passes the pinned sites, the revoking ones and the exempted ones", () => {
      const r = run();
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/"membershipCreations":5/);
      expect(r.out).not.toMatch(/membership-create/);
    });

    const REDS = [
      ["a Prisma create", "tenantMember.create", "await tx.tenantMember.create({ data: { tenantId, userId, role } });"],
      ["a Prisma createMany", "tenantMember.createMany", "await tx.tenantMember.createMany({ data: rows });"],
      ["a Prisma createManyAndReturn", "tenantMember.createManyAndReturn", "await tx.tenantMember.createManyAndReturn({ data: rows });"],
      ["a Prisma upsert", "tenantMember.upsert", "await tx.tenantMember.upsert({ where, create: { tenantId, userId, role }, update: {} });"],
      ["a raw INSERT INTO tenant_members", "tenant_members.raw", RAW("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (${tenantId}::uuid, ${userId}::uuid, 'MEMBER')")],
      ["a raw MERGE … THEN INSERT", "tenant_members.raw", RAW("MERGE INTO tenant_members t USING incoming s ON t.user_id = s.user_id WHEN NOT MATCHED THEN INSERT (tenant_id, user_id) VALUES (s.tenant_id, s.user_id)")],
    ];
    for (const [label, site, body] of REDS) {
      it(`refuses ${label} with no revocation after it`, () => {
        write(SUBJECT, `export async function admit(tx, tenantId, userId, role, rows, where, ids) {\n  ${body}\n}`);
        expectDenied(run({ creations: [key("admit", site)] }), created("admit", site));
      });
    }

    it("accepts the same create with a revocation after it", () => {
      write(SUBJECT, `export async function admit(tx, tenantId, userId, role, ids) {\n  await tx.tenantMember.create({ data: { tenantId, userId, role } });\n  ${REVOKE}\n}`);
      expect(run({ creations: [key("admit", "tenantMember.create")] }).code).toBe(0);
    });

    // departCreatedMembership revokes only the rows created deactivated. Each
    // create below names deactivatedAt, so it is also a rule-2 site, with the
    // creation lock before it.
    const createThenDepart = (deactivatedAt) => `export async function admit(tx, tenantId, userId, role) {
  await lockTenantMemberCreation(tx, tenantId, userId);
  await tx.tenantMember.create({ data: { tenantId, userId, role, deactivatedAt: ${deactivatedAt} } });
  await departCreatedMembership(tx, tenantId, [userId], { actor });
}`;

    it("accepts departCreatedMembership after a create that always creates the row deactivated", () => {
      write(SUBJECT, createThenDepart("new Date()"));
      const r = run({ tenantWrites: 1, creations: [key("admit", "tenantMember.create")] });
      expect(r.code).toBe(0);
      expect(r.out).not.toMatch(/membership-create/);
    });

    for (const [label, deactivatedAt] of [
      ["a conditional", "active ? null : new Date()"],
      ["an identifier", "stamp"],
      ["null", "null"],
    ]) {
      it(`refuses departCreatedMembership as the only revocation after a create whose deactivatedAt is ${label}`, () => {
        write(SUBJECT, createThenDepart(deactivatedAt));
        expectDenied(run({ tenantWrites: 1, creations: [key("admit", "tenantMember.create")] }), created("admit", "tenantMember.create"));
      });
    }

    it("refuses departCreatedMembership as the only revocation after a create not naming deactivatedAt", () => {
      write(SUBJECT, `export async function admit(tx, tenantId, userId, role) {\n  await tx.tenantMember.create({ data: { tenantId, userId, role } });\n  await departCreatedMembership(tx, tenantId, [userId], { actor });\n}`);
      expectDenied(run({ creations: [key("admit", "tenantMember.create")] }), created("admit", "tenantMember.create"));
    });

    it("refuses departCreatedMembership as the only revocation after a raw INSERT, even one naming deactivated_at", () => {
      write(SUBJECT, `export async function admit(tx, tenantId, userId) {
  await lockTenantMemberCreation(tx, tenantId, userId);
  ${RAW("INSERT INTO tenant_members (tenant_id, user_id) VALUES (${tenantId}::uuid, ${userId}::uuid)")}
  await departCreatedMembership(tx, tenantId, [userId], { actor });
}`);
      expectDenied(run({ creations: [key("admit", "tenant_members.raw")] }), created("admit", "tenant_members.raw"));
    });

    it("ignores a raw INSERT into another table", () => {
      write(SUBJECT, `export async function other(tx, tenantId) {\n  ${RAW("INSERT INTO tenant_claims (tenant_id, claim) VALUES (${tenantId}::uuid, 'x')")}\n}`);
      const r = run();
      expect(r.code).toBe(0);
      expect(r.out).not.toMatch(/membership-create/);
    });

    it("refuses a revocation called before the write", () => {
      write(SUBJECT, `export async function admit(tx, tenantId, userId, role, ids) {\n  ${REVOKE}\n  await tx.tenantMember.create({ data: { tenantId, userId, role } });\n}`);
      expectDenied(run({ creations: [key("admit", "tenantMember.create")] }), created("admit", "tenantMember.create"));
    });

    it("refuses a revocation inside a nested callback (not the write's own function)", () => {
      write(SUBJECT, `export async function admit(tx, tenantId, userId, role, ids) {
  await tx.tenantMember.create({ data: { tenantId, userId, role } });
  await Promise.all([ids].map(async (batch) => revokeUsersAuthArtifactsInTx(tx, batch, { tenantFilter: { tenantId } })));
}`);
      expectDenied(run({ creations: [key("admit", "tenantMember.create")] }), created("admit", "tenantMember.create"));
    });

    it("fails on an unexpected site even when it revokes", () => {
      write(SUBJECT, `export async function admit(tx, tenantId, userId, role, ids) {\n  await tx.tenantMember.create({ data: { tenantId, userId, role } });\n  ${REVOKE}\n}`);
      const r = run();
      expectDenied(r, /unexpected: membership-create::src\/lib\/team\/subject\.ts::admit::tenantMember\.create/);
      expect(r.out).not.toMatch(/creates a tenant membership/);
    });

    it("fails when a pinned site is missing", () => {
      replaceFile(DIRECTORY_SYNC, "export {};\n");
      // The seed's create was also one of the SEEDED_TENANT_WRITES.
      expectDenied(run({ tenantWrites: -1 }), /missing: membership-create::src\/lib\/directory-sync\/engine\.ts::<anonymous>::tenantMember\.create/);
    });

    // The removal cells mutate the seeds, which have production's shape, so
    // each one is the real site losing its real revocation.
    it("refuses sign-in's joinClaimedTenant INSERT without its revocation", () => {
      const seed = MEMBERSHIP_END_FILES[AUTH];
      const mutated = seed.replace(/\n\s*return revokeUsersAuthArtifactsInTx\(tx, \[userId\][^\n]*/, "\n  return null;");
      expect(mutated).not.toBe(seed);
      replaceFile(AUTH, mutated);
      expectDenied(run(), created("joinClaimedTenant", "tenant_members.raw", AUTH));
    });

    it("refuses the SCIM POST create without its active arm's revocation (departCreatedMembership stays)", () => {
      const seed = MEMBERSHIP_END_FILES[SCIM_POST];
      const mutated = seed.replace(/\n\s*if \(existingUserId && active !== false\) \{[^}]*\}/, "");
      expect(mutated).not.toBe(seed);
      expect(mutated).toMatch(/departCreatedMembership/);
      replaceFile(SCIM_POST, mutated);
      expectDenied(run(), created("<anonymous>", "tenantMember.create", SCIM_POST));
    });

    it("refuses the directory-sync create without the admissions' revocation (departCreatedMembership stays)", () => {
      const seed = MEMBERSHIP_END_FILES[DIRECTORY_SYNC];
      const mutated = seed.replace(/\n\s*admissions\.push\([^\n]*/, "");
      expect(mutated).not.toBe(seed);
      expect(mutated).toMatch(/departCreatedMembership/);
      replaceFile(DIRECTORY_SYNC, mutated);
      expectDenied(run(), created("<anonymous>", "tenantMember.create", DIRECTORY_SYNC));
    });

    // The seeds above are hand copies of production's shape, so a revocation
    // that moved or changed shape in the real file would leave them green.
    // These cells put the REAL files in the seeded root instead; the rest of
    // the root is the seed, so the whole gate runs as it does on every cell.
    describe("on the real files", () => {
      const REPO = join(dirname(GATE), "..", "..");
      const real = (rel) => readFileSync(join(REPO, rel), "utf8");
      /** Each real creation's revocation, renamed to a non-revoker so only the call's name changes. */
      const REAL_REVOCATIONS = [
        [SCIM_POST, "revokeUsersAuthArtifactsInTx(tx, [user.id],", "<anonymous>", "tenantMember.create"],
        [DIRECTORY_SYNC, "revokeUsersAuthArtifactsInTx(tx, createdActive,", "<anonymous>", "tenantMember.create"],
        [AUTH, "return revokeUsersAuthArtifactsInTx(tx, [userId],", "joinClaimedTenant", "tenant_members.raw"],
      ];

      beforeEach(() => {
        for (const [rel] of REAL_REVOCATIONS) replaceFile(rel, real(rel));
      });

      it("passes the real SCIM POST, directory-sync and sign-in creations", () => {
        const r = run();
        expect(r.code).toBe(0);
        expect(r.out).toMatch(/"membershipCreations":5/);
        expect(r.out).not.toMatch(/membership-create/);
      });

      for (const [rel, call, fn, site] of REAL_REVOCATIONS) {
        it(`refuses the real ${rel} creation without its revocation`, () => {
          const source = real(rel);
          // Exactly one match, so the mutation cannot miss and pass vacuously.
          expect(source.split(call)).toHaveLength(2);
          replaceFile(rel, source.replace(call, call.replace("revokeUsersAuthArtifactsInTx", "skipRevocation")));
          const r = run();
          expectDenied(r, created(fn, site, rel));
          expect(r.out.match(/membership-create  /g)).toHaveLength(1);
        });
      }
    });

    it("refuses the directory-sync create when the revocation moves into the loop's callback", () => {
      replaceFile(DIRECTORY_SYNC, `
export const apply = withTenantRls(prisma, tenantId, async (tx) => {
  await Promise.all(toCreate.map(async (pu) => {
    await tx.tenantMember.create({ data: { tenantId, userId: pu.userId, role: TENANT_ROLE.MEMBER } });
  }));
  await revokeUsersAuthArtifactsInTx(tx, createdActive, { tenantFilter: { tenantId }, boundedLockWait: true });
});
`);
      // No deactivatedAt here, so not one of the SEEDED_TENANT_WRITES.
      expectDenied(run({ tenantWrites: -1 }), created("<anonymous>", "tenantMember.create", DIRECTORY_SYNC));
    });

    it("refuses a second creation sharing the migration's key", () => {
      write(AUTH, `export async function again(userId, target) {
  await withBypassRls(prisma, async (tx) => { await tx.tenantMember.create({ data: { tenantId: target.id, userId, role: TENANT_ROLE.MEMBER } }); });
}`);
      expectDenied(run(), /repeated: membership-create::src\/auth\.ts::<anonymous>::tenantMember\.create\[\{ tenantId: target\.id/);
    });
  });
});
