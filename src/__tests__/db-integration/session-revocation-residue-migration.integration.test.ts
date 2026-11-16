/**
 * The migration that revokes credentials left filed under a tenant their user
 * has left (docs/archive/review/session-revocation-failure-surfaces-plan.md C9,
 * code review round 2 F5/S3).
 *
 * Every table it touches is under FORCE RLS, so the block runs as the
 * application role — NOSUPERUSER, NOBYPASSRLS, like the RDS migrate role. The
 * block reaches every tenant, so the artifacts are seeded and the block run
 * inside one transaction that is rolled back: the database's own rows are
 * untouched. Tenants and users are committed by the harness and swept after.
 *
 * Run: npm run test:integration -- session-revocation-residue-migration
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import type { Prisma } from "@prisma/client";
import { createPool } from "@/lib/db/pool-factory";
import {
  appConnectionString,
  createTestContext,
  gucSentinels,
  parseNoticeCounts,
  readGucs,
  redProofOverride,
  setBypassRlsGucs,
  setGucs,
  setTestBypass,
  type TestContext,
} from "./helpers";

const MIGRATION_DIR = "20261116200000_revoke_departed_member_credential_residue";
const BLOCK_NAME = "departed-member-credential-residue";

/** The ten models revokeUsersAuthArtifactsInTx revokes, by table, with the column that says "still usable". */
const MODELS = {
  sessions: null,
  extension_tokens: "revoked_at",
  api_keys: "revoked_at",
  mcp_access_tokens: "revoked_at",
  mcp_refresh_tokens: "revoked_at",
  delegation_sessions: "revoked_at",
  operator_tokens: "revoked_at",
  extension_bridge_codes: "used_at",
  mobile_bridge_codes: "used_at",
  mcp_authorization_codes: "used_at",
} as const;
type Table = keyof typeof MODELS;
const TABLES = Object.keys(MODELS) as Table[];
const SEED_TABLES = [...TABLES, "mcp_clients", "service_accounts"];

const hex = (n: number) => randomBytes(n).toString("hex");

function migrationBlock(): string {
  const sqlText = readFileSync(
    redProofOverride("RESIDUE_MIGRATION_SQL") ?? join(process.cwd(), "prisma/migrations", MIGRATION_DIR, "migration.sql"),
    "utf8",
  );
  const found = [...sqlText.matchAll(new RegExp(`-- BEGIN BACKFILL ${BLOCK_NAME}\\n([\\s\\S]*?)-- END BACKFILL ${BLOCK_NAME}\\n`, "g"))];
  if (found.length !== 1) throw new Error(`expected exactly one BACKFILL block "${BLOCK_NAME}", found ${found.length}`);
  return found[0][1];
}

