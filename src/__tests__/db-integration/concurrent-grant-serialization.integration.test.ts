/**
 * Real-DB proof that the per-key advisory locks / tenant-row locks added to
 * four read-then-create routes close their races:
 *
 *   - emergency-access POST      emergency-grant:<owner>:<email>
 *   - tenant/breakglass POST     breakglass-grant:<tenant>:<requester>:<target>
 *   - teams/[teamId]/invitations team-invitation:<team>:<email>
 *   - tenant/members/[userId] PUT lockTenantRows(actor, target, "update")
 *
 * Like count-then-create-toctou, each route's reads and writes are replicated
 * in SQL (the production handlers are bound to the singleton prisma and cannot
 * be raced on two injected clients) and raced on two distinct pooled clients.
 * The locking primitives themselves (advisoryXactLock, lockTenantRows) are the
 * production ones. The WITHOUT-lock case is the mutation-kill: it shows the
 * race is real, so the WITH-lock pass is meaningful. The sleeps only widen the
 * read→write window of the un-serialized path; with the lock the loser is
 * blocked on the lock regardless of timing.
 *
 * Because the SQL is a replica, removing a lock from a ROUTE leaves this file
 * green. The route-level pin is each route's unit test, which asserts the lock
 * (with its exact key) is taken before the gating read and the write
 * (invocationCallOrder): emergency-access/route.test.ts,
 * tenant/breakglass/route.test.ts, teams/[teamId]/invitations/route.test.ts,
 * tenant/members/[userId]/route.test.ts.
 *
 * Delegation POST is not covered here: its serialization is lockUserAuthArtifacts
 * (already proven by the user-auth-serialization tests) and the route also
 * writes Redis; its read-under-lock ordering is pinned in the route's unit test.
 *
 * Gated on DATABASE_URL — skips on the no-DB CI job, runs on test:integration.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { advisoryXactLock } from "@/lib/tenant-rls";
import { lockTenantRows } from "@/lib/team/tenant-row-lock";
import { createLockBudget } from "@/lib/team/team-key-rotation-lock";
import {
  createPrismaForRole,
  createTestContext,
  raceTwoClients,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";

const SKIP = !process.env.DATABASE_URL;

const tokenHash = () => randomUUID().replace(/-/g, "");

describe.skipIf(SKIP)("read-then-create races — route locks", () => {
  let ctx: TestContext;
  let a: { prisma: PrismaClient };
  let b: { prisma: PrismaClient };
  let tenantId: string | undefined;

  beforeAll(async () => {
    ctx = await createTestContext();
    a = ctx.app;
    // A second independent app-role pool so the two requests race on separate
    // connections.
    b = createPrismaForRole("app");
  });

  afterEach(async () => {
    if (tenantId) {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(`DELETE FROM emergency_access_grants WHERE tenant_id = $1::uuid`, tenantId);
      });
      await ctx.deleteTestData(tenantId);
      tenantId = undefined;
    }
  });

  afterAll(async () => {
    await b.prisma.$disconnect();
    await ctx.cleanup();
  });

  async function suExec(sql: string, ...params: unknown[]): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(sql, ...params);
    });
  }

  async function suCount(sql: string, ...params: unknown[]): Promise<number> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const r: Array<{ n: bigint }> = await tx.$queryRawUnsafe(sql, ...params);
      return Number(r[0].n);
    });
  }

  // ─── emergency-access POST ──────────────────────────────────────

  // Mirrors the route: lock → duplicateGrantWhere read → create.
  async function issueEmergencyGrant(
    client: PrismaClient,
    ownerId: string,
    tid: string,
    email: string,
    useLock: boolean,
  ): Promise<boolean> {
    return client.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      if (useLock) await advisoryXactLock(tx, `emergency-grant:${ownerId}:${email.toLowerCase()}`);
      const live: Array<{ n: bigint }> = await tx.$queryRawUnsafe(
        `SELECT count(*) n FROM emergency_access_grants
         WHERE owner_id = $1::uuid AND lower(grantee_email) = lower($2)
           AND status NOT IN ('REVOKED', 'REJECTED')
           AND NOT (status = 'PENDING' AND token_expires_at <= now())`,
        ownerId,
        email,
      );
      if (Number(live[0].n) > 0) return false; // route: DUPLICATE_GRANT
      await tx.$executeRawUnsafe(`SELECT pg_sleep(0.3)`);
      await tx.$executeRawUnsafe(
        `INSERT INTO emergency_access_grants
           (id, tenant_id, owner_id, grantee_email, wait_days, token_hash, token_expires_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 7, $5, now() + interval '7 days', now(), now())`,
        randomUUID(),
        tid,
        ownerId,
        email,
        tokenHash(),
      );
      return true;
    });
  }

  async function liveEmergencyGrants(ownerId: string): Promise<number> {
    return suCount(
      `SELECT count(*) n FROM emergency_access_grants
       WHERE owner_id = $1::uuid AND status NOT IN ('REVOKED', 'REJECTED')`,
      ownerId,
    );
  }

  it("emergency grant WITHOUT the lock: two concurrent creates both succeed (race is real)", async () => {
    tenantId = await ctx.createTenant();
    const ownerId = await ctx.createUser(tenantId);
    const results = await raceTwoClients(
      a.prisma,
      b.prisma,
      (c) => issueEmergencyGrant(c, ownerId, tenantId!, "grantee@example.com", false),
      (c) => issueEmergencyGrant(c, ownerId, tenantId!, "Grantee@Example.com", false),
    );
    expect(results).toEqual([true, true]);
    expect(await liveEmergencyGrants(ownerId)).toBe(2);
  });

  it("emergency grant WITH the lock: exactly one live grant, the loser gets DUPLICATE_GRANT", async () => {
    tenantId = await ctx.createTenant();
    const ownerId = await ctx.createUser(tenantId);
    const results = await raceTwoClients(
      a.prisma,
      b.prisma,
      (c) => issueEmergencyGrant(c, ownerId, tenantId!, "grantee@example.com", true),
      (c) => issueEmergencyGrant(c, ownerId, tenantId!, "Grantee@Example.com", true),
    );
    expect(results.filter(Boolean)).toHaveLength(1); // exactly one winner
    expect(await liveEmergencyGrants(ownerId)).toBe(1);
  });

  // ─── tenant/breakglass POST ─────────────────────────────────────

  // Mirrors the route: lock → member → duplicate → cooling-off lookup → create.
  // `stagger` starts the second request mid-way through the first, the
  // interleaving under which the second would otherwise read the first's commit
  // as a "recent grant" and be created with no cooling-off.
  async function issueBreakglass(
    client: PrismaClient,
    tid: string,
    requesterId: string,
    targetId: string,
    useLock: boolean,
    staggerMs: number,
  ): Promise<{ created: boolean; coolingOff: boolean }> {
    await raceDelay(staggerMs);
    return client.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      if (useLock) await advisoryXactLock(tx, `breakglass-grant:${tid}:${requesterId}:${targetId}`);
      const dup: Array<{ n: bigint }> = await tx.$queryRawUnsafe(
        `SELECT count(*) n FROM personal_log_access_grants
         WHERE requester_id = $1::uuid AND target_user_id = $2::uuid AND tenant_id = $3::uuid
           AND revoked_at IS NULL AND expires_at > now()`,
        requesterId,
        targetId,
        tid,
      );
      if (Number(dup[0].n) > 0) return { created: false, coolingOff: false }; // route: duplicate → 409
      await tx.$executeRawUnsafe(`SELECT pg_sleep(0.3)`);
      const recent: Array<{ n: bigint }> = await tx.$queryRawUnsafe(
        `SELECT count(*) n FROM personal_log_access_grants
         WHERE requester_id = $1::uuid AND target_user_id = $2::uuid AND tenant_id = $3::uuid
           AND created_at > now() - interval '24 hours'`,
        requesterId,
        targetId,
        tid,
      );
      const coolingOff = Number(recent[0].n) === 0;
      await tx.$executeRawUnsafe(
        `INSERT INTO personal_log_access_grants
           (id, tenant_id, requester_id, target_user_id, reason, expires_at, effective_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'integration test reason', now() + interval '24 hours',
                 ${coolingOff ? "now() + interval '1 hour'" : "NULL"}, now())`,
        randomUUID(),
        tid,
        requesterId,
        targetId,
      );
      return { created: true, coolingOff };
    });
  }

  const raceDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function breakglassSeed() {
    tenantId = await ctx.createTenant();
    const requesterId = await ctx.createUser(tenantId);
    const targetId = await ctx.createUser(tenantId);
    return { requesterId, targetId };
  }

  async function breakglassRows(requesterId: string, targetId: string) {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows: Array<{ effective_at: Date | null }> = await tx.$queryRawUnsafe(
        `SELECT effective_at FROM personal_log_access_grants
         WHERE requester_id = $1::uuid AND target_user_id = $2::uuid`,
        requesterId,
        targetId,
      );
      return rows;
    });
  }

  it("breakglass WITHOUT the lock: two grants, the second with no cooling-off (race is real)", async () => {
    const { requesterId, targetId } = await breakglassSeed();
    await raceTwoClients(
      a.prisma,
      b.prisma,
      (c) => issueBreakglass(c, tenantId!, requesterId, targetId, false, 0),
      (c) => issueBreakglass(c, tenantId!, requesterId, targetId, false, 100),
    );
    const rows = await breakglassRows(requesterId, targetId);
    expect(rows).toHaveLength(2);
    // The second saw the first's commit as a "recent grant": immediate access.
    expect(rows.some((r) => r.effective_at === null)).toBe(true);
  });

  it("breakglass WITH the lock: one grant, cooling-off set on the winner, no immediate grant", async () => {
    const { requesterId, targetId } = await breakglassSeed();
    const results = await raceTwoClients(
      a.prisma,
      b.prisma,
      (c) => issueBreakglass(c, tenantId!, requesterId, targetId, true, 0),
      (c) => issueBreakglass(c, tenantId!, requesterId, targetId, true, 100),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1); // exactly one winner
    const rows = await breakglassRows(requesterId, targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0].effective_at).not.toBeNull(); // cooling-off applied to the winner
  });

  // ─── teams/[teamId]/invitations POST ────────────────────────────

  // Mirrors the route's issuing tx for an address with no account (no invitee
  // row to lock): lock → live PENDING read → create.
  async function issueInvitation(
    client: PrismaClient,
    teamId: string,
    tid: string,
    inviterId: string,
    email: string,
    useLock: boolean,
  ): Promise<boolean> {
    return client.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      if (useLock) await advisoryXactLock(tx, `team-invitation:${teamId}:${email.toLowerCase()}`);
      const pending: Array<{ n: bigint }> = await tx.$queryRawUnsafe(
        `SELECT count(*) n FROM team_invitations
         WHERE team_id = $1::uuid AND status = 'PENDING' AND lower(email) = lower($2) AND expires_at > now()`,
        teamId,
        email,
      );
      if (Number(pending[0].n) > 0) return false; // route: ALREADY_SENT → 409
      await tx.$executeRawUnsafe(`SELECT pg_sleep(0.3)`);
      await tx.$executeRawUnsafe(
        `INSERT INTO team_invitations
           (id, team_id, tenant_id, email, token, expires_at, invited_by_id, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, now() + interval '7 days', $6::uuid, now())`,
        randomUUID(),
        teamId,
        tid,
        email,
        tokenHash(),
        inviterId,
      );
      return true;
    });
  }

  async function invitationSeed() {
    tenantId = await ctx.createTenant();
    const inviterId = await ctx.createUser(tenantId);
    const teamId = randomUUID();
    await suExec(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
      teamId,
      tenantId,
      `team-${teamId.slice(0, 8)}`,
    );
    return { inviterId, teamId };
  }

  const pendingInvitations = (teamId: string) =>
    suCount(`SELECT count(*) n FROM team_invitations WHERE team_id = $1::uuid AND status = 'PENDING'`, teamId);

  it("invitation (no account) WITHOUT the lock: two PENDING invitations are issued (race is real)", async () => {
    const { inviterId, teamId } = await invitationSeed();
    const results = await raceTwoClients(
      a.prisma,
      b.prisma,
      (c) => issueInvitation(c, teamId, tenantId!, inviterId, "nobody@example.com", false),
      (c) => issueInvitation(c, teamId, tenantId!, inviterId, "Nobody@Example.com", false),
    );
    expect(results).toEqual([true, true]);
    expect(await pendingInvitations(teamId)).toBe(2);
  });

  it("invitation (no account) WITH the lock: exactly one PENDING invitation", async () => {
    const { inviterId, teamId } = await invitationSeed();
    const results = await raceTwoClients(
      a.prisma,
      b.prisma,
      (c) => issueInvitation(c, teamId, tenantId!, inviterId, "nobody@example.com", true),
      (c) => issueInvitation(c, teamId, tenantId!, inviterId, "Nobody@Example.com", true),
    );
    expect(results.filter(Boolean)).toHaveLength(1); // exactly one winner
    expect(await pendingInvitations(teamId)).toBe(1);
  });

  // ─── tenant/members/[userId] PUT (ownership transfer) ───────────

  // Mirrors the route's transfer: (lockTenantRows on actor+target) → actor still
  // OWNER? → target active? → demote actor → promote target. Without the lock the
  // actor check is a plain read and the demotion is unconditional by user id
  // (the old shape), so two transfers by the same OWNER both pass.
  async function transferOwnership(
    client: PrismaClient,
    tid: string,
    actorId: string,
    targetId: string,
    useLock: boolean,
  ): Promise<boolean> {
    return client.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      let actorIsOwner: boolean;
      if (useLock) {
        const rows = await lockTenantRows(tx, tid, [actorId, targetId], "update", createLockBudget());
        const actorRow = rows.get(actorId);
        actorIsOwner = actorRow?.role === "OWNER" && actorRow.deactivatedAt === null;
      } else {
        const r: Array<{ role: string }> = await tx.$queryRawUnsafe(
          `SELECT role FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND deactivated_at IS NULL`,
          tid,
          actorId,
        );
        actorIsOwner = r[0]?.role === "OWNER";
      }
      if (!actorIsOwner) return false; // route: OWNER_ONLY
      await tx.$executeRawUnsafe(`SELECT pg_sleep(0.3)`);
      // Demote actor first (updateMany conditional on OWNER with the lock; the
      // old shape had no condition to fail on).
      await tx.$executeRawUnsafe(
        `UPDATE tenant_members SET role = 'ADMIN'
         WHERE tenant_id = $1::uuid AND user_id = $2::uuid ${useLock ? "AND role = 'OWNER'" : ""}`,
        tid,
        actorId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE tenant_members SET role = 'OWNER' WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        tid,
        targetId,
      );
      return true;
    });
  }

  async function transferSeed() {
    tenantId = await ctx.createTenant();
    // createUser makes every user an OWNER; keep only the actor as OWNER.
    const actorId = await ctx.createUser(tenantId);
    const target1 = await ctx.createUser(tenantId);
    const target2 = await ctx.createUser(tenantId);
    await suExec(
      `UPDATE tenant_members SET role = 'ADMIN' WHERE tenant_id = $1::uuid AND user_id <> $2::uuid`,
      tenantId,
      actorId,
    );
    return { actorId, target1, target2 };
  }

  const ownerCount = (tid: string) =>
    suCount(`SELECT count(*) n FROM tenant_members WHERE tenant_id = $1::uuid AND role = 'OWNER'`, tid);

  it("ownership transfer WITHOUT the lock: two concurrent transfers leave two OWNERs (race is real)", async () => {
    const { actorId, target1, target2 } = await transferSeed();
    const results = await raceTwoClients(
      a.prisma,
      b.prisma,
      (c) => transferOwnership(c, tenantId!, actorId, target1, false),
      (c) => transferOwnership(c, tenantId!, actorId, target2, false),
    );
    expect(results).toEqual([true, true]);
    expect(await ownerCount(tenantId!)).toBe(2);
  });

  it("ownership transfer WITH the lock: exactly one OWNER remains, the loser is refused", async () => {
    const { actorId, target1, target2 } = await transferSeed();
    const results = await raceTwoClients(
      a.prisma,
      b.prisma,
      (c) => transferOwnership(c, tenantId!, actorId, target1, true),
      (c) => transferOwnership(c, tenantId!, actorId, target2, true),
    );
    expect(results.filter(Boolean)).toHaveLength(1); // exactly one winner
    expect(await ownerCount(tenantId!)).toBe(1);
  });
});
