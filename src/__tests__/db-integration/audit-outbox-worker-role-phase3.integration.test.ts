/**
 * Phase 3: Worker role privilege enumeration — verifies that passwd_outbox_worker
 * has EXACTLY the grants needed for Phase 1+2+3 (audit_delivery_targets SELECT,
 * audit_deliveries full CRUD).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

describe("audit-outbox worker role (Phase 1+2+3)", () => {
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

  it("has exactly the expected table privileges (Phase 1+2+3)", async () => {
    const privs = await ctx.su.prisma.$queryRawUnsafe<{
      table_name: string;
      privilege_type: string;
    }[]>(
      `SELECT table_name, privilege_type
       FROM information_schema.table_privileges
       WHERE grantee = 'passwd_outbox_worker'
         AND table_schema = 'public'
       ORDER BY table_name, privilege_type`,
    );

    // Build a map of table -> sorted privileges
    const privMap = new Map<string, string[]>();
    for (const row of privs) {
      const existing = privMap.get(row.table_name) ?? [];
      existing.push(row.privilege_type);
      privMap.set(row.table_name, existing);
    }

    // Phase 1+2 grants
    expect(privMap.get("audit_outbox")?.sort()).toEqual(
      ["DELETE", "SELECT", "UPDATE"].sort(),
    );
    expect(privMap.get("audit_logs")?.sort()).toEqual(["INSERT", "SELECT"]);
    expect(privMap.get("tenants")?.sort()).toEqual(["REFERENCES", "SELECT"]);
    // FK ref tables (granted by Phase 1 migration for referential integrity under RLS)
    expect(privMap.get("users")?.sort()).toEqual(["REFERENCES", "SELECT"]);
    expect(privMap.get("teams")?.sort()).toEqual(["SELECT"]);
    expect(privMap.get("service_accounts")?.sort()).toEqual(["SELECT"]);

    // Phase 3 grants
    expect(privMap.get("audit_delivery_targets")?.sort()).toEqual(["SELECT", "UPDATE"]);
    expect(privMap.get("audit_deliveries")?.sort()).toEqual(
      ["DELETE", "INSERT", "SELECT", "UPDATE"].sort(),
    );

    // Phase 4 grants
    expect(privMap.get("audit_chain_anchors")?.sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);

    // Verify exact table set (Phase 1+2+3+4 combined)
    const allowedTables = new Set([
      "audit_outbox",
      "audit_logs",
      "tenants",
      "users",
      "teams",
      "service_accounts",
      "audit_delivery_targets",
      "audit_deliveries",
      "audit_chain_anchors",
    ]);
    for (const tableName of privMap.keys()) {
      expect(
        allowedTables.has(tableName),
        `Unexpected grant on table: ${tableName}`,
      ).toBe(true);
    }
    expect(privMap.size).toBe(allowedTables.size);
  });

  it("worker can SELECT from audit_delivery_targets", async () => {
    // Insert a target via superuser first
    const targetId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_delivery_targets (
          id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
          master_key_version, is_active, created_at
        ) VALUES ($1::uuid, $2::uuid, 'WEBHOOK'::"AuditDeliveryTargetKind", 'enc', 'iv', 'tag', 1, true, now())`,
        targetId,
        tenantId,
      );
    });

    // Worker should be able to SELECT
    const rows = await ctx.worker.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_delivery_targets WHERE id = $1::uuid`,
        targetId,
      );
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(targetId);
  });

  it("worker cannot INSERT into audit_delivery_targets", async () => {
    await expect(
      ctx.worker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_delivery_targets (
            id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
            master_key_version, is_active, created_at
          ) VALUES ($1::uuid, $2::uuid, 'WEBHOOK'::"AuditDeliveryTargetKind", 'enc', 'iv', 'tag', 1, true, now())`,
          randomUUID(),
          tenantId,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("worker can INSERT into audit_deliveries", async () => {
    // Setup: create target and outbox row via superuser
    const targetId = randomUUID();
    const outboxId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_delivery_targets (
          id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
          master_key_version, is_active, created_at
        ) VALUES ($1::uuid, $2::uuid, 'WEBHOOK'::"AuditDeliveryTargetKind", 'enc', 'iv', 'tag', 1, true, now())`,
        targetId,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
        outboxId,
        tenantId,
      );
    });

    // Worker should be able to INSERT into audit_deliveries
    const deliveryId = randomUUID();
    await ctx.worker.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        deliveryId,
        outboxId,
        targetId,
        tenantId,
      );
    });

    // Verify it was created
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_deliveries WHERE id = $1::uuid`,
        deliveryId,
      );
    });
    expect(rows).toHaveLength(1);
  });

  it("worker can UPDATE audit_deliveries", async () => {
    const targetId = randomUUID();
    const outboxId = randomUUID();
    const deliveryId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_delivery_targets (
          id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
          master_key_version, is_active, created_at
        ) VALUES ($1::uuid, $2::uuid, 'S3_OBJECT'::"AuditDeliveryTargetKind", 'enc', 'iv', 'tag', 1, true, now())`,
        targetId,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
        outboxId,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        deliveryId,
        outboxId,
        targetId,
        tenantId,
      );
    });

    // Worker should be able to UPDATE
    await ctx.worker.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.$executeRawUnsafe(
        `UPDATE audit_deliveries SET status = 'SENT' WHERE id = $1::uuid`,
        deliveryId,
      );
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM audit_deliveries WHERE id = $1::uuid`,
        deliveryId,
      );
    });
    expect(rows[0].status).toBe("SENT");
  });

  it("worker can DELETE from audit_deliveries", async () => {
    const targetId = randomUUID();
    const outboxId = randomUUID();
    const deliveryId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_delivery_targets (
          id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
          master_key_version, is_active, created_at
        ) VALUES ($1::uuid, $2::uuid, 'SIEM_HEC'::"AuditDeliveryTargetKind", 'enc', 'iv', 'tag', 1, true, now())`,
        targetId,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
        outboxId,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SENT')`,
        deliveryId,
        outboxId,
        targetId,
        tenantId,
      );
    });

    // Worker should be able to DELETE
    await ctx.worker.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_deliveries WHERE id = $1::uuid`,
        deliveryId,
      );
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_deliveries WHERE id = $1::uuid`,
        deliveryId,
      );
    });
    expect(Number(rows[0].cnt)).toBe(0);
  });

  it("worker cannot access password_entries table", async () => {
    await expect(
      ctx.worker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.$queryRawUnsafe(`SELECT id FROM password_entries LIMIT 1`);
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("worker cannot INSERT into users table (SELECT-only grant)", async () => {
    await expect(
      ctx.worker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRawUnsafe(
          `INSERT INTO users (id, tenant_id, email, name, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, 'test@example.com', 'Test', now(), now())`,
          tenantId,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