/** Run `work` as the application role inside a transaction that is rolled back. */
async function inRolledBackAppTransaction(work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const pool = createPool({ connectionString: appConnectionString(), max: 1 });
  try {
    const client = await pool.connect();
    try {
      const [principal] = (
        await client.query<{ bypass: boolean; superuser: boolean }>(
          `SELECT rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`,
        )
      ).rows;
      expect(principal).toEqual({ bypass: false, superuser: false });
      await client.query("BEGIN");
      try {
        await work(client);
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/** Run the block once; returns its report NOTICE's counts. */
async function runBlock(client: pg.PoolClient): Promise<Record<string, number>> {
  const notices: string[] = [];
  const onNotice = (notice: { message?: string }) => {
    if (notice.message?.startsWith(`${BLOCK_NAME}:`)) notices.push(notice.message);
  };
  client.on("notice", onNotice);
  try {
    await client.query(migrationBlock());
  } finally {
    client.removeListener("notice", onNotice);
  }
  expect(notices).toHaveLength(1);
  return parseNoticeCounts(notices[0]);
}

type Seeded = Record<Table, string>;

/** An MCP client of `tenantId`, which the MCP rows below hang off. */
async function seedClient(client: pg.PoolClient, tenantId: string, creator: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO mcp_clients (id, tenant_id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_active, created_by_id, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, ARRAY['http://localhost/cb']::text[], 'passwords:read', true, $6::uuid, now(), now())`,
    [id, tenantId, `cli-${id.slice(0, 16)}`, hex(32), `client-${id.slice(0, 8)}`, creator],
  );
  return id;
}

/** One live row of each of the ten models for `userId` under `tenantId`. */
async function seedArtifacts(client: pg.PoolClient, userId: string, tenantId: string, mcpClientId: string): Promise<Seeded> {
  const ids = Object.fromEntries(TABLES.map((t) => [t, randomUUID()])) as Seeded;
  const q = (text: string, values: unknown[]) => client.query(text, values);
  await q(
    `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
    [ids.sessions, hex(32), userId, tenantId],
  );
  await q(
    `INSERT INTO extension_tokens (id, user_id, tenant_id, token_hash, scope, expires_at, family_id, family_created_at, created_at, cnf_jkt)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'extension:read', now() + interval '1 day', $5::uuid, now(), now(), $6)`,
    [ids.extension_tokens, userId, tenantId, hex(32), randomUUID(), "a".repeat(43)],
  );
  await q(
    `INSERT INTO api_keys (id, user_id, tenant_id, token_hash, prefix, name, scope, expires_at, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'api_XXXX', 'k', 'passwords:read', now() + interval '30 days', now())`,
    [ids.api_keys, userId, tenantId, hex(32)],
  );
  await q(
    `INSERT INTO mcp_access_tokens (id, token_hash, client_id, tenant_id, user_id, scope, expires_at, created_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'passwords:read', now() + interval '1 day', now())`,
    [ids.mcp_access_tokens, hex(32), mcpClientId, tenantId, userId],
  );
  await q(
    `INSERT INTO mcp_refresh_tokens (id, token_hash, family_id, access_token_id, client_id, tenant_id, user_id, scope, expires_at, created_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, 'passwords:read', now() + interval '1 day', now())`,
    [ids.mcp_refresh_tokens, hex(32), randomUUID(), ids.mcp_access_tokens, mcpClientId, tenantId, userId],
  );
  await q(
    `INSERT INTO delegation_sessions (id, tenant_id, user_id, mcp_token_id, entry_ids, expires_at, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, '{}', now() + interval '1 hour', now())`,
    [ids.delegation_sessions, tenantId, userId, ids.mcp_access_tokens],
  );
  await q(
    `INSERT INTO operator_tokens (id, token_hash, prefix, name, tenant_id, subject_user_id, created_by_user_id, scope, expires_at, created_at)
     VALUES ($1::uuid, $2, 'op_XXXXX', 'k', $3::uuid, $4::uuid, $4::uuid, 'maintenance', now() + interval '30 days', now())`,
    [ids.operator_tokens, hex(32), tenantId, userId],
  );
  await q(
    `INSERT INTO extension_bridge_codes (id, code_hash, user_id, tenant_id, scope, expires_at, created_at, cnf_jkt)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'extension:read', now() + interval '5 minutes', now(), $5)`,
    [ids.extension_bridge_codes, hex(32), userId, tenantId, "b".repeat(43)],
  );
  await q(
    `INSERT INTO mobile_bridge_codes (id, tenant_id, user_id, code_hash, state, code_challenge, device_jkt, expires_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, now() + interval '5 minutes')`,
    [ids.mobile_bridge_codes, tenantId, userId, hex(32), hex(16), hex(32), "c".repeat(43)],
  );
  await q(
    `INSERT INTO mcp_authorization_codes (id, code_hash, client_id, tenant_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, expires_at, created_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'http://localhost/cb', 'passwords:read', $6, 'S256', now() + interval '10 minutes', now())`,
    [ids.mcp_authorization_codes, hex(32), mcpClientId, tenantId, userId, "d".repeat(43)],
  );
  return ids;
}

/** A service account's MCP rows (user_id NULL) under `tenantId`. */
async function seedUserlessMcp(
  client: pg.PoolClient,
  tenantId: string,
  mcpClientId: string,
  creator: string,
): Promise<Record<string, string>> {
  const serviceAccountId = randomUUID();
  const ids = { mcp_access_tokens: randomUUID(), mcp_refresh_tokens: randomUUID(), mcp_authorization_codes: randomUUID() };
  await client.query(
    `INSERT INTO service_accounts (id, tenant_id, name, created_by_id, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, now(), now())`,
    [serviceAccountId, tenantId, `sa-${serviceAccountId.slice(0, 8)}`, creator],
  );
  await client.query(
    `INSERT INTO mcp_access_tokens (id, token_hash, client_id, tenant_id, user_id, service_account_id, scope, expires_at, created_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, NULL, $5::uuid, 'passwords:read', now() + interval '1 day', now())`,
    [ids.mcp_access_tokens, hex(32), mcpClientId, tenantId, serviceAccountId],
  );
  await client.query(
    `INSERT INTO mcp_refresh_tokens (id, token_hash, family_id, access_token_id, client_id, tenant_id, user_id, service_account_id, scope, expires_at, created_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, NULL, $7::uuid, 'passwords:read', now() + interval '1 day', now())`,
    [ids.mcp_refresh_tokens, hex(32), randomUUID(), ids.mcp_access_tokens, mcpClientId, tenantId, serviceAccountId],
  );
  await client.query(
    `INSERT INTO mcp_authorization_codes (id, code_hash, client_id, tenant_id, user_id, service_account_id, redirect_uri, scope, code_challenge, code_challenge_method, expires_at, created_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, NULL, $5::uuid, 'http://localhost/cb', 'passwords:read', $6, 'S256', now() + interval '10 minutes', now())`,
    [ids.mcp_authorization_codes, hex(32), mcpClientId, tenantId, serviceAccountId, "e".repeat(43)],
  );
  return ids;
}

/** "live" or "revoked" per row; a deleted session reads "revoked". */
async function states(client: pg.PoolClient, ids: Partial<Record<Table, string>>): Promise<Record<string, string>> {
  await setTestBypass(client, TABLES);
  const out: Record<string, string> = {};
  for (const [table, id] of Object.entries(ids) as [Table, string][]) {
    const column = MODELS[table];
    const { rows } = await client.query<{ live: boolean }>(
      `SELECT ${column === null ? "true" : `${column} IS NULL`} AS live FROM ${table} WHERE id = $1::uuid`,
      [id],
    );
    out[table] = rows[0]?.live ? "live" : "revoked";
  }
  return out;
}

/** The "usable since" stamp of each row, to show a second run rewrites nothing. */
async function stamps(client: pg.PoolClient, ids: Partial<Record<Table, string>>): Promise<Record<string, string | null>> {
  await setTestBypass(client, TABLES);
  const out: Record<string, string | null> = {};
  for (const [table, id] of Object.entries(ids) as [Table, string][]) {
    const column = MODELS[table];
    if (column === null) continue;
    const { rows } = await client.query<{ stamp: Date | null }>(`SELECT ${column} AS stamp FROM ${table} WHERE id = $1::uuid`, [id]);
    out[table] = rows[0]?.stamp?.toISOString() ?? null;
  }
  return out;
}

const all = (state: string) => Object.fromEntries(TABLES.map((t) => [t, state]));

describe("migration: revoke credentials filed under a tenant their user has left", () => {
  let ctx: TestContext;
  let tenantA: string;
  let tenantB: string;
  /** Deactivated in A, active in B. */
  let departed: string;
  /** No row in A, active nowhere. */
  let rowless: string;
  /** Active in A. */
  let member: string;

  async function su(text: string, ...params: unknown[]): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(text, ...params);
    });
  }

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantA = await ctx.createTenant();
    tenantB = await ctx.createTenant();
    member = await ctx.createUser(tenantA);
    departed = await ctx.createUser(tenantA);
    rowless = await ctx.createUser(tenantA);
    await su(`UPDATE tenant_members SET deactivated_at = now() WHERE user_id = $1::uuid`, departed);
    await su(
      `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
      randomUUID(), tenantB, departed,
    );
    await su(`DELETE FROM tenant_members WHERE user_id = $1::uuid`, rowless);
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantB);
    await ctx.deleteTestData(tenantA);
  });

  async function seedScenario(client: pg.PoolClient) {
    await setTestBypass(client, SEED_TABLES);
    const clientA = await seedClient(client, tenantA, member);
    const clientB = await seedClient(client, tenantB, departed);
    return {
      departedInA: await seedArtifacts(client, departed, tenantA, clientA),
      rowlessInA: await seedArtifacts(client, rowless, tenantA, clientA),
      departedInB: await seedArtifacts(client, departed, tenantB, clientB),
      memberInA: await seedArtifacts(client, member, tenantA, clientA),
      userlessInA: await seedUserlessMcp(client, tenantA, clientA, member),
    };
  }

  async function snapshot(client: pg.PoolClient, seeded: Awaited<ReturnType<typeof seedScenario>>) {
    return {
      departedInA: await states(client, seeded.departedInA),
      rowlessInA: await states(client, seeded.rowlessInA),
      departedInB: await states(client, seeded.departedInB),
      memberInA: await states(client, seeded.memberInA),
      userlessInA: await states(client, seeded.userlessInA),
    };
  }

  it("revokes every model's residue of a departed and a rowless user, and leaves active memberships' and userless rows live", async () => {
    await inRolledBackAppTransaction(async (client) => {
      const seeded = await seedScenario(client);
      expect(await snapshot(client, seeded)).toEqual({
        departedInA: all("live"),
        rowlessInA: all("live"),
        departedInB: all("live"),
        memberInA: all("live"),
        userlessInA: { mcp_access_tokens: "live", mcp_refresh_tokens: "live", mcp_authorization_codes: "live" },
      });
      const sentinels = gucSentinels();
      await setGucs(client, sentinels);

      await runBlock(client);

      expect(await readGucs(client)).toEqual(sentinels);
      expect(await snapshot(client, seeded)).toEqual({
        departedInA: all("revoked"),
        rowlessInA: all("revoked"),
        departedInB: all("live"),
        memberInA: all("live"),
        userlessInA: { mcp_access_tokens: "live", mcp_refresh_tokens: "live", mcp_authorization_codes: "live" },
      });
    });
  });

  it("revokes an expired residue row too: expiry decides only whose lock is taken", async () => {
    await inRolledBackAppTransaction(async (client) => {
      const seeded = await seedScenario(client);
      await setTestBypass(client, TABLES);
      await client.query(`UPDATE api_keys SET expires_at = now() - interval '1 day' WHERE id = $1::uuid`, [seeded.rowlessInA.api_keys]);
      await client.query(`UPDATE sessions SET expires = now() - interval '1 day' WHERE id = $1::uuid`, [seeded.rowlessInA.sessions]);
      await setGucs(client, gucSentinels());

      await runBlock(client);

      expect(await states(client, { api_keys: seeded.rowlessInA.api_keys, sessions: seeded.rowlessInA.sessions })).toEqual({
        api_keys: "revoked",
        sessions: "revoked",
      });
    });
  });

  it("is idempotent: a second run changes no row and reports zero for every model", async () => {
    await inRolledBackAppTransaction(async (client) => {
      const seeded = await seedScenario(client);
      await setGucs(client, gucSentinels());
      await runBlock(client);
      const afterFirst = await snapshot(client, seeded);
      const stampsAfterFirst = await stamps(client, seeded.departedInA);
      await setGucs(client, gucSentinels());

      const second = await runBlock(client);

      expect(second).toEqual({ users: 0, ...Object.fromEntries(TABLES.map((t) => [t, 0])) });
      expect(await snapshot(client, seeded)).toEqual(afterFirst);
      expect(await stamps(client, seeded.departedInA)).toEqual(stampsAfterFirst);
    });
  });
});
