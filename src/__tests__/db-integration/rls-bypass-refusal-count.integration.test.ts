/**
 * #1048: a refused bypass is counted from the ErrorResponse on the pool's
 * connection, so it still counts when the WARNING before it never reaches the
 * client (`client_min_messages = error`) and when the caller swallows the 42501.
 *
 * Each cell checks out one client of a `createPool` pool and brackets its
 * statements in an explicit BEGIN … ROLLBACK, so no Prisma commit follows the
 * aborted transaction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import {
  createTestContext,
  assertRlsApplies,
  appConnectionString,
  expectSwallowedBypassRefusal,
  sqlStateOf,
  type TestContext,
} from "./helpers";
import { bypassNoticeBuffer, bypassRefusalBuffer } from "./bypass-notice-sink";
import { createPool } from "@/lib/db/pool-factory";
import { NIL_UUID } from "@/lib/constants/app";

describe("RLS bypass refusal count (enforcing)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertRlsApplies(ctx.app.prisma);
    tenantId = await ctx.createTenant();
    await ctx.createUser(tenantId);
    pool = createPool({ connectionString: appConnectionString(), max: 1 });
  });

  afterAll(async () => {
    await pool.end();
    await ctx.deleteTestData(tenantId);
    await ctx.cleanup();
  });

  /** Open a bypass whose grant covers `sessions` only, in the open transaction. */
  const openSessionsOnlyBypass = (client: pg.PoolClient) =>
    client.query(
      "SELECT set_config('app.bypass_rls', 'on', true), set_config('app.bypass_purpose', 'auth_flow', true), set_config('app.tenant_id', $1, true), set_config('app.bypass_tables', 'sessions', true)",
      [NIL_UUID],
    );

  /** Run a statement the caller swallows after checking it was the 42501 refusal. */
  const swallowRefusal = async (client: pg.PoolClient, sql: string) => {
    try {
      await client.query(sql);
    } catch (error) {
      expect(sqlStateOf(error)).toBe("42501");
    }
  };

  async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  const showMinMessages = async (client: pg.PoolClient) =>
    (await client.query<{ client_min_messages: string }>("SHOW client_min_messages")).rows[0].client_min_messages;

  it("counts a swallowed refusal when client_min_messages hides the WARNING", async () => {
    await withClient(async (client) => {
      const baseline = await showMinMessages(client);
      // A session/LOCAL value stands in for a role- or database-level one: it is
      // the same GUC, applied when each message is sent to the client.
      const { warnings, refusals } = await expectSwallowedBypassRefusal(async () => {
        await client.query("BEGIN");
        await client.query("SET LOCAL client_min_messages = error");
        expect(await showMinMessages(client)).toBe("error");
        await openSessionsOnlyBypass(client);
        // The refused statement is the transaction's last.
        await swallowRefusal(client, "SELECT id FROM users LIMIT 1");
        await client.query("ROLLBACK");
      });
      expect(warnings).toEqual([]);
      expect(refusals).toEqual([{ table: "users", purpose: "auth_flow" }]);
      // The LOCAL did not leak past ROLLBACK onto the checked-out connection.
      expect(await showMinMessages(client)).toBe(baseline);
    });
  });

  it("counts one warning and one refusal at the default setting", async () => {
    await withClient(async (client) => {
      const { warnings, refusals } = await expectSwallowedBypassRefusal(async () => {
        await client.query("BEGIN");
        await openSessionsOnlyBypass(client);
        await swallowRefusal(client, "SELECT id FROM users LIMIT 1");
        await client.query("ROLLBACK");
      });
      expect(warnings).toEqual([{ table: "users", purpose: "auth_flow" }]);
      expect(refusals).toEqual([{ table: "users", purpose: "auth_flow" }]);
    });
  });

  it("does not count a look-alike raised from another function", async () => {
    await withClient(async (client) => {
      const warningBuffer = bypassNoticeBuffer();
      const refusalBuffer = bypassRefusalBuffer();
      warningBuffer.splice(0);
      refusalBuffer.splice(0);
      await client.query("BEGIN");
      let caught: unknown;
      try {
        await client.query(
          `DO $$ BEGIN RAISE EXCEPTION 'RLS_BYPASS_NOT_GRANTED: users' USING ERRCODE = '42501', HINT = 'bypass purpose auth_flow'; END $$`,
        );
      } catch (error) {
        caught = error;
      }
      await client.query("ROLLBACK");
      expect(sqlStateOf(caught)).toBe("42501");
      expect((caught as Error).message).toBe("RLS_BYPASS_NOT_GRANTED: users");
      expect(warningBuffer.splice(0)).toEqual([]);
      expect(refusalBuffer.splice(0)).toEqual([]);
    });
  });

  it("does not count a plain permission denied", async () => {
    await withClient(async (client) => {
      const privilege = await client.query<{ granted: boolean }>(
        "SELECT has_table_privilege('passwd_app', 'tenant_claim_events', 'SELECT') AS granted",
      );
      expect(privilege.rows[0].granted).toBe(false);
      const warningBuffer = bypassNoticeBuffer();
      const refusalBuffer = bypassRefusalBuffer();
      warningBuffer.splice(0);
      refusalBuffer.splice(0);
      await client.query("BEGIN");
      let caught: unknown;
      try {
        await client.query("SELECT 1 FROM tenant_claim_events");
      } catch (error) {
        caught = error;
      }
      await client.query("ROLLBACK");
      expect(sqlStateOf(caught)).toBe("42501");
      expect(warningBuffer.splice(0)).toEqual([]);
      expect(refusalBuffer.splice(0)).toEqual([]);
    });
  });
});
