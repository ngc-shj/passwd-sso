/**
 * Privilege enumeration for passwd_outbox_worker role.
 * Asserts exact allowed privileges and confirms denied operations.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

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

    // Build a map of table -> sorted privileges
    const privMap = new Map<string, string[]>();
    for (const row of privs) {
      const existing = privMap.get(row.table_name) ?? [];
      existing.push(row.privilege_type);
      privMap.set(row.table_name, existing);
    }

    // Assert exact allowed set
    expect(privMap.get("audit_outbox")?.sort()).toEqual(
      ["DELETE", "SELECT", "UPDATE"].sort(),
    );
    expect(privMap.get("audit_logs")?.sort()).toEqual(["INSERT"]);
    expect(privMap.get("tenants")?.sort()).toEqual(["SELECT"]);

    // Worker should NOT have privileges on other tables
    // (only audit_outbox, audit_logs, tenants should appear)
    const allowedTables = new Set(["audit_outbox", "audit_logs", "tenants"]);
    for (const tableName of privMap.keys()) {
      expect(allowedTables.has(tableName)).toBe(true);
    }
  });

  it("cannot SELECT from users table", async () => {
    await expect(
      ctx.worker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.$queryRawUnsafe(`SELECT id FROM users LIMIT 1`);
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot INSERT into password_entries table", async () => {
    await expect(
      ctx.worker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRawUnsafe(
          `INSERT INTO password_entries (id, tenant_id, user_id, encrypted_blob, encrypted_overview, iv, auth_tag, overview_iv, overview_auth_tag, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, gen_random_uuid(), '', '', '', '', '', '', now(), now())`,
          tenantId,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot call nextval() on sequences it does not own", async () => {
    // The worker should not be able to advance arbitrary sequences
    await expect(
      ctx.worker.prisma.$queryRawUnsafe(
        `SELECT nextval(pg_get_serial_sequence('tenants', 'id'))`,
      ),
    ).rejects.toThrow();
  });
});
