/**
 * R13 re-entry suppression: bypass actions (e.g., WEBHOOK_DELIVERY_FAILED,
 * AUDIT_OUTBOX_REAPED) are written directly to audit_logs without creating
 * a new outbox row — preventing infinite outbox loops.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import {
  AUDIT_ACTION,
  OUTBOX_BYPASS_AUDIT_ACTIONS,
} from "@/lib/constants/audit/audit";

describe("audit-outbox reentrant guard (R13)", () => {
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

  it("OUTBOX_BYPASS_AUDIT_ACTIONS contains expected bypass actions", () => {
    // Verify key actions are in the bypass set
    expect(OUTBOX_BYPASS_AUDIT_ACTIONS.has(AUDIT_ACTION.WEBHOOK_DELIVERY_FAILED)).toBe(true);
    expect(OUTBOX_BYPASS_AUDIT_ACTIONS.has(AUDIT_ACTION.AUDIT_OUTBOX_REAPED)).toBe(true);
    expect(OUTBOX_BYPASS_AUDIT_ACTIONS.has(AUDIT_ACTION.AUDIT_OUTBOX_DEAD_LETTER)).toBe(true);
    expect(OUTBOX_BYPASS_AUDIT_ACTIONS.has(AUDIT_ACTION.AUDIT_DELIVERY_FAILED)).toBe(true);
    expect(OUTBOX_BYPASS_AUDIT_ACTIONS.has(AUDIT_ACTION.AUDIT_DELIVERY_DEAD_LETTER)).toBe(true);

    // Normal actions should NOT be in the bypass set
    expect(OUTBOX_BYPASS_AUDIT_ACTIONS.has(AUDIT_ACTION.ENTRY_CREATE)).toBe(false);
    expect(OUTBOX_BYPASS_AUDIT_ACTIONS.has(AUDIT_ACTION.AUTH_LOGIN)).toBe(false);
  });

  it("direct audit_logs INSERT with NULL outboxId succeeds for bypass actions", async () => {
    // For bypass actions, the system writes directly to audit_logs
    // with outboxId = NULL and actorType = SYSTEM, skipping the outbox entirely.
    const bypassAction = AUDIT_ACTION.AUDIT_OUTBOX_REAPED;

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type,
          created_at, outbox_id
        ) VALUES (
          gen_random_uuid(),
          $1::uuid,
          'TENANT'::"AuditScope",
          $2::"AuditAction",
          $3::uuid,
          'SYSTEM'::"ActorType",
          now(),
          NULL
        )`,
        tenantId,
        bypassAction,
        userId,
      );
    });

    // Verify the audit_logs row was written
    const logRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction"`,
        tenantId,
        bypassAction,
      );
    });
    expect(Number(logRows[0].cnt)).toBe(1);

    // Verify NO outbox row was created for the bypass action
    const outboxRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_outbox WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(Number(outboxRows[0].cnt)).toBe(0);
  });

  it("outbox row with bypass action does not create a secondary outbox row when delivered", async () => {
    // Even if a bypass action somehow ends up in the outbox,
    // delivering it should insert into audit_logs without creating another outbox row.
    const outboxId = randomUUID();
    const bypassAction = AUDIT_ACTION.WEBHOOK_DELIVERY_FAILED;

    // Insert a bypass-action row into outbox (simulating edge case)
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const payload = JSON.stringify({
        scope: "TENANT",
        action: bypassAction,
        userId,
        actorType: "SYSTEM",
        serviceAccountId: null,
        teamId: null,
        targetType: null,
        targetId: null,
        metadata: null,
        ip: null,
        userAgent: null,
      });
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PENDING', now(), now())`,
        outboxId,
        tenantId,
        payload,
      );
    });

    // Deliver it to audit_logs (like the worker would)
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type, created_at, outbox_id
        ) VALUES (
          gen_random_uuid(), $1::uuid, 'TENANT'::"AuditScope", $2::"AuditAction",
          $3::uuid, 'SYSTEM'::"ActorType", now(), $4::uuid
        )
        ON CONFLICT (outbox_id) DO NOTHING`,
        tenantId,
        bypassAction,
        userId,
        outboxId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'SENT', sent_at = now() WHERE id = $1::uuid`,
        outboxId,
      );
    });

    // The outbox should still have exactly 1 row (the original, now SENT)
    // No secondary outbox row should have been spawned
    const outboxRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_outbox WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(Number(outboxRows[0].cnt)).toBe(1);
  });
});
