/**
 * Privilege enumeration for passwd_retention_gc_worker role (C7/C10/RT5/T5/T11).
 *
 * Uses ctx.retentionWorker to assert:
 *   POSITIVE: the role CAN delete an expired row from sessions (RLS-enabled EXPIRY table)
 *             when bypass_rls GUC is set.
 *   NEGATIVE: the role CANNOT DELETE FROM audit_logs (no DELETE grant — S5/F5).
 *   NEGATIVE: the role CANNOT DELETE FROM tenants (no DELETE grant).
 *
 * Both positive and negative on the same retentionWorker client (T11).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";

describe("retention-gc-worker role privileges (C7/C10/RT5/T5/T11)", () => {
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

  // ─── POSITIVE: role CAN delete expired sessions row under bypass_rls ─────────

  it("POSITIVE: can DELETE an expired sessions row when bypass_rls GUC is set (T11 positive branch)", async () => {
    // Seed an expired session using superuser. id is @db.Uuid; session_token is
    // a free string — keep them distinct (id must be a valid UUID).
    const sessionId = randomUUID();
    const sessionToken = `sess-role-${randomUUID()}`;
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

    // As retentionWorker: BEGIN tx, set bypass_rls, DELETE, COMMIT
    await ctx.retentionWorker.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRawUnsafe(
        `DELETE FROM sessions
         WHERE (id) IN (
           SELECT id FROM sessions
           WHERE expires < now()
           LIMIT 100
         )`,
      );
    });

    // Verify the row is gone
    const remaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM sessions WHERE id = $1::uuid`,
        sessionId,
      );
    });
    expect(remaining).toHaveLength(0);
  });

  // ─── NEGATIVE: role CANNOT DELETE FROM audit_logs (T11 negative branch) ──────

  it("NEGATIVE: cannot DELETE FROM audit_logs (no DELETE grant — S5/F5)", async () => {
    await expect(
      ctx.retentionWorker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });

  // ─── NEGATIVE: role CANNOT DELETE FROM tenants ────────────────────────────────

  it("NEGATIVE: cannot DELETE FROM tenants (no DELETE grant)", async () => {
    await expect(
      ctx.retentionWorker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = $1::uuid`,
          tenantId,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });

  // ─── POSITIVE: role CAN INSERT into audit_outbox (heartbeat path) ────────────

  it("POSITIVE: can INSERT into audit_outbox with SYSTEM_TENANT_ID inside bypass_rls tx", async () => {
    const outboxId = randomUUID();
    const payload = JSON.stringify({
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION.RETENTION_GC_SWEEP,
      userId: "00000000-0000-4000-8000-000000000001",
      actorType: ACTOR_TYPE.SYSTEM,
      serviceAccountId: null,
      teamId: null,
      targetType: null,
      targetId: null,
      metadata: { purgedCount: 0, perTable: {}, sweepIntervalMs: 3_600_000 },
      ip: null,
      userAgent: "retention-gc-worker",
    });

    await ctx.retentionWorker.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${SYSTEM_TENANT_ID}, true)`;
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PENDING', 0, 8, now(), now())`,
        outboxId,
        SYSTEM_TENANT_ID,
        payload,
      );
    });

    // Verify it landed
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_outbox WHERE id = $1::uuid`,
        outboxId,
      );
    });
    expect(rows).toHaveLength(1);

    // Cleanup
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'FAILED' WHERE id = $1::uuid`,
        outboxId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE id = $1::uuid`,
        outboxId,
      );
    });
  });
});
