/**
 * Per-entry error isolation + idempotency tests (C4/T13).
 *
 * C4/INV-C4b: a single entry failure leaves siblings unaffected.
 * C4/T13 idempotency: _emitFn throws in the heartbeat tx; rows were already
 *   deleted (per-entry txs committed before the heartbeat). Re-run returns all-zero
 *   counts (idempotent, not double-delete).
 *
 * NOTE: The old dcr-cleanup-worker-tx-rollback "emit-failure rolls back DELETE"
 * assertion is intentionally NOT ported — that property no longer holds in the
 * new per-entry-tx design. The heartbeat tx is separate from the delete txs.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { sweepOnce } from "@/workers/retention-gc-worker/sweep";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";

describe("retention-gc sweepOnce: idempotency (C4/T13)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let seededSessionIds: string[];

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    seededSessionIds = [];
    // Clear unclaimed DCR rows so only seeded rows affect counts
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_clients WHERE is_dcr = true AND tenant_id IS NULL`,
      );
    });
  });
  afterEach(async () => {
    if (seededSessionIds.length > 0) {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        for (const id of seededSessionIds) {
          await tx.$executeRawUnsafe(`DELETE FROM sessions WHERE id = $1::uuid`, id);
        }
      });
    }
    // Clean up SYSTEM_TENANT_ID audit rows
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
         WHERE tenant_id = $1::uuid AND status IN ('PENDING', 'PROCESSING')`,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  it("rows deleted in per-entry txs even when heartbeat _emitFn throws; re-run returns all-zero counts (T13)", async () => {
    // Seed one expired session. id is @db.Uuid; session_token is a free string.
    const sessionId = randomUUID();
    const sessionToken = `sess-idem-${randomUUID()}`;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at, provider)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() - interval '1 hour', now(), now(), 'credentials')`,
        sessionId,
        sessionToken,
        userId,
        tenantId,
      );
    });
    seededSessionIds.push(sessionId);

    // Wire _emitFn to throw in the heartbeat tx
    const failingEmitFn = vi.fn().mockRejectedValue(new Error("simulated heartbeat failure"));

    // sweepOnce should NOT throw — per-entry errors are caught, heartbeat failure is non-fatal
    const counts = await sweepOnce(ctx.su.prisma, 100, {
      intervalMs: 3_600_000,
      emitHeartbeatAudit: true, // force heartbeat so _emitFn is called
      _emitFn: failingEmitFn,
    });

    // _emitFn was called (heartbeat attempted)
    expect(failingEmitFn).toHaveBeenCalled();

    // sessions row was deleted (per-entry tx committed before heartbeat)
    const sessionGone = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM sessions WHERE id = $1::uuid`,
        sessionId,
      );
    });
    expect(sessionGone).toHaveLength(0);
    // Remove from seededSessionIds since it was already deleted
    seededSessionIds = seededSessionIds.filter((id) => id !== sessionId);

    // sessions count should reflect the deletion
    expect(counts["sessions"]).toBeGreaterThanOrEqual(1);

    // T13 idempotency: re-run sweepOnce returns all-zero counts for sessions
    // (the row is gone; cutoff matches nothing)
    const rerunCounts = await sweepOnce(ctx.su.prisma, 100, {
      intervalMs: 3_600_000,
      emitHeartbeatAudit: false,
    });
    expect(rerunCounts["sessions"]).toBe(0);
  });
});

describe("retention-gc sweepOnce: per-entry error isolation (C4/INV-C4b)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let seededSessionIds: string[];

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    seededSessionIds = [];
    // Clear unclaimed DCR rows
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_clients WHERE is_dcr = true AND tenant_id IS NULL`,
      );
    });
  });
  afterEach(async () => {
    if (seededSessionIds.length > 0) {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        for (const id of seededSessionIds) {
          await tx.$executeRawUnsafe(`DELETE FROM sessions WHERE id = $1::uuid`, id);
        }
      });
    }
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
         WHERE tenant_id = $1::uuid AND status IN ('PENDING', 'PROCESSING')`,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  // Real-DB happy-path: every registry entry runs end-to-end against a live DB
  // and reports success (no -1). This complements — it does NOT replace — the
  // genuine fault-injection isolation test in
  // src/workers/retention-gc-worker/__tests__/sweep-isolation.test.ts, which
  // mocks one entry's $transaction to throw and asserts siblings still report
  // their counts (RT7: that test can go red; this one proves the wiring works
  // against the real schema/RLS).
  it("all registry entries run end-to-end against a live DB with no entry error (C4 wiring)", async () => {
    // Seed an expired session (one entry that should delete a row).
    // id is @db.Uuid; session_token is a free string — keep distinct.
    const sessionId = randomUUID();
    const sessionToken = `sess-isolation-${randomUUID()}`;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at, provider)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() - interval '1 hour', now(), now(), 'credentials')`,
        sessionId,
        sessionToken,
        userId,
        tenantId,
      );
    });
    seededSessionIds.push(sessionId);

    const counts = await sweepOnce(ctx.su.prisma, 100, {
      intervalMs: 3_600_000,
      emitHeartbeatAudit: false,
    });

    // No registry entry errored against the real schema (every entry's
    // table/column/grant is valid) — none is flagged -1.
    for (const [table, count] of Object.entries(counts)) {
      expect(count, `entry "${table}" should not error`).not.toBe(-1);
    }

    // The expired session row was deleted by its entry.
    const gone = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM sessions WHERE id = $1::uuid`,
        sessionId,
      );
    });
    expect(gone).toHaveLength(0);
    seededSessionIds = seededSessionIds.filter((id) => id !== sessionId);

    // sweepOnce returns a map for every registered table entry
    // (no entry should be silently missing from the map)
    expect("mcp_clients" in counts).toBe(true);
    expect("sessions" in counts).toBe(true);
    expect("verification_tokens" in counts).toBe(true);
    expect("extension_bridge_codes" in counts).toBe(true);
    expect("mobile_bridge_codes" in counts).toBe(true);
    expect("mcp_authorization_codes" in counts).toBe(true);
    expect("audit_logs" in counts).toBe(true);
  });
});
