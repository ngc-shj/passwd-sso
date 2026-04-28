/**
 * Atomicity test: if the audit-emit step inside sweepOnce's transaction throws,
 * the DELETE must also roll back (R9 contract).
 *
 * Uses the _emitFn injection point in SweepOpts to trigger a mid-tx failure
 * without modifying the worker's production code path or using brittle DB state.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { sweepOnce } from "@/workers/dcr-cleanup-worker";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";

describe("dcr-cleanup-worker tx-rollback atomicity (real DB)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let seededClientId: string | null;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    seededClientId = null;
  });
  afterEach(async () => {
    // Clean up any seeded mcp_clients row (present only if DELETE was rolled back)
    if (seededClientId !== null) {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `DELETE FROM mcp_clients WHERE id = $1::uuid`,
          seededClientId as string,
        );
      });
    }
    // Clean up any SYSTEM_TENANT_ID audit_outbox rows that may have leaked
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

  it("rolls back DELETE when audit emission throws mid-tx", async () => {
    // Seed one target row (is_dcr=true, tenant_id=null, expired)
    const clientId = randomUUID();
    seededClientId = clientId;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_clients (id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_dcr, tenant_id, dcr_expires_at, created_at, updated_at)
         VALUES ($1::uuid, $2, 'hash', $3, '{}', 'credentials:list', true, NULL, now() - interval '1 hour', now(), now())`,
        clientId,
        `test-cl-rollback-${clientId.slice(0, 8)}`,
        `client-rollback-${clientId.slice(0, 8)}`,
      );
    });

    // Stub the emit function to throw on the first call
    const failingEmitFn = vi.fn().mockRejectedValueOnce(new Error("simulated audit failure"));

    // Capture count of SYSTEM_TENANT_ID audit_outbox rows before the test
    const beforeCount = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_outbox WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
      return Number(rows[0].cnt);
    });

    // sweepOnce should throw because the emit function throws
    await expect(
      sweepOnce(ctx.dcrWorker.prisma, 10, {
        intervalMs: 3_600_000,
        emitHeartbeatAudit: false,
        _emitFn: failingEmitFn,
      }),
    ).rejects.toThrow("simulated audit failure");

    // The target row must still exist (DELETE was rolled back)
    const stillThere = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM mcp_clients WHERE id = $1::uuid`,
        clientId,
      );
    });
    expect(stillThere).toHaveLength(1);

    // No new audit_outbox rows for SYSTEM_TENANT_ID
    const afterCount = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_outbox WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
      return Number(rows[0].cnt);
    });
    expect(afterCount).toBe(beforeCount);

    expect(failingEmitFn).toHaveBeenCalledOnce();
  });
});
