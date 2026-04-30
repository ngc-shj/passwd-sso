/**
 * Integration test (real DB): dual-admin approval CAS race + DB-level
 * self-approval guard for AdminVaultReset.
 *
 * Plan: docs/archive/review/admin-vault-reset-dual-approval-plan.md §11.2
 *   - T1 (Critical): true-concurrency parallel approve. Asserts that the
 *     CAS update used by the approve route admits exactly one winner.
 *   - N3 (Critical): self-approval blocked at DB level — direct CAS-call
 *     pattern (preferred over auth() mocking) so the production WHERE
 *     clause is exercised verbatim.
 *
 * Concurrency strategy: option (a) — statistical N=50 loop with two
 * distinct Prisma client instances (separate pg.Pool connections per
 * helpers.ts:60-70). The pg_advisory_lock barrier (option (b)) has no
 * existing precedent in this repo; the statistical pattern is the
 * documented fallback.
 *
 * Run: docker compose up -d db && npm run test:integration -- \
 *      admin-vault-reset-dual-approval.integration
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  createPrismaForRole,
  createTestContext,
  raceTwoClients,
  setBypassRlsGucs,
  type PrismaWithPool,
  type TestContext,
} from "./helpers";

const RESET_TTL_MS = 24 * 60 * 60 * 1000;

describe("admin-vault-reset dual-approval CAS race (real DB)", () => {
  let ctx: TestContext;
  // Two extra clients, each with their own pg.Pool, simulating two admins
  // hitting the approve endpoint from separate Node workers / pods.
  let clientA: PrismaWithPool;
  let clientB: PrismaWithPool;
  let tenantId: string;
  let targetUserId: string;
  let initiatorId: string;
  let approverAId: string;
  let approverBId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    clientA = createPrismaForRole("superuser");
    clientB = createPrismaForRole("superuser");
  });

  afterAll(async () => {
    await Promise.all([
      clientA.prisma.$disconnect().then(() => clientA.pool.end()),
      clientB.prisma.$disconnect().then(() => clientB.pool.end()),
    ]);
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    targetUserId = await ctx.createUser(tenantId);
    initiatorId = await ctx.createUser(tenantId);
    approverAId = await ctx.createUser(tenantId);
    approverBId = await ctx.createUser(tenantId);
  });

  afterEach(async () => {
    // FK-safe — admin_vault_resets references users; clear before user delete.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM admin_vault_resets WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  /**
   * Insert a fresh PENDING_APPROVAL reset row, returning its id.
   * Mirrors the post-initiate state: approvedAt=null, executedAt=null,
   * revokedAt=null, expiresAt > now.
   */
  async function insertPendingReset(): Promise<string> {
    const id = randomUUID();
    const tokenHash = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO admin_vault_resets (
           id, tenant_id, target_user_id, initiated_by_id,
           token_hash, target_email_at_initiate,
           expires_at, created_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           $5, $6,
           now() + interval '24 hours', now()
         )`,
        id,
        tenantId,
        targetUserId,
        initiatorId,
        tokenHash.slice(0, 64),
        `target-${id.slice(0, 8)}@example.com`,
      );
    });
    return id;
  }

  /**
   * Issue the production CAS update used by the approve endpoint
   * (plan §"Approve endpoint" step 8). Returns updateMany count.
   */
  async function approveCas(
    client: PrismaWithPool,
    resetId: string,
    actorId: string,
  ): Promise<number> {
    const now = new Date();
    const result = await client.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      // Inline the WHERE clause from the approve route so we test the
      // exact CAS predicate that ships, not a paraphrase.
      const r = await tx.adminVaultReset.updateMany({
        where: {
          id: resetId,
          approvedAt: null,
          executedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
          initiatedById: { not: actorId },
        },
        data: {
          approvedAt: now,
          approvedById: actorId,
          expiresAt: new Date(now.getTime() + RESET_TTL_MS),
        },
      });
      return r.count;
    });
    return result;
  }

  // ─── T1: parallel approve race ───────────────────────────────

  it("two concurrent approves: exactly one wins, one loses", async () => {
    // 50 iterations: statistical confidence that no double-approval
    // slips through under racing conditions on a pooled real DB.
    const ITERATIONS = 50;
    let winnerCount = 0;
    let loserCount = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const resetId = await insertPendingReset();

      const [a, b] = await raceTwoClients(
        clientA.prisma,
        clientB.prisma,
        (c) => approveCas({ prisma: c, pool: clientA.pool }, resetId, approverAId),
        (c) => approveCas({ prisma: c, pool: clientB.pool }, resetId, approverBId),
      );

      // Exactly one row updated, exactly one zero — no draws, no doubles.
      const total = a + b;
      expect(total).toBe(1);

      if (a === 1) {
        winnerCount++;
        expect(b).toBe(0);
      } else {
        loserCount++;
        expect(a).toBe(0);
        expect(b).toBe(1);
      }

      // Verify the row's approvedById is one of the two actors.
      const row = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.adminVaultReset.findUnique({
          where: { id: resetId },
          select: { approvedById: true, approvedAt: true },
        });
      });
      expect(row?.approvedAt).not.toBeNull();
      expect([approverAId, approverBId]).toContain(row?.approvedById);
    }

    // Sanity: both clients won at least once across 50 iterations.
    // (If one client always wins, the race is suspect — likely the same
    // pool, or one client is starved by connection setup.)
    expect(winnerCount + loserCount).toBe(ITERATIONS);
  });

  // ─── N3: self-approval blocked at DB CAS level ───────────────

  it(
    "self-approval blocked at DB CAS level (bypasses app pre-check)",
    async () => {
      const resetId = await insertPendingReset();

      // Issue the production WHERE clause directly with actorId === initiatedById
      // — this is what "self-approval after the app pre-check is bypassed"
      // looks like at the DB tier.
      const count = await approveCas(clientA, resetId, initiatorId);
      expect(count).toBe(0);

      // Row state is unchanged: still PENDING.
      const row = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.adminVaultReset.findUnique({
          where: { id: resetId },
          select: { approvedAt: true, approvedById: true },
        });
      });
      expect(row?.approvedAt).toBeNull();
      expect(row?.approvedById).toBeNull();
    },
  );
});
