/**
 * Tests the audit chain verification logic with real DB data.
 * Exercises valid chain, tampered chain, and empty chain scenarios.
 * Uses the same hash computation as the verify endpoint.
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

// Mirrors the verify endpoint's row type
interface ChainRow {
  id: string;
  created_at: Date;
  chain_seq: bigint;
  event_hash: Uint8Array;
  chain_prev_hash: Uint8Array;
  metadata: unknown;
}

// Mirrors the verify endpoint's walk logic
function walkChain(
  rows: ChainRow[],
  seedPrevHash: Buffer,
): {
  ok: boolean;
  totalVerified: number;
  firstTamperedSeq: number | null;
  firstGapAfterSeq: number | null;
  firstTimestampViolationSeq: number | null;
} {
  let prevHash = seedPrevHash;
  let prevSeq: number | null = null;
  let prevCreatedAt: Date | null = null;
  let totalVerified = 0;
  let firstTamperedSeq: number | null = null;
  let firstGapAfterSeq: number | null = null;
  let firstTimestampViolationSeq: number | null = null;

  for (const row of rows) {
    const seq = Number(row.chain_seq);

    // Gap detection
    if (prevSeq !== null && firstGapAfterSeq === null && seq !== prevSeq + 1) {
      firstGapAfterSeq = prevSeq;
    }

    // Timestamp monotonicity
    if (
      prevCreatedAt !== null &&
      row.created_at < prevCreatedAt &&
      firstTimestampViolationSeq === null
    ) {
      firstTimestampViolationSeq = seq;
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
    prevCreatedAt = row.created_at;
    totalVerified++;
  }

  const ok =
    firstTamperedSeq === null &&
    firstGapAfterSeq === null &&
    firstTimestampViolationSeq === null;

  return { ok, totalVerified, firstTamperedSeq, firstGapAfterSeq, firstTimestampViolationSeq };
}

describe("audit-chain verify endpoint logic", () => {
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

  // Helper: insert N chained rows and return their IDs
  async function insertChainedRows(count: number): Promise<string[]> {
    const ids: string[] = [];
    let prevHash: Buffer = Buffer.from([0x00]);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now())
         ON CONFLICT (tenant_id) DO NOTHING`,
        tenantId,
      );

      for (let i = 1; i <= count; i++) {
        const id = randomUUID();
        const createdAt = new Date(Date.now() + i * 1000);
        const seq = BigInt(i);
        const metadata = { index: i, verify: true };

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
        prevHash = eventHash;
      }

      await tx.$executeRawUnsafe(
        `UPDATE audit_chain_anchors
         SET chain_seq = $1, prev_hash = $2, updated_at = now()
         WHERE tenant_id = $3::uuid`,
        BigInt(count),
        prevHash,
        tenantId,
      );
    });

    return ids;
  }

  // Helper: fetch chain rows from DB
  async function fetchChainRows(): Promise<ChainRow[]> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<ChainRow[]>(
        `SELECT id, created_at, chain_seq, event_hash, chain_prev_hash, metadata
         FROM audit_logs
         WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL
         ORDER BY chain_seq ASC`,
        tenantId,
      );
    });
  }

  it("valid chain returns ok: true with correct totalVerified", async () => {
    await insertChainedRows(5);
    const rows = await fetchChainRows();
    const result = walkChain(rows, Buffer.from([0x00]));

    expect(result.ok).toBe(true);
    expect(result.totalVerified).toBe(5);
    expect(result.firstTamperedSeq).toBeNull();
    expect(result.firstGapAfterSeq).toBeNull();
    expect(result.firstTimestampViolationSeq).toBeNull();
  });

  it("tampered chain returns ok: false with firstTamperedSeq", async () => {
    const ids = await insertChainedRows(5);

    // Tamper with row 3's metadata
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_logs SET metadata = '{"tampered": true}'::jsonb WHERE id = $1::uuid`,
        ids[2],
      );
    });

    const rows = await fetchChainRows();
    const result = walkChain(rows, Buffer.from([0x00]));

    expect(result.ok).toBe(false);
    expect(result.firstTamperedSeq).toBe(3);
    // totalVerified still counts all rows walked
    expect(result.totalVerified).toBe(5);
  });

  it("empty chain (no anchor) returns ok: true, totalVerified: 0", async () => {
    // Do not insert any chain rows or anchor
    const anchors = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: string }[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });

    // No anchor → verify endpoint returns { ok: true, totalVerified: 0 }
    expect(anchors).toHaveLength(0);

    // Simulate the endpoint's early return for no anchor
    const rows = await fetchChainRows();
    expect(rows).toHaveLength(0);

    const result = walkChain(rows, Buffer.from([0x00]));
    expect(result.ok).toBe(true);
    expect(result.totalVerified).toBe(0);
  });

  it("detects timestamp violation when created_at goes backwards", async () => {
    let prevHash: Buffer = Buffer.from([0x00]);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now())
         ON CONFLICT (tenant_id) DO NOTHING`,
        tenantId,
      );

      // Insert 3 rows where row 3 has an earlier timestamp than row 2
      const timestamps = [
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-01T02:00:00Z"),
        new Date("2026-01-01T01:00:00Z"), // backwards!
      ];

      for (let i = 0; i < 3; i++) {
        const id = randomUUID();
        const seq = BigInt(i + 1);
        const metadata = { index: i + 1 };

        const chainInput = buildChainInput({
          id,
          createdAt: timestamps[i],
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
          timestamps[i].toISOString(),
          seq,
          eventHash,
          prevHash,
        );

        prevHash = eventHash;
      }

      await tx.$executeRawUnsafe(
        `UPDATE audit_chain_anchors
         SET chain_seq = 3, prev_hash = $1, updated_at = now()
         WHERE tenant_id = $2::uuid`,
        prevHash,
        tenantId,
      );
    });

    const rows = await fetchChainRows();
    const result = walkChain(rows, Buffer.from([0x00]));

    // Hashes are still valid (timestamp is part of canonical data, but chain links correctly)
    expect(result.firstTamperedSeq).toBeNull();
    // But timestamp violation is detected
    expect(result.firstTimestampViolationSeq).toBe(3);
    expect(result.ok).toBe(false);
  });
});
