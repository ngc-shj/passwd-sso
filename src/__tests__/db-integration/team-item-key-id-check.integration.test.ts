/**
 * Integration test (real DB): the ItemKey identity CHECKs of #1011
 * (docs/archive/review/team-item-key-id-check-plan.md C1, C2, C4) — the two
 * constraints as the app role meets them, the repair block of migration
 * 20261120000000 and the VALIDATE of 20261120000100 as an RDS-shaped migrate
 * role, the block's bypass table list, and its lock order.
 *
 * The RDS migrate role (NOSUPERUSER NOBYPASSRLS, a member of the table owner)
 * is emulated by a NOLOGIN role created inside each cell's transaction, which
 * the rollback removes. Every cell runs on one client in one rolled-back
 * transaction; the constraints a cell drops come back with the rollback.
 *
 * Run: docker compose up -d db && npm run test:integration -- team-item-key-id-check
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import type pg from "pg";
import {
  appConnectionString,
  collectNotices,
  createTestContext,
  expectBypassRefusal,
  gucSentinels,
  parseNoticeCounts,
  readBackfillBlock,
  readGucs,
  REPAIRED_ROLLOUT_ENTRY,
  setBypassRlsGucs,
  setGucs,
  superuserConnectionString,
  TEAM_ENTRY_ITEM_KEY_ID_CHECK as ENTRY_CHECK,
  TEAM_HISTORY_ITEM_KEY_ID_CHECK as HISTORY_CHECK,
  TEAM_ITEM_KEY_ID_CHECK_BLOCK as BLOCK_NAME,
  TEAM_ITEM_KEY_ID_CHECK_DIR,
  teamItemKeyIdCheckAlters as alterStatements,
  type RolloutEntryRows,
  type TestContext,
} from "./helpers";
import { createPool } from "@/lib/db/pool-factory";
import { SQLSTATE_CHECK_VIOLATION } from "@/lib/prisma/prisma-error";
import { createRaceHelpers } from "./race-helpers";

const VALIDATE_DIR = "20261120000100_team_item_key_id_check_validate";
const REPORT = "team-item-key-id-check backfill:";
const BLOCK_TABLES = ["team_password_entries", "team_password_entry_histories", "attachments"] as const;
const LOCK_STATEMENT = "LOCK TABLE team_password_entries, team_password_entry_histories IN ACCESS EXCLUSIVE MODE";
const ZERO_COUNTS = {
  v0_ids_cleared: 0, ids_adopted: 0, ids_minted: 0, stale_pending: 0,
  history_v0_ids_cleared: 0, history_ids: 0, high_water: 0,
};

function hex(nBytes: number): string {
  return randomBytes(nBytes).toString("hex");
}

type Wrap = { encryptedItemKey: string | null; itemKeyIv: string | null; itemKeyAuthTag: string | null };

function newWrap(): Wrap {
  return { encryptedItemKey: hex(48), itemKeyIv: hex(12), itemKeyAuthTag: hex(16) };
}

const pgError = (e: unknown) => e as { code?: string; constraint?: string; where?: string; message?: string };

/** Run `text` in a savepoint: kept when it succeeds, rolled back when refused. */
async function attempt(client: pg.PoolClient, text: string, params: unknown[] = []): Promise<string> {
  await client.query("SAVEPOINT attempt");
  try {
    await client.query(text, params);
    await client.query("RELEASE SAVEPOINT attempt");
    return "accepted";
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT attempt");
    const { code, constraint } = pgError(e);
    return `${code} ${constraint ?? pgError(e).message}`;
  }
}

