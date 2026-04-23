/**
 * Tests concurrent chain insert ordering using two separate PrismaClient connections.
 * Verifies that SELECT ... FOR UPDATE serializes anchor access and produces
 * gap-free, monotonically increasing chain_seq values.
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
} from "@/lib/audit/audit-chain";

describe("audit-chain-ordering (concurrent inserts)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let clientA: PrismaWithPool;
  let clientB: PrismaWithPool;

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
    userId = await ctx.createUser(tenantId);

    // Enable audit chain for the tenant
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_chain_enabled = true WHERE id = $1::uuid`,
        tenantId,
      );
    });
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  it("produces gap-free sequential chain_seq values under concurrent inserts", async () => {
    // Insert an outbox row (just for reference; we do chain logic inline)
    const outboxIdA = randomUUID();
    const outboxIdB = randomUUID();
    const createdAt = new Date();

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 0, 5, $4::timestamptz, now())`,
        outboxIdA,
        tenantId,
        JSON.stringify({ scope: "PERSONAL", action: "ENTRY_CREATE", userId, actorType: "HUMAN" }),
        createdAt.toISOString(),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 0, 5, $4::timestamptz, now())`,
        outboxIdB,
        tenantId,
        JSON.stringify({ scope: "PERSONAL", action: "ENTRY_CREATE", userId, actorType: "HUMAN" }),
        createdAt.toISOString(),
      );
    });

    // Barrier: both clients will wait here before acquiring the FOR UPDATE lock
    const barrier = new Deferred();

    const runChainInsert = async (
      client: PrismaWithPool,
      outboxId: string,
      barrierPromise: Promise<void>,
    ): Promise<bigint> => {
      return client.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);

        // Ensure anchor row exists
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
           VALUES ($1::uuid, 0, '\\x00'::bytea, now())
           ON CONFLICT (tenant_id) DO NOTHING`,
          tenantId,
        );

        // Wait for barrier — both clients reach this point before either locks
        await barrierPromise;

        // Lock the anchor
        const anchors = await tx.$queryRawUnsafe<{
          chain_seq: bigint;
          prev_hash: Uint8Array;
        }[]>(
          `SELECT chain_seq, prev_hash FROM audit_chain_anchors WHERE tenant_id = $1::uuid FOR UPDATE`,
          tenantId,
        );

        const anchor = anchors[0]!;
        const newSeq = BigInt(anchor.chain_seq) + BigInt(1);
        const prevHashBuf = Buffer.from(anchor.prev_hash);

        const auditLogId = randomUUID();
        const metadata = { test: "concurrent" };
        const chainInput = buildChainInput({
          id: auditLogId,
          createdAt,
          chainSeq: newSeq,
          prevHash: prevHashBuf,
          payload: metadata,
        });
        const canonicalBytes = computeCanonicalBytes(chainInput);
        const eventHash = computeEventHash(prevHashBuf, canonicalBytes);

        // Insert audit_logs row with chain fields
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs (
            id, tenant_id, scope, action, user_id, actor_type,
            metadata, created_at, outbox_id,
            chain_seq, event_hash, chain_prev_hash
          ) VALUES (
            $1::uuid, $2::uuid, 'PERSONAL'::"AuditScope", 'ENTRY_CREATE'::"AuditAction",
            $3::uuid, 'HUMAN'::"ActorType",
            $4::jsonb, $5::timestamptz, $6::uuid,
            $7, $8, $9
          )`,
          auditLogId,
          tenantId,
          userId,
          JSON.stringify(metadata),
          createdAt.toISOString(),
          outboxId,
          newSeq,
          eventHash,
          prevHashBuf,
        );

        // Update anchor
        await tx.$executeRawUnsafe(
          `UPDATE audit_chain_anchors
           SET chain_seq = $1, prev_hash = $2, updated_at = now()
           WHERE tenant_id = $3::uuid`,
          newSeq,
          eventHash,
          tenantId,
        );

        return newSeq;
      });
    };

    // Start both transactions, release barrier so both race for the lock
    const resultA = runChainInsert(clientA, outboxIdA, barrier.promise);
    const resultB = runChainInsert(clientB, outboxIdB, barrier.promise);

    // Small delay to let both transactions start and reach the barrier point
    await new Promise((r) => setTimeout(r, 50));
    barrier.resolve();

    const [seqA, seqB] = await Promise.all([resultA, resultB]);

    // Both should succeed with distinct sequential values
    const seqs = [Number(seqA), Number(seqB)].sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2]);

    // Verify created_at is non-decreasing across chain_seq order
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint; created_at: Date }[]>(
        `SELECT chain_seq, created_at FROM audit_logs
         WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL
         ORDER BY chain_seq ASC`,
        tenantId,
      );
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].created_at.getTime()).toBeLessThanOrEqual(rows[1].created_at.getTime());
  });
});
