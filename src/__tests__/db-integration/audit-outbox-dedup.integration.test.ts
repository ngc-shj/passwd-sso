/**
 * ON CONFLICT (outbox_id) DO NOTHING dedup: re-delivering the same
 * outbox row to audit_logs must be idempotent.
 *
 * T1: exercises the REAL exported deliverRowWithChain (not hand-rolled SQL)
 * so a regression in the worker's own INSERT ... ON CONFLICT shape or chain
 * bookkeeping is caught here, not just in a parallel copy of the SQL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { deliverRowWithChain } from "@/workers/audit-outbox-worker";
import type { AuditOutboxRow, AuditOutboxPayload } from "@/workers/audit-outbox-worker";

describe("audit-outbox dedup (ON CONFLICT) — real deliverRowWithChain", () => {
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

    // Enable audit chain — deliverRowWithChain is the export under test.
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

  async function claimRow(outboxId: string): Promise<AuditOutboxRow> {
    // Mirrors the worker's claimBatch UPDATE ... RETURNING (PENDING -> PROCESSING).
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<AuditOutboxRow[]>(
        `UPDATE audit_outbox
         SET status = 'PROCESSING', processing_started_at = now()
         WHERE id = $1::uuid AND status = 'PENDING'
         RETURNING *`,
        outboxId,
      );
    });
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function resetToPending(outboxId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'PENDING', processing_started_at = NULL WHERE id = $1::uuid`,
        outboxId,
      );
    });
  }

  async function insertOutboxRow(payload: AuditOutboxPayload): Promise<string> {
    const outboxId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PENDING', 0, 5, now(), now())`,
        outboxId,
        tenantId,
        JSON.stringify(payload),
      );
    });
    return outboxId;
  }

  function makePayload(): AuditOutboxPayload {
    return {
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
  }

  async function countAuditLogsFor(outboxId: string): Promise<number> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_logs WHERE outbox_id = $1::uuid`,
        outboxId,
      );
    });
    return Number(rows[0].cnt);
  }

  it("first delivery inserts exactly one audit_logs row and advances the chain", async () => {
    const payload = makePayload();
    const outboxId = await insertOutboxRow(payload);
    const row = await claimRow(outboxId);

    const delivered = await deliverRowWithChain(ctx.su.prisma, row, payload);
    expect(delivered).toBe(true);
    expect(await countAuditLogsFor(outboxId)).toBe(1);

    const anchor = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint }[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(Number(anchor[0].chain_seq)).toBe(1);
  });

  it("claim -> deliver -> reset to PENDING -> deliver again: exactly one audit_logs row, chain_seq unchanged on 2nd delivery", async () => {
    const payload = makePayload();
    const outboxId = await insertOutboxRow(payload);

    // First delivery cycle.
    const row1 = await claimRow(outboxId);
    const delivered1 = await deliverRowWithChain(ctx.su.prisma, row1, payload);
    expect(delivered1).toBe(true);
    expect(await countAuditLogsFor(outboxId)).toBe(1);

    const anchorAfterFirst = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint }[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(Number(anchorAfterFirst[0].chain_seq)).toBe(1);

    // Simulate a re-delivery: the row is reset to PENDING (e.g. by the reaper
    // after a crash between the INSERT and the outbox status UPDATE) and
    // re-claimed + re-delivered with the SAME outbox row id.
    await resetToPending(outboxId);
    const row2 = await claimRow(outboxId);
    const delivered2 = await deliverRowWithChain(ctx.su.prisma, row2, payload);

    // deliverRowWithChain always returns true when not paused (it unconditionally
    // marks the outbox row SENT) — the dedup guarantee is on audit_logs, not on
    // this return value.
    expect(delivered2).toBe(true);

    // Still exactly ONE audit_logs row for this outbox_id (ON CONFLICT DO NOTHING).
    expect(await countAuditLogsFor(outboxId)).toBe(1);

    // Chain must NOT have advanced a second time — the INSERT conflicted, so
    // deliverRowWithChain's "only advance anchor if INSERT succeeded" guard held.
    const anchorAfterSecond = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint }[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(Number(anchorAfterSecond[0].chain_seq)).toBe(1);

    // Outbox row ends up SENT either way.
    const outboxRow = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM audit_outbox WHERE id = $1::uuid`,
        outboxId,
      );
    });
    expect(outboxRow[0].status).toBe("SENT");
  });

  it("different outbox rows each insert their own audit_logs row", async () => {
    const payload1 = makePayload();
    const payload2 = makePayload();
    const outboxId1 = await insertOutboxRow(payload1);
    const outboxId2 = await insertOutboxRow(payload2);

    const row1 = await claimRow(outboxId1);
    const row2 = await claimRow(outboxId2);

    await deliverRowWithChain(ctx.su.prisma, row1, payload1);
    await deliverRowWithChain(ctx.su.prisma, row2, payload2);

    expect(await countAuditLogsFor(outboxId1)).toBe(1);
    expect(await countAuditLogsFor(outboxId2)).toBe(1);

    const anchor = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint }[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(Number(anchor[0].chain_seq)).toBe(2);
  });
});
