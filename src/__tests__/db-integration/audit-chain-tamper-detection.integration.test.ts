/**
 * Tests that modifying a row's payload after insertion is detected by
 * re-computing the hash chain. Also tests gap detection.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import {
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
} from "@/lib/audit-chain";

describe("audit-chain tamper detection", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);

    // Enable audit chain
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

  // Helper: insert N chained audit_logs rows, returning their IDs and hashes
  async function insertChainedRows(
    count: number,
  ): Promise<{ ids: string[]; hashes: Buffer[] }> {
    const ids: string[] = [];
    const hashes: Buffer[] = [];
    let prevHash: Buffer = Buffer.from([0x00]);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      // Ensure anchor row
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now())
         ON CONFLICT (tenant_id) DO NOTHING`,
        tenantId,
      );

      for (let i = 1; i <= count; i++) {
        const id = randomUUID();
        const createdAt = new Date(Date.now() + i * 1000); // ensure non-decreasing
        const seq = BigInt(i);
        const metadata = { index: i, test: "tamper-detection" };

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
          tenantId,
          userId,
          JSON.stringify(metadata),
          createdAt.toISOString(),
          seq,
          eventHash,
          prevHash,
        );

        ids.push(id);
        hashes.push(eventHash);
        prevHash = eventHash;
      }

      // Update anchor to final state
      await tx.$executeRawUnsafe(
        `UPDATE audit_chain_anchors
         SET chain_seq = $1, prev_hash = $2, updated_at = now()
         WHERE tenant_id = $3::uuid`,
        BigInt(count),
        prevHash,
        tenantId,
      );
    });

    return { ids, hashes };
  }

  // Helper: walk the chain and verify hashes, returning verification result
  async function verifyChain(): Promise<{
    ok: boolean;
    totalVerified: number;
    firstTamperedSeq: number | null;
    firstGapAfterSeq: number | null;
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
        tenantId,
      );
    });

    let prevHash: Buffer = Buffer.from([0x00]);
    let prevSeq: number | null = null;
    let totalVerified = 0;
    let firstTamperedSeq: number | null = null;
    let firstGapAfterSeq: number | null = null;

    for (const row of rows) {
      const seq = Number(row.chain_seq);

      // Gap detection
      if (prevSeq !== null && firstGapAfterSeq === null && seq !== prevSeq + 1) {
        firstGapAfterSeq = prevSeq;
      }

      // Hash verification
      if (firstTamperedSeq === null) {
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
          firstTamperedSeq = seq;
        }
      }

      prevHash = Buffer.from(row.event_hash);
      prevSeq = seq;
      totalVerified++;
    }

    const ok = firstTamperedSeq === null && firstGapAfterSeq === null;
    return { ok, totalVerified, firstTamperedSeq, firstGapAfterSeq };
  }

  it("validates a correctly chained sequence", async () => {
    await insertChainedRows(3);
    const result = await verifyChain();

    expect(result.ok).toBe(true);
    expect(result.totalVerified).toBe(3);
    expect(result.firstTamperedSeq).toBeNull();
    expect(result.firstGapAfterSeq).toBeNull();
  });

  it("detects metadata tampering in the middle of the chain", async () => {
    const { ids } = await insertChainedRows(3);

    // Tamper with row 2's metadata
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_logs SET metadata = '{"tampered": true}'::jsonb WHERE id = $1::uuid`,
        ids[1],
      );
    });

    const result = await verifyChain();
    expect(result.ok).toBe(false);
    expect(result.firstTamperedSeq).toBe(2);
  });

  it("detects chain_seq gap", async () => {
    // Insert rows with chain_seq 1, 2, 4 (gap at 3)
    let prevHash: Buffer = Buffer.from([0x00]);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now())
         ON CONFLICT (tenant_id) DO NOTHING`,
        tenantId,
      );

      for (const seq of [1, 2, 4]) {
        const id = randomUUID();
        const createdAt = new Date(Date.now() + seq * 1000);
        const metadata = { index: seq };

        const chainInput = buildChainInput({
          id,
          createdAt,
          chainSeq: BigInt(seq),
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
          tenantId,
          userId,
          JSON.stringify(metadata),
          createdAt.toISOString(),
          BigInt(seq),
          eventHash,
          prevHash,
        );

        prevHash = eventHash;
      }

      await tx.$executeRawUnsafe(
        `UPDATE audit_chain_anchors
         SET chain_seq = 4, prev_hash = $1, updated_at = now()
         WHERE tenant_id = $2::uuid`,
        prevHash,
        tenantId,
      );
    });

    const result = await verifyChain();
    expect(result.ok).toBe(false);
    expect(result.firstGapAfterSeq).toBe(2);
  });
});
