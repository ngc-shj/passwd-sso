/**
 * Concurrent workers claiming rows with SELECT FOR UPDATE SKIP LOCKED
 * must claim disjoint row sets.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  createPrismaForRole,
  setBypassRlsGucs,
  Deferred,
  type TestContext,
  type PrismaWithPool,
} from "./helpers";

describe("audit-outbox SKIP LOCKED concurrency", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let worker2: PrismaWithPool;

  beforeAll(async () => {
    ctx = await createTestContext();
    worker2 = createPrismaForRole("superuser");
  });
  afterAll(async () => {
    await worker2.prisma.$disconnect().then(() => worker2.pool.end());
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  it("two concurrent workers claim disjoint row sets", async () => {
    // Insert 4 PENDING outbox rows
    const rowIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = randomUUID();
      rowIds.push(id);
      const payload = JSON.stringify({
        scope: "PERSONAL",
        action: "ENTRY_CREATE",
        userId,
        actorType: "HUMAN",
        serviceAccountId: null,
        teamId: null,
        targetType: "PasswordEntry",
        targetId: randomUUID(),
        metadata: null,
        ip: "127.0.0.1",
        userAgent: "integration-test",
      });
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, created_at, next_retry_at)
           VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PENDING', now() + ($4 || ' seconds')::interval, now())`,
          id,
          tenantId,
          payload,
          i.toString(),
        );
      });
    }

    // Barriers to synchronize concurrent claims
    const worker1Ready = new Deferred();
    const worker2Ready = new Deferred();

    const claimQuery = `
      SELECT id FROM audit_outbox
      WHERE status = 'PENDING'
        AND tenant_id = $1::uuid
        AND next_retry_at <= now()
      ORDER BY created_at ASC
      LIMIT 2
      FOR UPDATE SKIP LOCKED
    `;

    // Worker 1 claims first
    const w1Promise = ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const claimed = await tx.$queryRawUnsafe<{ id: string }[]>(claimQuery, tenantId);
      // Signal that worker1 holds locks
      worker1Ready.resolve();
      // Wait for worker2 to also attempt its claim
      await worker2Ready.promise;
      return claimed.map((r) => r.id);
    });

    // Wait for worker1 to acquire locks before worker2 starts
    await worker1Ready.promise;

    // Worker 2 claims next — SKIP LOCKED skips worker1's locked rows
    const w2Promise = worker2.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const claimed = await tx.$queryRawUnsafe<{ id: string }[]>(claimQuery, tenantId);
      // Signal that worker2 has completed its SELECT
      worker2Ready.resolve();
      return claimed.map((r) => r.id);
    });

    const [claimed1, claimed2] = await Promise.all([w1Promise, w2Promise]);

    // Verify disjoint sets
    const set1 = new Set(claimed1);
    const set2 = new Set(claimed2);
    for (const id of claimed2) {
      expect(set1.has(id)).toBe(false);
    }

    // Together they should cover all 4 rows
    expect(claimed1.length + claimed2.length).toBe(4);

    // All claimed IDs should be from our inserted rows
    const allClaimed = [...set1, ...set2];
    for (const id of allClaimed) {
      expect(rowIds).toContain(id);
    }
  });
});
