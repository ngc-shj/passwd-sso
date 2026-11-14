/**
 * #922: the SECURITY DEFINER audit functions check the CALLER's RLS bypass
 * grant before touching audit_logs, as the application role.
 *
 * - Outside a bypass: refused (42501, AUDIT_DEFINER_REQUIRES_BYPASS).
 * - Bypass with a grant naming audit_logs: runs, no report.
 * - Bypass with a grant that does not name audit_logs: refused (42501,
 *   RLS_BYPASS_NOT_GRANTED) and reported.
 *
 * The last describe runs the same bodies as an owner that RLS applies to, which
 * is what the migration role is on RDS (E2); the cells above run as a dev/CI
 * superuser owner.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  createTestContext,
  assertRlsApplies,
  expectBypassNotices,
  expectBypassRefusal,
  superuserConnectionString,
  type TestContext,
} from "./helpers";
import { createProbeRole, type ProbeRole } from "./rds-probe-role";
import { NIL_UUID } from "@/lib/constants/app";
import { defineGrant, setBypassGucs, type BypassGrant } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";

const AUDIT_LOGS = defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["auditLog"]);
const USERS_ONLY = defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["user"]);
const LONG_AGO = "2000-01-01T00:00:00Z";
// The purge deletes rows strictly older than its cutoff.
const AFTER_SEED = "2001-01-01T00:00:00Z";

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

  // The body of each routine touches only audit_logs, which the routine's own
  // guard (rls_bypass_admits) already checks before the body runs: the refusal
  // under a grant without audit_logs is that guard's, covered above. What an
  // RLS-subject owner adds is the allow arm: the body's DELETE / UPDATE must
  // find the rows through the caller's grant, with no exemption of its own.
  describe("with the routine's owner swapped to an owner-shaped NOBYPASSRLS role", () => {
    let probe: ProbeRole;

    beforeAll(async () => {
      probe = await createProbeRole();
    });

    afterAll(async () => {
      await probe.drop();
    });

    const ROUTINES = [
      {
        name: "audit_log_purge",
        alter: (owner: string) => `ALTER FUNCTION public.audit_log_purge(uuid, timestamptz) OWNER TO "${owner}"`,
        signature: "public.audit_log_purge(uuid, timestamptz)",
        call: (c: Client) => c.query(`SELECT audit_log_purge($1::uuid, $2::timestamptz)`, [tenantId, AFTER_SEED]),
        // Deleted by the purge.
        expectWritten: (rows: Array<{ tenant_id: string }>) => expect(rows).toEqual([]),
      },
      {
        name: "audit_log_tenant_migrate",
        alter: (owner: string) =>
          `ALTER PROCEDURE public.audit_log_tenant_migrate(uuid, uuid, uuid) OWNER TO "${owner}"`,
        signature: "public.audit_log_tenant_migrate(uuid, uuid, uuid)",
        call: (c: Client) =>
          c.query(`CALL audit_log_tenant_migrate($1::uuid, $2::uuid, $3::uuid)`, [userId, tenantId, otherTenantId]),
        // Moved to the other tenant.
        expectWritten: (rows: Array<{ tenant_id: string }>) => expect(rows).toEqual([{ tenant_id: otherTenantId }]),
      },
    ];

    it.each(ROUTINES)("$name writes through the caller's grant as an RLS-subject owner", async (routine) => {
      const marker = randomUUID();
      await ctx.su.prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs (id, tenant_id, scope, action, actor_type, user_id, metadata, created_at)
         VALUES ($1::uuid, $2::uuid, 'PERSONAL', 'AUTH_LOGIN', 'SYSTEM', $3::uuid, '{}'::jsonb, $4::timestamptz)`,
        marker, tenantId, userId, LONG_AGO,
      );
      const c = new Client({ connectionString: superuserConnectionString() });
      await c.connect();
      try {
        const { rows: [before] } = await c.query<{ owner: string }>(
          `SELECT proowner::regrole::text AS owner FROM pg_proc WHERE oid = $1::regprocedure`,
          [routine.signature],
        );
        // Short, and always rolled back: ALTER ... OWNER takes strong locks.
        await c.query("BEGIN");
        try {
          await c.query(routine.alter(probe.name));
          const { rows: [owned] } = await c.query<{ owner: string }>(
            `SELECT proowner::regrole::text AS owner FROM pg_proc WHERE oid = $1::regprocedure`,
            [routine.signature],
          );
          expect(owned.owner).toBe(probe.name);

          // Control: the owner is subject to RLS. Outside a bypass it sees no row the superuser sees.
          await c.query(`SET LOCAL ROLE "${probe.name}"`);
          const hidden = await c.query(`SELECT 1 FROM audit_logs WHERE id = $1::uuid`, [marker]);
          expect(hidden.rows).toEqual([]);
          await c.query("RESET ROLE");
          const visible = await c.query(`SELECT 1 FROM audit_logs WHERE id = $1::uuid`, [marker]);
          expect(visible.rows).toHaveLength(1);

          await c.query(`SET LOCAL ROLE passwd_app`);
          await c.query(
            `SELECT set_config('app.bypass_rls', 'on', true), set_config('app.bypass_purpose', $1, true),
                    set_config('app.tenant_id', $2, true), set_config('app.bypass_tables', $3, true)`,
            [AUDIT_LOGS.purpose, NIL_UUID, AUDIT_LOGS.tables],
          );
          await routine.call(c);
          await c.query("RESET ROLE");
          const { rows } = await c.query<{ tenant_id: string }>(`SELECT tenant_id FROM audit_logs WHERE id = $1::uuid`, [marker]);
          routine.expectWritten(rows);
        } finally {
          await c.query("ROLLBACK");
        }
        const { rows: [after] } = await c.query<{ owner: string }>(
          `SELECT proowner::regrole::text AS owner FROM pg_proc WHERE oid = $1::regprocedure`,
          [routine.signature],
        );
        expect(after.owner).toBe(before.owner);
      } finally {
        await c.end();
      }
      // The rollback undid the write too: the row is where the seed put it.
      const left = await ctx.su.prisma.$queryRawUnsafe<Array<{ tenant_id: string }>>(
        `SELECT tenant_id FROM audit_logs WHERE id = $1::uuid`,
        marker,
      );
      expect(left).toEqual([{ tenant_id: tenantId }]);
    });
  });
});
