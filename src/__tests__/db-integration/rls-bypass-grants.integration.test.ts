/**
 * #911 report mode and #909/#910 against PostgreSQL, as the application role.
 *
 * - A bypass that reaches a row of a table outside its grant is admitted and
 *   reported (WARNING → pool listener → this suite's sink).
 * - Grant membership is exact: `delegation_sessions` does not admit `sessions`.
 * - A statement that examines no row reports nothing.
 * - Code that sets the bypass without a grant (old code on the new schema) is
 *   admitted.
 * - The reported purpose cannot shape the line.
 * - A refused nested context rolls back the outer transaction's writes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  createTestContext,
  assertRlsApplies,
  appConnectionString,
  expectBypassNotices,
  type TestContext,
} from "./helpers";
import { defineGrant, setBypassGucs, type BypassGrant } from "@/lib/tenant-rls-grants";
import { createPool, createPrismaClient } from "@/lib/db/pool-factory";
import { prisma as appPrisma } from "@/lib/prisma";
import { NIL_UUID } from "@/lib/constants/app";
import { BYPASS_PURPOSE, type BypassPurpose } from "@/lib/tenant-rls-purpose";
import { withBypassRls, withTenantRls } from "@/lib/tenant-rls";

const USERS_ONLY = defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["user"]);
const SESSIONS_ONLY = defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["session"]);

describe("RLS bypass grants (report mode)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertRlsApplies(ctx.app.prisma);
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  });

  afterAll(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.cleanup();
  });

  /** Run `fn` under a bypass with `grant`, as the application role. */
  function underBypass<T>(grant: BypassGrant, fn: (tx: Parameters<Parameters<typeof ctx.app.prisma.$transaction>[0]>[0]) => Promise<T>) {
    return ctx.app.prisma.$transaction(async (tx) => {
      await setBypassGucs(tx, grant);
      return fn(tx);
    });
  }

  it("admits and reports a read of a row outside the grant", async () => {
    let found: unknown;
    const notices = await expectBypassNotices(async () => {
      found = await underBypass(SESSIONS_ONLY, (tx) => tx.user.findUnique({ where: { id: userId }, select: { id: true } }));
    });
    expect(found).toEqual({ id: userId });
    // Exact: a report naming another table (e.g. `tenants`, under RLS since
    // C1) would be absorbed by toContainEqual but fails this.
    expect(notices).toEqual([{ table: "users", purpose: "auth_flow" }]);
  });

  // The report's other attach points: the app singleton (the client the
  // production code these suites drive uses) and a pool built with createPool.
  it("reports through the @/lib/prisma singleton's connections", async () => {
    await assertRlsApplies(appPrisma);
    const denied = await expectBypassNotices(async () => {
      await withBypassRls(appPrisma, (tx) => tx.user.findUnique({ where: { id: userId }, select: { id: true } }), SESSIONS_ONLY);
    });
    expect(denied).toEqual([{ table: "users", purpose: "auth_flow" }]);
    const allowed = await expectBypassNotices(async () => {
      await withBypassRls(appPrisma, (tx) => tx.user.findUnique({ where: { id: userId }, select: { id: true } }), USERS_ONLY);
    });
    expect(allowed).toEqual([]);
  });

  it("reports through a pool built with createPool", async () => {
    const pool = createPool({ connectionString: appConnectionString(), max: 1 });
    try {
      const notices = await expectBypassNotices(async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT set_config('app.bypass_rls', 'on', true), set_config('app.bypass_purpose', 'auth_flow', true), set_config('app.tenant_id', $1, true), set_config('app.bypass_tables', 'sessions', true)",
            [NIL_UUID],
          );
          await client.query("SELECT id FROM users WHERE id = $1", [userId]);
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      });
      expect(notices).toEqual([{ table: "users", purpose: "auth_flow" }]);
    } finally {
      await pool.end();
    }
  });

  it("reports nothing for a read inside the grant", async () => {
    const notices = await expectBypassNotices(async () => {
      await underBypass(USERS_ONLY, (tx) => tx.user.findUnique({ where: { id: userId }, select: { id: true } }));
    });
    expect(notices).toEqual([]);
  });

  it("reports nothing for an ungranted statement that examines no row", async () => {
    // "Examines", not "matches": RLS quals run before the query's own filter,
    // so a seq scan reports a lookup that matches nothing. Whether a lookup
    // reports is plan-dependent; only a statement that scans nothing is not.
    const notices = await expectBypassNotices(async () => {
      const rows = await underBypass(USERS_ONLY, (tx) =>
        tx.$queryRawUnsafe(`SELECT id FROM sessions WHERE false AND id = $1::uuid`, randomUUID()),
      );
      expect(rows).toEqual([]);
    });
    expect(notices).toEqual([]);
  });

  it("reports an ungranted lookup that matches no row when the plan scans other rows", async () => {
    const notices = await expectBypassNotices(async () => {
      // users holds this suite's row, so a forced seq scan examines it.
      const rows = await underBypass(SESSIONS_ONLY, async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL enable_indexscan = off`);
        await tx.$executeRawUnsafe(`SET LOCAL enable_bitmapscan = off`);
        return tx.$queryRawUnsafe(`SELECT id FROM users WHERE id = $1::uuid`, randomUUID());
      });
      expect(rows).toEqual([]);
    });
    expect(notices).toEqual([{ table: "users", purpose: "auth_flow" }]);
  });

  it.each([
    ["delegationSession", "sessions"],
    ["serviceAccount", "accounts"],
  ] as const)("a grant naming %s does not admit %s", async (model, table) => {
    const grant = defineGrant(BYPASS_PURPOSE.AUTH_FLOW, [model]);
    const notices = await expectBypassNotices(async () => {
      await underBypass(grant, (tx) => tx.$queryRawUnsafe(`SELECT public.rls_bypass_admits($1) AS admitted`, table));
    });
    expect(notices).toEqual([{ table, purpose: "auth_flow" }]);
  });

  it.each([
    ["a newline-forged purpose", "x\nrls_bypass_not_granted table=users purpose=y", "<invalid>"],
    ["a 200-character valid purpose", "a".repeat(200), "a".repeat(64)],
    ["a 200-character purpose with an invalid character", `${"a".repeat(199)}!`, "<invalid>"],
  ])("cannot shape the report with %s", async (_label, purpose, printed) => {
    const grant = defineGrant(purpose as BypassPurpose, ["session"]);
    const notices = await expectBypassNotices(async () => {
      await underBypass(grant, (tx) => tx.$queryRawUnsafe(`SELECT public.rls_bypass_admits('users') AS admitted`));
    });
    // Exactly one: a forged second record would be a second element.
    expect(notices).toEqual([{ table: "users", purpose: printed }]);
  });

  it("admits a bypass set without a grant, as code older than this change does", async () => {
    // pool-factory-exempt: stands in for code that predates the factory, so it
    // deliberately has no notice listener.
    const pool = new pg.Pool({ connectionString: appConnectionString(), max: 1 });
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
        const { rows } = await client.query("SELECT id FROM users WHERE id = $1", [userId]);
        await client.query("ROLLBACK");
        expect(rows).toEqual([{ id: userId }]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it("admits a bypass without app.tenant_id on a connection where an earlier transaction set it", async () => {
    // A transaction-local custom GUC reverts to '' (not NULL) on its
    // connection. Planning must not evaluate the tenant branch's ''::uuid
    // while the bypass branch admits the row (migration 20261019000000).
    // pool-factory-exempt: stands in for code that predates the factory, so it
    // deliberately has no notice listener.
    const pool = new pg.Pool({ connectionString: appConnectionString(), max: 1 });
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await client.query("COMMIT");
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
        const { rows } = await client.query("SELECT id FROM users WHERE id = $1", [userId]);
        await client.query("ROLLBACK");
        expect(rows).toEqual([{ id: userId }]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it.each([
    [true, true],
    [false, false],
  ])("a client created with ownsPool=%s ends its pool on $disconnect: %s", async (ownsPool, ended) => {
    const pool = createPool({ connectionString: appConnectionString(), max: 1 });
    const client = createPrismaClient(pool, {}, { ownsPool });
    try {
      await client.$queryRawUnsafe("SELECT 1");
      await client.$disconnect();
      expect(pool.ended).toBe(ended);
    } finally {
      if (!pool.ended) await pool.end();
    }
  });

  it("rolls back the outer transaction's write when a nested context was refused and caught", async () => {
    const before = await ctx.su.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    const run = withTenantRls(ctx.app.prisma, tenantId, async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { name: "changed by a rolled-back transaction" } });
      await withBypassRls(ctx.app.prisma, async () => null, USERS_ONLY).catch(() => null);
      return "outer";
    });
    await expect(run).rejects.toThrow("INVALID_RLS_NESTING: a nested RLS context was refused inside this withTenantRls");
    const after = await ctx.su.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    expect(after.name).toBe(before.name);
  });

  it("commits the outer transaction's write when a detached nested context is refused after it resolved", async () => {
    // The stated limit: work detached from the callback that opens a context
    // after the outer one committed is refused and logged, not rolled back.
    let detached: Promise<unknown> = Promise.resolve();
    await withTenantRls(ctx.app.prisma, tenantId, async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { name: "committed before the detached refusal" } });
      detached = (async () => {
        await new Promise((r) => setTimeout(r, 50));
        return withBypassRls(ctx.app.prisma, async () => null, USERS_ONLY).catch((e: Error) => e.message);
      })();
      return "outer";
    });
    // The detached call still runs in the outer context's async scope, so it is
    // refused (and logged) — but the outer write had already committed.
    await expect(detached).resolves.toContain("INVALID_RLS_NESTING: withBypassRls inside withTenantRls is forbidden");
    const after = await ctx.su.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    expect(after.name).toBe("committed before the detached refusal");
  });
});