describe("team item key id CHECKs (#1011) — real-DB integration", () => {
  let ctx: TestContext;
  let suPool: pg.Pool;
  let appPool: pg.Pool;
  let owner: string;
  let tenantId: string;
  let userId: string;
  let teamId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    suPool = createPool({ connectionString: superuserConnectionString(), max: 4, statement_timeout: 30_000 });
    appPool = createPool({ connectionString: appConnectionString(), max: 2, statement_timeout: 30_000 });
    const { rows } = await suPool.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class
        WHERE oid IN ('team_password_entries'::regclass, 'team_password_entry_histories'::regclass)`,
    );
    expect(rows).toHaveLength(1);
    owner = rows[0].owner;
  });

  afterAll(async () => {
    await appPool?.end();
    await suPool?.end();
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    teamId = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, 3, now(), now())`,
      teamId, tenantId, `team-${teamId.slice(0, 8)}`,
    );
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  async function sql(text: string, ...params: unknown[]): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(text, ...params);
    });
  }

  // ── Row writers on a cell's client (superuser setup, or the app role under its tenant) ──

  type EntrySeed = {
    itemKeyVersion: number;
    itemKeyId: string | null;
    marker: number;
    highWater: number;
    teamKeyVersion?: number;
    wrap?: Wrap | null;
  };

  async function insertEntry(client: pg.PoolClient, o: EntrySeed): Promise<string> {
    const id = randomUUID();
    const wrap = o.wrap === undefined ? (o.itemKeyVersion >= 1 ? newWrap() : null) : o.wrap;
    await client.query(
      `INSERT INTO team_password_entries (
         id, team_id, tenant_id, created_by_id, updated_by_id,
         encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag,
         aad_version, team_key_version, item_key_version,
         encrypted_item_key, item_key_iv, item_key_auth_tag,
         item_key_id, item_key_team_key_version, item_key_version_high_water,
         entry_type, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid,
         $5, $6, $7, $5, $8, $7,
         1, $9, $10, $11, $12, $13, $14::uuid, $15, $16, 'LOGIN', now(), now()
       )`,
      [
        id, teamId, tenantId, userId, hex(32), hex(12), hex(16), hex(12),
        o.teamKeyVersion ?? 3, o.itemKeyVersion,
        wrap?.encryptedItemKey ?? null, wrap?.itemKeyIv ?? null, wrap?.itemKeyAuthTag ?? null,
        o.itemKeyId, o.marker, o.highWater,
      ],
    );
    return id;
  }

  type HistorySeed = { itemKeyVersion: number; itemKeyId: string | null; teamKeyVersion?: number; wrap?: Wrap | null };

  function historyInsert(entryId: string, o: HistorySeed): { text: string; params: unknown[] } {
    const id = randomUUID();
    const wrap = o.wrap === undefined ? (o.itemKeyVersion >= 1 ? newWrap() : null) : o.wrap;
    return {
      text: `INSERT INTO team_password_entry_histories (
               id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag,
               aad_version, team_key_version, item_key_version,
               encrypted_item_key, item_key_iv, item_key_auth_tag, item_key_id,
               changed_by_id, changed_at
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12::uuid, $13::uuid, now())`,
      params: [
        id, entryId, tenantId, hex(32), hex(12), hex(16), o.teamKeyVersion ?? 3, o.itemKeyVersion,
        wrap?.encryptedItemKey ?? null, wrap?.itemKeyIv ?? null, wrap?.itemKeyAuthTag ?? null, o.itemKeyId, userId,
      ],
    };
  }

  async function insertHistory(client: pg.PoolClient, entryId: string, o: HistorySeed): Promise<string> {
    const { text, params } = historyInsert(entryId, o);
    await client.query(text, params);
    return params[0] as string;
  }

  async function insertAttachment(
    client: pg.PoolClient,
    entryId: string,
    o: { cekKeyVersion: number | null; cekItemKeyId: string | null; mode: number },
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO attachments (
         id, team_password_entry_id, tenant_id, created_by_id, filename, content_type, size_bytes,
         encrypted_data, iv, auth_tag, key_version, cek_key_version, cek_item_key_id, aad_version, encryption_mode, created_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'f.bin', 'application/octet-stream', 4,
                 '\\x00010203'::bytea, $5, $6, 1, $7, $8::uuid, 1, $9, now())`,
      [id, entryId, tenantId, userId, hex(12), hex(16), o.cekKeyVersion, o.cekItemKeyId, o.mode],
    );
    return id;
  }

  // ── Roles and transactions ──

  /**
   * Inside the open transaction on a superuser client, become a NOLOGIN
   * NOSUPERUSER NOBYPASSRLS member of the table owner: the RDS migrate role's
   * shape. The role vanishes with the rollback.
   */
  async function enterOwnerRole(client: pg.PoolClient): Promise<string> {
    const name = `ikc_${randomBytes(6).toString("hex")}`;
    await client.query(`CREATE ROLE ${name} NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${client.escapeIdentifier(owner)}`);
    await client.query(`SET LOCAL ROLE ${name}`);
    const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; member: boolean }>(
      `SELECT rolsuper, rolbypassrls, pg_has_role(current_user, $1, 'USAGE') AS member
         FROM pg_roles WHERE rolname = current_user`,
      [owner],
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, member: true });
    return name;
  }

  async function inRolledBackTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await fn(client);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  async function dropConstraints(client: pg.PoolClient): Promise<void> {
    await client.query(`ALTER TABLE team_password_entries DROP CONSTRAINT ${ENTRY_CHECK}`);
    await client.query(`ALTER TABLE team_password_entry_histories DROP CONSTRAINT ${HISTORY_CHECK}`);
  }

  /** Runs the block with the settings sentinels in place and asserts it left them as found. */
  async function runBlock(client: pg.PoolClient, block: string): Promise<void> {
    const sentinels = gucSentinels();
    await setGucs(client, sentinels);
    await client.query(block);
    expect(await readGucs(client)).toEqual(sentinels);
  }

  const repairBlock = () => readBackfillBlock(TEAM_ITEM_KEY_ID_CHECK_DIR, BLOCK_NAME);

  const countsOf = (messages: string[]) => {
    const lines = messages.filter((m) => m.startsWith(REPORT));
    expect(lines).toHaveLength(1);
    return parseNoticeCounts(lines[0]);
  };

  // ── 1. The constraints, as the app role ──────────────────────────────────

  it("CHECK cell as passwd_app: entries refuse (v1, NULL) and (v0, id) on INSERT and UPDATE, histories refuse (v0, id); the other shapes are accepted; both constraints are validated", async () => {
    await inRolledBackTx(appPool, async (client) => {
      const { rows: [principal] } = await client.query<{ name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(principal).toEqual({ name: "passwd_app", rolsuper: false, rolbypassrls: false });
      await setGucs(client, { rls: "off", tables: "", purpose: "", tenant: tenantId });

      const entry = (o: { id?: string; itemKeyVersion: number; itemKeyId: string | null }) =>
        attempt(client, ...entryInsert(o));
      const v0 = randomUUID();
      const v1 = randomUUID();
      const refused = {
        entryV1NullInsert: await entry({ itemKeyVersion: 1, itemKeyId: null }),
        entryV0IdInsert: await entry({ itemKeyVersion: 0, itemKeyId: randomUUID() }),
      };
      const accepted = {
        entryV0Null: await entry({ id: v0, itemKeyVersion: 0, itemKeyId: null }),
        entryV1Id: await entry({ id: v1, itemKeyVersion: 1, itemKeyId: randomUUID() }),
        entryV2Id: await entry({ itemKeyVersion: 2, itemKeyId: randomUUID() }),
      };
      const updates = {
        entryV1ToNullId: await attempt(client, `UPDATE team_password_entries SET item_key_id = NULL WHERE id = $1::uuid`, [v1]),
        entryV0ToId: await attempt(client, `UPDATE team_password_entries SET item_key_id = $2::uuid WHERE id = $1::uuid`, [v0, randomUUID()]),
      };
      const history = (o: HistorySeed) => {
        const { text, params } = historyInsert(v1, o);
        return attempt(client, text, params);
      };
      const histories = {
        historyV0Id: await history({ itemKeyVersion: 0, itemKeyId: randomUUID() }),
        historyV0Null: await history({ itemKeyVersion: 0, itemKeyId: null }),
        historyV1Null: await history({ itemKeyVersion: 1, itemKeyId: null }),
        historyV1Id: await history({ itemKeyVersion: 1, itemKeyId: randomUUID() }),
      };

      expect({ refused, accepted, updates, histories }).toEqual({
        refused: { entryV1NullInsert: `${SQLSTATE_CHECK_VIOLATION} ${ENTRY_CHECK}`, entryV0IdInsert: `${SQLSTATE_CHECK_VIOLATION} ${ENTRY_CHECK}` },
        accepted: { entryV0Null: "accepted", entryV1Id: "accepted", entryV2Id: "accepted" },
        updates: { entryV1ToNullId: `${SQLSTATE_CHECK_VIOLATION} ${ENTRY_CHECK}`, entryV0ToId: `${SQLSTATE_CHECK_VIOLATION} ${ENTRY_CHECK}` },
        histories: {
          historyV0Id: `${SQLSTATE_CHECK_VIOLATION} ${HISTORY_CHECK}`, historyV0Null: "accepted", historyV1Null: "accepted", historyV1Id: "accepted",
        },
      });

      const { rows } = await client.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`,
        [[ENTRY_CHECK, HISTORY_CHECK]],
      );
      expect(rows).toEqual([
        { conname: ENTRY_CHECK, convalidated: true },
        { conname: HISTORY_CHECK, convalidated: true },
      ]);
    });

    /** The INSERT of an entry in the given shape, as the app role writes one under its tenant. */
    function entryInsert(o: { id?: string; itemKeyVersion: number; itemKeyId: string | null }): [string, unknown[]] {
      const wrap = o.itemKeyVersion >= 1 ? newWrap() : null;
      return [
        `INSERT INTO team_password_entries (
           id, team_id, tenant_id, created_by_id, updated_by_id,
           encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag,
           aad_version, team_key_version, item_key_version, encrypted_item_key, item_key_iv, item_key_auth_tag,
           item_key_id, item_key_team_key_version, item_key_version_high_water, entry_type, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid, 'b', $5, $6, 'o', $5, $6,
                   1, 3, $7, $8, $9, $10, $11::uuid, 3, $7, 'LOGIN', now(), now())`,
        [o.id ?? randomUUID(), teamId, tenantId, userId, hex(12), hex(16), o.itemKeyVersion,
          wrap?.encryptedItemKey ?? null, wrap?.itemKeyIv ?? null, wrap?.itemKeyAuthTag ?? null, o.itemKeyId],
      ];
    }
  });

  // ── 2. The repair block, as the owner-shaped role ────────────────────────

  /**
   * Every shape the block decides on (plan D-b), each named. Every entry has
   * marker >= 1 except the double-label control, so a missing marker reset
   * shows; every arm that sets an id has a NULL-id history row of the
   * entry's wrap, so a missing link shows.
   */
  async function seedRepairShapes(client: pg.PoolClient) {
    const ids: Record<string, string> = {};
    for (const name of [
      "X0", "Xh0", "Y1", "Y2", "Z2", "X5", "Y5", "X6", "Y6", "X7", "Xhw", "Yhw", "X8", "Y8", "X9", "Ytkv", "Yikv", "Ynull",
      "Xa", "Xaf", "Xae", "Xaz", "Xc1", "Xc1b", "Xc1t", "Xc2", "Xc2b", "Xc2t", "Xb1", "Yb1", "Xb2", "Yb2", "Xb3", "Yb3",
    ]) ids[name] = randomUUID();
    const entries: Record<string, string> = {};
    const histories: Record<string, string> = {};
    const attachments: Record<string, string> = {};
    /** What each entry's high-water is computed from, recorded as the rows are written. */
    const rows: Record<string, Required<RolloutEntryRows>> = {};

    const entry = async (name: string, o: EntrySeed) => {
      entries[name] = await insertEntry(client, o);
      rows[name] = { itemKeyVersion: o.itemKeyVersion, highWater: o.highWater, historyItemKeyVersions: [], attachmentCekKeyVersions: [] };
    };
    const history = async (name: string, of: string, o: HistorySeed) => {
      histories[name] = await insertHistory(client, entries[of], o);
      (rows[of].historyItemKeyVersions as number[]).push(o.itemKeyVersion);
    };
    const attachment = async (name: string, of: string, o: { cekKeyVersion: number | null; cekItemKeyId: string | null; mode?: number }) => {
      attachments[name] = await insertAttachment(client, entries[of], { mode: 1, ...o });
      (rows[of].attachmentCekKeyVersions as (number | null)[]).push(o.cekKeyVersion);
    };

    // Repaired: a v0 entry with an id, and the history row a 0.5.0 snapshot made of it.
    await entry("v0WithId", { itemKeyVersion: 0, itemKeyId: ids.X0, marker: 2, highWater: 1 });
    await history("v0WithId_v0", "v0WithId", { itemKeyVersion: 0, itemKeyId: ids.Xh0 });

    // Repaired: H = {Y1} → adopts Y1.
    const w1 = newWrap();
    await entry("adopt", { itemKeyVersion: 1, itemKeyId: null, marker: 3, highWater: 0, wrap: w1 });
    await history("adopt_Y", "adopt", { itemKeyVersion: 1, itemKeyId: ids.Y1, wrap: w1 });
    await history("adopt_link", "adopt", { itemKeyVersion: 1, itemKeyId: null, wrap: w1 });

    // Repaired: H = ∅ → minted; a history row above the entry's version raises the high-water past it.
    const w2 = newWrap();
    await entry("mintEmpty", { itemKeyVersion: 1, itemKeyId: null, marker: 3, highWater: 0, wrap: w2 });
    await history("mintEmpty_link", "mintEmpty", { itemKeyVersion: 1, itemKeyId: null, wrap: w2 });
    await history("mintEmpty_v2", "mintEmpty", { itemKeyVersion: 2, itemKeyId: null });
    // Link control: the entry's wrap at another item_key_version is not linked.
    await history("mintEmpty_ikv", "mintEmpty", { itemKeyVersion: 2, itemKeyId: null, wrap: w2 });

    // Repaired: H = {Y2, Z2} → minted, adopting neither.
    const w3 = newWrap();
    await entry("mintTwo", { itemKeyVersion: 1, itemKeyId: null, marker: 3, highWater: 0, wrap: w3 });
    await history("mintTwo_Y", "mintTwo", { itemKeyVersion: 1, itemKeyId: ids.Y2, wrap: w3 });
    await history("mintTwo_Z", "mintTwo", { itemKeyVersion: 1, itemKeyId: ids.Z2, wrap: w3 });
    await history("mintTwo_link", "mintTwo", { itemKeyVersion: 1, itemKeyId: null, wrap: w3 });
    // Link control: the entry's wrap at another team_key_version is not linked.
    await history("mintTwo_tkv", "mintTwo", { itemKeyVersion: 1, itemKeyId: null, teamKeyVersion: 2, wrap: w3 });

    // Marker only (the 0.4.77 restore of an id'd row, F5): H = {Y5}, and H = {X6, Y6}.
    const w4 = newWrap();
    await entry("f5", { itemKeyVersion: 1, itemKeyId: ids.X5, marker: 2, highWater: 1, wrap: w4 });
    await history("f5_Y", "f5", { itemKeyVersion: 1, itemKeyId: ids.Y5, wrap: w4 });
    const w5 = newWrap();
    await entry("f5Both", { itemKeyVersion: 1, itemKeyId: ids.X6, marker: 2, highWater: 1, wrap: w5 });
    await history("f5Both_X", "f5Both", { itemKeyVersion: 1, itemKeyId: ids.X6, wrap: w5 });
    await history("f5Both_Y", "f5Both", { itemKeyVersion: 1, itemKeyId: ids.Y6, wrap: w5 });

    // Untouched: H = {X7}, the entry's own id.
    const w6 = newWrap();
    await entry("sameId", { itemKeyVersion: 1, itemKeyId: ids.X7, marker: 2, highWater: 1, wrap: w6 });
    await history("sameId_X", "sameId", { itemKeyVersion: 1, itemKeyId: ids.X7, wrap: w6 });

    // High-water: an attachment's CEK above both the entry's version and its history max.
    await entry("hwAttachment", { itemKeyVersion: 1, itemKeyId: ids.Xhw, marker: 3, highWater: 1 });
    await history("hwAttachment_v2", "hwAttachment", { itemKeyVersion: 2, itemKeyId: ids.Yhw });
    await attachment("hwAttachment_cek4", "hwAttachment", { cekKeyVersion: 4, cekItemKeyId: null });

    // Untouched control: the 0.5.0 restore-twice double label (marker 0), with an attachment bound to X8.
    const w8 = newWrap();
    await entry("doubleLabel", { itemKeyVersion: 1, itemKeyId: ids.X8, marker: 0, highWater: 1, wrap: w8 });
    await history("doubleLabel_Y", "doubleLabel", { itemKeyVersion: 1, itemKeyId: ids.Y8, wrap: w8 });
    await attachment("doubleLabel_cek", "doubleLabel", { cekKeyVersion: 1, cekItemKeyId: ids.X8 });

    // Untouched control: an id'd entry's NULL-id row of its wrap is not linked.
    const w9 = newWrap();
    await entry("unlinked", { itemKeyVersion: 1, itemKeyId: ids.X9, marker: 3, highWater: 1, wrap: w9 });
    await history("unlinked_null", "unlinked", { itemKeyVersion: 1, itemKeyId: null, wrap: w9 });

    // Wrap-equality controls: the only id'd row differs in team_key_version, in
    // item_key_version, or both rows hold NULL in item_key_auth_tag. Each is minted.
    const w10 = newWrap();
    await entry("ctlTeamKeyVersion", { itemKeyVersion: 1, itemKeyId: null, marker: 3, highWater: 0, wrap: w10 });
    await history("ctlTeamKeyVersion_Y", "ctlTeamKeyVersion", { itemKeyVersion: 1, itemKeyId: ids.Ytkv, teamKeyVersion: 2, wrap: w10 });
    const w11 = newWrap();
    await entry("ctlItemKeyVersion", { itemKeyVersion: 1, itemKeyId: null, marker: 3, highWater: 0, wrap: w11 });
    await history("ctlItemKeyVersion_Y", "ctlItemKeyVersion", { itemKeyVersion: 2, itemKeyId: ids.Yikv, wrap: w11 });
    const w12 = { ...newWrap(), itemKeyAuthTag: null };
    await entry("ctlNullColumn", { itemKeyVersion: 1, itemKeyId: null, marker: 3, highWater: 0, wrap: w12 });
    await history("ctlNullColumn_Y", "ctlNullColumn", { itemKeyVersion: 1, itemKeyId: ids.Ynull, wrap: w12 });
    // Link control: both rows hold NULL in item_key_auth_tag, so the NULL-id row is not linked.
    await history("ctlNullColumn_link", "ctlNullColumn", { itemKeyVersion: 1, itemKeyId: null, wrap: w12 });

    // Repaired: minted; a mode-0 attachment (NULL CEK version) and a CEK above the entry's version
    // and its history max raise the high-water.
    const w16 = newWrap();
    await entry("mintAttachments", { itemKeyVersion: 1, itemKeyId: null, marker: 3, highWater: 0, wrap: w16 });
    await history("mintAttachments_link", "mintAttachments", { itemKeyVersion: 1, itemKeyId: null, wrap: w16 });
    await attachment("mintAttachments_mode0", "mintAttachments", { cekKeyVersion: null, cekItemKeyId: null, mode: 0 });
    await attachment("mintAttachments_cek3", "mintAttachments", { cekKeyVersion: 3, cekItemKeyId: null });

    // Marker above the wrap's team key version (step 4a): reset, on v1+ and v0 alike; equal, or
    // within GREATEST(team_key_version, 1), untouched.
    await entry("aStale", { itemKeyVersion: 1, itemKeyId: ids.Xa, marker: 3, highWater: 1, teamKeyVersion: 2 });
    await entry("aEqual", { itemKeyVersion: 1, itemKeyId: ids.Xae, marker: 3, highWater: 1, teamKeyVersion: 3 });
    await entry("aFloorStale", { itemKeyVersion: 1, itemKeyId: ids.Xaf, marker: 2, highWater: 1, teamKeyVersion: 0 });
    await entry("aZeroTkv", { itemKeyVersion: 1, itemKeyId: ids.Xaz, marker: 1, highWater: 1, teamKeyVersion: 0 });
    await entry("v0Stale", { itemKeyVersion: 0, itemKeyId: null, marker: 3, highWater: 0, teamKeyVersion: 2 });
    await entry("v0Equal", { itemKeyVersion: 0, itemKeyId: null, marker: 3, highWater: 0, teamKeyVersion: 3 });

    // The entry's id at another item_key_version (step 4c), above or below it: on a history row, and
    // on an attachment's CEK, reset; the same id at the entry's version under another wrap, untouched.
    // c1Below's row is the 0.5.0 snapshot of a (v0, id) entry 0.4.77 then upgraded: step 4 reads its
    // id before step 5 clears it.
    await entry("c1", { itemKeyVersion: 1, itemKeyId: ids.Xc1, marker: 3, highWater: 1 });
    await history("c1_v2", "c1", { itemKeyVersion: 2, itemKeyId: ids.Xc1 });
    await entry("c1Below", { itemKeyVersion: 1, itemKeyId: ids.Xc1b, marker: 3, highWater: 1 });
    await history("c1Below_v0", "c1Below", { itemKeyVersion: 0, itemKeyId: ids.Xc1b });
    await entry("c1Twin", { itemKeyVersion: 2, itemKeyId: ids.Xc1t, marker: 3, highWater: 2 });
    await history("c1Twin_v2", "c1Twin", { itemKeyVersion: 2, itemKeyId: ids.Xc1t });
    await entry("c2", { itemKeyVersion: 1, itemKeyId: ids.Xc2, marker: 3, highWater: 1 });
    await attachment("c2_cek2", "c2", { cekKeyVersion: 2, cekItemKeyId: ids.Xc2 });
    await entry("c2Below", { itemKeyVersion: 2, itemKeyId: ids.Xc2b, marker: 3, highWater: 2 });
    await attachment("c2Below_cek1", "c2Below", { cekKeyVersion: 1, cekItemKeyId: ids.Xc2b });
    await entry("c2Twin", { itemKeyVersion: 1, itemKeyId: ids.Xc2t, marker: 3, highWater: 1 });
    await attachment("c2Twin_cek1", "c2Twin", { cekKeyVersion: 1, cekItemKeyId: ids.Xc2t });

    // Wrap-equality controls for step 4b: the row under another id differs in team_key_version, in
    // item_key_version, or both rows hold NULL in item_key_auth_tag. Each keeps its marker.
    const w13 = newWrap();
    await entry("bCtlTeamKeyVersion", { itemKeyVersion: 1, itemKeyId: ids.Xb1, marker: 3, highWater: 1, wrap: w13 });
    await history("bCtlTeamKeyVersion_Y", "bCtlTeamKeyVersion", { itemKeyVersion: 1, itemKeyId: ids.Yb1, teamKeyVersion: 2, wrap: w13 });
    const w14 = newWrap();
    await entry("bCtlItemKeyVersion", { itemKeyVersion: 2, itemKeyId: ids.Xb2, marker: 3, highWater: 2, wrap: w14 });
    await history("bCtlItemKeyVersion_Y", "bCtlItemKeyVersion", { itemKeyVersion: 1, itemKeyId: ids.Yb2, wrap: w14 });
    const w15 = { ...newWrap(), itemKeyAuthTag: null };
    await entry("bCtlNullColumn", { itemKeyVersion: 1, itemKeyId: ids.Xb3, marker: 3, highWater: 1, wrap: w15 });
    await history("bCtlNullColumn_Y", "bCtlNullColumn", { itemKeyVersion: 1, itemKeyId: ids.Yb3, wrap: w15 });

    return { ids, entries, histories, attachments, rows };
  }

  type Shapes = Awaited<ReturnType<typeof seedRepairShapes>>;
  const MINTED = ["mintEmpty", "mintTwo", "mintAttachments", "ctlTeamKeyVersion", "ctlItemKeyVersion", "ctlNullColumn"] as const;

  /**
   * The seeded rows as a map with every id spelled as the seeded name it
   * equals (`Y1`), `minted(<entry>)` for an id the block minted for that
   * entry, or null.
   */
  async function readState(client: pg.PoolClient, s: Shapes) {
    const { rows: entryRows } = await client.query<{ id: string; ik: string | null; m: number; hw: number }>(
      `SELECT id, item_key_id AS ik, item_key_team_key_version AS m, item_key_version_high_water AS hw
         FROM team_password_entries WHERE id = ANY($1::uuid[])`,
      [Object.values(s.entries)],
    );
    const byId = new Map(entryRows.map((r) => [r.id, r]));
    const seededName = new Map(Object.entries(s.ids).map(([n, id]) => [id, n]));
    const entryName = new Map(Object.entries(s.entries).map(([n, id]) => [id, n]));
    const mintedFor = new Map(
      entryRows.filter((r) => r.ik !== null && !seededName.has(r.ik)).map((r) => [r.ik!, `minted(${entryName.get(r.id)})`]),
    );
    const label = (ik: string | null) => (ik === null ? null : seededName.get(ik) ?? mintedFor.get(ik) ?? `unknown ${ik}`);

    const entries = Object.fromEntries(Object.entries(s.entries).map(([n, id]) => {
      const r = byId.get(id);
      return [n, r ? { id: label(r.ik), marker: r.m, hw: r.hw } : "missing"];
    }));
    const { rows: historyRows } = await client.query<{ id: string; ik: string | null }>(
      `SELECT id, item_key_id AS ik FROM team_password_entry_histories WHERE id = ANY($1::uuid[])`,
      [Object.values(s.histories)],
    );
    const historyIk = new Map(historyRows.map((r) => [r.id, r.ik]));
    const histories = Object.fromEntries(Object.entries(s.histories).map(([n, id]) => [n, historyIk.has(id) ? label(historyIk.get(id)!) : "missing"]));
    const { rows: attachmentRows } = await client.query<{ id: string; ik: string | null }>(
      `SELECT id, cek_item_key_id AS ik FROM attachments WHERE id = ANY($1::uuid[])`,
      [Object.values(s.attachments)],
    );
    const attachmentIk = new Map(attachmentRows.map((r) => [r.id, r.ik]));
    const attachments = Object.fromEntries(Object.entries(s.attachments).map(([n, id]) => [n, attachmentIk.has(id) ? label(attachmentIk.get(id)!) : "missing"]));
    return { entries, histories, attachments, mintedIds: [...mintedFor.keys()] };
  }

  /** Rows the current role sees with no bypass and a tenant that owns none of them. */
  async function visibleSeededRows(client: pg.PoolClient, s: Shapes) {
    await setGucs(client, gucSentinels());
    const { rows: [counts] } = await client.query<{ entries: number; histories: number; attachments: number }>(
      `SELECT (SELECT count(*)::int FROM team_password_entries WHERE id = ANY($1::uuid[])) AS entries,
              (SELECT count(*)::int FROM team_password_entry_histories WHERE id = ANY($2::uuid[])) AS histories,
              (SELECT count(*)::int FROM attachments WHERE id = ANY($3::uuid[])) AS attachments`,
      [Object.values(s.entries), Object.values(s.histories), Object.values(s.attachments)],
    );
    return counts;
  }

  const POST_REPAIR = {
    entries: {
      v0WithId: { id: null, marker: 0, hw: 1 },
      adopt: { id: "Y1", marker: 0, hw: 1 },
      mintEmpty: { id: "minted(mintEmpty)", marker: 0, hw: 2 },
      mintTwo: { id: "minted(mintTwo)", marker: 0, hw: 1 },
      f5: { id: "X5", marker: 0, hw: 1 },
      f5Both: { id: "X6", marker: 0, hw: 1 },
      sameId: { id: "X7", marker: 2, hw: 1 },
      hwAttachment: { id: "Xhw", marker: 3, hw: 4 },
      doubleLabel: { id: "X8", marker: 0, hw: 1 },
      unlinked: { id: "X9", marker: 3, hw: 1 },
      ctlTeamKeyVersion: { id: "minted(ctlTeamKeyVersion)", marker: 0, hw: 1 },
      ctlItemKeyVersion: { id: "minted(ctlItemKeyVersion)", marker: 0, hw: 2 },
      ctlNullColumn: { id: "minted(ctlNullColumn)", marker: 0, hw: 1 },
      mintAttachments: { id: "minted(mintAttachments)", marker: 0, hw: 3 },
      aStale: { id: "Xa", marker: 0, hw: 1 },
      aFloorStale: { id: "Xaf", marker: 0, hw: 1 },
      aEqual: { id: "Xae", marker: 3, hw: 1 },
      aZeroTkv: { id: "Xaz", marker: 1, hw: 1 },
      v0Stale: { id: null, marker: 0, hw: 0 },
      v0Equal: { id: null, marker: 3, hw: 0 },
      c1: { id: "Xc1", marker: 0, hw: 2 },
      c1Below: { id: "Xc1b", marker: 0, hw: 1 },
      c1Twin: { id: "Xc1t", marker: 3, hw: 2 },
      c2: { id: "Xc2", marker: 0, hw: 2 },
      c2Below: { id: "Xc2b", marker: 0, hw: 2 },
      c2Twin: { id: "Xc2t", marker: 3, hw: 1 },
      bCtlTeamKeyVersion: { id: "Xb1", marker: 3, hw: 1 },
      bCtlItemKeyVersion: { id: "Xb2", marker: 3, hw: 2 },
      bCtlNullColumn: { id: "Xb3", marker: 3, hw: 1 },
    },
    histories: {
      v0WithId_v0: null,
      adopt_Y: "Y1", adopt_link: "Y1",
      mintEmpty_link: "minted(mintEmpty)", mintEmpty_v2: null, mintEmpty_ikv: null,
      mintTwo_Y: "Y2", mintTwo_Z: "Z2", mintTwo_link: "minted(mintTwo)", mintTwo_tkv: null,
      f5_Y: "Y5",
      f5Both_X: "X6", f5Both_Y: "Y6",
      sameId_X: "X7",
      hwAttachment_v2: "Yhw",
      doubleLabel_Y: "Y8",
      unlinked_null: null,
      ctlTeamKeyVersion_Y: "Ytkv", ctlItemKeyVersion_Y: "Yikv", ctlNullColumn_Y: "Ynull", ctlNullColumn_link: null,
      mintAttachments_link: "minted(mintAttachments)",
      c1_v2: "Xc1", c1Below_v0: null, c1Twin_v2: "Xc1t",
      bCtlTeamKeyVersion_Y: "Yb1", bCtlItemKeyVersion_Y: "Yb2", bCtlNullColumn_Y: "Yb3",
    },
    attachments: {
      hwAttachment_cek4: null, doubleLabel_cek: "X8",
      mintAttachments_mode0: null, mintAttachments_cek3: null,
      c2_cek2: "Xc2", c2Below_cek1: "Xc2b", c2Twin_cek1: "Xc2t",
    },
  };

  it("backfill cell as the owner-shaped role: the literal post-state map, the first run's counts per arm, minted entries in REPAIRED_ROLLOUT_ENTRY's shape, ADD + VALIDATE succeed, a second run changes nothing", async () => {
    await inRolledBackTx(suPool, async (client) => {
      const notices = collectNotices(client);
      try {
        await dropConstraints(client);
        // The block counts the whole database: a first run, before the seeds,
        // repairs any committed residue in a repairable shape (a crashed run
        // elsewhere), so the literal counts below depend only on this cell's rows.
        await client.query(repairBlock());
        notices.messages.length = 0;
        const s = await seedRepairShapes(client);
        await enterOwnerRole(client);

        // Hidden control: without a bypass the role sees none of the rows it repairs.
        expect(await visibleSeededRows(client, s)).toEqual({ entries: 0, histories: 0, attachments: 0 });

        await runBlock(client, repairBlock());

        await client.query("SAVEPOINT as_role");
        await client.query("RESET ROLE");
        const after = await readState(client, s);
        await client.query("ROLLBACK TO SAVEPOINT as_role");
        const { mintedIds, ...map } = after;
        expect(map).toEqual(POST_REPAIR);
        expect(new Set(mintedIds).size).toBe(MINTED.length);
        const markerAndHighWater = (n: string) => {
          const e = after.entries[n];
          return typeof e === "string" ? e : { marker: e.marker, hw: e.hw };
        };
        expect(Object.fromEntries(MINTED.map((n) => [n, markerAndHighWater(n)])))
          .toEqual(Object.fromEntries(MINTED.map((n) => [n, { marker: REPAIRED_ROLLOUT_ENTRY.marker, hw: REPAIRED_ROLLOUT_ENTRY.highWater(s.rows[n]) }])));

        expect(countsOf(notices.messages)).toEqual({
          v0_ids_cleared: 1, ids_adopted: 1, ids_minted: 6, stale_pending: 9,
          history_v0_ids_cleared: 2, history_ids: 4, high_water: 10,
        });

        for (const statement of [...alterStatements(TEAM_ITEM_KEY_ID_CHECK_DIR), ...alterStatements(VALIDATE_DIR)]) {
          expect(await attempt(client, statement)).toBe("accepted");
        }
        const { rows: validated } = await client.query<{ conname: string; convalidated: boolean }>(
          `SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`,
          [[ENTRY_CHECK, HISTORY_CHECK]],
        );
        expect(validated).toEqual([
          { conname: ENTRY_CHECK, convalidated: true },
          { conname: HISTORY_CHECK, convalidated: true },
        ]);

        notices.messages.length = 0;
        await runBlock(client, repairBlock());
        expect(countsOf(notices.messages)).toEqual(ZERO_COUNTS);
        await client.query("RESET ROLE");
        expect(await readState(client, s)).toEqual(after);
      } finally {
        notices.stop();
      }
    });
  });

  // ── 3. VALIDATE is not filtered by RLS ───────────────────────────────────

  describe("VALIDATE cell as the owner-shaped role", () => {
    async function addNotValid(client: pg.PoolClient): Promise<void> {
      for (const statement of alterStatements(TEAM_ITEM_KEY_ID_CHECK_DIR)) await client.query(statement);
    }

    it("a violating row the role cannot see fails VALIDATE of each constraint with 23514", async () => {
      await inRolledBackTx(suPool, async (client) => {
        await dropConstraints(client);
        const s = await seedRepairShapes(client);
        await enterOwnerRole(client);
        await addNotValid(client);
        expect(await visibleSeededRows(client, s)).toEqual({ entries: 0, histories: 0, attachments: 0 });

        const [validateEntries, validateHistories] = alterStatements(VALIDATE_DIR);
        expect({
          entries: await attempt(client, validateEntries),
          histories: await attempt(client, validateHistories),
        }).toEqual({ entries: `${SQLSTATE_CHECK_VIOLATION} ${ENTRY_CHECK}`, histories: `${SQLSTATE_CHECK_VIOLATION} ${HISTORY_CHECK}` });
      });
    });

    it("allow twin: with only rows the CHECKs admit, hidden from the role, VALIDATE of each succeeds", async () => {
      await inRolledBackTx(suPool, async (client) => {
        await dropConstraints(client);
        const clean = await insertEntry(client, { itemKeyVersion: 1, itemKeyId: randomUUID(), marker: 3, highWater: 1 });
        const v0 = await insertEntry(client, { itemKeyVersion: 0, itemKeyId: null, marker: 3, highWater: 0 });
        const histories = [
          await insertHistory(client, clean, { itemKeyVersion: 1, itemKeyId: null }),
          await insertHistory(client, clean, { itemKeyVersion: 0, itemKeyId: null }),
        ];
        await enterOwnerRole(client);
        await addNotValid(client);
        await setGucs(client, gucSentinels());
        const { rows: [visible] } = await client.query<{ entries: number; histories: number }>(
          `SELECT (SELECT count(*)::int FROM team_password_entries WHERE id = ANY($1::uuid[])) AS entries,
                  (SELECT count(*)::int FROM team_password_entry_histories WHERE id = ANY($2::uuid[])) AS histories`,
          [[clean, v0], histories],
        );
        expect(visible).toEqual({ entries: 0, histories: 0 });

        const [validateEntries, validateHistories] = alterStatements(VALIDATE_DIR);
        expect({
          entries: await attempt(client, validateEntries),
          histories: await attempt(client, validateHistories),
        }).toEqual({ entries: "accepted", histories: "accepted" });
      });
    });
  });

  // ── 4. The block's table list ────────────────────────────────────────────

  it.each(BLOCK_TABLES)("table-list control: with %s removed from app.bypass_tables the block is refused and reports it under system_maintenance", async (removed) => {
    const block = repairBlock();
    const literal = /'(team_password_entries,[a-z_,]+)'/.exec(block);
    expect(literal).not.toBeNull();
    const mutated = block.replace(literal![1], literal![1].split(",").filter((t) => t !== removed).join(","));
    expect(mutated).not.toBe(block);
    // The block is the transaction's last statement and the rollback undoes
    // it; the allow twin is the backfill cell, whose same block writes. The
    // seeds are the backfill cell's, so every step has rows that pass its
    // leakproof predicates and reach the table's policy (a step whose
    // predicates filter every row first never evaluates it).
    const { notices, table } = await expectBypassRefusal(() => inRolledBackTx(suPool, async (client) => {
      await dropConstraints(client);
      await seedRepairShapes(client);
      await enterOwnerRole(client);
      await runBlock(client, mutated);
    }));
    expect(table).toBe(removed);
    expect(notices).toContainEqual({ table: removed, purpose: "system_maintenance" });
  });

  // ── 5. Locks ─────────────────────────────────────────────────────────────

  describe("locks: an entry row lock held elsewhere", () => {
    let clean: string;
    beforeEach(async () => {
      clean = randomUUID();
      await sql(
        `INSERT INTO team_password_entries (
           id, team_id, tenant_id, created_by_id, updated_by_id,
           encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag,
           aad_version, team_key_version, item_key_version, encrypted_item_key, item_key_iv, item_key_auth_tag,
           item_key_id, item_key_team_key_version, item_key_version_high_water, entry_type, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid, 'b', $5, $6, 'o', $5, $6,
                   1, 3, 1, $7, $8, $9, $10::uuid, 3, 1, 'LOGIN', now(), now())`,
        clean, teamId, tenantId, userId, hex(12), hex(16), hex(48), hex(12), hex(16), randomUUID(),
      );
    });

    it("(a) with lock_timeout the block fails 55P03 on its LOCK TABLE", async () => {
      const held = await createRaceHelpers(suPool).holdRowLock(
        `SELECT 1 FROM team_password_entries WHERE id = $1::uuid FOR UPDATE`, [clean],
      );
      try {
        const error = await inRolledBackTx(suPool, async (client) => {
          await enterOwnerRole(client);
          await client.query("SET LOCAL lock_timeout = '1500ms'");
          await setGucs(client, gucSentinels());
          return client.query(repairBlock()).then(() => null, (e: unknown) => pgError(e));
        });
        expect(error?.code).toBe("55P03");
        expect(error?.where).toContain(LOCK_STATEMENT);
      } finally {
        await held.release();
      }
    });

    it("(b) while the block waits for the entries lock it holds no lock on the histories or attachments", async () => {
      const race = createRaceHelpers(suPool);
      const held = await race.holdRowLock(`SELECT 1 FROM team_password_entries WHERE id = $1::uuid FOR UPDATE`, [clean]);
      const client = await suPool.connect();
      let running: Promise<ReturnType<typeof pgError> | null> | undefined;
      try {
        await client.query("BEGIN");
        await enterOwnerRole(client);
        const { rows: [{ pid }] } = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
        await setGucs(client, gucSentinels());
        running = client.query(repairBlock()).then(() => null, (e: unknown) => pgError(e));
        expect(await race.waitForBackendBlockedBy(held.pid)).toBe(pid);

        const { rows: locks } = await suPool.query<{ rel: string; mode: string; granted: boolean }>(
          `SELECT c.relname AS rel, l.mode, l.granted
             FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid = $1 AND l.locktype = 'relation'`,
          [pid],
        );
        expect(locks.filter((l) => !l.granted)).toEqual([{ rel: "team_password_entries", mode: "AccessExclusiveLock", granted: false }]);
        expect(locks.filter((l) => l.granted && ["team_password_entry_histories", "attachments"].includes(l.rel))).toEqual([]);

        await held.release();
        expect(await running).toBeNull();
      } finally {
        // Let the parked block finish before the rollback goes on the same client.
        await held.release();
        await running;
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    });
  });
});
