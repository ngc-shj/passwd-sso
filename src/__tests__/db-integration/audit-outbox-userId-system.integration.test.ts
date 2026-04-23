import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";

describe("audit-outbox: SYSTEM actor with sentinel userId (post audit-path-unification)", () => {
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

  it("allows SYSTEM actor with user_id = SYSTEM_ACTOR_ID", async () => {
    // Post-migration: SYSTEM actor rows use SYSTEM_ACTOR_ID sentinel, not NULL
    // userId is now NOT NULL — sentinels fill the previously-null slot
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type, metadata, created_at
        ) VALUES (
          gen_random_uuid(),
          $1::uuid,
          $2::"AuditScope",
          $3::"AuditAction",
          $6::uuid,
          $4::"ActorType",
          $5::jsonb,
          now()
        )`,
        tenantId,
        AUDIT_SCOPE.TENANT,
        AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
        ACTOR_TYPE.SYSTEM,
        JSON.stringify({ test: true }),
        SYSTEM_ACTOR_ID,
      );
    });

    // Verify the row was inserted with the sentinel UUID
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ user_id: string; actor_type: string }[]>(
        `SELECT user_id::text, actor_type::text FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction" AND actor_type = 'SYSTEM'`,
        tenantId,
        AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(SYSTEM_ACTOR_ID);
    expect(rows[0].actor_type).toBe("SYSTEM");
  });

  it("rejects any actor with user_id = NULL (NOT NULL constraint)", async () => {
    // Post-migration: userId is NOT NULL — any NULL insert fails regardless of actor_type
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs (
            id, tenant_id, scope, action, user_id, actor_type, metadata, created_at
          ) VALUES (
            gen_random_uuid(),
            $1::uuid,
            $2::"AuditScope",
            $3::"AuditAction",
            NULL,
            $4::"ActorType",
            $5::jsonb,
            now()
          )`,
          tenantId,
          AUDIT_SCOPE.PERSONAL,
          AUDIT_ACTION.ENTRY_CREATE,
          ACTOR_TYPE.HUMAN,
          JSON.stringify({ test: true }),
        );
      }),
    ).rejects.toThrow(/null value in column|not-null constraint|audit_logs_outbox_id_actor_type_check/);
  });

  it("allows HUMAN actor with valid user_id", async () => {
    // Positive test: HUMAN with a real userId should succeed.
    // Must also provide outbox_id since the outbox_id check requires
    // (outbox_id IS NOT NULL OR actor_type = 'SYSTEM').
    const outboxId = randomUUID();

    // First, insert an outbox row so the FK/unique constraint is satisfied
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', 1, 8, now(), now())`,
        outboxId,
        tenantId,
        JSON.stringify({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.ENTRY_CREATE,
          userId,
          actorType: ACTOR_TYPE.HUMAN,
        }),
      );
    });

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type, metadata, created_at, outbox_id
        ) VALUES (
          gen_random_uuid(),
          $1::uuid,
          $2::"AuditScope",
          $3::"AuditAction",
          $4::uuid,
          $5::"ActorType",
          $6::jsonb,
          now(),
          $7::uuid
        )`,
        tenantId,
        AUDIT_SCOPE.PERSONAL,
        AUDIT_ACTION.ENTRY_CREATE,
        userId,
        ACTOR_TYPE.HUMAN,
        JSON.stringify({ test: true }),
        outboxId,
      );
    });

    // Verify
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ user_id: string; actor_type: string }[]>(
        `SELECT user_id, actor_type::text FROM audit_logs
         WHERE tenant_id = $1::uuid AND outbox_id = $2::uuid`,
        tenantId,
        outboxId,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(userId);
  });
});
