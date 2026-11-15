/**
 * The migration that removes the two `system_settings` rows earlier releases
 * of the audit-anchor publisher decided from (#949).
 *
 * `system_settings` is under FORCE RLS, so the block is run here as the
 * application role — NOSUPERUSER, NOBYPASSRLS, like the RDS migrate role —
 * where a statement without a bypass sees no row. Everything happens inside
 * one transaction that is rolled back: the database's own rows are untouched.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { createPool } from "@/lib/db/pool-factory";
import { SETTING_DEPLOYMENT_ID, SETTING_UPLOAD_ATTEMPTS } from "@/workers/audit-anchor-publisher";
import { LEGACY_SETTING } from "./anchor-publisher-fixtures";
import { appConnectionString, gucSentinels, readGucs, redProofOverride, setGucs, setTestBypass } from "./helpers";

const MIGRATION_DIR = "20261115000000_remove_audit_anchor_legacy_settings";
const BLOCK_NAME = "audit-anchor-legacy-settings";
const TABLE = "system_settings";

const LEGACY_KEYS = Object.values(LEGACY_SETTING);
const KEPT_KEYS = [SETTING_DEPLOYMENT_ID, SETTING_UPLOAD_ATTEMPTS];
// Not the publisher's: a row of another feature the block must not touch.
const UNRELATED_KEY = "audit_anchor_legacy_settings_test_unrelated";

function migrationBlock(): string {
  const sqlText = readFileSync(
    redProofOverride("AUDIT_ANCHOR_LEGACY_SETTINGS_SQL") ?? join(process.cwd(), "prisma/migrations", MIGRATION_DIR, "migration.sql"),
    "utf8",
  );
  const found = [...sqlText.matchAll(new RegExp(`-- BEGIN BACKFILL ${BLOCK_NAME}\\n([\\s\\S]*?)-- END BACKFILL ${BLOCK_NAME}\\n`, "g"))];
  if (found.length !== 1) throw new Error(`expected exactly one BACKFILL block "${BLOCK_NAME}", found ${found.length}`);
  return found[0][1];
}

/**
 * The keys the block deletes: the list of its one DELETE, which must be
 * `WHERE key IN (…)` over string literals and nothing else. The planted rows
 * below cannot show a key deleted beyond them.
 */
function deletedKeys(block: string): string[] {
  const deletes = [...block.matchAll(/\bDELETE\s+FROM\s+(\S+)\s+WHERE\s+([^;]*);/g)];
  if (deletes.length !== 1) throw new Error(`expected exactly one DELETE in the block, found ${deletes.length}`);
  const [, table, predicate] = deletes[0];
  const list = /^key\s+IN\s+\(([^()]*)\)$/.exec(predicate.trim());
  if (table !== TABLE || !list) throw new Error(`the block's DELETE is not "DELETE FROM ${TABLE} WHERE key IN (…)"`);
  return list[1].split(",").map((item) => {
    const literal = /^'([^']*)'$/.exec(item.trim());
    if (!literal) throw new Error(`not a string literal in the DELETE's key list: ${item.trim()}`);
    return literal[1];
  });
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

/** Plant every key under a test-owned bypass, then leave the settings a migrate role would have. */
async function plantSettings(client: pg.PoolClient, keys: readonly string[]): Promise<void> {
  await setTestBypass(client, [TABLE]);
  for (const key of keys) {
    await client.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, `planted-${key}`],
    );
  }
}

async function plantedKeys(client: pg.PoolClient, keys: readonly string[]): Promise<string[]> {
  await setTestBypass(client, [TABLE]);
  const { rows } = await client.query<{ key: string }>(
    `SELECT key FROM system_settings WHERE key = ANY($1::text[]) ORDER BY key`,
    [[...keys]],
  );
  return rows.map((r) => r.key);
}

describe("migration: remove the audit-anchor publisher's legacy settings rows", () => {
  const ALL_KEYS = [...LEGACY_KEYS, ...KEPT_KEYS, UNRELATED_KEY];

  it("deletes exactly the two rows the earlier publisher decided from, and names neither row the publisher still uses", () => {
    expect([...LEGACY_KEYS].sort()).toEqual(["audit_anchor_last_published_boundary", "audit_anchor_previous_manifest"]);
    const block = migrationBlock();
    expect(deletedKeys(block).sort()).toEqual([...LEGACY_KEYS].sort());
    for (const key of KEPT_KEYS) expect(block).not.toContain(key);
  });

  it("run as a role RLS binds, removes the two legacy rows, keeps every other row, and restores the settings it found", async () => {
    await inRolledBackAppTransaction(async (client) => {
      await plantSettings(client, ALL_KEYS);
      const sentinels = gucSentinels();
      await setGucs(client, sentinels);

      await client.query(migrationBlock());

      expect(await readGucs(client)).toEqual(sentinels);
      expect(await plantedKeys(client, ALL_KEYS)).toEqual([...KEPT_KEYS, UNRELATED_KEY].sort());
    });
  });

  it("the same DELETE without the block's bypass removes nothing: the bypass is what reaches the rows", async () => {
    await inRolledBackAppTransaction(async (client) => {
      await plantSettings(client, ALL_KEYS);
      await setGucs(client, gucSentinels());

      const deleted = await client.query(`DELETE FROM system_settings WHERE key = ANY($1::text[])`, [[...LEGACY_KEYS]]);

      expect(deleted.rowCount).toBe(0);
      expect(await plantedKeys(client, ALL_KEYS)).toEqual([...ALL_KEYS].sort());
    });
  });

  it("is a no-op where the rows were never written, and runs twice", async () => {
    await inRolledBackAppTransaction(async (client) => {
      await plantSettings(client, KEPT_KEYS);
      await setTestBypass(client, [TABLE]);
      await client.query(`DELETE FROM system_settings WHERE key = ANY($1::text[])`, [[...LEGACY_KEYS]]);
      await setGucs(client, gucSentinels());

      await client.query(migrationBlock());
      await client.query(migrationBlock());

      expect(await plantedKeys(client, ALL_KEYS)).toEqual([...KEPT_KEYS].sort());
    });
  });
});
