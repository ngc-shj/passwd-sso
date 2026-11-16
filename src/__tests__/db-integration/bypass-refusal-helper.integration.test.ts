/**
 * expectBypassRefusal's own cells: it must fail when the statement it wraps is
 * not refused, or is refused for another reason, or a refusal cell would pass
 * on a statement the database admitted.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  createTestContext,
  assertRlsApplies,
  appConnectionString,
  expectBypassRefusal,
  expectSwallowedBypassRefusal,
  type TestContext,
} from "./helpers";
import { failOnReports, recordBypassNotice } from "./bypass-notice-sink";
import { BYPASS_REPORT_KIND, createPool } from "@/lib/db/pool-factory";
import { NIL_UUID } from "@/lib/constants/app";
import { defineGrant, setBypassGucs } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";

// Not `users`. Two tables, because (auth_flow, sessions) alone is
// BYPASS_GRANT.AUTH_SESSION_LIFECYCLE's pair, and a test-local grant must not
// credit a member with evidence (integration-test-grants-no-collision).
const SESSIONS_AND_ACCOUNTS = defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["session", "account"]);
const USERS_ONLY = defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["user"]);

describe("expectBypassRefusal", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertRlsApplies(ctx.app.prisma);
    tenantId = await ctx.createTenant();
    await ctx.createUser(tenantId);
  });

  afterAll(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.cleanup();
  });

  const readUsersUnder = (grant: typeof USERS_ONLY) =>
    ctx.app.prisma.$transaction(async (tx) => {
      await setBypassGucs(tx, grant);
      return tx.user.findFirst({ select: { id: true } });
    });

  it("returns the reports and the table of a refused statement", async () => {
    const { notices, refusals, table, error } = await expectBypassRefusal(() => readUsersUnder(SESSIONS_AND_ACCOUNTS));
    expect(table).toBe("users");
    expect(notices).toEqual([{ table: "users", purpose: "auth_flow" }]);
    expect(refusals).toEqual([{ table: "users", purpose: "auth_flow" }]);
    expect(error).toBeInstanceOf(Error);
  });

  it("throws when the statement resolves", async () => {
    await expect(expectBypassRefusal(() => readUsersUnder(USERS_ONLY))).rejects.toThrow(
      "but the statement succeeded",
    );
  });

  it("throws when the statement rejects with another SQLSTATE", async () => {
    await expect(
      expectBypassRefusal(() => ctx.app.prisma.$queryRawUnsafe(`SELECT 1 FROM no_such_table_for_refusal_helper`)),
    ).rejects.toThrow(/expected a 42501 RLS_BYPASS_NOT_GRANTED refusal, got SQLSTATE 42P01/);
  });

  it("throws on a 42501 that is not the bypass refusal", async () => {
    await expect(
      expectBypassRefusal(() => ctx.app.prisma.$queryRawUnsafe(`SELECT rolpassword FROM pg_authid`)),
    ).rejects.toThrow(/got SQLSTATE 42501/);
  });

  /** Open a bypass granting `sessions` only on `client`, then read `users` as the transaction's last statement. */
  const refuseUsersRead = async (client: pg.PoolClient) => {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.bypass_rls', 'on', true), set_config('app.bypass_purpose', 'auth_flow', true), set_config('app.tenant_id', $1, true), set_config('app.bypass_tables', 'sessions', true)",
      [NIL_UUID],
    );
    return client.query("SELECT id FROM users LIMIT 1");
  };

  async function onConnection(build: () => pg.Pool, fn: (client: pg.PoolClient) => Promise<void>): Promise<void> {
    const pool = build();
    try {
      const client = await pool.connect();
      try {
        await fn(client);
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    } finally {
      await pool.end();
    }
  }

  // pool-factory-exempt: stands in for a connection with no refusal listener.
  const rawPool = () => new pg.Pool({ connectionString: appConnectionString(), max: 1 });
  const factoryPool = () => createPool({ connectionString: appConnectionString(), max: 1 });

  it("throws when the refusal was not counted, on a connection outside pool-factory", async () => {
    await onConnection(rawPool, async (client) => {
      await expect(expectBypassRefusal(() => refuseUsersRead(client))).rejects.toThrow(
        /the refusal on users was not counted/,
      );
    });
  });

  it("passes with counted: false on a connection outside pool-factory", async () => {
    await onConnection(rawPool, async (client) => {
      const { table, refusals } = await expectBypassRefusal(() => refuseUsersRead(client), { counted: false });
      expect(table).toBe("users");
      expect(refusals).toEqual([]);
    });
  });

  it("throws with counted: false when the refusal was counted", async () => {
    await onConnection(factoryPool, async (client) => {
      await expect(expectBypassRefusal(() => refuseUsersRead(client), { counted: false })).rejects.toThrow(
        /expected no refusal to be counted/,
      );
    });
  });

  it("expectSwallowedBypassRefusal throws when the statement rejects", async () => {
    await expect(expectSwallowedBypassRefusal(() => readUsersUnder(SESSIONS_AND_ACCOUNTS))).rejects.toThrow(
      /RLS_BYPASS_NOT_GRANTED: users/,
    );
  });

  it("expectSwallowedBypassRefusal throws when the statement resolves after a granted statement", async () => {
    await expect(expectSwallowedBypassRefusal(() => readUsersUnder(USERS_ONLY))).rejects.toThrow(
      /no rls\.bypass_refused report reached the sink/,
    );
  });

  it("failOnReports fails on a refusal no cell took, and drains it", () => {
    recordBypassNotice({ kind: BYPASS_REPORT_KIND.REFUSAL, table: "users", purpose: "auth_flow" });
    expect(() => failOnReports("in this cell")).toThrow(/refusals were counted in this cell and not taken: users \(purpose auth_flow\)/);
    expect(() => failOnReports("in this cell")).not.toThrow();
  });
});
