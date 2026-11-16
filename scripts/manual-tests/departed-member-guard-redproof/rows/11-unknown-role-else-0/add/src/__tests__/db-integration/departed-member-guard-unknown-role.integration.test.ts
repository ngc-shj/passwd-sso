/**
 * Scratch-only T1 cell (red-proof runner row 11; not part of the suite): a
 * TeamRole label the guard does not rank raises unknown_role. Needs the label
 * RP_UNKNOWN_LABEL, which the row's setup.sql adds to the scratch database
 * only (ALTER TYPE ... ADD VALUE cannot be rolled back).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Prisma } from "@prisma/client";
import { appConnectionString, createTestContext, setBypassRlsGucs, sqlStateOf, type TestContext } from "./helpers";
import { createPool } from "@/lib/db/pool-factory";

const LABEL = "RP_UNKNOWN_LABEL";

describe("departed-member guard — scratch-only unknown TeamRole label", () => {
  let ctx: TestContext;
  let appPool: pg.Pool;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    appPool = createPool({ connectionString: appConnectionString(), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    if (tenantId) await ctx.deleteTestData(tenantId);
    await ctx.cleanup();
  });

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  it("T1: a raise to a label the guard does not rank is refused with unknown_role", async () => {
    expect(await sql(`SELECT 1 FROM pg_enum WHERE enumtypid = '"TeamRole"'::regtype AND enumlabel = $1`, LABEL)).toHaveLength(1);
    tenantId = await ctx.createTenant();
    const userId = await ctx.createUser(tenantId);
    const teamId = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
      teamId, tenantId, `team-${teamId.slice(0, 8)}`,
    );
    const rowId = randomUUID();
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MEMBER', true, now() - interval '1 hour', now())`,
      rowId, teamId, userId, tenantId,
    );

    const client = await appPool.connect();
    let error: unknown = null;
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.bypass_rls', 'off', true), set_config('app.bypass_tables', '', true)`,
        [tenantId],
      );
      await client.query(`UPDATE team_members SET role = $2::"TeamRole" WHERE id = $1::uuid`, [rowId, LABEL]).catch((e: unknown) => {
        error = e;
      });
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }

    expect({ code: sqlStateOf(error), message: error instanceof Error ? error.message : String(error) }).toMatchObject({
      code: "23514",
      message: expect.stringContaining("DEPARTED_MEMBER_GUARD:unknown_role:"),
    });
    const [row] = await sql<{ role: string }>(`SELECT role::text AS role FROM team_members WHERE id = $1::uuid`, rowId);
    expect(row.role).toBe("MEMBER");
  });
});
