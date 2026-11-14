/**
 * #922: the SECURITY DEFINER audit functions check the CALLER's RLS bypass
 * grant before touching audit_logs, as the application role.
 *
 * - Outside a bypass: refused (42501, AUDIT_DEFINER_REQUIRES_BYPASS).
 * - Bypass with a grant naming audit_logs: runs, no report.
 * - Bypass with a grant that does not name audit_logs: refused (42501,
 *   RLS_BYPASS_NOT_GRANTED) and reported.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, assertRlsApplies, expectBypassNotices, expectBypassRefusal, type TestContext } from "./helpers";
import { defineGrant, setBypassGucs, type BypassGrant } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";

const AUDIT_LOGS = defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["auditLog"]);
const USERS_ONLY = defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["user"]);
const LONG_AGO = "2000-01-01T00:00:00Z";

describe("SECURITY DEFINER audit functions check the caller's bypass grant (#922)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let otherTenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertRlsApplies(ctx.app.prisma);
    tenantId = await ctx.createTenant();
    otherTenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  });

  afterAll(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.deleteTestData(otherTenantId);
    await ctx.cleanup();
  });

  /** Run `sql` as the application role, under `grant` or outside any bypass. */
  function asApp(grant: BypassGrant | null, run: (tx: Parameters<Parameters<typeof ctx.app.prisma.$transaction>[0]>[0]) => Promise<unknown>) {
    return ctx.app.prisma.$transaction(async (tx) => {
      if (grant) await setBypassGucs(tx, grant);
      return run(tx);
    });
  }

  const purge = (tx: Parameters<Parameters<typeof ctx.app.prisma.$transaction>[0]>[0]) =>
    tx.$queryRawUnsafe(`SELECT audit_log_purge($1::uuid, $2::timestamptz) AS n`, tenantId, LONG_AGO);
  const migrate = (tx: Parameters<Parameters<typeof ctx.app.prisma.$transaction>[0]>[0]) =>
    tx.$executeRawUnsafe(`CALL audit_log_tenant_migrate($1::uuid, $2::uuid, $3::uuid)`, userId, tenantId, otherTenantId);

  it.each([
    ["audit_log_purge", purge],
    ["audit_log_tenant_migrate", migrate],
  ] as const)("refuses %s outside a bypass", async (name, call) => {
    await expect(asApp(null, call)).rejects.toThrow(`AUDIT_DEFINER_REQUIRES_BYPASS: ${name} must run under an RLS bypass`);
  });

  it.each([
    ["audit_log_purge", purge],
    ["audit_log_tenant_migrate", migrate],
  ] as const)("runs %s under a grant naming audit_logs, with no report", async (_name, call) => {
    const notices = await expectBypassNotices(async () => {
      await asApp(AUDIT_LOGS, call);
    });
    expect(notices).toEqual([]);
  });

  it.each([
    ["audit_log_purge", purge],
    ["audit_log_tenant_migrate", migrate],
  ] as const)("refuses %s under a grant without audit_logs, and reports it", async (_name, call) => {
    const marker = randomUUID();
    await ctx.su.prisma.$executeRawUnsafe(
      `INSERT INTO audit_logs (id, tenant_id, scope, action, actor_type, user_id, metadata, created_at)
       VALUES ($1::uuid, $2::uuid, 'PERSONAL', 'AUTH_LOGIN', 'SYSTEM', $3::uuid, '{}'::jsonb, $4::timestamptz)`,
      marker, tenantId, userId, LONG_AGO,
    );
    // The refused call is the transaction's only statement after the grant.
    const { notices, table } = await expectBypassRefusal(() => asApp(USERS_ONLY, call));
    expect(table).toBe("audit_logs");
    expect(notices).toEqual([{ table: "audit_logs", purpose: "system_maintenance" }]);
    // The transaction ended with the refusal: the row is neither deleted nor moved.
    const left = await ctx.su.prisma.$queryRawUnsafe<Array<{ tenant_id: string }>>(
      `SELECT tenant_id FROM audit_logs WHERE id = $1::uuid`,
      marker,
    );
    expect(left).toEqual([{ tenant_id: tenantId }]);
  });

  it("still deletes what the purge was asked to delete", async () => {
    // The guard sits in front of the work; it must not change what the work does.
    const marker = randomUUID();
    await ctx.su.prisma.$executeRawUnsafe(
      `INSERT INTO audit_logs (id, tenant_id, scope, action, actor_type, user_id, metadata, created_at)
       VALUES ($1::uuid, $2::uuid, 'PERSONAL', 'AUTH_LOGIN', 'SYSTEM', $3::uuid, '{}'::jsonb, $4::timestamptz)`,
      marker, tenantId, userId, LONG_AGO,
    );
    const rows = (await asApp(AUDIT_LOGS, (tx) =>
      tx.$queryRawUnsafe(`SELECT audit_log_purge($1::uuid, '2001-01-01'::timestamptz) AS n`, tenantId),
    )) as Array<{ n: number }>;
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(1);
    const left = await ctx.su.prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM audit_logs WHERE id = $1::uuid`, marker);
    expect(left).toEqual([]);
  });
});
