/**
 * Tests that two tenants' audit hash chains are fully independent.
 * Each tenant has its own anchor, its own chain_seq numbering, and
 * a stuck lock on one tenant does not block the other.
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
import {
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
} from "@/lib/audit-chain";

describe("audit-chain cross-tenant isolation", () => {
  let ctx: TestContext;
  let tenantIdA: string;
  let tenantIdB: string;
  let userIdA: string;
  let userIdB: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantIdA = await ctx.createTenant();
    tenantIdB = await ctx.createTenant();
    userIdA = await ctx.createUser(tenantIdA);
    userIdB = await ctx.createUser(tenantIdB);

    // Enable audit chain for both tenants
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_chain_enabled = true WHERE id = $1::uuid`,
        tenantIdA,
      );
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_chain_enabled = true WHERE id = $1::uuid`,
        tenantIdB,
      );
    });
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantIdA);
    await ctx.deleteTestData(tenantIdB);
  });

  // Helper: insert N chained rows for a given tenant
  async function insertChainedRows(
    targetTenantId: string,
    targetUserId: string,
    count: number,
  ): Promise<void> {
    let prevHash: Buffer = Buffer.from([0x00]);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now())
         ON CONFLICT (tenant_id) DO NOTHING`,
        targetTenantId,
      );

      for (let i = 1; i <= count; i++) {
        const id = randomUUID();
        const createdAt = new Date(Date.now() + i * 1000);
        const seq = BigInt(i);
        const metadata = { tenant: targetTenantId.slice(0, 8), index: i };

        const chainInput = buildChainInput({
          id,
          createdAt,
          chainSeq: seq,
          prevHash,
          payload: metadata,
        });
        const canonicalBytes = computeCanonicalBytes(chainInput);
        const eventHash = computeEventHash(prevHash, canonicalBytes);

        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs (
            id, tenant_id, scope, action, user_id, actor_type,
            metadata, created_at,
            chain_seq, event_hash, chain_prev_hash
          ) VALUES (
            $1::uuid, $2::uuid, 'PERSONAL'::"AuditScope", 'ENTRY_CREATE'::"AuditAction",
            $3::uuid, 'HUMAN'::"ActorType",
            $4::jsonb, $5::timestamptz,
            $6, $7, $8
          )`,
          id,
          targetTenantId,
          targetUserId,
          JSON.stringify(metadata),
          createdAt.toISOString(),
          seq,
          eventHash,
          prevHash,
        );

        prevHash = eventHash;
      }

      await tx.$executeRawUnsafe(
        `UPDATE audit_chain_anchors
         SET chain_seq = $1, prev_hash = $2, updated_at = now()
         WHERE tenant_id = $3::uuid`,
        BigInt(count),
        prevHash,
        targetTenantId,
      );
    });
  }

  // Helper: verify chain for a given tenant
  async function verifyChainForTenant(targetTenantId: string): Promise<{
    ok: boolean;
    totalVerified: number;
  }> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{
        id: string;
        created_at: Date;
        chain_seq: bigint;
        event_hash: Uint8Array;
        chain_prev_hash: Uint8Array;
        metadata: unknown;
      }[]>(
        `SELECT id, created_at, chain_seq, event_hash, chain_prev_hash, metadata
         FROM audit_logs
         WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL
         ORDER BY chain_seq ASC`,
        targetTenantId,
      );
    });

    let prevHash: Buffer = Buffer.from([0x00]);
    let totalVerified = 0;

    for (const row of rows) {
      const payload =
        row.metadata != null && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : {};

      const chainInput = buildChainInput({
        id: row.id,
        createdAt: row.created_at,
        chainSeq: BigInt(row.chain_seq),
        prevHash,
        payload,
      });
      const canonicalBytes = computeCanonicalBytes(chainInput);
      const computedHash = computeEventHash(prevHash, canonicalBytes);

      if (!computedHash.equals(Buffer.from(row.event_hash))) {
        return { ok: false, totalVerified };
      }

      prevHash = Buffer.from(row.event_hash);
      totalVerified++;
    }

    return { ok: true, totalVerified };
  }

  it("maintains independent chain_seq numbering per tenant", async () => {
    await insertChainedRows(tenantIdA, userIdA, 3);
    await insertChainedRows(tenantIdB, userIdB, 2);

    // Both chains start at seq 1
    const rowsA = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint }[]>(
        `SELECT chain_seq FROM audit_logs
         WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL
         ORDER BY chain_seq ASC`,
        tenantIdA,
      );
    });

    const rowsB = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint }[]>(
        `SELECT chain_seq FROM audit_logs
         WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL
         ORDER BY chain_seq ASC`,
        tenantIdB,
      );
    });

    expect(rowsA.map((r) => Number(r.chain_seq))).toEqual([1, 2, 3]);
    expect(rowsB.map((r) => Number(r.chain_seq))).toEqual([1, 2]);
  });

  it("verifies each tenant chain independently", async () => {
    await insertChainedRows(tenantIdA, userIdA, 3);
    await insertChainedRows(tenantIdB, userIdB, 2);

    const resultA = await verifyChainForTenant(tenantIdA);
    const resultB = await verifyChainForTenant(tenantIdB);

    expect(resultA).toEqual({ ok: true, totalVerified: 3 });
    expect(resultB).toEqual({ ok: true, totalVerified: 2 });
  });

  it("tenant A locked anchor does not block tenant B inserts", async () => {
    // Use a separate client that will hold a lock on tenant A's anchor
    const locker = createPrismaForRole("superuser");

    try {
      // Create anchor for tenant A
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
           VALUES ($1::uuid, 0, '\\x00'::bytea, now())
           ON CONFLICT (tenant_id) DO NOTHING`,
          tenantIdA,
        );
      });

      const lockAcquired = new Deferred();
      const releaseLock = new Deferred();

      // Hold FOR UPDATE lock on tenant A's anchor
      const lockPromise = locker.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$queryRawUnsafe(
          `SELECT * FROM audit_chain_anchors WHERE tenant_id = $1::uuid FOR UPDATE`,
          tenantIdA,
        );
        lockAcquired.resolve();
        // Hold the lock until we're told to release
        await releaseLock.promise;
      });

      await lockAcquired.promise;

      // Tenant B should be able to insert without being blocked
      await insertChainedRows(tenantIdB, userIdB, 1);

      const resultB = await verifyChainForTenant(tenantIdB);
      expect(resultB).toEqual({ ok: true, totalVerified: 1 });

      // Release the lock
      releaseLock.resolve();
      await lockPromise;
    } finally {
      await locker.prisma.$disconnect().then(() => locker.pool.end());
    }
  });
});
