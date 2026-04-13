/**
 * Privilege enumeration for passwd_outbox_worker role (Phase 1+2+3+4).
 * Asserts exact allowed privileges after all migrations run,
 * and confirms denied operations on non-granted tables.
 *
 * Expected grants after all migrations:
 *   audit_outbox: SELECT, UPDATE, DELETE
 *   audit_logs: SELECT, INSERT
 *   tenants: SELECT
 *   users: SELECT (FK ref integrity under RLS)
 *   teams: SELECT (FK ref integrity under RLS)
 *   service_accounts: SELECT (FK ref integrity under RLS)
 *   audit_delivery_targets: SELECT, UPDATE
 *   audit_deliveries: SELECT, INSERT, UPDATE, DELETE
 *   audit_chain_anchors: SELECT, INSERT, UPDATE
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createTestContext, type TestContext } from "./helpers";

describe("audit-outbox worker role privileges", () => {
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

  it("has exactly the expected table privileges", async () => {
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

    // Build a map of table -> sorted privileges (exclude REFERENCES —
    // it is implicitly granted by SUPERUSER's ALTER DEFAULT PRIVILEGES
    // in dev but not in CI where passwd_user is the table owner only)
    const privMap = new Map<string, string[]>();
    for (const row of privs) {
      if (row.privilege_type === "REFERENCES") continue;
      const existing = privMap.get(row.table_name) ?? [];
      existing.push(row.privilege_type);
      privMap.set(row.table_name, existing);
    }

    // Phase 1: outbox + audit_logs + tenants + FK ref tables
    expect(privMap.get("audit_outbox")?.sort()).toEqual(["DELETE", "SELECT", "UPDATE"]);
    expect(privMap.get("audit_logs")?.sort()).toEqual(["INSERT", "SELECT"]);
    expect(privMap.get("tenants")?.sort()).toEqual(["SELECT"]);
    expect(privMap.get("users")?.sort()).toEqual(["SELECT"]);
    expect(privMap.get("teams")?.sort()).toEqual(["SELECT"]);
    expect(privMap.get("service_accounts")?.sort()).toEqual(["SELECT"]);

    // Phase 3: delivery targets + deliveries
    expect(privMap.get("audit_delivery_targets")?.sort()).toEqual(["SELECT", "UPDATE"]);
    expect(privMap.get("audit_deliveries")?.sort()).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);

    // Phase 4: chain anchors
    expect(privMap.get("audit_chain_anchors")?.sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);

    // Verify no unexpected tables
    const allowedTables = new Set([
      "audit_outbox", "audit_logs", "tenants",
      "users", "teams", "service_accounts",
      "audit_delivery_targets", "audit_deliveries",
      "audit_chain_anchors",
    ]);
    for (const tableName of privMap.keys()) {
      expect(allowedTables.has(tableName), `Unexpected grant on table: ${tableName}`).toBe(true);
    }
    expect(privMap.size).toBe(allowedTables.size);
  });

  it("cannot INSERT into password_entries table", async () => {
    await expect(
      ctx.worker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRawUnsafe(
          `INSERT INTO password_entries (id, tenant_id, user_id, encrypted_blob, encrypted_overview, blob_iv, blob_auth_tag, overview_iv, overview_auth_tag, key_version, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, gen_random_uuid(), '', '', '', '', '', '', 1, now(), now())`,
          tenantId,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot INSERT into users table", async () => {
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
