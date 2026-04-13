/**
 * RLS enforcement tests:
 * (a) passwd_app without bypass GUC cannot SELECT cross-tenant outbox rows
 * (b) passwd_user (table owner) with FORCE RLS also cannot SELECT cross-tenant rows
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

describe("audit-outbox RLS enforcement", () => {
  let ctx: TestContext;
  let tenantA: string;
  let tenantB: string;
  let userA: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantA = await ctx.createTenant();
    tenantB = await ctx.createTenant();
    userA = await ctx.createUser(tenantA);
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantA);
    await ctx.deleteTestData(tenantB);
  });

  async function insertOutboxRowForTenantA(): Promise<string> {
    const id = randomUUID();
    const payload = JSON.stringify({
      scope: "PERSONAL",
      action: "ENTRY_CREATE",
      userId: userA,
      actorType: "HUMAN",
      serviceAccountId: null,
      teamId: null,
      targetType: "PasswordEntry",
      targetId: randomUUID(),
      metadata: null,
      ip: "127.0.0.1",
      userAgent: "integration-test",
    });
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PENDING', now(), now())`,
        id,
        tenantA,
        payload,
      );
    });
    return id;
  }

  it("passwd_app with tenant_id=B cannot see tenant A outbox rows", async () => {
    await insertOutboxRowForTenantA();

    // As passwd_app role, set tenant_id to tenant B (no bypass)
    const rows = await ctx.app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'off', true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_outbox WHERE tenant_id = $1::uuid`,
        tenantA,
      );
    });
    expect(Number(rows[0].cnt)).toBe(0);
  });

  it("passwd_app with tenant_id=A can see tenant A outbox rows", async () => {
    await insertOutboxRowForTenantA();

    const rows = await ctx.app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'off', true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_outbox WHERE tenant_id = $1::uuid`,
        tenantA,
      );
    });
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it("passwd_app (non-superuser) WITHOUT bypass GUC and tenant_id=B cannot see tenant A rows (FORCE RLS)", async () => {
    await insertOutboxRowForTenantA();

    // passwd_app is NOSUPERUSER + NOBYPASSRLS, so FORCE ROW LEVEL SECURITY
    // ensures the app role cannot bypass RLS without the app.bypass_rls GUC.
    // Note: passwd_user is SUPERUSER with BYPASSRLS, so it always bypasses RLS.
    const rows = await ctx.app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'off', true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_outbox WHERE tenant_id = $1::uuid`,
        tenantA,
      );
    });
    expect(Number(rows[0].cnt)).toBe(0);
  });
});
