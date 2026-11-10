/**
 * Integration test (real DB): the server side of entry key identity
 * (docs/archive/review/team-key-rotation-rekey-plan.md C1, C3, C6) — the
 * backfill block of migration 20261104000000 (A10), the entry PUT and
 * history-restore writers (A7, A5 IV reuse), the restore holder rule and the
 * rotation carry rules (A12, server parts).
 *
 * Production entry points are driven directly; only the auth, step-up and
 * rate-limit boundaries are mocked (precedent: team-rotate-key.integration.test.ts).
 * Audit rows are read from audit_outbox, so the outbox worker must be stopped
 * (CLAUDE.md "Integration tests and the outbox worker cannot share a database").
 *
 * Run: docker compose up -d db && npm run test:integration -- team-key-rekey-writers
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type pg from "pg";
import {
  appConnectionString,
  BYPASS_ROLE_KIND,
  collectNotices,
  createTestContext,
  enterBypassRole,
  expectBypassNotices,
  gucSentinels,
  parseNoticeCounts,
  readBackfillBlock,
  readGucs,
  RLS_BACKFILL_RERUN_DIR,
  setBypassRlsGucs,
  setGucs,
  setTestBypass,
  type TestContext,
} from "./helpers";
import { createPool } from "@/lib/db/pool-factory";
import { createRaceHelpers } from "./race-helpers";

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: async () => null,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: async () => {},
  }),
}));

import { POST as createEntry } from "@/app/api/teams/[teamId]/passwords/route";
import { PUT as updateEntry } from "@/app/api/teams/[teamId]/passwords/[id]/route";
import { POST as restoreHistory } from "@/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/restore/route";
import { POST as rotateKey } from "@/app/api/teams/[teamId]/rotate-key/route";

function hex(nBytes: number): string {
  return randomBytes(nBytes).toString("hex");
}

function encryptedField() {
  return { ciphertext: hex(32), iv: hex(12), authTag: hex(16) };
}

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Wrap = { encryptedItemKey: string | null; itemKeyIv: string | null; itemKeyAuthTag: string | null };

function newWrap() {
  return { encryptedItemKey: hex(48), itemKeyIv: hex(12), itemKeyAuthTag: hex(16) };
}

type EntryRow = {
  item_key_version: number;
  team_key_version: number;
  item_key_id: string | null;
  item_key_team_key_version: number;
  item_key_version_high_water: number;
  encrypted_blob: string;
  blob_iv: string;
  encrypted_item_key: string | null;
  item_key_iv: string | null;
  item_key_auth_tag: string | null;
  overview_iv: string;
};

describe("team entry key identity writers — real-DB integration", () => {
  let ctx: TestContext;
  let tenantId: string;
  const race = () => createRaceHelpers(ctx.su.pool);

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    vi.clearAllMocks();
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

  async function seedTeam(teamKeyVersion: number): Promise<string> {
    const teamId = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, $4, now(), now())`,
      teamId, tenantId, `team-${teamId.slice(0, 8)}`, teamKeyVersion,
    );
    return teamId;
  }

  async function seedMember(
    teamId: string,
    role: "OWNER" | "ADMIN" | "MEMBER",
    keyVersions: number[],
    opts: { deactivated?: boolean } = {},
  ): Promise<string> {
    const userId = await ctx.createUser(tenantId);
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, deactivated_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", true, $6::timestamptz, now(), now())`,
      randomUUID(), teamId, userId, tenantId, role, opts.deactivated ? new Date().toISOString() : null,
    );
    for (const keyVersion of keyVersions) {
      await sql(
        `INSERT INTO team_member_keys (
           id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv, team_key_auth_tag,
           ephemeral_public_key, hkdf_salt, key_version, wrap_version, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, 1, now(), now())`,
        randomUUID(), teamId, tenantId, userId, hex(32), hex(12), hex(16), hex(32), hex(32), keyVersion,
      );
    }
    return userId;
  }

  async function seedEntry(
    teamId: string,
    userId: string,
    opts: {
      teamKeyVersion: number;
      itemKeyVersion: number;
      itemKeyId?: string | null;
      marker?: number;
      highWater?: number;
      wrap?: Wrap | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    const wrap = opts.itemKeyVersion >= 1 ? (opts.wrap ?? newWrap()) : null;
    const itemKeyId = opts.itemKeyVersion >= 1 ? (opts.itemKeyId ?? randomUUID()) : null;
    await sql(
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
      id, teamId, tenantId, userId, hex(32), hex(12), hex(16), hex(12),
      opts.teamKeyVersion, opts.itemKeyVersion,
      wrap?.encryptedItemKey ?? null, wrap?.itemKeyIv ?? null, wrap?.itemKeyAuthTag ?? null,
      itemKeyId, opts.marker ?? opts.teamKeyVersion, opts.highWater ?? opts.itemKeyVersion,
    );
    return id;
  }

  async function seedHistory(
    entryId: string,
    userId: string,
    opts: { teamKeyVersion: number; itemKeyVersion: number; itemKeyId?: string | null; wrap?: Wrap | null; changedAt?: string },
  ): Promise<string> {
    const id = randomUUID();
    const wrap = opts.wrap === undefined ? (opts.itemKeyVersion >= 1 ? newWrap() : null) : opts.wrap;
    await sql(
      `INSERT INTO team_password_entry_histories (
         id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag,
         aad_version, team_key_version, item_key_version,
         encrypted_item_key, item_key_iv, item_key_auth_tag, item_key_id,
         changed_by_id, changed_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12::uuid, $13::uuid,
                 COALESCE($14::timestamptz, now()))`,
      id, entryId, tenantId, hex(32), hex(12), hex(16),
      opts.teamKeyVersion, opts.itemKeyVersion,
      wrap?.encryptedItemKey ?? null, wrap?.itemKeyIv ?? null, wrap?.itemKeyAuthTag ?? null,
      opts.itemKeyId ?? null, userId, opts.changedAt ?? null,
    );
    return id;
  }

  async function seedAttachment(entryId: string, userId: string, cekKeyVersion: number | null, mode: number): Promise<void> {
    await sql(
      `INSERT INTO attachments (
         id, team_password_entry_id, tenant_id, created_by_id, filename, content_type, size_bytes,
         encrypted_data, iv, auth_tag, key_version, cek_key_version, aad_version, encryption_mode, created_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'f.bin', 'application/octet-stream', 4,
                 '\\x00010203'::bytea, $5, $6, 1, $7, 1, $8, now())`,
      randomUUID(), entryId, tenantId, userId, hex(12), hex(16), cekKeyVersion, mode,
    );
  }

  /**
   * The entries and history rows the backfill's high-water and item_key_id steps read: each
   * high-water term alone (history, CEK attachment, mode-0 attachment, none), and an entry whose
   * history rows equal its wrap except, in turn, exactly one wrap column (or hold a NULL there).
   */
  async function seedIdentityShapes(teamV3: string, owner: string) {
    const hwHistory = await seedEntry(teamV3, owner, { teamKeyVersion: 3, itemKeyVersion: 1 });
    await seedHistory(hwHistory, owner, { teamKeyVersion: 3, itemKeyVersion: 3 });
    const hwAttachment = await seedEntry(teamV3, owner, { teamKeyVersion: 3, itemKeyVersion: 1 });
    await seedHistory(hwAttachment, owner, { teamKeyVersion: 3, itemKeyVersion: 2 });
    const mode0Only = await seedEntry(teamV3, owner, { teamKeyVersion: 3, itemKeyVersion: 2 });
    const neither = await seedEntry(teamV3, owner, { teamKeyVersion: 3, itemKeyVersion: 1 });
    await seedAttachment(hwHistory, owner, 2, 1);
    await seedAttachment(hwAttachment, owner, 4, 1);
    await seedAttachment(mode0Only, owner, null, 0);

    const wrap = newWrap();
    const idEntry = await seedEntry(teamV3, owner, { teamKeyVersion: 3, itemKeyVersion: 2, wrap });
    const other = await seedEntry(teamV3, owner, { teamKeyVersion: 3, itemKeyVersion: 1 });
    const v0 = await seedEntry(teamV3, owner, { teamKeyVersion: 3, itemKeyVersion: 0 });
    const sameLength = (s: string) => hex(s.length / 2);
    const fullMatch = await seedHistory(idEntry, owner, { teamKeyVersion: 3, itemKeyVersion: 2, wrap });
    const variants = {
      teamKeyVersion: await seedHistory(idEntry, owner, { teamKeyVersion: 4, itemKeyVersion: 2, wrap }),
      itemKeyVersion: await seedHistory(idEntry, owner, { teamKeyVersion: 3, itemKeyVersion: 3, wrap }),
      encryptedItemKey: await seedHistory(idEntry, owner, {
        teamKeyVersion: 3, itemKeyVersion: 2, wrap: { ...wrap, encryptedItemKey: sameLength(wrap.encryptedItemKey) },
      }),
      itemKeyIv: await seedHistory(idEntry, owner, {
        teamKeyVersion: 3, itemKeyVersion: 2, wrap: { ...wrap, itemKeyIv: sameLength(wrap.itemKeyIv) },
      }),
      itemKeyAuthTag: await seedHistory(idEntry, owner, {
        teamKeyVersion: 3, itemKeyVersion: 2, wrap: { ...wrap, itemKeyAuthTag: sameLength(wrap.itemKeyAuthTag) },
      }),
    };
    const nullVariants = await Promise.all([
      seedHistory(idEntry, owner, { teamKeyVersion: 3, itemKeyVersion: 2, wrap: { ...wrap, encryptedItemKey: null } }),
      seedHistory(idEntry, owner, { teamKeyVersion: 3, itemKeyVersion: 2, wrap: { ...wrap, itemKeyIv: null } }),
      seedHistory(idEntry, owner, { teamKeyVersion: 3, itemKeyVersion: 2, wrap: { ...wrap, itemKeyAuthTag: null } }),
    ]);
    return { hwHistory, hwAttachment, mode0Only, neither, idEntry, other, v0, fullMatch, variants, nullVariants };
  }

  async function entry(id: string): Promise<EntryRow> {
    const r = await ctx.su.pool.query<EntryRow>(
      `SELECT item_key_version, team_key_version, item_key_id, item_key_team_key_version,
              item_key_version_high_water, encrypted_blob, blob_iv,
              encrypted_item_key, item_key_iv, item_key_auth_tag, overview_iv
         FROM team_password_entries WHERE id = $1::uuid`,
      [id],
    );
    return r.rows[0];
  }

  async function teamVersion(teamId: string): Promise<number> {
    const r = await ctx.su.pool.query<{ team_key_version: number }>(
      `SELECT team_key_version FROM teams WHERE id = $1::uuid`,
      [teamId],
    );
    return r.rows[0].team_key_version;
  }

  /** The blobIv of a history row, as the client reads it before a restore. */
  async function historyBlobIv(historyId: string): Promise<string> {
    const r = await ctx.su.pool.query<{ blob_iv: string }>(
      `SELECT blob_iv FROM team_password_entry_histories WHERE id = $1::uuid`,
      [historyId],
    );
    return r.rows[0]?.blob_iv ?? hex(12);
  }

  /** The row's own blob as the restore body's `encryptedBlob` (the client re-seals it; same AAD for aadVersion-1 rows). */
  async function historyBlob(historyId: string): Promise<{ ciphertext: string; iv: string; authTag: string }> {
    const r = await ctx.su.pool.query<{ encrypted_blob: string; blob_iv: string; blob_auth_tag: string }>(
      `SELECT encrypted_blob, blob_iv, blob_auth_tag FROM team_password_entry_histories WHERE id = $1::uuid`,
      [historyId],
    );
    const row = r.rows[0];
    return row ? { ciphertext: row.encrypted_blob, iv: row.blob_iv, authTag: row.blob_auth_tag } : encryptedField();
  }

  async function restore(teamId: string, entryId: string, historyId: string) {
    return restoreHistory(
      jsonRequest(`http://localhost/api/teams/${teamId}/passwords/${entryId}/history/${historyId}/restore`, "POST", {
        encryptedBlob: await historyBlob(historyId),
        encryptedOverview: encryptedField(),
        snapshotBlobIv: await historyBlobIv(historyId),
      }),
      { params: Promise.resolve({ teamId, id: entryId, historyId }) },
    );
  }

  function put(teamId: string, entryId: string, body: Record<string, unknown>) {
    return updateEntry(
      jsonRequest(`http://localhost/api/teams/${teamId}/passwords/${entryId}`, "PUT", body),
      { params: Promise.resolve({ teamId, id: entryId }) },
    );
  }

  /** A full update reusing the ItemKey `itemKeyId` names. */
  function reusePut(teamId: string, entryId: string, teamKeyVersion: number, itemKeyVersion: number, itemKeyId: string | null) {
    return put(teamId, entryId, {
      encryptedBlob: encryptedField(),
      encryptedOverview: encryptedField(),
      aadVersion: 1,
      teamKeyVersion,
      itemKeyVersion,
      itemKeyId,
    });
  }

  /** The v0→v1 upgrade PUT of an entry whose blob IV the client read as `snapshotBlobIv`. */
  function upgradePut(
    teamId: string,
    entryId: string,
    opts: { teamKeyVersion: number; itemKeyVersion: number; snapshotBlobIv: string; wrapIv?: string },
  ) {
    return put(teamId, entryId, {
      encryptedBlob: encryptedField(),
      encryptedOverview: encryptedField(),
      aadVersion: 1,
      teamKeyVersion: opts.teamKeyVersion,
      itemKeyVersion: opts.itemKeyVersion,
      encryptedItemKey: { ciphertext: hex(48), iv: opts.wrapIv ?? hex(12), authTag: hex(16) },
      snapshotBlobIv: opts.snapshotBlobIv,
    });
  }

  async function errorOf(res: Response): Promise<{ status: number; error: string | undefined }> {
    return { status: res.status, error: res.status === 200 ? undefined : (await res.json()).error };
  }

  // ── A10: the backfill block ──────────────────────────────────────────────

  it("A10: the backfill block sets the marker, the high-water and the item_key_id, and adds no CHECK (it ships in the next release)", async () => {
    const owner1 = await ctx.createUser(tenantId);
    const teamV0 = await seedTeam(0);
    const teamV1 = await seedTeam(1);
    const teamV3 = await seedTeam(3);
    // A team still at version 0 counts as its first version (`<= 1`).
    const atV0 = await seedEntry(teamV0, owner1, { teamKeyVersion: 0, itemKeyVersion: 1 });
    const atV1 = await seedEntry(teamV1, owner1, { teamKeyVersion: 1, itemKeyVersion: 1 });
    const atV3 = await seedEntry(teamV3, owner1, { teamKeyVersion: 3, itemKeyVersion: 1 });

    const {
      hwHistory, hwAttachment, mode0Only, neither, idEntry, other, v0, fullMatch, variants, nullVariants,
    } = await seedIdentityShapes(teamV3, owner1);

    const migration = readFileSync(
      join(process.cwd(), "prisma/migrations/20261104000000_team_key_rotation_rekey/migration.sql"),
      "utf8",
    );
    const block = /-- BEGIN BACKFILL team-key-rotation-rekey\n([\s\S]*?)-- END BACKFILL team-key-rotation-rekey/.exec(migration)?.[1];
    expect(block).toBeDefined();

    const seeded = [atV0, atV1, atV3, hwHistory, hwAttachment, mode0Only, neither, idEntry, other, v0];
    const client = await ctx.su.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE team_password_entries
            SET item_key_team_key_version = 0, item_key_version_high_water = 0, item_key_id = NULL
          WHERE id = ANY($1::uuid[])`,
        [seeded],
      );
      await client.query(`UPDATE team_password_entry_histories SET item_key_id = NULL WHERE entry_id = ANY($1::uuid[])`, [seeded]);
      await client.query(block!);

      const rows = await client.query<{ id: string; m: number; hw: number; ik: string | null }>(
        `SELECT id, item_key_team_key_version AS m, item_key_version_high_water AS hw, item_key_id AS ik
           FROM team_password_entries WHERE id = ANY($1::uuid[])`,
        [seeded],
      );
      const byId = new Map(rows.rows.map((r) => [r.id, r]));
      const at = (id: string) => {
        const row = byId.get(id);
        if (!row) throw new Error(`seeded entry ${id} not found`);
        return row;
      };
      expect({ v0Team: at(atV0).m, v1Team: at(atV1).m, v3Team: at(atV3).m }).toEqual({ v0Team: 1, v1Team: 1, v3Team: 0 });
      expect({
        history: at(hwHistory).hw,
        attachment: at(hwAttachment).hw,
        mode0Only: at(mode0Only).hw,
        neither: at(neither).hw,
      }).toEqual({ history: 3, attachment: 4, mode0Only: 2, neither: 1 });

      const v1Ids = [atV0, atV1, atV3, hwHistory, hwAttachment, mode0Only, neither, idEntry, other].map((id) => at(id).ik);
      expect(v1Ids.every((ik) => ik !== null)).toBe(true);
      expect(new Set(v1Ids).size).toBe(v1Ids.length);
      expect(at(v0).ik).toBeNull();

      const hist = await client.query<{ id: string; ik: string | null }>(
        `SELECT id, item_key_id AS ik FROM team_password_entry_histories WHERE entry_id = $1::uuid`,
        [idEntry],
      );
      const histId = new Map(hist.rows.map((r) => [r.id, r.ik]));
      expect(histId.get(fullMatch)).toBe(at(idEntry).ik);
      expect(Object.fromEntries(Object.entries(variants).map(([k, id]) => [k, histId.get(id)]))).toEqual({
        teamKeyVersion: null, itemKeyVersion: null, encryptedItemKey: null, itemKeyIv: null, itemKeyAuthTag: null,
      });
      expect(nullVariants.map((id) => histId.get(id))).toEqual([null, null, null]);

      // A previous-release instance writes a v1 entry without an id during
      // rollout; this release accepts the row (and treats it as pending).
      const constraint = await client.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'team_password_entries_item_key_id_iff_item_key'`,
      );
      expect(constraint.rowCount).toBe(0);
      await client.query(
        `INSERT INTO team_password_entries (
           id, team_id, tenant_id, created_by_id, updated_by_id,
           encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag,
           item_key_version, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid, 'b', $5, $6, 'o', $5, $6, 1, now(), now())`,
        [randomUUID(), teamV3, tenantId, owner1, hex(12), hex(16)],
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("A10: entry create on a team at version 2 marks the entry current and mints the id for an ItemKey", async () => {
    const teamId = await seedTeam(2);
    const owner = await seedMember(teamId, "OWNER", [1, 2]);
    mockAuth.mockResolvedValue({ user: { id: owner } });

    const create = (body: Record<string, unknown>) =>
      createEntry(jsonRequest(`http://localhost/api/teams/${teamId}/passwords`, "POST", body), {
        params: Promise.resolve({ teamId }),
      });
    const v1Id = randomUUID();
    const v0Id = randomUUID();
    const base = { encryptedBlob: encryptedField(), encryptedOverview: encryptedField(), aadVersion: 1, teamKeyVersion: 2 };
    expect((await create({ ...base, id: v1Id, itemKeyVersion: 1, encryptedItemKey: encryptedField() })).status).toBe(201);
    expect((await create({ ...base, id: v0Id })).status).toBe(201);

    const v1 = await entry(v1Id);
    const v0 = await entry(v0Id);
    expect({ marker: v1.item_key_team_key_version, highWater: v1.item_key_version_high_water, id: v1.item_key_id !== null })
      .toEqual({ marker: 2, highWater: 1, id: true });
    expect({ marker: v0.item_key_team_key_version, highWater: v0.item_key_version_high_water, id: v0.item_key_id })
      .toEqual({ marker: 2, highWater: 0, id: null });
  });

  // ── A7: restore and PUT ──────────────────────────────────────────────────

  it("A7: restore of a v0 row at an old team key version → stale v1 PUT refused → upgrade (high-water + 1) → still pending", async () => {
    const teamId = await seedTeam(2);
    const owner = await seedMember(teamId, "OWNER", [1, 2]);
    mockAuth.mockResolvedValue({ user: { id: owner } });
    const liveId = randomUUID();
    const entryId = await seedEntry(teamId, owner, { teamKeyVersion: 2, itemKeyVersion: 1, itemKeyId: liveId });
    const v0Row = await seedHistory(entryId, owner, { teamKeyVersion: 1, itemKeyVersion: 0 });

    expect((await restore(teamId, entryId, v0Row)).status).toBe(200);
    const restored = await entry(entryId);
    expect({
      itemKeyVersion: restored.item_key_version,
      id: restored.item_key_id,
      marker: restored.item_key_team_key_version,
      teamKeyVersion: restored.team_key_version,
      highWater: restored.item_key_version_high_water,
    }).toEqual({ itemKeyVersion: 0, id: null, marker: 0, teamKeyVersion: 1, highWater: 1 });

    // A client still holding the pre-restore v1 view.
    expect(await errorOf(await reusePut(teamId, entryId, 2, 1, liveId))).toEqual({ status: 409, error: "ITEM_KEY_CHANGED" });
    // The upgrade must take high-water + 1 (= 2): + 2 is refused, + 1 accepted.
    expect(await errorOf(await upgradePut(teamId, entryId, { teamKeyVersion: 2, itemKeyVersion: 3, snapshotBlobIv: restored.blob_iv })))
      .toEqual({ status: 409, error: "ITEM_KEY_VERSION_INVALID" });
    expect((await upgradePut(teamId, entryId, { teamKeyVersion: 2, itemKeyVersion: 2, snapshotBlobIv: restored.blob_iv })).status)
      .toBe(200);

    const upgraded = await entry(entryId);
    expect(upgraded.item_key_id).not.toBeNull();
    expect(upgraded.item_key_id).not.toBe(liveId);
    expect({
      itemKeyVersion: upgraded.item_key_version,
      teamKeyVersion: upgraded.team_key_version,
      highWater: upgraded.item_key_version_high_water,
      // The upgrade leaves the marker as it was: the entry is still pending re-key.
      pending: upgraded.item_key_team_key_version < (await teamVersion(teamId)),
    }).toEqual({ itemKeyVersion: 2, teamKeyVersion: 2, highWater: 2, pending: true });

    // After the upgrade, the restore-era v1 view is stale too; a fresh read's id is accepted.
    expect(await errorOf(await reusePut(teamId, entryId, 2, 2, liveId))).toEqual({ status: 409, error: "ITEM_KEY_CHANGED" });
    expect((await reusePut(teamId, entryId, 2, 2, upgraded.item_key_id)).status).toBe(200);
  });

  it("A7: restore of a v1 row at an old team key version → a full update needs re-key, a stale id is refused first, a metadata-only PUT passes", async () => {
    const teamId = await seedTeam(2);
    const owner = await seedMember(teamId, "OWNER", [1, 2]);
    mockAuth.mockResolvedValue({ user: { id: owner } });
    const liveId = randomUUID();
    const oldId = randomUUID();
    const entryId = await seedEntry(teamId, owner, { teamKeyVersion: 2, itemKeyVersion: 1, itemKeyId: liveId });
    const v1Row = await seedHistory(entryId, owner, { teamKeyVersion: 1, itemKeyVersion: 1, itemKeyId: oldId });

    expect((await restore(teamId, entryId, v1Row)).status).toBe(200);
    const restored = await entry(entryId);
    expect({ id: restored.item_key_id, marker: restored.item_key_team_key_version, teamKeyVersion: restored.team_key_version })
      .toEqual({ id: oldId, marker: 0, teamKeyVersion: 1 });

    expect(await errorOf(await reusePut(teamId, entryId, 2, 1, oldId))).toEqual({ status: 409, error: "ENTRY_REKEY_REQUIRED" });
    // Check order: a stale id on the same stale entry answers ITEM_KEY_CHANGED.
    expect(await errorOf(await reusePut(teamId, entryId, 2, 1, liveId))).toEqual({ status: 409, error: "ITEM_KEY_CHANGED" });
    expect((await put(teamId, entryId, { isArchived: true })).status).toBe(200);
    expect(await entry(entryId)).toEqual(restored);
  });

  it("A7: on a team at version 1, restoring NULL-id rows A then B mints distinct ids; a PUT with A's id after B is refused", async () => {
    const teamId = await seedTeam(1);
    const owner = await seedMember(teamId, "OWNER", [1]);
    mockAuth.mockResolvedValue({ user: { id: owner } });
    const entryId = await seedEntry(teamId, owner, { teamKeyVersion: 1, itemKeyVersion: 1 });
    const rowA = await seedHistory(entryId, owner, { teamKeyVersion: 1, itemKeyVersion: 1, itemKeyId: null });
    const rowB = await seedHistory(entryId, owner, { teamKeyVersion: 1, itemKeyVersion: 1, itemKeyId: null });
    const rowV0 = await seedHistory(entryId, owner, { teamKeyVersion: 1, itemKeyVersion: 0 });
    const before = await entry(entryId);
    expect(before.item_key_team_key_version).toBe(await teamVersion(teamId));

    expect((await restore(teamId, entryId, rowA)).status).toBe(200);
    const afterA = await entry(entryId);
    expect(afterA.item_key_id).not.toBeNull();
    expect(afterA.item_key_id).not.toBe(before.item_key_id);
    expect(afterA.item_key_team_key_version).toBe(0);

    expect((await restore(teamId, entryId, rowB)).status).toBe(200);
    const afterB = await entry(entryId);
    expect(afterB.item_key_id).not.toBeNull();
    expect(afterB.item_key_id).not.toBe(afterA.item_key_id);

    expect(await errorOf(await reusePut(teamId, entryId, 1, 1, afterA.item_key_id))).toEqual({ status: 409, error: "ITEM_KEY_CHANGED" });
    // Control: a fresh read's id.
    expect((await reusePut(teamId, entryId, 1, 1, afterB.item_key_id)).status).toBe(200);

    expect((await restore(teamId, entryId, rowV0)).status).toBe(200);
    expect((await entry(entryId)).item_key_id).toBeNull();
  });

  it("A7: restoring a row that holds the live ItemKey keeps the marker and the id", async () => {
    const teamId = await seedTeam(2);
    const owner = await seedMember(teamId, "OWNER", [2]);
    mockAuth.mockResolvedValue({ user: { id: owner } });
    const liveId = randomUUID();
    const entryId = await seedEntry(teamId, owner, { teamKeyVersion: 2, itemKeyVersion: 1, itemKeyId: liveId });
    // An edit snapshots the live row — its item_key_id included — into history.
    expect((await reusePut(teamId, entryId, 2, 1, liveId)).status).toBe(200);
    const snap = await ctx.su.pool.query<{ id: string; item_key_id: string | null }>(
      `SELECT id, item_key_id FROM team_password_entry_histories WHERE entry_id = $1::uuid`,
      [entryId],
    );
    expect(snap.rows.map((r) => r.item_key_id)).toEqual([liveId]);

    expect((await restore(teamId, entryId, snap.rows[0].id)).status).toBe(200);
    const restored = await entry(entryId);
    expect({ id: restored.item_key_id, marker: restored.item_key_team_key_version }).toEqual({ id: liveId, marker: 2 });
  });

  it("A5: an upgrade PUT whose wrap IV a history row already used is refused; a fresh IV is accepted", async () => {
    const teamId = await seedTeam(1);
    const owner = await seedMember(teamId, "OWNER", [1]);
    mockAuth.mockResolvedValue({ user: { id: owner } });
    const entryId = await seedEntry(teamId, owner, { teamKeyVersion: 1, itemKeyVersion: 0, highWater: 1 });
    const usedWrap = newWrap();
    await seedHistory(entryId, owner, { teamKeyVersion: 1, itemKeyVersion: 1, wrap: usedWrap });
    const { blob_iv: blobIv } = await entry(entryId);

    expect(await errorOf(await upgradePut(teamId, entryId, {
      teamKeyVersion: 1, itemKeyVersion: 2, snapshotBlobIv: blobIv, wrapIv: usedWrap.itemKeyIv,
    }))).toEqual({ status: 400, error: "ITEM_KEY_IV_REUSED" });
    expect((await upgradePut(teamId, entryId, { teamKeyVersion: 1, itemKeyVersion: 2, snapshotBlobIv: blobIv })).status).toBe(200);
  });

  // ── A12: restore holder rule and rotation carries ────────────────────────

  it("A12: a restore of a row whose version only a deactivated member, or no one, holds is refused; with an active holder it succeeds", async () => {
    const teamId = await seedTeam(2);
    // The admin and a member who joined after v1 (key_distributed, v2 only) are not holders of v1.
    const admin = await seedMember(teamId, "ADMIN", [2]);
    await seedMember(teamId, "MEMBER", [2]);
    const departed = await seedMember(teamId, "MEMBER", [1, 2], { deactivated: true });
    mockAuth.mockResolvedValue({ user: { id: admin } });
    const entryId = await seedEntry(teamId, admin, { teamKeyVersion: 2, itemKeyVersion: 1 });
    const oldRow = await seedHistory(entryId, admin, { teamKeyVersion: 1, itemKeyVersion: 1 });
    const live = await entry(entryId);

    expect(await errorOf(await restore(teamId, entryId, oldRow))).toEqual({ status: 409, error: "HISTORY_KEY_UNAVAILABLE" });
    expect(await entry(entryId)).toEqual(live);

    await sql(
      `UPDATE team_members SET deactivated_at = NULL WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      teamId, departed,
    );
    expect((await restore(teamId, entryId, oldRow)).status).toBe(200);
  });

  describe("A12: rotation carry", () => {
    type CarrySeed = { teamId: string; holder: string; nonHolder: string; carried: string; rotated: string };

    async function seedCarry(): Promise<CarrySeed> {
      const teamId = await seedTeam(2);
      const holder = await seedMember(teamId, "OWNER", [1, 2]);
      const nonHolder = await seedMember(teamId, "ADMIN", [2]);
      // `carried` stays at team key version 1 (a planted or restored entry);
      // `rotated` is an ordinary entry at the current version.
      const carried = await seedEntry(teamId, holder, { teamKeyVersion: 1, itemKeyVersion: 1, marker: 0 });
      const rotated = await seedEntry(teamId, holder, { teamKeyVersion: 2, itemKeyVersion: 1 });
      return { teamId, holder, nonHolder, carried, rotated };
    }

    async function rotate(seed: CarrySeed, actor: string, reason: string) {
      mockAuth.mockResolvedValue({ user: { id: actor } });
      const rotated = await entry(seed.rotated);
      return rotateKey(
        jsonRequest(`http://localhost/api/teams/${seed.teamId}/rotate-key`, "POST", {
          newTeamKeyVersion: 3,
          entries: [{
            id: seed.rotated,
            itemKeyVersion: 1,
            snapshotIv: rotated.item_key_iv,
            encryptedItemKey: encryptedField(),
            aadVersion: 1,
          }],
          carry: [{ id: seed.carried, teamKeyVersion: 1, reason }],
          memberKeys: [seed.holder, seed.nonHolder].map((userId) => ({
            userId, encryptedTeamKey: hex(32), teamKeyIv: hex(12), teamKeyAuthTag: hex(16),
            ephemeralPublicKey: hex(32), hkdfSalt: hex(32), keyVersion: 3,
          })),
        }),
        { params: Promise.resolve({ teamId: seed.teamId }) },
      );
    }

    async function carryAudits(entryId: string) {
      const r = await ctx.su.pool.query<{ payload: { userId: string; targetId: string; metadata: unknown } }>(
        `SELECT payload FROM audit_outbox
          WHERE payload->>'action' = 'TEAM_KEY_ROTATION_CARRY' AND payload->>'targetId' = $1`,
        [entryId],
      );
      return r.rows.map((row) => row.payload);
    }

    it("a not_held carry by an actor holding the entry's version is refused (TEAM_ROTATE_KEY_UNAVAILABLE)", async () => {
      const seed = await seedCarry();
      expect(await errorOf(await rotate(seed, seed.holder, "not_held"))).toEqual({ status: 409, error: "TEAM_ROTATE_KEY_UNAVAILABLE" });
      expect(await teamVersion(seed.teamId)).toBe(2);
    });

    it.each(["undecryptable", "key_invalid"])(
      "a %s carry by an actor not holding the entry's version is refused (TEAM_ROTATE_CARRY_INVALID)",
      async (reason) => {
        const seed = await seedCarry();
        expect(await errorOf(await rotate(seed, seed.nonHolder, reason))).toEqual({ status: 409, error: "TEAM_ROTATE_CARRY_INVALID" });
        expect(await teamVersion(seed.teamId)).toBe(2);
      },
    );

    it("a not_held carry by a non-holder is accepted", async () => {
      const seed = await seedCarry();
      expect((await rotate(seed, seed.nonHolder, "not_held")).status).toBe(200);
      expect(await teamVersion(seed.teamId)).toBe(3);
    });

    it.each(["undecryptable", "key_invalid"])(
      "a %s carry by a holder is accepted: the carried entry is byte-identical and pending, audited per entry; rotation leaves ids, markers and high-water alone",
      async (reason) => {
        const seed = await seedCarry();
        const carriedBefore = await entry(seed.carried);
        const rotatedBefore = await entry(seed.rotated);

        expect((await rotate(seed, seed.holder, reason)).status).toBe(200);

        expect(await teamVersion(seed.teamId)).toBe(3);
        expect(await entry(seed.carried)).toEqual(carriedBefore);
        const rotatedAfter = await entry(seed.rotated);
        expect(rotatedAfter.item_key_iv).not.toBe(rotatedBefore.item_key_iv);
        expect({
          id: rotatedAfter.item_key_id,
          marker: rotatedAfter.item_key_team_key_version,
          highWater: rotatedAfter.item_key_version_high_water,
          teamKeyVersion: rotatedAfter.team_key_version,
        }).toEqual({
          id: rotatedBefore.item_key_id,
          marker: rotatedBefore.item_key_team_key_version,
          highWater: rotatedBefore.item_key_version_high_water,
          teamKeyVersion: 3,
        });
        expect(await carryAudits(seed.carried)).toEqual([
          expect.objectContaining({ userId: seed.holder, targetId: seed.carried, metadata: { reason, teamKeyVersion: 1 } }),
        ]);
      },
    );
  });

  // ── The actor's role, re-read under the team lock (PUT, restore) ─────────

  describe("ACTOR_NOT_PERMITTED: entry PUT and history restore re-read the actor's role under the team lock", () => {
    /**
     * Park `send` on the team FOR SHARE behind a blocker holding the team
     * row; the blocker optionally changes the actor's role, then commits.
     */
    async function parkedBehindTeamRow(
      teamId: string,
      actor: string,
      send: () => Promise<Response>,
      demoteTo: "MEMBER" | "VIEWER" | null,
    ) {
      const r = race();
      return r.parkBehind(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [teamId], send, async (blocker, parkedPid) => {
        expect(await r.waitingQueryOf(parkedPid)).toMatch(/FROM teams WHERE id = .* FOR SHARE/s);
        if (demoteTo) {
          await blocker.query(
            `UPDATE team_members SET role = $3::"TeamRole" WHERE team_id = $1::uuid AND user_id = $2::uuid`,
            [teamId, actor, demoteTo],
          );
        }
      });
    }

    /** An ADMIN editing an entry another member created. */
    async function seedAdminEdit() {
      const teamId = await seedTeam(1);
      const owner = await seedMember(teamId, "OWNER", [1]);
      const admin = await seedMember(teamId, "ADMIN", [1]);
      const itemKeyId = randomUUID();
      const entryId = await seedEntry(teamId, owner, { teamKeyVersion: 1, itemKeyVersion: 1, itemKeyId });
      mockAuth.mockResolvedValue({ user: { id: admin } });
      return { teamId, admin, entryId, itemKeyId };
    }

    it("PUT: demoted to MEMBER while parked (the entry is another member's) → 403 ACTOR_NOT_PERMITTED, nothing written", async () => {
      const s = await seedAdminEdit();
      const before = await entry(s.entryId);
      const res = await parkedBehindTeamRow(s.teamId, s.admin, () => reusePut(s.teamId, s.entryId, 1, 1, s.itemKeyId), "MEMBER");
      expect(await errorOf(res)).toEqual({ status: 403, error: "ACTOR_NOT_PERMITTED" });
      expect(await entry(s.entryId)).toEqual(before);
    });

    it("PUT: demoted to VIEWER while parked → 403 ACTOR_NOT_PERMITTED", async () => {
      const s = await seedAdminEdit();
      const res = await parkedBehindTeamRow(s.teamId, s.admin, () => reusePut(s.teamId, s.entryId, 1, 1, s.itemKeyId), "VIEWER");
      expect(await errorOf(res)).toEqual({ status: 403, error: "ACTOR_NOT_PERMITTED" });
    });

    it("PUT control: the blocker commits without a role change → 200", async () => {
      const s = await seedAdminEdit();
      const res = await parkedBehindTeamRow(s.teamId, s.admin, () => reusePut(s.teamId, s.entryId, 1, 1, s.itemKeyId), null);
      expect(res.status).toBe(200);
    });

    async function seedAdminRestore() {
      const s = await seedAdminEdit();
      const historyId = await seedHistory(s.entryId, s.admin, { teamKeyVersion: 1, itemKeyVersion: 1, itemKeyId: s.itemKeyId });
      return { ...s, historyId };
    }

    it("restore: demoted to VIEWER while parked → 403 ACTOR_NOT_PERMITTED, nothing written", async () => {
      const s = await seedAdminRestore();
      const before = await entry(s.entryId);
      const res = await parkedBehindTeamRow(s.teamId, s.admin, () => restore(s.teamId, s.entryId, s.historyId), "VIEWER");
      expect(await errorOf(res)).toEqual({ status: 403, error: "ACTOR_NOT_PERMITTED" });
      expect(await entry(s.entryId)).toEqual(before);
    });

    it("restore control: the blocker commits without a role change → 200", async () => {
      const s = await seedAdminRestore();
      const res = await parkedBehindTeamRow(s.teamId, s.admin, () => restore(s.teamId, s.entryId, s.historyId), null);
      expect(res.status).toBe(200);
    });
  });

  // ── C1: 20261110000000_rls_backfill_rerun, re-key block ──────────────────

  describe("C1: rls_backfill_rerun — team-key-rotation-rekey-rerun", () => {
    const ORIGINAL_DIR = "20261104000000_team_key_rotation_rekey";
    const BLOCK_TABLES = ["teams", "team_password_entries", "team_password_entry_histories", "attachments"] as const;
    const RERUN_REPORT = "team-key-rotation-rekey-rerun backfill:";

    let appPool: pg.Pool;
    beforeAll(() => {
      appPool = createPool({ connectionString: appConnectionString(), max: 3 });
    });
    afterAll(async () => {
      await appPool.end();
    });

    type EntryState = { marker: number; hw: number; hasId: boolean };
    type Fx = {
      teamV1: string;
      entries: Record<string, string>;
      histories: Record<string, { id: string; entry: string }>;
    };

    /**
     * Pre-change rows (marker 0, high-water 0, no ids) of every shape the steps move, beside
     * app-written rows the steps must leave: one that a real history restore left at marker 0
     * with a high-water of 1 on a team at version 1.
     */
    async function seedFixtures(): Promise<Fx> {
      const teamV0 = await seedTeam(0);
      const teamV1 = await seedTeam(1);
      const teamV3 = await seedTeam(3);
      const owner = await seedMember(teamV1, "OWNER", [1]);
      const entries: Fx["entries"] = {};
      const histories: Fx["histories"] = {};

      entries.atV1 = await seedEntry(teamV1, owner, { teamKeyVersion: 1, itemKeyVersion: 1 });
      entries.atV0Team = await seedEntry(teamV0, owner, { teamKeyVersion: 0, itemKeyVersion: 1 });
      entries.atV3 = await seedEntry(teamV3, owner, { teamKeyVersion: 3, itemKeyVersion: 1 });
      entries.v0Entry = await seedEntry(teamV1, owner, { teamKeyVersion: 1, itemKeyVersion: 0 });
      const shapes = await seedIdentityShapes(teamV3, owner);
      Object.assign(entries, {
        hwHistory: shapes.hwHistory, hwAttachment: shapes.hwAttachment, mode0Only: shapes.mode0Only,
        neither: shapes.neither, idEntry: shapes.idEntry, other: shapes.other, v0Shape: shapes.v0,
      });
      histories.identical = { id: shapes.fullMatch, entry: "idEntry" };
      for (const [column, id] of Object.entries(shapes.variants)) histories[`differsIn_${column}`] = { id, entry: "idEntry" };
      shapes.nullVariants.forEach((id, i) => {
        histories[`null_${["encryptedItemKey", "itemKeyIv", "itemKeyAuthTag"][i]}`] = { id, entry: "idEntry" };
      });

      // The pre-change state: what the columns held before the key-identity release.
      await sql(
        `UPDATE team_password_entries SET item_key_team_key_version = 0, item_key_version_high_water = 0, item_key_id = NULL WHERE id = ANY($1::uuid[])`,
        [Object.values(entries)],
      );
      await sql(`UPDATE team_password_entry_histories SET item_key_id = NULL WHERE entry_id = ANY($1::uuid[])`, [Object.values(entries)]);

      // App-written rows.
      entries.appCurrent = await seedEntry(teamV1, owner, { teamKeyVersion: 1, itemKeyVersion: 1, marker: 1, highWater: 1 });
      entries.appPending = await seedEntry(teamV3, owner, { teamKeyVersion: 3, itemKeyVersion: 1, marker: 0, highWater: 1 });
      entries.stragglerNoId = await seedEntry(teamV3, owner, { teamKeyVersion: 3, itemKeyVersion: 1, marker: 0, highWater: 1 });
      await sql(`UPDATE team_password_entries SET item_key_id = NULL WHERE id = $1::uuid`, entries.stragglerNoId);

      // An app-written entry whose high-water sits above everything its own rows hold: the raise-only guard must keep it.
      entries.appHighWaterAbove = await seedEntry(teamV3, owner, { teamKeyVersion: 3, itemKeyVersion: 1, marker: 0, highWater: 5 });

      // Restored through the real route to a NULL-id row on a team at version 1: marker 0, high-water 1.
      entries.restored = await seedEntry(teamV1, owner, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const snapshot = await seedHistory(entries.restored, owner, { teamKeyVersion: 1, itemKeyVersion: 1, itemKeyId: null });
      mockAuth.mockResolvedValue({ user: { id: owner } });
      expect((await restore(teamV1, entries.restored, snapshot)).status).toBe(200);
      const restoredRow = await entry(entries.restored);
      expect({ marker: restoredRow.item_key_team_key_version, hw: restoredRow.item_key_version_high_water, hasId: restoredRow.item_key_id !== null })
        .toEqual({ marker: 0, hw: 1, hasId: true });
      return { teamV1, entries, histories };
    }

    async function readState(client: pg.PoolClient, fx: Fx) {
      const names = Object.keys(fx.entries);
      const rows = await client.query<{ id: string; m: number; hw: number; ik: string | null }>(
        `SELECT id, item_key_team_key_version AS m, item_key_version_high_water AS hw, item_key_id AS ik
           FROM team_password_entries WHERE id = ANY($1::uuid[])`,
        [names.map((n) => fx.entries[n])],
      );
      const byId = new Map(rows.rows.map((r) => [r.id, r]));
      const entriesState: Record<string, EntryState> = Object.fromEntries(names.map((n) => {
        const r = byId.get(fx.entries[n])!;
        return [n, { marker: r.m, hw: r.hw, hasId: r.ik !== null }];
      }));
      const hist = await client.query<{ id: string; ik: string | null }>(
        `SELECT id, item_key_id AS ik FROM team_password_entry_histories WHERE id = ANY($1::uuid[])`,
        [Object.values(fx.histories).map((h) => h.id)],
      );
      const histIk = new Map(hist.rows.map((r) => [r.id, r.ik]));
      const histories = Object.fromEntries(Object.entries(fx.histories).map(([n, h]) => {
        const ik = histIk.get(h.id) ?? null;
        return [n, ik === null ? null : ik === byId.get(fx.entries[h.entry])!.ik ? "entry's id" : "other id"];
      }));
      return { entries: entriesState, histories };
    }

    const NO_HISTORY_IDS = {
      identical: null, differsIn_teamKeyVersion: null, differsIn_itemKeyVersion: null,
      differsIn_encryptedItemKey: null, differsIn_itemKeyIv: null, differsIn_itemKeyAuthTag: null,
      null_encryptedItemKey: null, null_itemKeyIv: null, null_itemKeyAuthTag: null,
    };
    const PRE = {
      entries: {
        atV1: { marker: 0, hw: 0, hasId: false }, atV0Team: { marker: 0, hw: 0, hasId: false },
        atV3: { marker: 0, hw: 0, hasId: false }, v0Entry: { marker: 0, hw: 0, hasId: false },
        hwHistory: { marker: 0, hw: 0, hasId: false }, hwAttachment: { marker: 0, hw: 0, hasId: false },
        idEntry: { marker: 0, hw: 0, hasId: false }, mode0Only: { marker: 0, hw: 0, hasId: false },
        neither: { marker: 0, hw: 0, hasId: false }, other: { marker: 0, hw: 0, hasId: false },
        v0Shape: { marker: 0, hw: 0, hasId: false },
        appCurrent: { marker: 1, hw: 1, hasId: true }, appPending: { marker: 0, hw: 1, hasId: true },
        appHighWaterAbove: { marker: 0, hw: 5, hasId: true },
        stragglerNoId: { marker: 0, hw: 1, hasId: false }, restored: { marker: 0, hw: 1, hasId: true },
      },
      histories: NO_HISTORY_IDS,
    };
    /** Steps 2-4 on any role; step 1 (marker) additionally where the role cannot bypass. */
    const POST_STEPS_2_TO_4 = {
      entries: {
        atV1: { marker: 0, hw: 1, hasId: true }, atV0Team: { marker: 0, hw: 1, hasId: true },
        atV3: { marker: 0, hw: 1, hasId: true }, v0Entry: { marker: 0, hw: 0, hasId: false },
        hwHistory: { marker: 0, hw: 3, hasId: true }, hwAttachment: { marker: 0, hw: 4, hasId: true },
        idEntry: { marker: 0, hw: 3, hasId: true }, mode0Only: { marker: 0, hw: 2, hasId: true },
        neither: { marker: 0, hw: 1, hasId: true }, other: { marker: 0, hw: 1, hasId: true },
        v0Shape: { marker: 0, hw: 0, hasId: false },
        appCurrent: { marker: 1, hw: 1, hasId: true }, appPending: { marker: 0, hw: 1, hasId: true },
        appHighWaterAbove: { marker: 0, hw: 5, hasId: true },
        stragglerNoId: { marker: 0, hw: 1, hasId: true }, restored: { marker: 0, hw: 1, hasId: true },
      },
      histories: { ...NO_HISTORY_IDS, identical: "entry's id" },
    };
    const POST_APP_ROLE = {
      ...POST_STEPS_2_TO_4,
      entries: {
        ...POST_STEPS_2_TO_4.entries,
        atV1: { marker: 1, hw: 1, hasId: true }, atV0Team: { marker: 1, hw: 1, hasId: true },
        v0Entry: { marker: 1, hw: 0, hasId: false },
      },
    };

    async function asApp<T>(fn: (client: pg.PoolClient, notices: string[]) => Promise<T>): Promise<T> {
      const client = await appPool.connect();
      const collected = collectNotices(client);
      try {
        const [principal] = (await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
        )).rows;
        expect(principal).toEqual({ rolsuper: false, rolbypassrls: false });
        await client.query("BEGIN");
        return await fn(client, collected.messages);
      } finally {
        collected.stop();
        await client.query("ROLLBACK");
        client.release();
      }
    }

    /** Runs the block with the settings sentinels in place and asserts it left them as found (I3). */
    async function runBlock(client: pg.PoolClient, block: string): Promise<void> {
      const sentinels = gucSentinels();
      await setGucs(client, sentinels);
      await client.query(block);
      expect(await readGucs(client)).toEqual(sentinels);
    }

    async function stateUnderTestBypass(client: pg.PoolClient, fx: Fx) {
      await setTestBypass(client, BLOCK_TABLES);
      return readState(client, fx);
    }

    const countsOf = (messages: string[], prefix: string) => {
      const line = messages.filter((m) => m.startsWith(prefix));
      expect(line).toHaveLength(1);
      return parseNoticeCounts(line[0]);
    };
    const rerunRekey = () => readBackfillBlock(RLS_BACKFILL_RERUN_DIR, "team-key-rotation-rekey-rerun");

    let fx: Fx;
    beforeEach(async () => {
      fx = await seedFixtures();
    });

    it("control: the ORIGINAL block as passwd_app changes nothing and reports zero everywhere; under a test bypass it moves the fixtures", async () => {
      await asApp(async (client, notices) => {
        const original = readBackfillBlock(ORIGINAL_DIR, "team-key-rotation-rekey");
        expect(await stateUnderTestBypass(client, fx)).toEqual(PRE);

        await runBlock(client, original);
        const counts = countsOf(notices, "team-key-rotation-rekey backfill:");
        expect(counts).toEqual({ marker: 0, high_water: 0, entry_ids: 0, history_ids: 0 });
        expect(await stateUnderTestBypass(client, fx)).toEqual(PRE);

        // Positive control: the same block with the bypass it lacked.
        await setTestBypass(client, BLOCK_TABLES);
        notices.length = 0;
        await client.query(original);
        const changed = countsOf(notices, "team-key-rotation-rekey backfill:");
        expect(changed.marker).toBeGreaterThan(0);
        expect(changed.entry_ids).toBeGreaterThan(0);
        expect((await readState(client, fx)).entries.atV1).toEqual({ marker: 1, hw: 1, hasId: true });
      });
    });

    it("C1 as passwd_app: markers, high-water, ids and history ids are what the literal map says; the restored entry stays pending", async () => {
      await asApp(async (client) => {
        await runBlock(client, rerunRekey());
        expect(await stateUnderTestBypass(client, fx)).toEqual(POST_APP_ROLE);
      });
    });

    it("I1: a second run in the same transaction changes nothing", async () => {
      await asApp(async (client, notices) => {
        await runBlock(client, rerunRekey());
        const afterFirst = await stateUnderTestBypass(client, fx);
        notices.length = 0;
        await runBlock(client, rerunRekey());
        expect(countsOf(notices, RERUN_REPORT)).toEqual({ marker: 0, high_water: 0, entry_ids: 0, history_ids: 0 });
        expect(await stateUnderTestBypass(client, fx)).toEqual(afterFirst);
      });
    });

    it.each(BLOCK_TABLES)("table-list control: with %s removed from app.bypass_tables the block reports it under system_maintenance", async (removed) => {
      const block = rerunRekey();
      const literal = /'(teams,[a-z_,]+)'/.exec(block);
      expect(literal).not.toBeNull();
      const mutated = block.replace(literal![1], literal![1].split(",").filter((t) => t !== removed).join(","));
      expect(mutated).not.toBe(block);
      const notices = await expectBypassNotices(() => asApp(async (client) => {
        await runBlock(client, mutated);
      }));
      expect(notices).toContainEqual({ table: removed, purpose: "system_maintenance" });
    });

    describe("I2: a migrate role that bypasses RLS", () => {
      async function inRolledBackTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
        const client = await ctx.su.pool.connect();
        try {
          await client.query("BEGIN");
          return await fn(client);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }

      it.each([BYPASS_ROLE_KIND.MIGRATION_SUPERUSER, BYPASS_ROLE_KIND.BYPASSRLS_ROLE, BYPASS_ROLE_KIND.SUPERUSER_ROLE])(
        "%s: step 1 leaves marker 0, steps 2-4 repair the stragglers, app-written rows are unchanged (literal map)",
        async (kind) => {
          await inRolledBackTx(async (client) => {
            await enterBypassRole(client, kind);
            await client.query(rerunRekey());
            await client.query("RESET ROLE");
            expect(await readState(client, fx)).toEqual(POST_STEPS_2_TO_4);
          });
        },
      );

      it("passwd_app entered with SET LOCAL ROLE (session_user bypasses, current_user does not): step 1 applies", async () => {
        await inRolledBackTx(async (client) => {
          await enterBypassRole(client, BYPASS_ROLE_KIND.APP_ROLE);
          await client.query(rerunRekey());
          await client.query("RESET ROLE");
          expect(await readState(client, fx)).toEqual(POST_APP_ROLE);
        });
      });
    });

    it("the teams lock held alone makes the block fail on its teams FOR SHARE with 55P03", async () => {
      const a = await ctx.su.pool.connect();
      const b = await appPool.connect();
      try {
        await a.query("BEGIN");
        await a.query(`SELECT 1 FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [fx.teamV1]);
        await b.query("BEGIN");
        await b.query("SET LOCAL lock_timeout = '1500ms'");
        await setGucs(b, gucSentinels());
        const error = await b.query(rerunRekey()).then(() => null, (e: unknown) => e as { code?: string; where?: string });
        expect(error?.code).toBe("55P03");
        expect(error?.where).toContain("FROM teams ORDER BY id FOR SHARE");
      } finally {
        await b.query("ROLLBACK").catch(() => {});
        await a.query("ROLLBACK").catch(() => {});
        b.release();
        a.release();
      }
    });
  });
});
