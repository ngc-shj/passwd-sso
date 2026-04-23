import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";

describe("audit-outbox null-invariant: outbox_id = NULL only allowed for SYSTEM actor", () => {
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

  it("allows outbox_id = NULL for SYSTEM actor bypass actions (AUDIT_OUTBOX_REAPED)", async () => {
    // SYSTEM actor with NULL outbox_id should succeed
    // CHECK constraint: (outbox_id IS NOT NULL OR actor_type = 'SYSTEM')
    // user_id must be SYSTEM_ACTOR_ID sentinel (NOT NULL constraint)
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
          $6::uuid,
          $4::"ActorType",
          $5::jsonb,
          now(),
          NULL
        )`,
        tenantId,
        AUDIT_SCOPE.TENANT,
        AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
        ACTOR_TYPE.SYSTEM,
        JSON.stringify({ test: true }),
        SYSTEM_ACTOR_ID,
      );
    });

    // Verify the row exists
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ outbox_id: string | null; actor_type: string }[]>(
        `SELECT outbox_id, actor_type::text FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction" AND outbox_id IS NULL`,
        tenantId,
        AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].outbox_id).toBeNull();
    expect(rows[0].actor_type).toBe("SYSTEM");
  });

  it("rejects outbox_id = NULL for HUMAN actor (non-bypass action)", async () => {
    // HUMAN actor with NULL outbox_id should fail
    // CHECK constraint: (outbox_id IS NOT NULL OR actor_type = 'SYSTEM')
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
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
            NULL
          )`,
          tenantId,
          AUDIT_SCOPE.PERSONAL,
          AUDIT_ACTION.ENTRY_CREATE,
          userId,
          ACTOR_TYPE.HUMAN,
          JSON.stringify({ test: true }),
        );
      }),
    ).rejects.toThrow(/audit_logs_outbox_id_actor_type_check/);
  });

  it("allows outbox_id = NULL for SYSTEM actor with AUDIT_OUTBOX_RETENTION_PURGED", async () => {
    // Another bypass action should also work
    // user_id must be SYSTEM_ACTOR_ID sentinel (NOT NULL constraint)
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
          $6::uuid,
          $4::"ActorType",
          $5::jsonb,
          now(),
          NULL
        )`,
        tenantId,
        AUDIT_SCOPE.TENANT,
        AUDIT_ACTION.AUDIT_OUTBOX_RETENTION_PURGED,
        ACTOR_TYPE.SYSTEM,
        JSON.stringify({ purgedCount: 5 }),
        SYSTEM_ACTOR_ID,
      );
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ action: string }[]>(
        `SELECT action::text FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction" AND outbox_id IS NULL`,
        tenantId,
        AUDIT_ACTION.AUDIT_OUTBOX_RETENTION_PURGED,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("AUDIT_OUTBOX_RETENTION_PURGED");
  });
});
