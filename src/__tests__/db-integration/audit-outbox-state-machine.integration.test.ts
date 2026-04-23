/**
 * State machine transitions for audit_outbox rows:
 * PENDING -> PROCESSING -> SENT (happy path)
 * PENDING -> PROCESSING -> PENDING (retry with backoff)
 * PENDING -> ... -> FAILED (dead-letter after MAX_ATTEMPTS)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX } from "@/lib/constants/audit/audit";

describe("audit-outbox state machine", () => {
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
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  const payloadJson = JSON.stringify({
    scope: "PERSONAL",
    action: "ENTRY_CREATE",
    userId: "placeholder",
    actorType: "HUMAN",
    serviceAccountId: null,
    teamId: null,
    targetType: "PasswordEntry",
    targetId: "placeholder",
    metadata: null,
    ip: "127.0.0.1",
    userAgent: "integration-test",
  });

  async function insertOutboxRow(
    overrides: { attemptCount?: number; maxAttempts?: number } = {},
  ): Promise<string> {
    const id = randomUUID();
    const payload = payloadJson
      .replace('"userId":"placeholder"', `"userId":"${userId}"`)
      .replace('"targetId":"placeholder"', `"targetId":"${randomUUID()}"`);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PENDING', $4, $5, now(), now())`,
        id,
        tenantId,
        payload,
        overrides.attemptCount ?? 0,
        overrides.maxAttempts ?? AUDIT_OUTBOX.MAX_ATTEMPTS,
      );
    });
    return id;
  }

  it("PENDING -> PROCESSING -> SENT (happy path)", async () => {
    const rowId = await insertOutboxRow();

    // Claim: PENDING -> PROCESSING
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'PROCESSING', processing_started_at = now()
         WHERE id = $1::uuid AND status = 'PENDING'`,
        rowId,
      );
    });

    const checkStatus = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM audit_outbox WHERE id = $1::uuid`,
        rowId,
      );
      return rows[0];
    });
    expect(checkStatus.status).toBe("PROCESSING");

    // Deliver: insert into audit_logs + mark SENT
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (id, tenant_id, scope, action, user_id, actor_type, created_at, outbox_id)
         VALUES (gen_random_uuid(), $1::uuid, 'PERSONAL'::"AuditScope", 'ENTRY_CREATE'::"AuditAction",
                 $2::uuid, 'HUMAN'::"ActorType", now(), $3::uuid)`,
        tenantId,
        userId,
        rowId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'SENT', sent_at = now(), processing_started_at = NULL
         WHERE id = $1::uuid`,
        rowId,
      );
    });

    const finalRow = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<{ status: string; sent_at: Date | null }[]>(
        `SELECT status, sent_at FROM audit_outbox WHERE id = $1::uuid`, rowId,
      );
      return rows[0];
    });
    expect(finalRow.status).toBe("SENT");
    expect(finalRow.sent_at).not.toBeNull();
  });

  it("PENDING -> PROCESSING -> PENDING (retry with incremented attempt_count)", async () => {
    const rowId = await insertOutboxRow();

    // Claim
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'PROCESSING', processing_started_at = now()
         WHERE id = $1::uuid`,
        rowId,
      );
    });

    // Simulate failure: back to PENDING with bumped attempt_count and future next_retry_at
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox
         SET status = 'PENDING',
             attempt_count = attempt_count + 1,
             next_retry_at = now() + interval '60 seconds',
             last_error = 'simulated failure',
             processing_started_at = NULL
         WHERE id = $1::uuid`,
        rowId,
      );
    });

    const row = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<{
        status: string;
        attempt_count: number;
        next_retry_at: Date;
        last_error: string | null;
      }[]>(
        `SELECT status, attempt_count, next_retry_at, last_error
         FROM audit_outbox WHERE id = $1::uuid`,
        rowId,
      );
      return rows[0];
    });
    expect(row.status).toBe("PENDING");
    expect(row.attempt_count).toBe(1);
    expect(row.next_retry_at.getTime()).toBeGreaterThan(Date.now());
    expect(row.last_error).toBe("simulated failure");
  });

  it("transitions to FAILED (dead-letter) when attempt_count reaches MAX_ATTEMPTS", async () => {
    const maxAttempts = AUDIT_OUTBOX.MAX_ATTEMPTS;
    const rowId = await insertOutboxRow({
      attemptCount: maxAttempts - 1,
      maxAttempts,
    });

    // Claim
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'PROCESSING', processing_started_at = now()
         WHERE id = $1::uuid`,
        rowId,
      );
    });

    // Simulate final failure: attempt_count reaches max -> FAILED
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox
         SET status = 'FAILED',
             attempt_count = $1,
             last_error = 'max attempts reached',
             processing_started_at = NULL
         WHERE id = $2::uuid`,
        maxAttempts,
        rowId,
      );
    });

    const row = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<{
        status: string;
        attempt_count: number;
      }[]>(
        `SELECT status, attempt_count FROM audit_outbox WHERE id = $1::uuid`,
        rowId,
      );
      return rows[0];
    });
    expect(row.status).toBe("FAILED");
    expect(row.attempt_count).toBe(maxAttempts);
  });
});
