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
} from "@/lib/audit/audit-chain";
import { deliverRowWithChain } from "@/workers/audit-outbox-worker";
import type { AuditOutboxRow, AuditOutboxPayload } from "@/workers/audit-outbox-worker";

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
        const outboxId = randomUUID();
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

        // Create a SENT outbox row so the HUMAN audit_logs row satisfies
        // CHECK (outbox_id IS NOT NULL OR actor_type = 'SYSTEM')
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
           VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
          outboxId,
          tenantId,
        );

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
          id,
          tenantId,
          userId,
          JSON.stringify(metadata),
          createdAt.toISOString(),
          outboxId,
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
        const outboxId = randomUUID();
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

        // Create a SENT outbox row so the HUMAN audit_logs row satisfies
        // CHECK (outbox_id IS NOT NULL OR actor_type = 'SYSTEM')
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
           VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
          outboxId,
          tenantId,
        );

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
          id,
          tenantId,
          userId,
          JSON.stringify(metadata),
          timestamps[i].toISOString(),
          outboxId,
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

  // T5 (A1 diagnostic): characterization test pinning the CURRENT semantics of
  // chain-verify with the default fromSeq=1 after the earliest rows have been
  // purged via audit_log_purge(). See TODO(route-policy-sql-security) A1.
  //
  // OBSERVED (not the review doc's a-priori guess of ok:true/totalVerified:0):
  // fromSeq stays 1 (no `from` query param), so the seed-lookup branch
  // (`if (fromSeq > 1)`) is skipped and the walk seeds with the GENESIS
  // prevHash (0x00) — not row 3's real event_hash. The query's `chain_seq >= 1`
  // is a range bound, not an equality check, so it still returns the surviving
  // rows 4-5. Re-hashing row 4 against the wrong (genesis) seed does not match
  // its stored event_hash (which was chained from row 3), so the walk reports
  // firstTamperedSeq=4 / ok:false — a FALSE tamper signal on an untampered
  // chain, not a graceful "verified from the retained start". This is the A1
  // finding this test pins: purging the chain head produces a misleading
  // FAILURE report (not a misleading success) at the default fromSeq. A
  // watermark (purged_up_to_seq) is the planned fix; this test exists so a
  // future fix can diff its behavior against today's deliberately.
  it("A1: after purging the earliest chained rows, default fromSeq=1 verify reports a false tamper at the first retained row (characterization)", async () => {
    // Deliver 5 chained rows through the REAL deliverRowWithChain (not the
    // hand-rolled insertChainedRows helper) so the chain bookkeeping this test
    // observes is the worker's own.
    const rowIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const outboxId = randomUUID();
      const createdAt = new Date(Date.now() + i * 1000);
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
           VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 0, 5, $4::timestamptz, now())`,
          outboxId,
          tenantId,
          JSON.stringify({ scope: "PERSONAL", action: "ENTRY_CREATE", userId, actorType: "HUMAN" }),
          createdAt.toISOString(),
        );
      });
      const row: AuditOutboxRow = {
        id: outboxId,
        tenant_id: tenantId,
        payload: { scope: "PERSONAL", action: "ENTRY_CREATE", userId, actorType: "HUMAN" },
        status: "PROCESSING",
        attempt_count: 0,
        max_attempts: 5,
        created_at: createdAt,
        next_retry_at: createdAt,
        processing_started_at: new Date(),
        sent_at: null,
        last_error: null,
      };
      const payload: AuditOutboxPayload = {
        scope: "PERSONAL",
        action: "ENTRY_CREATE",
        userId,
        actorType: "HUMAN",
        serviceAccountId: null,
        teamId: null,
        targetType: null,
        targetId: null,
        metadata: null,
        ip: null,
        userAgent: null,
      };
      await deliverRowWithChain(ctx.su.prisma, row, payload);
      const inserted = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM audit_logs WHERE outbox_id = $1::uuid`,
          outboxId,
        );
      });
      rowIds.push(inserted[0].id);
    }

    // Sanity: full chain (seq 1..5) verifies cleanly before any purge.
    const rowsBeforePurge = await fetchChainRows();
    expect(rowsBeforePurge).toHaveLength(5);
    const beforePurge = walkChain(rowsBeforePurge, Buffer.from([0x00]));
    expect(beforePurge.ok).toBe(true);
    expect(beforePurge.totalVerified).toBe(5);

    // Purge the earliest 3 rows via the real SECURITY DEFINER function — cutoff
    // set so only rows 1-3 (created earliest) fall before it.
    const cutoff = new Date(Date.now() + 2500); // between row index 2 and 3 (0-based)
    const purged = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ rows_deleted: number }[]>(
        `SELECT audit_log_purge($1::uuid, $2::timestamptz) AS rows_deleted`,
        tenantId,
        cutoff,
      );
    });
    expect(purged[0].rows_deleted).toBe(3);

    // Remaining rows are seq 4 and 5 — chain_seq is NOT renumbered by the purge.
    const rowsAfterPurge = await fetchChainRows();
    expect(rowsAfterPurge).toHaveLength(2);
    expect(rowsAfterPurge.map((r) => Number(r.chain_seq))).toEqual([4, 5]);

    // Default fromSeq=1 (no `from` query param): the verify endpoint's query
    // is `chain_seq >= 1 AND chain_seq <= toSeq`, seeded with prevHash = 0x00
    // (the genesis seed, since fromSeq=1 <= 1 skips the seed-lookup branch).
    // OBSERVED characterization: the walk finds rows 4-5, but re-derives their
    // hash starting from the GENESIS prevHash (0x00) instead of row 3's actual
    // event_hash — row 4's stored hash was chained from row 3, not genesis, so
    // this is expected to report tamper/mismatch (NOT a clean ok:true skip).
    // This is the A1 finding: default fromSeq=1 after a purge does not
    // gracefully report "verified from the retained start" — it misinterprets
    // the retained range against the wrong seed.
    const result = walkChain(rowsAfterPurge, Buffer.from([0x00]));
    expect(result.firstTamperedSeq).toBe(4);
    expect(result.ok).toBe(false);
  });
});
