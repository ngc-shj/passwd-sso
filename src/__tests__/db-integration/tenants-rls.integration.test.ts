/**
 * Real-DB integration tests for RLS on `tenants` itself (C1 / C4 / C5).
 *
 * `tenants` now carries ENABLE + FORCE RLS and the policy
 * `tenants_tenant_isolation`: `(SELECT rls_bypass_admits('tenants')) OR
 * id = (SELECT current_setting('app.tenant_id', true)::uuid)`
 * (prisma/migrations/20261022000000_tenants_rls). These cells pin the policy's
 * effect on `passwd_app` directly — a bare read with no scope, a tenant-scoped
 * read/write, and a bypass with and without a grant naming `tenant` — the same
 * shape rls-bypass-grants.integration.test.ts pins for `users`.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  assertRlsApplies,
  appConnectionString,
  expectBypassNotices,
  setBypassRlsGucs,
  sqlStateOf,
  type TestContext,
} from "./helpers";
import { defineGrant, setBypassGucs, setTenantGucs, BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";
import { createClient, createPool } from "@/lib/db/pool-factory";
import { NIL_UUID } from "@/lib/constants/app";
import { enqueueAuditInTx, type AuditOutboxPayload } from "@/lib/audit/audit-outbox-in-tx";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants/audit/audit";

const SAMPLE_PAYLOAD: AuditOutboxPayload = {
  scope: AUDIT_SCOPE.PERSONAL,
  action: AUDIT_ACTION.AUTH_LOGIN,
  userId: "tenants-rls-test",
  actorType: "SYSTEM",
  serviceAccountId: null,
  teamId: null,
  targetType: null,
  targetId: null,
  metadata: null,
  ip: null,
  userAgent: null,
};

describe("tenants RLS (C1 / C4 / C5)", () => {
  let ctx: TestContext;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertRlsApplies(ctx.app.prisma);
    tenantA = await ctx.createTenant();
    tenantB = await ctx.createTenant();
  });

  afterAll(async () => {
    await ctx.deleteTestData(tenantA);
    await ctx.deleteTestData(tenantB);
    await ctx.cleanup();
  });

  /** The connected principal, asserted before every bare-client cell below. */
  async function assertConnectedAsApp(client: { query: (sql: string) => Promise<{ rows: Array<{ who: string; is_super: boolean }> }> }): Promise<void> {
    const { rows } = await client.query(
      `SELECT current_user AS who, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super`,
    );
    expect(rows[0].who, "this file proves RLS, so it must run as passwd_app").toBe("passwd_app");
    expect(rows[0].is_super, "a superuser bypasses RLS outright").toBe(false);
  }

  describe("(a) a fresh connection with no scope", () => {
    it("(a1) a bare read sees neither tenant", async () => {
      const client = createClient({ connectionString: appConnectionString() });
      await client.connect();
      try {
        await assertConnectedAsApp(client);
        const { rows } = await client.query(
          `SELECT id FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
          [tenantA, tenantB],
        );
        expect(rows).toEqual([]);
      } finally {
        await client.end().catch(() => {});
      }
    });

    it("(a2) once a transaction on this connection has touched app.tenant_id, a later bare read raises 22P02", async () => {
      // A transaction-local custom GUC reverts to '' (not NULL) on its
      // connection once touched — the same mechanism
      // rls-bypass-grants.integration.test.ts pins for `users`. max: 1 pins
      // both statements to the SAME backend connection.
      const pool = createPool({ connectionString: appConnectionString(), max: 1 });
      try {
        const client = await pool.connect();
        try {
          await assertConnectedAsApp(client);
          await client.query("BEGIN");
          await client.query(
            "SELECT set_config('app.bypass_rls', 'on', true), set_config('app.bypass_purpose', 'system_maintenance', true), set_config('app.tenant_id', $1, true), set_config('app.bypass_tables', 'tenants', true)",
            [NIL_UUID],
          );
          await client.query(`SELECT id FROM tenants WHERE id = $1::uuid`, [tenantA]);
          await client.query("COMMIT");

          let caught: { code?: string } | undefined;
          try {
            await client.query(`SELECT id FROM tenants WHERE id = $1::uuid`, [tenantA]);
          } catch (e) {
            caught = e as { code?: string };
          }
          expect(caught?.code).toBe("22P02");
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    });
  });

  it("(b) a tenant-scoped read sees exactly its own row", async () => {
    const rows = await ctx.app.prisma.$transaction(async (tx) => {
      await setTenantGucs(tx, tenantA);
      return tx.tenant.findMany({
        where: { id: { in: [tenantA, tenantB] } },
        select: { id: true },
      });
    });
    expect(rows).toEqual([{ id: tenantA }]);
  });

  it("(c1) a tenant-scoped UPDATE targeting another tenant's row touches nothing", async () => {
    const before = await ctx.su.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantB },
      select: { name: true },
    });

    const updated = await ctx.app.prisma.$transaction(async (tx) => {
      await setTenantGucs(tx, tenantA);
      return tx.tenant.updateMany({
        where: { id: tenantB },
        data: { name: "changed by (c1), should not land" },
      });
    });
    expect(updated.count).toBe(0);

    const after = await ctx.su.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantB },
      select: { name: true },
    });
    expect(after.name).toBe(before.name);
  });

  it("(c2) a tenant-scoped INSERT of a fresh id is refused with 42501 exactly", async () => {
    const freshId = randomUUID();
    let caught: unknown;
    try {
      await ctx.app.prisma.$transaction(async (tx) => {
        await setTenantGucs(tx, tenantA);
        await tx.$executeRawUnsafe(
          `INSERT INTO tenants (id, name, slug, created_at, updated_at)
           VALUES ($1::uuid, 'c2 insert', $2, now(), now())`,
          freshId,
          `c2-${freshId.slice(0, 8)}`,
        );
      });
    } catch (e) {
      caught = e;
    }
    // Pinned exactly: a widened WITH CHECK (e.g. `true`) lets this succeed
    // and the cell goes red, rather than merely "some error happened".
    expect(sqlStateOf(caught)).toBe("42501");

    const rows = await ctx.su.prisma.tenant.findMany({ where: { id: freshId } });
    expect(rows).toEqual([]);
  });

  it("(c2) a tenant-scoped UPDATE that changes its own id is refused with 42501 exactly", async () => {
    // A childless tenant, visible under USING (scope C sees its own row) but
    // refused under WITH CHECK (the new row's id no longer equals
    // app.tenant_id) — distinct from (c1), which denies via USING instead.
    const tenantC = await ctx.createTenant();
    const freshId = randomUUID();
    let caught: unknown;
    try {
      await ctx.app.prisma.$transaction(async (tx) => {
        await setTenantGucs(tx, tenantC);
        await tx.$executeRawUnsafe(
          `UPDATE tenants SET id = $1::uuid WHERE id = $2::uuid`,
          freshId,
          tenantC,
        );
      });
    } catch (e) {
      caught = e;
    }
    expect(sqlStateOf(caught)).toBe("42501");

    const stillThere = await ctx.su.prisma.tenant.findUnique({ where: { id: tenantC } });
    expect(stillThere).not.toBeNull();

    await ctx.deleteTestData(tenantC);
  });

  it("(d) a bypass grant naming `tenant` admits both tenants with no report", async () => {
    const grant = defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["tenant"]);
    let rows: Array<{ id: string }> = [];
    const notices = await expectBypassNotices(async () => {
      rows = await ctx.app.prisma.$transaction(async (tx) => {
        await setBypassGucs(tx, grant);
        return tx.tenant.findMany({
          where: { id: { in: [tenantA, tenantB] } },
          select: { id: true },
        });
      });
    });
    expect(rows.map((r) => r.id).sort()).toEqual([tenantA, tenantB].sort());
    expect(notices).toEqual([]);
  });

  it("(e) a bypass grant not naming `tenant` still admits both tenants, but reports exactly one notice", async () => {
    const grant = defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["user"]);
    let rows: Array<{ id: string }> = [];
    const notices = await expectBypassNotices(async () => {
      rows = await ctx.app.prisma.$transaction(async (tx) => {
        await setBypassGucs(tx, grant);
        return tx.tenant.findMany({
          where: { id: { in: [tenantA, tenantB] } },
          select: { id: true },
        });
      });
    });
    expect(rows.map((r) => r.id).sort()).toEqual([tenantA, tenantB].sort());
    // The policy's bypass branch is an uncorrelated sub-SELECT
    // ([E-RLS-TENANT-INITPLAN]), hoisted to one evaluation per statement —
    // one notice, not one per row scanned.
    expect(notices).toEqual([{ table: "tenants", purpose: "system_maintenance" }]);
  });

  describe("C4: enqueueAuditInTx drops its own tenants probe", () => {
    it("enqueues for an existing tenant with no report", async () => {
      const notices = await expectBypassNotices(async () => {
        await ctx.app.prisma.$transaction(async (tx) => {
          await setBypassGucs(tx, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
          await enqueueAuditInTx(tx, tenantA, SAMPLE_PAYLOAD);
        });
      });
      expect(notices).toEqual([]);

      const rows = await ctx.su.prisma.auditOutbox.findMany({ where: { tenantId: tenantA } });
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects an unknown tenant id (FK, not a probe) and writes no row", async () => {
      const unknownTenantId = randomUUID();
      let caught: unknown;
      try {
        await ctx.app.prisma.$transaction(async (tx) => {
          await setBypassGucs(tx, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
          await enqueueAuditInTx(tx, unknownTenantId, SAMPLE_PAYLOAD);
        });
      } catch (e) {
        caught = e;
      }
      // foreign_key_violation: audit_outbox_tenant_id_fkey, checked at the
      // INSERT now that the probe is gone (C4).
      expect(sqlStateOf(caught)).toBe("23503");

      const rows = await ctx.su.prisma.auditOutbox.findMany({ where: { tenantId: unknownTenantId } });
      expect(rows).toEqual([]);
    });
  });

  describe("C5: the bootstrap trigger's own INSERT INTO tenants is refused first", () => {
    it("INSERT INTO users with NULL tenant_id and no context fails naming `tenants`, not `users`; no tenants row leaks", async () => {
      const [{ count: before }] = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT COUNT(*) AS count FROM tenants`);
      });

      const client = createClient({ connectionString: appConnectionString() });
      await client.connect();
      let caught: { code?: string; message?: string } | undefined;
      try {
        await assertConnectedAsApp(client);

        const userId = randomUUID();
        try {
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO users (id, tenant_id, email, name, created_at, updated_at)
             VALUES ($1::uuid, NULL, $2, $3, now(), now())`,
            [userId, `c5-${userId.slice(0, 8)}@example.com`, "C5 test user"],
          );
          await client.query("ROLLBACK");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          caught = e as { code?: string; message?: string };
        }
      } finally {
        await client.end().catch(() => {});
      }

      expect(caught?.code, "the bootstrap trigger's own INSERT INTO tenants is what now fails").toBe("42501");
      expect(caught?.message).toMatch(/tenants/);

      const [{ count: after }] = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT COUNT(*) AS count FROM tenants`);
      });
      expect(Number(after)).toBe(Number(before));
    });
  });
});
