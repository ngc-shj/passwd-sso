import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit";

describe("audit-outbox BEFORE DELETE trigger (TM1 defense)", () => {
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

  const makePayload = () =>
    JSON.stringify({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: randomUUID(),
      actorType: ACTOR_TYPE.HUMAN,
    });

  async function insertOutboxRow(id: string, status: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const processingStartedAt =
        status === "PROCESSING" ? ", processing_started_at = now()" : "";
      const sentAt = status === "SENT" ? ", sent_at = now()" : "";
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, $4::"AuditOutboxStatus", 1, 8, now(), now())`,
        id,
        tenantId,
        makePayload(),
        status,
      );
      if (processingStartedAt) {
        await tx.$executeRawUnsafe(
          `UPDATE audit_outbox SET processing_started_at = now() WHERE id = $1::uuid`,
          id,
        );
      }
      if (sentAt) {
        await tx.$executeRawUnsafe(
          `UPDATE audit_outbox SET sent_at = now() WHERE id = $1::uuid`,
          id,
        );
      }
    });
  }

  it("blocks DELETE of PENDING rows", async () => {
    const id = randomUUID();
    await insertOutboxRow(id, "PENDING");

    // Attempt to delete as worker role — should be blocked by the trigger
    await expect(
      ctx.worker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
        await tx.$executeRaw`SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`;
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_outbox WHERE id = $1::uuid`,
          id,
        );
      }),
    ).rejects.toThrow(/Cannot delete audit_outbox row with status/);
  });

  it("blocks DELETE of PROCESSING rows", async () => {
    const id = randomUUID();
    await insertOutboxRow(id, "PROCESSING");

    await expect(
      ctx.worker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
        await tx.$executeRaw`SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`;
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_outbox WHERE id = $1::uuid`,
          id,
        );
      }),
    ).rejects.toThrow(/Cannot delete audit_outbox row with status/);
  });

  it("allows DELETE of SENT rows", async () => {
    const id = randomUUID();
    await insertOutboxRow(id, "SENT");

    // Should succeed — trigger allows SENT deletions
    await ctx.worker.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`;
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE id = $1::uuid`,
        id,
      );
    });

    // Verify deleted
    const remaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_outbox WHERE id = $1::uuid`,
        id,
      );
    });
    expect(remaining).toHaveLength(0);
  });

  it("allows DELETE of FAILED rows", async () => {
    const id = randomUUID();
    await insertOutboxRow(id, "FAILED");

    // Should succeed — trigger allows FAILED deletions
    await ctx.worker.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`;
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE id = $1::uuid`,
        id,
      );
    });

    // Verify deleted
    const remaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_outbox WHERE id = $1::uuid`,
        id,
      );
    });
    expect(remaining).toHaveLength(0);
  });
});
