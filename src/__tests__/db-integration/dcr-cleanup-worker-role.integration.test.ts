/**
 * Privilege enumeration for passwd_dcr_cleanup_worker role.
 * Asserts the role can DELETE matching (is_dcr=true, tenant_id IS NULL, expired) rows
 * when bypass_rls GUC is set, cannot DELETE tenant-scoped rows without the GUC,
 * and has no DELETE grant on tenants or audit_logs.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";

describe("dcr-cleanup-worker role privileges", () => {
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

  it("can DELETE matching rows when bypass_rls GUC is set", async () => {
    // Seed an expired unclaimed DCR row using superuser
    const targetId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_clients (id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_dcr, tenant_id, dcr_expires_at, created_at, updated_at)
         VALUES ($1::uuid, $2, 'hash', 'test-dcr', '{}', 'credentials:list', true, NULL, now() - interval '1 hour', now(), now())`,
        targetId,
        `test-client-${targetId.slice(0, 8)}`,
      );
    });

    // As dcrWorker: BEGIN tx, set bypass_rls, DELETE matching rows, COMMIT
    await ctx.dcrWorker.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_clients
         USING (
           SELECT id FROM mcp_clients
           WHERE is_dcr = true AND tenant_id IS NULL AND dcr_expires_at < now()
           LIMIT 100
         ) sub
         WHERE mcp_clients.id = sub.id`,
      );
    });

    // Verify the row is gone
    const remaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM mcp_clients WHERE id = $1::uuid`,
        targetId,
      );
    });
    expect(remaining).toHaveLength(0);
  });

  it("cannot DELETE rows with tenant_id IS NOT NULL when bypass_rls is OFF", async () => {
    // Seed an MCP client with a real tenantId using superuser
    const clientId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_clients (id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_dcr, tenant_id, dcr_expires_at, created_at, updated_at)
         VALUES ($1::uuid, $2, 'hash', 'test-tenant-client', '{}', 'credentials:list', true, $3::uuid, now() - interval '1 hour', now(), now())`,
        clientId,
        `test-client-tenant-${clientId.slice(0, 8)}`,
        tenantId,
      );
    });

    try {
      // As dcrWorker without bypass_rls GUC: DELETE should affect 0 rows (RLS denies)
      const rowCount = await ctx.dcrWorker.prisma.$transaction(async (tx) => {
        return tx.$executeRawUnsafe<number>(
          `DELETE FROM mcp_clients WHERE id = $1::uuid`,
          clientId,
        );
      });
      expect(rowCount).toBe(0);

      // Original row still exists
      const stillThere = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM mcp_clients WHERE id = $1::uuid`,
          clientId,
        );
      });
      expect(stillThere).toHaveLength(1);
    } finally {
      // Remove the mcp_client before deleteTestData deletes the tenant (FK constraint)
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `DELETE FROM mcp_clients WHERE id = $1::uuid`,
          clientId,
        );
      });
    }
  });

  it("cannot DELETE from tenants (no DELETE grant)", async () => {
    await expect(
      ctx.dcrWorker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = $1::uuid`,
          tenantId,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot DELETE from audit_logs (no DELETE grant)", async () => {
    await expect(
      ctx.dcrWorker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("can INSERT into audit_outbox with sentinel tenantId inside bypass_rls tx", async () => {
    const outboxId = randomUUID();
    const payload = JSON.stringify({
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP,
      userId: "00000000-0000-4000-8000-000000000001",
      actorType: ACTOR_TYPE.SYSTEM,
      serviceAccountId: null,
      teamId: null,
      targetType: null,
      targetId: null,
      metadata: { purgedCount: 0, triggeredBy: "dcr-cleanup-worker", sweepIntervalMs: 3600000 },
      ip: null,
      userAgent: "dcr-cleanup-worker",
    });

    await ctx.dcrWorker.prisma.$transaction(async (tx) => {
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

    // Cleanup the inserted outbox row
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
