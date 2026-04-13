/**
 * Tests RLS enforcement on audit_chain_anchors.
 * (a) passwd_app without bypass GUC cannot see cross-tenant anchor rows.
 * (b) passwd_user (table owner) with FORCE RLS also cannot bypass without GUC.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";

describe("audit-chain RLS enforcement", () => {
  let ctx: TestContext;
  let tenantIdA: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantIdA = await ctx.createTenant();

    // Enable chain and insert an anchor row for tenant A
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_chain_enabled = true WHERE id = $1::uuid`,
        tenantIdA,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
         VALUES ($1::uuid, 5, '\\xdeadbeef'::bytea, now())
         ON CONFLICT (tenant_id) DO NOTHING`,
        tenantIdA,
      );
    });
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantIdA);
  });

  it("passwd_app without bypass GUC cannot SELECT cross-tenant anchor row", async () => {
    // Set tenant_id GUC to a different UUID (not tenantIdA)
    const differentTenantId = "00000000-0000-0000-0000-000000000001";

    const rows = await ctx.app.prisma.$transaction(async (tx) => {
      // Set app.tenant_id to a different tenant — NOT bypass
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${differentTenantId}, true)`;
      return tx.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantIdA,
      );
    });

    expect(rows).toHaveLength(0);
  });

  it("passwd_app with matching tenant_id GUC CAN see own anchor row", async () => {
    const rows = await ctx.app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantIdA}, true)`;
      return tx.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantIdA,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenantIdA);
  });

  it("passwd_user (table owner) without bypass GUC cannot see cross-tenant anchor (FORCE RLS)", async () => {
    // passwd_user has FORCE ROW LEVEL SECURITY, so even the table owner
    // cannot bypass RLS without the app.bypass_rls GUC
    const differentTenantId = "00000000-0000-0000-0000-000000000002";

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      // Explicitly set tenant_id to a different tenant — do NOT set bypass_rls
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${differentTenantId}, true)`;
      return tx.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantIdA,
      );
    });

    expect(rows).toHaveLength(0);
  });

  it("passwd_app cannot UPDATE cross-tenant anchor row", async () => {
    const differentTenantId = "00000000-0000-0000-0000-000000000001";

    // Attempt to update a cross-tenant anchor (should affect 0 rows due to RLS)
    await ctx.app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${differentTenantId}, true)`;
      await tx.$executeRawUnsafe(
        `UPDATE audit_chain_anchors SET chain_seq = 999 WHERE tenant_id = $1::uuid`,
        tenantIdA,
      );
    });

    // Verify anchor was NOT modified
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint }[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantIdA,
      );
    });

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].chain_seq)).toBe(5);
  });
});
