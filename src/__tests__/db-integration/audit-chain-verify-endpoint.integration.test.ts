/**
 * Drives GET /api/maintenance/audit-chain-verify end-to-end against real DB
 * rows: valid chain, tampered chain, empty chain, timestamp violation, and the
 * post-purge characterization.
 *
 * This file used to re-implement the endpoint's walk in a local `walkChain()`
 * and assert against that. The copy drifted — it had no bail-on-first-tamper,
 * so it counted rows the endpoint never verifies, and it carried none of the
 * endpoint's `truncated` / `reason` / `walkedThrough` outputs. A test named for
 * the endpoint that cannot fail when the endpoint changes is worse than no
 * test, so the walk is now the production one and the assertions below are its
 * real values.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
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

// Row shape returned by the fetch helper below (diagnostics only — the
// endpoint reads its own rows straight from the DB).
interface ChainRow {
  id: string;
  created_at: Date;
  chain_seq: bigint;
  event_hash: Uint8Array;
  chain_prev_hash: Uint8Array;
  metadata: unknown;
}

// Set per test in beforeEach; the auth mocks below close over these so the
// operator always resolves to the tenant the fixtures were built in.
let currentTenantId = "";
let currentUserId = "";
const OPERATOR_TOKEN_ID = "integration-op-token";

const { mockLogAudit } = vi.hoisted(() => ({ mockLogAudit: vi.fn() }));

vi.mock("@/lib/auth/tokens/admin-token", () => ({
  verifyAdminToken: vi.fn(async () => ({
    ok: true,
    auth: {
      subjectUserId: currentUserId,
      tenantId: currentTenantId,
      tokenId: OPERATOR_TOKEN_ID,
      scopes: ["maintenance"],
    },
  })),
}));
vi.mock("@/lib/auth/access/maintenance-auth", () => ({
  requireMaintenanceOperator: vi.fn(async () => ({
    ok: true,
    operator: { tenantId: currentTenantId, role: "ADMIN" },
  })),
}));
// The route's limiter is fail-closed on a missing Redis, which would 503 before
// the walk ever runs. The limiter contract for this route (exact tenant-scoped
// key + the 503 envelope) is pinned in route.test.ts; the subject here is the
// walk over real rows.
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true }),
    clear: () => {},
  }),
}));
// Kept out of the DB so a verify call cannot enqueue an audit row that the next
// assertion in the same tenant would then have to account for.
vi.mock("@/lib/audit/audit", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  logAuditAsync: mockLogAudit,
}));

import { GET } from "@/app/api/maintenance/audit-chain-verify/route";

interface VerifyBody {
  ok: boolean;
  reason?: string;
  truncated: boolean;
  walkedThrough: number;
  verifiedUpToSeq?: number;
  firstTamperedSeq: number | null;
  firstGapAfterSeq: number | null;
  firstTimestampViolationSeq: number | null;
  totalVerified: number;
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
    vi.clearAllMocks();
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    currentTenantId = tenantId;
    currentUserId = userId;

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

  /** Drive the real handler for the current tenant. */
  async function verifyChain(params: Record<string, string> = {}): Promise<VerifyBody> {
    const url = new URL("http://localhost/api/maintenance/audit-chain-verify");
    url.searchParams.set("tenantId", tenantId);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const res = await GET(
      new NextRequest(url, {
        method: "GET",
        headers: { authorization: "Bearer op_integration", "x-forwarded-for": "10.0.0.1" },
      }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as VerifyBody;
  }

  it("valid chain returns ok: true with correct totalVerified", async () => {
    await insertChainedRows(5);

    const body = await verifyChain();

    expect(body.ok).toBe(true);
    expect(body.reason).toBeUndefined();
    expect(body.totalVerified).toBe(5);
    expect(body.walkedThrough).toBe(5);
    expect(body.verifiedUpToSeq).toBe(5);
    expect(body.firstTamperedSeq).toBeNull();
    expect(body.firstGapAfterSeq).toBeNull();
    expect(body.firstTimestampViolationSeq).toBeNull();
  });

  it("tampered chain bails at the tampered row and reports TAMPER_DETECTED", async () => {
    const ids = await insertChainedRows(5);

    // Tamper with row 3's metadata
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_logs SET metadata = '{"tampered": true}'::jsonb WHERE id = $1::uuid`,
        ids[2],
      );
    });

    const body = await verifyChain();

    expect(body.ok).toBe(false);
    expect(body.reason).toBe("TAMPER_DETECTED");
    expect(body.firstTamperedSeq).toBe(3);
    // C15 (OWASP A08-2): the walk stops at seq 3, so only rows 1-2 are
    // verified. Rows 4-5 are NOT counted — past a tamper the chain re-seeds
    // from a hash the attacker controls, and reporting them as verified is
    // exactly the false assurance the bail exists to prevent.
    expect(body.totalVerified).toBe(2);
    expect(body.walkedThrough).toBe(2);
    expect(body.verifiedUpToSeq).toBe(2);
  });

  it("empty chain (no anchor, no rows) returns ok: true, totalVerified: 0", async () => {
    // Do not insert any chain rows or anchor
    const anchors = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: string }[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(anchors).toHaveLength(0);

    const body = await verifyChain();

    expect(body.ok).toBe(true);
    expect(body.totalVerified).toBe(0);
  });

  it("anchor present with every chained row purged fails closed as RANGE_INCOMPLETE", async () => {
    await insertChainedRows(3);

    // Delete every chained row but leave the anchor claiming chain_seq = 3.
    // No gap survives BETWEEN returned rows (there are none), so only the
    // coverage comparison can catch this.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL`,
        tenantId,
      );
    });

    const body = await verifyChain();

    expect(body.ok).toBe(false);
    expect(body.reason).toBe("RANGE_INCOMPLETE");
    expect(body.totalVerified).toBe(0);
    expect(body.firstTamperedSeq).toBeNull();
  });

  it("chained rows surviving without their anchor fail closed as ANCHOR_MISSING", async () => {
    await insertChainedRows(3);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });

    const body = await verifyChain();

    expect(body.ok).toBe(false);
    expect(body.reason).toBe("ANCHOR_MISSING");
    expect(body.totalVerified).toBe(0);
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

    const body = await verifyChain();

    // Hashes are still valid (timestamp is part of canonical data, but chain links correctly)
    expect(body.firstTamperedSeq).toBeNull();
    // But timestamp violation is detected
    expect(body.firstTimestampViolationSeq).toBe(3);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("TIMESTAMP_VIOLATION");
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
    const beforePurge = await verifyChain();
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
    const body = await verifyChain();
    expect(body.firstTamperedSeq).toBe(4);
    expect(body.ok).toBe(false);
    // Tamper outranks the coverage shortfall in the reason ladder: the bail at
    // seq 4 is also why the walk never reaches toSeq, but the misleading signal
    // an operator sees is the false tamper — which is the point of A1.
    expect(body.reason).toBe("TAMPER_DETECTED");
    expect(body.totalVerified).toBe(0);
  });
});
