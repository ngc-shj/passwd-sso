/**
 * T3: exercises the REAL exported reapStuckRows (not duplicated SQL) so a
 * regression in the worker's own reaper query is caught here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX, AUDIT_ACTION, AUDIT_SCOPE, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { reapStuckRows } from "@/workers/audit-outbox-worker";

describe("audit-outbox reaper resets stuck PROCESSING rows (T3 real reapStuckRows)", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  async function insertStuckRow(opts: {
    attemptCount: number;
    maxAttempts: number;
  }): Promise<string> {
    const outboxId = randomUUID();
    const timeoutSeconds = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / 1000;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', $4, $5,
                 now() - make_interval(secs => $6::double precision) - interval '60 seconds',
                 now(), now())`,
        outboxId,
        tenantId,
        JSON.stringify({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.ENTRY_CREATE,
          userId: randomUUID(),
          actorType: ACTOR_TYPE.HUMAN,
        }),
        opts.attemptCount,
        opts.maxAttempts,
        timeoutSeconds,
      );
    });
    return outboxId;
  }

  async function getOutboxRow(outboxId: string) {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<
        { status: string; attempt_count: number; processing_started_at: Date | null }[]
      >(
        `SELECT status::text, attempt_count, processing_started_at FROM audit_outbox WHERE id = $1::uuid`,
        outboxId,
      );
    });
    return rows[0];
  }

  it("reaps a stuck PROCESSING row back to PENDING with incremented attempt_count", async () => {
    const outboxId = await insertStuckRow({ attemptCount: 2, maxAttempts: 8 });

    const reaped = await reapStuckRows(ctx.su.prisma);
    expect(reaped).toBe(1);

    const row = await getOutboxRow(outboxId);
    expect(row.status).toBe("PENDING");
    expect(row.attempt_count).toBe(3); // was 2, incremented to 3
    expect(row.processing_started_at).toBeNull();
  });

  it("writes an AUDIT_OUTBOX_REAPED audit_logs entry with SYSTEM actor and SYSTEM_ACTOR_ID userId", async () => {
    const outboxId = await insertStuckRow({ attemptCount: 2, maxAttempts: 8 });

    await reapStuckRows(ctx.su.prisma);

    const logs = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<
        { action: string; user_id: string | null; actor_type: string; metadata: unknown }[]
      >(
        `SELECT action::text, user_id, actor_type::text, metadata FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction"`,
        tenantId,
        AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
      );
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].user_id).toBe(SYSTEM_ACTOR_ID);
    expect(logs[0].actor_type).toBe("SYSTEM");
    expect((logs[0].metadata as { outboxId: string }).outboxId).toBe(outboxId);
  });

  it("transitions stuck row to FAILED and writes AUDIT_OUTBOX_DEAD_LETTER when attempt_count reaches max_attempts", async () => {
    const outboxId = await insertStuckRow({ attemptCount: 7, maxAttempts: 8 });

    const reaped = await reapStuckRows(ctx.su.prisma);
    expect(reaped).toBe(1);

    const row = await getOutboxRow(outboxId);
    expect(row.status).toBe("FAILED");
    expect(row.attempt_count).toBe(8);

    const logs = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ action: string }[]>(
        `SELECT action::text FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction"`,
        tenantId,
        AUDIT_ACTION.AUDIT_OUTBOX_DEAD_LETTER,
      );
    });
    expect(logs).toHaveLength(1);
  });

  it("does not touch rows that are not stuck (recent PROCESSING, or PENDING/SENT)", async () => {
    // Recent PROCESSING row (not past the timeout) must be left alone.
    const freshId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 0, 8, now(), now(), now())`,
        freshId,
        tenantId,
        JSON.stringify({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.ENTRY_CREATE,
          userId: randomUUID(),
          actorType: ACTOR_TYPE.HUMAN,
        }),
      );
    });

    const reaped = await reapStuckRows(ctx.su.prisma);
    expect(reaped).toBe(0);

    const row = await getOutboxRow(freshId);
    expect(row.status).toBe("PROCESSING");
  });
});
