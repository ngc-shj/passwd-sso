/**
 * The two `[D]` cells Phase 3 Round 1 named as unbuilt and Round 2 caught still
 * missing: E2's in-transaction visibility, and the N1 team-delete flatten.
 *
 * Both pin the same property from opposite directions — that statements which
 * LOOK like they run on an ambient client really do run inside the enclosing
 * opener's transaction — and neither is observable in the corresponding unit
 * test, because both of those mock the opener.
 *
 * What each cell does and does not cover:
 *
 *   E2 — the approve route's unit test asserts `logAuditInTx` received the
 *   client the opener handed it (`txArg === mockTxClient`), which pins the
 *   WIRING. It cannot observe a rollback, because its `$transaction` mock just
 *   invokes the callback. This cell pins the DURABILITY half against a real
 *   database, in the route's transaction shape.
 *
 *   N1 — the team-delete route's unit test mocks both openers as passthroughs
 *   and never asserts on them, so dropping the inner `withTenantRls` is
 *   invisible there in either direction. This cell pins that the three
 *   statements the flatten rewrote from `tx.*` to `prisma.*` are still inside
 *   `withTeamTenantRls`'s transaction — the Proxy's delegation is what puts
 *   them there, and nothing else in the tree exercises it against a database.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { prisma } from "@/lib/prisma";
import { withTenantRls, BYPASS_PURPOSE, withBypassRls } from "@/lib/tenant-rls";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { logAuditInTx } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE, EA_STATUS } from "@/lib/constants";

const SKIP = !process.env.DATABASE_URL;

describe("ambient statements share the opener's transaction", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });
  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });
  beforeEach(async () => {
    if (SKIP) return;
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  });
  afterEach(async () => {
    if (SKIP) return;
    await ctx.deleteTestData(tenantId);
  });

  async function countActivations(): Promise<number> {
    const r = await ctx.su.pool.query(
      `SELECT count(*)::int AS n FROM audit_outbox
        WHERE tenant_id = $1::uuid AND payload->>'action' = $2`,
      [tenantId, AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE],
    );
    return r.rows[0].n;
  }

  async function seedTeam(): Promise<string> {
    const teamId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 1, now(), now())`,
        teamId,
        tenantId,
        `team-${teamId.slice(0, 8)}`,
        `team-${teamId.slice(0, 8)}`,
      );
    });
    return teamId;
  }

  async function teamExists(teamId: string): Promise<boolean> {
    const r = await ctx.su.pool.query(`SELECT 1 FROM teams WHERE id = $1::uuid`, [teamId]);
    return (r.rowCount ?? 0) > 0;
  }

  // ─── E2: the approve route's transaction shape ────────────────────────────

  it.skipIf(SKIP)("E2: the CAS and its audit row commit together", async () => {
    // The allow side, and it has to come first: a cell that fails on everything
    // satisfies the deny half below without proving anything.
    const grantId = randomUUID();
    await seedRequestedGrant(grantId);
    const before = await countActivations();

    await withTenantRls(prisma, tenantId, async (tx) => {
      await tx.emergencyAccessGrant.updateMany({
        where: { id: grantId, ownerId: userId, status: { in: [EA_STATUS.REQUESTED] } },
        data: { status: EA_STATUS.ACTIVATED, activatedAt: new Date() },
      });
      await logAuditInTx(tx, tenantId, {
        scope: AUDIT_SCOPE.PERSONAL,
        userId,
        action: AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE,
        targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
        targetId: grantId,
        metadata: { earlyApproval: true, outcome: "approved" },
      });
    });

    expect(await grantStatus(grantId)).toBe("ACTIVATED");
    expect(await countActivations()).toBe(before + 1);
  });

  it.skipIf(SKIP)("E2: a throw after the emit leaves neither the row nor the status", async () => {
    // The throw must land AFTER the emit and BEFORE the callback returns — one
    // outside the callback proves nothing, and one before the emit cannot
    // distinguish the defect.
    const grantId = randomUUID();
    await seedRequestedGrant(grantId);
    const before = await countActivations();
    const boom = new Error("PROBE_ROLLBACK");

    await expect(
      withTenantRls(prisma, tenantId, async (tx) => {
        await tx.emergencyAccessGrant.updateMany({
          where: { id: grantId, ownerId: userId, status: { in: [EA_STATUS.REQUESTED] } },
          data: { status: EA_STATUS.ACTIVATED, activatedAt: new Date() },
        });
        await logAuditInTx(tx, tenantId, {
          scope: AUDIT_SCOPE.PERSONAL,
          userId,
          action: AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE,
          targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
          targetId: grantId,
          metadata: { earlyApproval: true, outcome: "approved" },
        });
        throw boom;
      }),
    ).rejects.toBe(boom);

    // Positive first: the CAS did not survive either.
    expect(await grantStatus(grantId)).toBe("REQUESTED");
    expect(await countActivations()).toBe(before);
  });

  // ─── N1: the team-delete flatten ──────────────────────────────────────────

  it.skipIf(SKIP)("N1: the flattened statements run inside withTeamTenantRls's transaction", async () => {
    // The route dropped an inner `withTenantRls` and rewrote three `tx.*` calls
    // to `prisma.*`. Under an active context the Proxy delegates those to the
    // open transaction — that delegation is the whole basis of the flatten, and
    // this is the only place it is exercised against a database.
    const teamId = await seedTeam();
    const boom = new Error("PROBE_ROLLBACK");

    await expect(
      withTeamTenantRls(teamId, async () => {
        // Ambient client, exactly as the route now writes it.
        await prisma.team.delete({ where: { id: teamId } });
        throw boom;
      }),
    ).rejects.toBe(boom);

    // If the delete had run outside the wrapper's transaction it would have
    // committed on its own and the row would be gone.
    expect(await teamExists(teamId)).toBe(true);
  });

  it.skipIf(SKIP)("N1: the same statements commit when nothing throws", async () => {
    // The allow companion. Without it, a wrapper that rolled everything back
    // unconditionally would satisfy the cell above.
    const teamId = await seedTeam();

    await withTeamTenantRls(teamId, async () => {
      await prisma.team.delete({ where: { id: teamId } });
    });

    expect(await teamExists(teamId)).toBe(false);
  });

  // ─── fixtures ─────────────────────────────────────────────────────────────

  async function seedRequestedGrant(grantId: string): Promise<void> {
    await withBypassRls(prisma, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO emergency_access_grants (
           id, tenant_id, owner_id, grantee_id, grantee_email, status, wait_days,
           token_hash, token_expires_at, wrap_version, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $3::uuid, $4,
           'REQUESTED'::"EmergencyAccessStatus", 7, $5, now() + interval '30 days',
           1, now(), now()
         )`,
        grantId,
        tenantId,
        userId,
        `grantee-${grantId.slice(0, 6)}@example.com`,
        randomUUID().replace(/-/g, ""),
      );
    }, BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
  }

  async function grantStatus(grantId: string): Promise<string> {
    const r = await ctx.su.pool.query(
      `SELECT status FROM emergency_access_grants WHERE id = $1::uuid`,
      [grantId],
    );
    return r.rows[0].status;
  }
});
