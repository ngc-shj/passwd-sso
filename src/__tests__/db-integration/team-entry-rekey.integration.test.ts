/**
 * Integration test (real DB): the re-key pass endpoints
 * (docs/archive/review/team-key-rotation-rekey-plan.md C2) — the re-key POST's
 * refusal cells with their minus-step controls (A4, the A13 IV-reuse pair),
 * the server half of A1 (after a re-key the new ItemKey opens everything the
 * pass re-keyed and the old one opens nothing), retained rows (A6 server
 * parts), identity after re-key (A10, A7), a restore parked behind a re-key
 * (A5), and assertEntryRekeyConsistent red-proved on seeded inconsistent rows.
 *
 * Ciphertext is real (Web Crypto through the shared crypto modules): each POST
 * body is built the way the client does it — decrypt with the ItemKeys the
 * actor holds, re-encrypt under a fresh ItemKey wrapped under the current team
 * key (a test-local builder; the client's lands in Batch 4). Production entry
 * points are driven directly; only the auth, step-up and rate-limit
 * boundaries are mocked. Audit rows are read from audit_outbox, so the outbox
 * worker must be stopped.
 *
 * Run: docker compose up -d db && npm run test:integration -- team-entry-rekey
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { createRaceHelpers } from "./race-helpers";
import {
  deriveItemCekWrapKey,
  deriveItemEncryptionKey,
  deriveTeamEncryptionKey,
  generateItemKey,
  generateTeamSymmetricKey,
  unwrapItemKey,
  unwrapTeamAttachmentCek,
  wrapItemKey,
  wrapTeamAttachmentCek,
} from "@/lib/crypto/crypto-team";
import { buildAttachmentAAD, buildItemKeyWrapAAD, buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
import { decryptBinary, decryptData, encryptBinary, encryptData } from "@/lib/crypto/crypto-client";
import { assertEntryRekeyConsistent, REKEY_INCONSISTENCY, RekeyConsistencyError } from "@/lib/team/rekey-consistency";
import { buildTeamHistoryRestoreBody, type TeamHistoryRowDto } from "@/lib/team/team-history-restore";
import type { EntryItemKeyData } from "@/lib/team/team-vault-core";

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

import { GET as entryRekeyGET, POST as entryRekeyPOST } from "@/app/api/teams/[teamId]/passwords/[id]/rekey/route";
import { GET as rekeyListGET } from "@/app/api/teams/[teamId]/rekey/route";
import { PUT as updateEntry } from "@/app/api/teams/[teamId]/passwords/[id]/route";
import { POST as restoreRoute } from "@/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/restore/route";
import { GET as historyRowGET } from "@/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/route";
import { POST as rotateRoute } from "@/app/api/teams/[teamId]/rotate-key/route";
import { GET as downloadRoute } from "@/app/api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/route";
import { PUT as migrateRoute } from "@/app/api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/migrate/route";

const hex = (n: number) => randomBytes(n).toString("hex");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bytesOf = (text: string) => new TextEncoder().encode(text);
const textOf = (buf: ArrayBuffer) => new TextDecoder().decode(buf);
const toArrayBuffer = (u8: Uint8Array) => u8.slice().buffer as ArrayBuffer;

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function errorOf(res: Response): Promise<{ status: number; error: unknown }> {
  const json = (await res.json()) as { error?: unknown };
  return { status: res.status, error: json.error };
}

type Team = {
  teamId: string;
  admin: string;
  member: string;
  /** Every team key, by version (the test's view). */
  keys: Map<number, Uint8Array>;
  /** The versions the acting admin holds a member key for. */
  held: Set<number>;
};

type Seeded = {
  team: Team;
  entryId: string;
  itemKey: Uint8Array;
  itemKeyId: string;
  plaintext: { blob: string; overview: string };
  /** History rows by role, with the plaintext each holds. */
  history: { sameKey: string; aad0: string; v0: string; retained: string | null };
  historyPlain: Map<string, string>;
  attachment: { attId: string; plaintext: string };
};

type RekeyData = {
  entry: {
    id: string;
    encryptedBlob: string; blobIv: string; blobAuthTag: string;
    encryptedOverview: string; overviewIv: string; overviewAuthTag: string;
    aadVersion: number; teamKeyVersion: number; itemKeyVersion: number;
    encryptedItemKey: string | null; itemKeyIv: string | null; itemKeyAuthTag: string | null;
    itemKeyId: string | null; itemKeyTeamKeyVersion: number;
  };
  history: {
    id: string;
    encryptedBlob: string; blobIv: string; blobAuthTag: string;
    aadVersion: number; teamKeyVersion: number; itemKeyVersion: number;
    encryptedItemKey: string | null; itemKeyIv: string | null; itemKeyAuthTag: string | null;
    itemKeyId: string | null;
  }[];
  attachments: {
    id: string; encryptionMode: number;
    cekEncrypted: string | null; cekIv: string | null; cekAuthTag: string | null;
    cekKeyVersion: number | null; cekWrapAadVersion: number | null; cekItemKeyId: string | null;
  }[];
  nextItemKeyVersion: number;
  teamKeyVersion: number;
};

type RekeyBody = {
  teamKeyVersion: number;
  snapshot: { blobIv: string; overviewIv: string; itemKeyIv: string; itemKeyVersion: number };
  newItemKeyVersion: number;
  encryptedItemKey: { ciphertext: string; iv: string; authTag: string };
  encryptedBlob: { ciphertext: string; iv: string; authTag: string };
  encryptedOverview: { ciphertext: string; iv: string; authTag: string };
  aadVersion: number;
  history: { id: string; snapshotBlobIv: string; encryptedBlob: { ciphertext: string; iv: string; authTag: string } }[];
  retainHistoryIds: string[];
  attachmentCekRewraps: { id: string; snapshotCekIv: string; cekEncrypted: string; cekIv: string; cekAuthTag: string }[];
};

describe("team entry re-key — real-DB integration", () => {
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

  // ── Seeding (real keys) ──────────────────────────────────────────────────

  async function seedMember(teamId: string, role: "OWNER" | "ADMIN" | "MEMBER", keyVersions: number[]): Promise<string> {
    const userId = await ctx.createUser(tenantId);
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", true, now(), now())`,
      randomUUID(), teamId, userId, tenantId, role,
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

  /**
   * A team at version 3. The acting ADMIN holds team keys 2 and 3 (joined
   * after the first rotation); a MEMBER holds 1, 2 and 3.
   */
  async function seedTeam(): Promise<Team> {
    const teamId = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, 3, now(), now())`,
      teamId, tenantId, `team-${teamId.slice(0, 8)}`,
    );
    const admin = await seedMember(teamId, "ADMIN", [2, 3]);
    const member = await seedMember(teamId, "MEMBER", [1, 2, 3]);
    mockAuth.mockResolvedValue({ user: { id: admin } });
    return {
      teamId,
      admin,
      member,
      keys: new Map([1, 2, 3].map((v) => [v, generateTeamSymmetricKey()])),
      held: new Set([2, 3]),
    };
  }

  async function teamKeyOf(team: Team, version: number): Promise<CryptoKey> {
    const raw = team.keys.get(version);
    if (!raw) throw new Error(`no team key ${version}`);
    return deriveTeamEncryptionKey(raw);
  }

  async function wrapFor(team: Team, entryId: string, teamKeyVersion: number, itemKey: Uint8Array) {
    return wrapItemKey(itemKey, await teamKeyOf(team, teamKeyVersion), buildItemKeyWrapAAD(team.teamId, entryId, teamKeyVersion));
  }

  /** AAD of a team entry blob/overview: none at aadVersion 0. */
  function entryAad(teamId: string, entryId: string, kind: "blob" | "overview", aadVersion: number, itemKeyVersion: number) {
    return aadVersion >= 1 ? buildTeamEntryAAD(teamId, entryId, kind, itemKeyVersion) : undefined;
  }

  async function insertHistory(
    team: Team,
    entryId: string,
    row: {
      plaintext: string;
      contentKey: CryptoKey;
      aadVersion: number;
      teamKeyVersion: number;
      itemKeyVersion: number;
      wrap: { ciphertext: string; iv: string; authTag: string } | null;
      itemKeyId: string | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    const blob = await encryptData(
      row.plaintext,
      row.contentKey,
      entryAad(team.teamId, entryId, "blob", row.aadVersion, row.itemKeyVersion),
    );
    await sql(
      `INSERT INTO team_password_entry_histories (
         id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag,
         aad_version, team_key_version, item_key_version,
         encrypted_item_key, item_key_iv, item_key_auth_tag, item_key_id,
         changed_by_id, changed_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid, $14::uuid, now())`,
      id, entryId, tenantId, blob.ciphertext, blob.iv, blob.authTag,
      row.aadVersion, row.teamKeyVersion, row.itemKeyVersion,
      row.wrap?.ciphertext ?? null, row.wrap?.iv ?? null, row.wrap?.authTag ?? null, row.itemKeyId, team.admin,
    );
    return id;
  }

  /**
   * One pending entry (ItemKey created at team key 2, wrapped under 3) with
   * history the admin can open — a row under its own wrap of the live
   * ItemKey, the same at aadVersion 0, a v0 row under team key 2 — and,
   * optionally, a row under another ItemKey wrapped with team key 1, which the
   * admin does not hold (retained). One mode-2 attachment under the ItemKey.
   */
  async function seedEntry(opts: { retained?: boolean } = {}): Promise<Seeded> {
    const team = await seedTeam();
    const entryId = randomUUID();
    const itemKey = generateItemKey();
    const itemKeyId = randomUUID();
    const contentKey = await deriveItemEncryptionKey(itemKey);
    const plaintext = { blob: `blob ${randomUUID()}`, overview: `overview ${randomUUID()}` };
    const blob = await encryptData(plaintext.blob, contentKey, buildTeamEntryAAD(team.teamId, entryId, "blob", 1));
    const overview = await encryptData(plaintext.overview, contentKey, buildTeamEntryAAD(team.teamId, entryId, "overview", 1));
    const wrap = await wrapFor(team, entryId, 3, itemKey);
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
         $5, $6, $7, $8, $9, $10,
         1, 3, 1, $11, $12, $13, $14::uuid, 2, 1, 'LOGIN', now(), now()
       )`,
      entryId, team.teamId, tenantId, team.admin,
      blob.ciphertext, blob.iv, blob.authTag, overview.ciphertext, overview.iv, overview.authTag,
      wrap.ciphertext, wrap.iv, wrap.authTag, itemKeyId,
    );

    const historyPlain = new Map<string, string>();
    const oldWrap = await wrapFor(team, entryId, 2, itemKey);
    const sameText = `history same ${randomUUID()}`;
    const sameKey = await insertHistory(team, entryId, {
      plaintext: sameText, contentKey, aadVersion: 1, teamKeyVersion: 2, itemKeyVersion: 1, wrap: oldWrap, itemKeyId,
    });
    historyPlain.set(sameKey, sameText);
    const aad0Text = `history aad0 ${randomUUID()}`;
    const aad0 = await insertHistory(team, entryId, {
      plaintext: aad0Text, contentKey, aadVersion: 0, teamKeyVersion: 2, itemKeyVersion: 1, wrap: oldWrap, itemKeyId,
    });
    historyPlain.set(aad0, aad0Text);
    const v0Text = `history v0 ${randomUUID()}`;
    const v0 = await insertHistory(team, entryId, {
      plaintext: v0Text, contentKey: await teamKeyOf(team, 2), aadVersion: 1, teamKeyVersion: 2, itemKeyVersion: 0, wrap: null, itemKeyId: null,
    });
    historyPlain.set(v0, v0Text);
    let retained: string | null = null;
    if (opts.retained) {
      const otherKey = generateItemKey();
      const retainedText = `history retained ${randomUUID()}`;
      retained = await insertHistory(team, entryId, {
        plaintext: retainedText,
        contentKey: await deriveItemEncryptionKey(otherKey),
        aadVersion: 1,
        teamKeyVersion: 1,
        itemKeyVersion: 1,
        wrap: await wrapFor(team, entryId, 1, otherKey),
        itemKeyId: randomUUID(),
      });
      historyPlain.set(retained, retainedText);
    }

    const attId = randomUUID();
    const attPlain = `attachment ${randomUUID()}`;
    await insertMode2Attachment(team, entryId, attId, itemKey, itemKeyId, 1, attPlain);

    return {
      team, entryId, itemKey, itemKeyId, plaintext,
      history: { sameKey, aad0, v0, retained },
      historyPlain,
      attachment: { attId, plaintext: attPlain },
    };
  }

  async function insertMode2Attachment(
    team: Team, entryId: string, attId: string, itemKey: Uint8Array, itemKeyId: string, itemKeyVersion: number, plaintext: string,
  ) {
    const cek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const body = await encryptBinary(toArrayBuffer(bytesOf(plaintext)), cek, buildAttachmentAAD(entryId, attId));
    const cekRaw = new Uint8Array(await crypto.subtle.exportKey("raw", cek));
    const wrapped = await wrapTeamAttachmentCek(cekRaw, await deriveItemCekWrapKey(itemKey), {
      teamId: team.teamId, entryId, attachmentId: attId, itemKeyVersion, cekWrapAadVersion: 1,
    });
    cekRaw.fill(0);
    await sql(
      `INSERT INTO attachments (
         id, filename, content_type, size_bytes, encrypted_data, iv, auth_tag,
         key_version, aad_version, encryption_mode,
         cek_encrypted, cek_iv, cek_auth_tag, cek_key_version, cek_wrap_aad_version, cek_item_key_id,
         tenant_id, team_password_entry_id, created_by_id, created_at
       ) VALUES ($1::uuid, 'a.pdf', 'application/pdf', $2, $3, $4, $5, 3, 1, 2,
                 $6, $7, $8, $9, 1, $10::uuid, $11::uuid, $12::uuid, $13::uuid, now())`,
      attId, bytesOf(plaintext).length, Buffer.from(body.ciphertext), body.iv, body.authTag,
      Buffer.from(wrapped.ciphertext), wrapped.iv, wrapped.authTag, itemKeyVersion, itemKeyId,
      tenantId, entryId, team.admin,
    );
  }

  // ── The client's side (real crypto) ──────────────────────────────────────

  async function rekeyData(s: Seeded): Promise<RekeyData> {
    const res = await entryRekeyGET(
      new NextRequest(`http://localhost/api/teams/${s.team.teamId}/passwords/${s.entryId}/rekey`),
      { params: Promise.resolve({ teamId: s.team.teamId, id: s.entryId }) },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as RekeyData;
  }

  /** Unwrap an ItemKey wrap with the actor's team key at its version; null when not held or not opening. */
  async function openWrap(s: Seeded, row: { encryptedItemKey: string | null; itemKeyIv: string | null; itemKeyAuthTag: string | null; teamKeyVersion: number }) {
    if (!row.encryptedItemKey || !row.itemKeyIv || !row.itemKeyAuthTag || !s.team.held.has(row.teamKeyVersion)) return null;
    try {
      return await unwrapItemKey(
        { ciphertext: row.encryptedItemKey, iv: row.itemKeyIv, authTag: row.itemKeyAuthTag },
        await teamKeyOf(s.team, row.teamKeyVersion),
        buildItemKeyWrapAAD(s.team.teamId, s.entryId, row.teamKeyVersion),
      );
    } catch {
      return null;
    }
  }

  /**
   * Build the re-key POST as the pass does: GET, open every row with the
   * ItemKeys the actor holds (own wrap, else trial with the live ItemKey;
   * a v0 row with the team key), re-encrypt under a new ItemKey wrapped
   * under the current team key; rows nothing opens are retained.
   */
  async function buildRekey(s: Seeded): Promise<{ body: RekeyBody; newItemKey: Uint8Array; data: RekeyData }> {
    const data = await rekeyData(s);
    const { entry } = data;
    const live = await openWrap(s, entry);
    if (!live) throw new Error("the actor cannot open the live ItemKey");
    const liveKey = await deriveItemEncryptionKey(live);
    const teamId = s.team.teamId;
    const blob = await decryptData(
      { ciphertext: entry.encryptedBlob, iv: entry.blobIv, authTag: entry.blobAuthTag },
      liveKey, entryAad(teamId, s.entryId, "blob", entry.aadVersion, entry.itemKeyVersion),
    );
    const overview = await decryptData(
      { ciphertext: entry.encryptedOverview, iv: entry.overviewIv, authTag: entry.overviewAuthTag },
      liveKey, entryAad(teamId, s.entryId, "overview", entry.aadVersion, entry.itemKeyVersion),
    );

    const newItemKey = generateItemKey();
    const newKey = await deriveItemEncryptionKey(newItemKey);
    const v = data.nextItemKeyVersion;
    const heldItemKeys: Uint8Array[] = [live];

    const history: RekeyBody["history"] = [];
    const retainHistoryIds: string[] = [];
    for (const h of data.history) {
      const keys: CryptoKey[] = [];
      if (h.itemKeyVersion === 0) {
        if (s.team.held.has(Math.max(1, h.teamKeyVersion))) keys.push(await teamKeyOf(s.team, Math.max(1, h.teamKeyVersion)));
      } else {
        const own = await openWrap(s, h);
        if (own) {
          heldItemKeys.push(own);
          keys.push(await deriveItemEncryptionKey(own));
        }
        keys.push(liveKey);
      }
      let plain: string | null = null;
      for (const key of keys) {
        try {
          plain = await decryptData(
            { ciphertext: h.encryptedBlob, iv: h.blobIv, authTag: h.blobAuthTag },
            key, entryAad(teamId, s.entryId, "blob", h.aadVersion, h.itemKeyVersion),
          );
          break;
        } catch {
          // Not this key.
        }
      }
      if (plain === null) {
        retainHistoryIds.push(h.id);
        continue;
      }
      history.push({
        id: h.id,
        snapshotBlobIv: h.blobIv,
        encryptedBlob: await encryptData(plain, newKey, buildTeamEntryAAD(teamId, s.entryId, "blob", v)),
      });
    }

    const attachmentCekRewraps: RekeyBody["attachmentCekRewraps"] = [];
    for (const a of data.attachments) {
      if (!a.cekEncrypted || !a.cekIv || !a.cekAuthTag) throw new Error("legacy attachment in the builder");
      let cekRaw: Uint8Array | null = null;
      for (const itemKey of heldItemKeys) {
        try {
          cekRaw = await unwrapTeamAttachmentCek(
            { ciphertext: Buffer.from(a.cekEncrypted, "base64"), iv: a.cekIv, authTag: a.cekAuthTag },
            await deriveItemCekWrapKey(itemKey),
            { teamId, entryId: s.entryId, attachmentId: a.id, itemKeyVersion: a.cekKeyVersion ?? 0, cekWrapAadVersion: a.cekWrapAadVersion ?? 0 },
          );
          break;
        } catch {
          // Not this ItemKey.
        }
      }
      if (!cekRaw) throw new Error("no held ItemKey opens the CEK");
      const rewrapped = await wrapTeamAttachmentCek(cekRaw, await deriveItemCekWrapKey(newItemKey), {
        teamId, entryId: s.entryId, attachmentId: a.id, itemKeyVersion: v, cekWrapAadVersion: 1,
      });
      cekRaw.fill(0);
      attachmentCekRewraps.push({
        id: a.id,
        snapshotCekIv: a.cekIv,
        cekEncrypted: b64(rewrapped.ciphertext),
        cekIv: rewrapped.iv,
        cekAuthTag: rewrapped.authTag,
      });
    }

    const body: RekeyBody = {
      teamKeyVersion: data.teamKeyVersion,
      snapshot: {
        blobIv: entry.blobIv,
        overviewIv: entry.overviewIv,
        itemKeyIv: entry.itemKeyIv ?? "",
        itemKeyVersion: entry.itemKeyVersion,
      },
      newItemKeyVersion: v,
      encryptedItemKey: await wrapFor(s.team, s.entryId, data.teamKeyVersion, newItemKey),
      encryptedBlob: await encryptData(blob, newKey, buildTeamEntryAAD(teamId, s.entryId, "blob", v)),
      encryptedOverview: await encryptData(overview, newKey, buildTeamEntryAAD(teamId, s.entryId, "overview", v)),
      aadVersion: 1,
      history,
      retainHistoryIds,
      attachmentCekRewraps,
    };
    return { body, newItemKey, data };
  }

  function rekey(s: Seeded, body: unknown) {
    return entryRekeyPOST(
      jsonRequest(`http://localhost/api/teams/${s.team.teamId}/passwords/${s.entryId}/rekey`, "POST", body),
      { params: Promise.resolve({ teamId: s.team.teamId, id: s.entryId }) },
    );
  }

  async function rekeyList(s: Seeded) {
    const res = await rekeyListGET(
      new NextRequest(`http://localhost/api/teams/${s.team.teamId}/rekey`),
      { params: Promise.resolve({ teamId: s.team.teamId }) },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { pendingCount: number; retainedHistoryCount: number; entryIds: string[] };
  }

  /** Rotate through the route: every entry's ItemKey re-wrapped (not replaced) under a new team key. */
  async function rotate(s: Seeded) {
    const from = Math.max(...s.team.keys.keys());
    const to = from + 1;
    s.team.keys.set(to, generateTeamSymmetricKey());
    const entries = await ctx.su.pool.query<{
      id: string; team_key_version: number; item_key_version: number; aad_version: number;
      encrypted_item_key: string; item_key_iv: string; item_key_auth_tag: string;
    }>(
      `SELECT id, team_key_version, item_key_version, aad_version, encrypted_item_key, item_key_iv, item_key_auth_tag
         FROM team_password_entries WHERE team_id = $1::uuid`,
      [s.team.teamId],
    );
    const payloadEntries = [];
    for (const e of entries.rows) {
      const itemKey = await unwrapItemKey(
        { ciphertext: e.encrypted_item_key, iv: e.item_key_iv, authTag: e.item_key_auth_tag },
        await teamKeyOf(s.team, e.team_key_version),
        buildItemKeyWrapAAD(s.team.teamId, e.id, e.team_key_version),
      );
      payloadEntries.push({
        id: e.id,
        itemKeyVersion: e.item_key_version,
        snapshotIv: e.item_key_iv,
        encryptedItemKey: await wrapFor(s.team, e.id, to, itemKey),
        aadVersion: e.aad_version,
      });
    }
    const res = await rotateRoute(
      jsonRequest(`http://localhost/api/teams/${s.team.teamId}/rotate-key`, "POST", {
        newTeamKeyVersion: to,
        entries: payloadEntries,
        memberKeys: [s.team.admin, s.team.member].map((userId) => ({
          userId, encryptedTeamKey: hex(32), teamKeyIv: hex(12), teamKeyAuthTag: hex(16),
          ephemeralPublicKey: hex(32), hkdfSalt: hex(32), keyVersion: to,
        })),
      }),
      { params: Promise.resolve({ teamId: s.team.teamId }) },
    );
    expect(res.status).toBe(200);
    s.team.held.add(to);
  }

  /** The restore POST; `snapshotBlobIv` is the blobIv of the row the client decrypted (default: as stored now). */
  async function restore(
    s: Seeded,
    historyId: string,
    overview: { ciphertext: string; iv: string; authTag: string },
    snapshotBlobIv?: string,
  ) {
    const blobIv = snapshotBlobIv ?? (await ctx.su.pool.query<{ blob_iv: string }>(
      `SELECT blob_iv FROM team_password_entry_histories WHERE id = $1::uuid`,
      [historyId],
    )).rows[0].blob_iv;
    return restoreRoute(
      jsonRequest(`http://localhost/api/teams/${s.team.teamId}/passwords/${s.entryId}/history/${historyId}/restore`, "POST", {
        encryptedOverview: overview,
        snapshotBlobIv: blobIv,
      }),
      { params: Promise.resolve({ teamId: s.team.teamId, id: s.entryId, historyId }) },
    );
  }

  // ── Read-back ────────────────────────────────────────────────────────────

  type EntryRow = {
    item_key_id: string | null;
    item_key_version: number;
    team_key_version: number;
    item_key_team_key_version: number;
    item_key_version_high_water: number;
    blob_iv: string;
    encrypted_item_key: string | null;
    item_key_iv: string | null;
    item_key_auth_tag: string | null;
  };

  async function entryRow(entryId: string): Promise<EntryRow> {
    const r = await ctx.su.pool.query<EntryRow>(
      `SELECT item_key_id, item_key_version, team_key_version, item_key_team_key_version, item_key_version_high_water,
              blob_iv, encrypted_item_key, item_key_iv, item_key_auth_tag
         FROM team_password_entries WHERE id = $1::uuid`,
      [entryId],
    );
    return r.rows[0];
  }

  /** Every column of the entry's rows, to prove a refusal changed nothing. */
  async function snapshotRows(entryId: string) {
    const [entry, history, attachments] = await Promise.all([
      ctx.su.pool.query(`SELECT * FROM team_password_entries WHERE id = $1::uuid`, [entryId]),
      ctx.su.pool.query(`SELECT * FROM team_password_entry_histories WHERE entry_id = $1::uuid ORDER BY id`, [entryId]),
      ctx.su.pool.query(`SELECT * FROM attachments WHERE team_password_entry_id = $1::uuid ORDER BY id`, [entryId]),
    ]);
    return { entry: entry.rows, history: history.rows, attachments: attachments.rows };
  }

  async function historyIds(entryId: string): Promise<Map<string, string | null>> {
    const r = await ctx.su.pool.query<{ id: string; item_key_id: string | null }>(
      `SELECT id, item_key_id FROM team_password_entry_histories WHERE entry_id = $1::uuid`,
      [entryId],
    );
    return new Map(r.rows.map((row) => [row.id, row.item_key_id]));
  }

  async function attachmentKeyId(attId: string): Promise<string | null> {
    const r = await ctx.su.pool.query<{ cek_item_key_id: string | null }>(
      `SELECT cek_item_key_id FROM attachments WHERE id = $1::uuid`,
      [attId],
    );
    return r.rows[0].cek_item_key_id;
  }

  /**
   * Rows of the team not on the team's current key version — independent of
   * the route's post-check: entries off the current team key or marker,
   * history rows off it or not under their entry's ItemKey (retained rows
   * included), attachments not mode 2 under the entry's ItemKey.
   */
  async function rowsOffCurrentVersion(teamId: string): Promise<string[]> {
    const r = await ctx.su.pool.query<{ id: string }>(
      `SELECT e.id FROM team_password_entries e JOIN teams t ON t.id = e.team_id
        WHERE e.team_id = $1::uuid
          AND (e.team_key_version <> t.team_key_version OR e.item_key_team_key_version <> t.team_key_version)
       UNION ALL
       SELECT h.id FROM team_password_entry_histories h
         JOIN team_password_entries e ON e.id = h.entry_id JOIN teams t ON t.id = e.team_id
        WHERE e.team_id = $1::uuid
          AND (h.team_key_version <> t.team_key_version OR h.item_key_id IS DISTINCT FROM e.item_key_id)
       UNION ALL
       SELECT a.id FROM attachments a
         JOIN team_password_entries e ON e.id = a.team_password_entry_id JOIN teams t ON t.id = e.team_id
        WHERE e.team_id = $1::uuid
          AND (a.encryption_mode <> 2 OR a.key_version IS DISTINCT FROM t.team_key_version
               OR a.cek_item_key_id IS DISTINCT FROM e.item_key_id)`,
      [teamId],
    );
    return r.rows.map((row) => row.id);
  }

  async function rekeyAudits(entryId: string) {
    const r = await ctx.su.pool.query<{ payload: { userId: string; metadata: Record<string, unknown> } }>(
      `SELECT payload FROM audit_outbox WHERE payload->>'action' = 'TEAM_ENTRY_REKEY' AND payload->>'targetId' = $1`,
      [entryId],
    );
    return r.rows.map((row) => row.payload);
  }

  /** Download an attachment through the route and decrypt it with `itemKey` as the client would. */
  async function downloadWith(s: Seeded, attId: string, itemKey: Uint8Array): Promise<string> {
    const res = await downloadRoute(
      new NextRequest(`http://localhost/api/teams/${s.team.teamId}/passwords/${s.entryId}/attachments/${attId}`),
      { params: Promise.resolve({ teamId: s.team.teamId, id: s.entryId, attachmentId: attId }) },
    );
    expect(res.status).toBe(200);
    const d = (await res.json()) as {
      encryptedData: string; iv: string; authTag: string;
      cekEncrypted: string; cekIv: string; cekAuthTag: string; cekKeyVersion: number; cekWrapAadVersion: number;
    };
    const cekRaw = await unwrapTeamAttachmentCek(
      { ciphertext: Buffer.from(d.cekEncrypted, "base64"), iv: d.cekIv, authTag: d.cekAuthTag },
      await deriveItemCekWrapKey(itemKey),
      { teamId: s.team.teamId, entryId: s.entryId, attachmentId: attId, itemKeyVersion: d.cekKeyVersion, cekWrapAadVersion: d.cekWrapAadVersion },
    );
    const cek = await crypto.subtle.importKey("raw", toArrayBuffer(cekRaw), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    return textOf(await decryptBinary(
      { ciphertext: Buffer.from(d.encryptedData, "base64"), iv: d.iv, authTag: d.authTag },
      cek,
      buildAttachmentAAD(s.entryId, attId),
    ));
  }

  // ── A1 (server half), A10 ────────────────────────────────────────────────

  async function versionHolders(s: Seeded) {
    const res = await rekeyListGET(
      new NextRequest(`http://localhost/api/teams/${s.team.teamId}/rekey`),
      { params: Promise.resolve({ teamId: s.team.teamId }) },
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as {
      versionHolders: Record<string, {
        callerHolds: boolean;
        activeHolderCount: number;
        holders: { id: string; canRekey: boolean }[];
        deactivatedHolderCount: number;
      }>;
    }).versionHolders;
  }

  it("D36: the list names the other active holders of a pending version and counts a tenant-deactivated holder (control: none deactivated → 0)", async () => {
    const s = await seedEntry();
    const otherAdmin = await seedMember(s.team.teamId, "ADMIN", [3]);

    const before = (await versionHolders(s))[3];
    expect(before).toMatchObject({ callerHolds: true, activeHolderCount: 3, deactivatedHolderCount: 0 });
    expect(new Set(before.holders.map((h) => `${h.id}:${h.canRekey}`))).toEqual(
      new Set([`${otherAdmin}:true`, `${s.team.member}:false`]),
    );

    // The MEMBER leaves the tenant: their membership is deactivated, their key row stays.
    await sql(
      `UPDATE team_members SET deactivated_at = now(), deactivated_by_tenant = true
        WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      s.team.teamId, s.team.member,
    );

    const after = (await versionHolders(s))[3];
    expect(after).toMatchObject({ callerHolds: true, activeHolderCount: 2, deactivatedHolderCount: 1 });
    expect(after.holders.map((h) => h.id)).toEqual([otherAdmin]);
  });

  it("A1: after a re-key the new ItemKey (from the current team key) opens the blob, overview, every history row and the CEK; the old ItemKey opens none; nothing is off-version; pending 0", async () => {
    const s = await seedEntry();
    expect((await rekeyList(s)).pendingCount).toBe(1);
    const { body } = await buildRekey(s);
    expect(body.retainHistoryIds).toEqual([]);
    const res = await rekey(s, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, itemKeyVersion: 2 });

    // What a client reads back after the re-key, with the current team key only.
    const after = await rekeyData(s);
    expect(after.entry).toMatchObject({ teamKeyVersion: 3, itemKeyVersion: 2, itemKeyTeamKeyVersion: 3 });
    const newItemKey = await unwrapItemKey(
      { ciphertext: after.entry.encryptedItemKey ?? "", iv: after.entry.itemKeyIv ?? "", authTag: after.entry.itemKeyAuthTag ?? "" },
      await teamKeyOf(s.team, 3),
      buildItemKeyWrapAAD(s.team.teamId, s.entryId, 3),
    );
    const newKey = await deriveItemEncryptionKey(newItemKey);
    const oldKey = await deriveItemEncryptionKey(s.itemKey);
    const blobAad = buildTeamEntryAAD(s.team.teamId, s.entryId, "blob", 2);
    const blobCt = { ciphertext: after.entry.encryptedBlob, iv: after.entry.blobIv, authTag: after.entry.blobAuthTag };
    expect(await decryptData(blobCt, newKey, blobAad)).toBe(s.plaintext.blob);
    await expect(decryptData(blobCt, oldKey, blobAad)).rejects.toThrow();
    const overviewCt = { ciphertext: after.entry.encryptedOverview, iv: after.entry.overviewIv, authTag: after.entry.overviewAuthTag };
    const overviewAad = buildTeamEntryAAD(s.team.teamId, s.entryId, "overview", 2);
    expect(await decryptData(overviewCt, newKey, overviewAad)).toBe(s.plaintext.overview);
    await expect(decryptData(overviewCt, oldKey, overviewAad)).rejects.toThrow();

    // Every history row — incl. the one seeded at aadVersion 0 and the v0 row — is under the new ItemKey now.
    expect(after.history).toHaveLength(3);
    for (const h of after.history) {
      expect(h).toMatchObject({ aadVersion: 1, teamKeyVersion: 3, itemKeyVersion: 2, itemKeyId: after.entry.itemKeyId });
      const own = await unwrapItemKey(
        { ciphertext: h.encryptedItemKey ?? "", iv: h.itemKeyIv ?? "", authTag: h.itemKeyAuthTag ?? "" },
        await teamKeyOf(s.team, 3),
        buildItemKeyWrapAAD(s.team.teamId, s.entryId, 3),
      );
      const ct = { ciphertext: h.encryptedBlob, iv: h.blobIv, authTag: h.blobAuthTag };
      expect(await decryptData(ct, await deriveItemEncryptionKey(own), blobAad)).toBe(s.historyPlain.get(h.id));
      await expect(decryptData(ct, oldKey, blobAad)).rejects.toThrow();
    }

    // The CEK, through the download route.
    expect(await downloadWith(s, s.attachment.attId, newItemKey)).toBe(s.attachment.plaintext);
    await expect(downloadWith(s, s.attachment.attId, s.itemKey)).rejects.toThrow();

    expect(await rowsOffCurrentVersion(s.team.teamId)).toEqual([]);
    const list = await rekeyList(s);
    expect(list).toMatchObject({ pendingCount: 0, retainedHistoryCount: 0, entryIds: [] });
  });

  it("A10: the re-key gives the entry a new ItemKey id carried by its re-keyed rows (retained rows keep theirs); a later rotation changes no id", async () => {
    const s = await seedEntry({ retained: true });
    const retainedId = s.history.retained ?? "";
    const before = await historyIds(s.entryId);
    const { body } = await buildRekey(s);
    expect(body.retainHistoryIds).toEqual([retainedId]);
    expect((await rekey(s, body)).status).toBe(200);

    const newId = (await entryRow(s.entryId)).item_key_id;
    expect(newId).not.toBeNull();
    expect(newId).not.toBe(s.itemKeyId);
    const after = await historyIds(s.entryId);
    for (const id of [s.history.sameKey, s.history.aad0, s.history.v0]) expect(after.get(id)).toBe(newId);
    expect(after.get(retainedId)).toBe(before.get(retainedId));
    expect(await attachmentKeyId(s.attachment.attId)).toBe(newId);

    await rotate(s);
    expect((await entryRow(s.entryId)).item_key_id).toBe(newId);
    expect(await historyIds(s.entryId)).toEqual(after);
    expect(await attachmentKeyId(s.attachment.attId)).toBe(newId);
  });

  it("retained rows: left byte-identical, listed with their versions in the in-transaction audit row, counted in retainedHistoryCount and off-version", async () => {
    const s = await seedEntry({ retained: true });
    const retainedId = s.history.retained ?? "";
    const retainedBefore = await ctx.su.pool.query(`SELECT * FROM team_password_entry_histories WHERE id = $1::uuid`, [retainedId]);
    const { body } = await buildRekey(s);
    expect((await rekey(s, body)).status).toBe(200);

    const retainedAfter = await ctx.su.pool.query(`SELECT * FROM team_password_entry_histories WHERE id = $1::uuid`, [retainedId]);
    expect(retainedAfter.rows).toEqual(retainedBefore.rows);
    expect(await rekeyAudits(s.entryId)).toEqual([
      expect.objectContaining({
        userId: s.team.admin,
        metadata: {
          fromItemKeyVersion: 1,
          toItemKeyVersion: 2,
          fromTeamKeyVersion: 2,
          toTeamKeyVersion: 3,
          retained: [{ id: retainedId, teamKeyVersion: 1, itemKeyVersion: 1 }],
        },
      }),
    ]);
    expect(await rekeyList(s)).toMatchObject({ pendingCount: 0, retainedHistoryCount: 1 });
    expect(await rowsOffCurrentVersion(s.team.teamId)).toEqual([retainedId]);
  });

  // ── A4: refusals, each with its minus-step control ───────────────────────

  async function expectRefusedUnchanged(s: Seeded, body: unknown, expected: { status: number; error: string }) {
    const before = await snapshotRows(s.entryId);
    expect(await errorOf(await rekey(s, body))).toEqual(expected);
    expect(await snapshotRows(s.entryId)).toEqual(before);
    expect(await rekeyAudits(s.entryId)).toEqual([]);
  }

  it("ITEM_KEY_VERSION_INVALID: a newItemKeyVersion other than high-water + 1 (control: high-water + 1 → 200)", async () => {
    const s = await seedEntry();
    const { body } = await buildRekey(s);
    await expectRefusedUnchanged(s, { ...body, newItemKeyVersion: body.newItemKeyVersion + 1 }, {
      status: 409, error: "ITEM_KEY_VERSION_INVALID",
    });
    expect((await rekey(s, body)).status).toBe(200);
  });

  it("TEAM_KEY_VERSION_CHANGED: a rotation committed after the GET (control: rebuilt after the rotation → 200)", async () => {
    const s = await seedEntry();
    const { body: stale } = await buildRekey(s);
    await rotate(s);
    await expectRefusedUnchanged(s, stale, { status: 409, error: "TEAM_KEY_VERSION_CHANGED" });
    const { body } = await buildRekey(s);
    expect(body.teamKeyVersion).toBe(4);
    expect((await rekey(s, body)).status).toBe(200);
    expect((await entryRow(s.entryId)).item_key_team_key_version).toBe(4);
  });

  it("REKEY_SNAPSHOT_MISMATCH: an edit between the GET and the POST (control: rebuilt after it → 200)", async () => {
    const s = await seedEntry();
    const { body: stale } = await buildRekey(s);
    const contentKey = await deriveItemEncryptionKey(s.itemKey);
    const edited = await updateEntry(
      jsonRequest(`http://localhost/api/teams/${s.team.teamId}/passwords/${s.entryId}`, "PUT", {
        encryptedBlob: await encryptData("edited", contentKey, buildTeamEntryAAD(s.team.teamId, s.entryId, "blob", 1)),
        encryptedOverview: await encryptData("edited", contentKey, buildTeamEntryAAD(s.team.teamId, s.entryId, "overview", 1)),
        aadVersion: 1,
        teamKeyVersion: 3,
        itemKeyVersion: 1,
        itemKeyId: s.itemKeyId,
      }),
      { params: Promise.resolve({ teamId: s.team.teamId, id: s.entryId }) },
    );
    expect(edited.status).toBe(200);
    await expectRefusedUnchanged(s, stale, { status: 409, error: "REKEY_SNAPSHOT_MISMATCH" });
    const { body } = await buildRekey(s);
    expect((await rekey(s, body)).status).toBe(200);
  });

  it("REKEY_SNAPSHOT_MISMATCH: a stale history blobIv rolls back the rows already written (control → 200)", async () => {
    const s = await seedEntry();
    const { body } = await buildRekey(s);
    const last = body.history.length - 1;
    const stale = {
      ...body,
      history: body.history.map((h, i) => (i === last ? { ...h, snapshotBlobIv: hex(12) } : h)),
    };
    await expectRefusedUnchanged(s, stale, { status: 409, error: "REKEY_SNAPSHOT_MISMATCH" });
    expect((await rekey(s, body)).status).toBe(200);
  });

  it("REKEY_NOT_PENDING: a second re-key of a re-keyed entry, rows unchanged (control: the first → 200)", async () => {
    const s = await seedEntry();
    const { body } = await buildRekey(s);
    expect((await rekey(s, body)).status).toBe(200);
    const before = await snapshotRows(s.entryId);
    expect(await errorOf(await rekey(s, body))).toEqual({ status: 409, error: "REKEY_NOT_PENDING" });
    expect(await snapshotRows(s.entryId)).toEqual(before);
    expect(await rekeyAudits(s.entryId)).toHaveLength(1);
  });

  describe("REKEY_SET_MISMATCH: a history row deleted while the re-key is parked at its exact-set FOR UPDATE read", () => {
    async function rekeyParkedBehindHistoryRow(deleteRow: boolean) {
      const s = await seedEntry();
      const { body } = await buildRekey(s);
      const target = s.history.v0;
      const r = race();
      const res = await r.parkBehind(
        `SELECT id FROM team_password_entry_histories WHERE id = $1::uuid FOR UPDATE`,
        [target],
        () => rekey(s, body),
        async (blocker, parkedPid) => {
          expect(await r.waitingQueryOf(parkedPid)).toMatch(/FROM team_password_entry_histories[\s\S]*FOR UPDATE/);
          if (deleteRow) {
            await blocker.query(`DELETE FROM team_password_entry_histories WHERE id = $1::uuid`, [target]);
          }
        },
      );
      return { s, res };
    }

    it("deleted while parked → 409 REKEY_SET_MISMATCH, nothing written", async () => {
      const { s, res } = await rekeyParkedBehindHistoryRow(true);
      expect(await errorOf(res)).toEqual({ status: 409, error: "REKEY_SET_MISMATCH" });
      expect((await entryRow(s.entryId)).item_key_id).toBe(s.itemKeyId);
      expect(await rekeyAudits(s.entryId)).toEqual([]);
    });

    it("control: the blocker commits without change → 200", async () => {
      const { res } = await rekeyParkedBehindHistoryRow(false);
      expect(res.status).toBe(200);
    });
  });

  describe("ACTOR_NOT_PERMITTED: the actor's role, re-read under the team lock", () => {
    async function rekeyParkedBehindTeamRow(revoke: boolean) {
      const s = await seedEntry();
      const { body } = await buildRekey(s);
      const r = race();
      const res = await r.parkBehind(
        `SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`,
        [s.team.teamId],
        () => rekey(s, body),
        async (blocker, parkedPid) => {
          expect(await r.waitingQueryOf(parkedPid)).toMatch(/FROM teams WHERE id = .* FOR SHARE/s);
          if (revoke) {
            await blocker.query(
              `UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1::uuid AND user_id = $2::uuid`,
              [s.team.teamId, s.team.admin],
            );
          }
        },
      );
      return { s, res };
    }

    it("revoked while parked → 403 ACTOR_NOT_PERMITTED, nothing written", async () => {
      const { s, res } = await rekeyParkedBehindTeamRow(true);
      expect(await errorOf(res)).toEqual({ status: 403, error: "ACTOR_NOT_PERMITTED" });
      expect((await entryRow(s.entryId)).item_key_id).toBe(s.itemKeyId);
    });

    it("control: the blocker commits without revoking → 200", async () => {
      const { res } = await rekeyParkedBehindTeamRow(false);
      expect(res.status).toBe(200);
    });

    it("control: revoked before the request → FORBIDDEN from the gate", async () => {
      const s = await seedEntry();
      const { body } = await buildRekey(s);
      await sql(`UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1::uuid AND user_id = $2::uuid`, s.team.teamId, s.team.admin);
      expect(await errorOf(await rekey(s, body))).toEqual({ status: 403, error: "FORBIDDEN" });
    });
  });

  it("REKEY_ATTACHMENTS_UNMIGRATED: a mode-1 attachment (control: migrate it, then re-key → 200 and it decrypts with the new ItemKey)", async () => {
    const s = await seedEntry();
    const attId = randomUUID();
    const plaintext = `legacy ${randomUUID()}`;
    const legacy = await encryptBinary(
      toArrayBuffer(bytesOf(plaintext)),
      await deriveItemEncryptionKey(s.itemKey),
      buildAttachmentAAD(s.entryId, attId),
    );
    await sql(
      `INSERT INTO attachments (
         id, filename, content_type, size_bytes, encrypted_data, iv, auth_tag,
         key_version, aad_version, encryption_mode, tenant_id, team_password_entry_id, created_by_id, created_at
       ) VALUES ($1::uuid, 'legacy.pdf', 'application/pdf', $2, $3, $4, $5, 3, 1, 1, $6::uuid, $7::uuid, $8::uuid, now())`,
      attId, bytesOf(plaintext).length, Buffer.from(legacy.ciphertext), legacy.iv, legacy.authTag,
      tenantId, s.entryId, s.team.admin,
    );
    // The builder cannot re-wrap a legacy attachment; whatever body a client
    // sends, the re-key is refused before the body is read.
    await expect(buildRekey(s)).rejects.toThrow("legacy attachment");
    await expectRefusedUnchanged(s, { not: "read" }, { status: 409, error: "REKEY_ATTACHMENTS_UNMIGRATED" });

    // Migrate through the route (mode 1 → 2 under the live ItemKey).
    const cek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const body2 = await encryptBinary(toArrayBuffer(bytesOf(plaintext)), cek, buildAttachmentAAD(s.entryId, attId));
    const cekRaw = new Uint8Array(await crypto.subtle.exportKey("raw", cek));
    const wrapped = await wrapTeamAttachmentCek(cekRaw, await deriveItemCekWrapKey(s.itemKey), {
      teamId: s.team.teamId, entryId: s.entryId, attachmentId: attId, itemKeyVersion: 1, cekWrapAadVersion: 1,
    });
    const migrated = await migrateRoute(
      jsonRequest(`http://localhost/api/teams/${s.team.teamId}/passwords/${s.entryId}/attachments/${attId}/migrate`, "PUT", {
        itemKeyId: s.itemKeyId,
        cekKeyVersion: 1,
        snapshot: { iv: legacy.iv, authTag: legacy.authTag },
        clientHash: createHash("sha256").update(legacy.ciphertext).digest("hex"),
        encryptedData: b64(body2.ciphertext),
        iv: body2.iv,
        authTag: body2.authTag,
        cekEncrypted: b64(wrapped.ciphertext),
        cekIv: wrapped.iv,
        cekAuthTag: wrapped.authTag,
        cekWrapAadVersion: 1,
        filename: "legacy.pdf",
        contentType: "application/pdf",
        sizeBytes: bytesOf(plaintext).length,
        aadVersion: 1,
      }),
      { params: Promise.resolve({ teamId: s.team.teamId, id: s.entryId, attachmentId: attId }) },
    );
    expect(migrated.status).toBe(200);

    const { body, newItemKey } = await buildRekey(s);
    expect(body.attachmentCekRewraps.map((a) => a.id).sort()).toEqual([attId, s.attachment.attId].sort());
    expect((await rekey(s, body)).status).toBe(200);
    expect(await downloadWith(s, attId, newItemKey)).toBe(plaintext);
  });

  // ── A13 / A5: wrap IV reuse ──────────────────────────────────────────────

  it("ITEM_KEY_IV_REUSED: a wrap IV equal to a history row's whose wrap differs from the entry's (control: a fresh IV → 200)", async () => {
    const s = await seedEntry({ retained: true });
    const { body } = await buildRekey(s);
    const r = await ctx.su.pool.query<{ item_key_iv: string; encrypted_item_key: string }>(
      `SELECT item_key_iv, encrypted_item_key FROM team_password_entry_histories WHERE id = $1::uuid`,
      [s.history.retained],
    );
    expect(r.rows[0].encrypted_item_key).not.toBe((await entryRow(s.entryId)).encrypted_item_key);
    await expectRefusedUnchanged(s, { ...body, encryptedItemKey: { ...body.encryptedItemKey, iv: r.rows[0].item_key_iv } }, {
      status: 400, error: "ITEM_KEY_IV_REUSED",
    });
    expect((await rekey(s, body)).status).toBe(200);
  });

  it("ITEM_KEY_IV_REUSED: a wrap IV echoing the locked entry's (control: a fresh IV → 200)", async () => {
    const s = await seedEntry();
    const { body } = await buildRekey(s);
    const lockedIv = (await entryRow(s.entryId)).item_key_iv ?? "";
    await expectRefusedUnchanged(s, { ...body, encryptedItemKey: { ...body.encryptedItemKey, iv: lockedIv } }, {
      status: 400, error: "ITEM_KEY_IV_REUSED",
    });
    expect((await rekey(s, body)).status).toBe(200);
  });

  // ── A5 / A7: restore and re-key ──────────────────────────────────────────

  // ── A5 / F1: a restore built from a row a re-key then rewrote ───────────

  /** Give the sameKey row a JSON blob (the restore rebuilds the overview from it), under its own key. */
  async function jsonSameKeyRow(s: Seeded): Promise<string> {
    const text = JSON.stringify({ title: `restored ${randomUUID()}`, username: "u", password: randomUUID() });
    const sealed = await encryptData(text, await deriveItemEncryptionKey(s.itemKey), buildTeamEntryAAD(s.team.teamId, s.entryId, "blob", 1));
    await sql(
      `UPDATE team_password_entry_histories SET encrypted_blob = $2, blob_iv = $3, blob_auth_tag = $4 WHERE id = $1::uuid`,
      s.history.sameKey, sealed.ciphertext, sealed.iv, sealed.authTag,
    );
    s.historyPlain.set(s.history.sameKey, text);
    return text;
  }

  /** What the client does: GET the row, then build the body under the row's own key (D1). */
  async function clientRestoreBody(s: Seeded, historyId: string) {
    const got = await historyRowGET(
      new NextRequest(`http://localhost/api/teams/${s.team.teamId}/passwords/${s.entryId}/history/${historyId}`),
      { params: Promise.resolve({ teamId: s.team.teamId, id: s.entryId, historyId }) },
    );
    expect(got.status).toBe(200);
    const row = (await got.json()) as TeamHistoryRowDto;
    const rowKey = async (_teamId: string, entryId: string, keyData: EntryItemKeyData) =>
      deriveItemEncryptionKey(await unwrapItemKey(
        { ciphertext: keyData.encryptedItemKey ?? "", iv: keyData.itemKeyIv ?? "", authTag: keyData.itemKeyAuthTag ?? "" },
        await teamKeyOf(s.team, keyData.teamKeyVersion ?? 1),
        buildItemKeyWrapAAD(s.team.teamId, entryId, keyData.teamKeyVersion ?? 1),
      ));
    return { row, body: await buildTeamHistoryRestoreBody(s.team.teamId, s.entryId, row, rowKey) };
  }

  function restoreWith(s: Seeded, historyId: string, body: unknown) {
    return restoreRoute(
      jsonRequest(`http://localhost/api/teams/${s.team.teamId}/passwords/${s.entryId}/history/${historyId}/restore`, "POST", body),
      { params: Promise.resolve({ teamId: s.team.teamId, id: s.entryId, historyId }) },
    );
  }

  it("A5: a restore built before a re-key and parked behind it → 409 HISTORY_ROW_CHANGED, the entry stays as the re-key left it; the client's retry from the re-read row → 200", async () => {
    const s = await seedEntry();
    await jsonSameKeyRow(s);
    // The client read the row and sealed its overview under the row's
    // pre-re-key ItemKey before the re-key committed.
    const stale = await clientRestoreBody(s, s.history.sameKey);
    const { body, newItemKey } = await buildRekey(s);

    // Park the re-key (holding the entry FOR UPDATE) at its history read.
    const blocker = await race().holdRowLock(
      `SELECT id FROM team_password_entry_histories WHERE id = $1::uuid FOR UPDATE`,
      [s.history.v0],
    );
    const rekeyRes = rekey(s, body);
    let restoreRes: Promise<Response>;
    try {
      const rekeyPid = await race().waitForBackendBlockedBy(blocker.pid);
      restoreRes = restoreWith(s, s.history.sameKey, stale.body);
      expect(await race().settledOrBlocked(restoreRes, rekeyPid, blocker.pid)).toBe("blocked-on-parked");
    } finally {
      await blocker.release();
    }
    expect((await rekeyRes).status).toBe(200);
    const afterRekey = await entryRow(s.entryId);
    expect(await errorOf(await restoreRes)).toEqual({ status: 409, error: "HISTORY_ROW_CHANGED" });
    expect(await entryRow(s.entryId)).toEqual(afterRekey);
    expect((await rekeyList(s)).pendingCount).toBe(0);

    // The client re-fetches the row and retries once.
    const fresh = await clientRestoreBody(s, s.history.sameKey);
    expect(fresh.body.snapshotBlobIv).not.toBe(stale.body.snapshotBlobIv);
    expect((await restoreWith(s, s.history.sameKey, fresh.body)).status).toBe(200);
    const row = await entryRow(s.entryId);
    expect(row.item_key_team_key_version).toBe(3);
    expect(row.item_key_version).toBe(body.newItemKeyVersion);
    const data = await rekeyData(s);
    const newKey = await deriveItemEncryptionKey(newItemKey);
    expect(JSON.parse(await decryptData(
      { ciphertext: data.entry.encryptedOverview, iv: data.entry.overviewIv, authTag: data.entry.overviewAuthTag },
      newKey,
      buildTeamEntryAAD(s.team.teamId, s.entryId, "overview", body.newItemKeyVersion),
    ))).toMatchObject({ title: JSON.parse(s.historyPlain.get(s.history.sameKey) ?? "{}").title });
    expect(await rowsOffCurrentVersion(s.team.teamId)).toEqual([]);
  });

  it("A5 control: a restore of an unchanged row → 200, and the overview opens under the row's key", async () => {
    const s = await seedEntry();
    const text = await jsonSameKeyRow(s);
    const { body } = await clientRestoreBody(s, s.history.sameKey);

    expect((await restoreWith(s, s.history.sameKey, body)).status).toBe(200);

    const data = await rekeyData(s);
    expect(JSON.parse(await decryptData(
      { ciphertext: data.entry.encryptedOverview, iv: data.entry.overviewIv, authTag: data.entry.overviewAuthTag },
      await deriveItemEncryptionKey(s.itemKey),
      buildTeamEntryAAD(s.team.teamId, s.entryId, "overview", 1),
    ))).toMatchObject({ title: JSON.parse(text).title });
  });

  it("A7: re-key, then restore a re-keyed row → the marker stays current and the ids are equal", async () => {
    const s = await seedEntry();
    const { body, newItemKey } = await buildRekey(s);
    expect((await rekey(s, body)).status).toBe(200);
    const idAfterRekey = (await entryRow(s.entryId)).item_key_id;

    const newKey = await deriveItemEncryptionKey(newItemKey);
    const overview = await encryptData(
      s.plaintext.overview, newKey, buildTeamEntryAAD(s.team.teamId, s.entryId, "overview", body.newItemKeyVersion),
    );
    expect((await restore(s, s.history.aad0, overview)).status).toBe(200);

    const row = await entryRow(s.entryId);
    expect(row.item_key_team_key_version).toBe(3);
    expect(row.item_key_id).toBe(idAfterRekey);
    const data = await rekeyData(s);
    expect(await decryptData(
      { ciphertext: data.entry.encryptedBlob, iv: data.entry.blobIv, authTag: data.entry.blobAuthTag },
      newKey,
      buildTeamEntryAAD(s.team.teamId, s.entryId, "blob", body.newItemKeyVersion),
    )).toBe(s.historyPlain.get(s.history.aad0));
    expect((await rekeyList(s)).pendingCount).toBe(0);
  });

  // ── assertEntryRekeyConsistent, red-proved on seeded inconsistent rows ───

  describe("assertEntryRekeyConsistent", () => {
    class Rollback extends Error {}

    /** Run the post-check after `mutation`, in a transaction that is always rolled back. */
    async function postcheckAfter(entryId: string, retained: string[], mutation?: { sql: string; params: unknown[] }) {
      let outcome: unknown = "passed";
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        if (mutation) await tx.$executeRawUnsafe(mutation.sql, ...mutation.params);
        try {
          await assertEntryRekeyConsistent(tx, entryId, retained);
        } catch (e) {
          outcome = e;
        }
        throw new Rollback();
      }).catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
      return outcome;
    }

    async function rekeyed() {
      const s = await seedEntry({ retained: true });
      const { body } = await buildRekey(s);
      expect((await rekey(s, body)).status).toBe(200);
      return { s, retained: [s.history.retained ?? ""] };
    }

    it("passes on the rows a re-key wrote", async () => {
      const { s, retained } = await rekeyed();
      expect(await postcheckAfter(s.entryId, retained)).toBe("passed");
    });

    it("throws for a non-retained history row carrying a stale ItemKey id", async () => {
      const { s, retained } = await rekeyed();
      const outcome = await postcheckAfter(s.entryId, retained, {
        sql: `UPDATE team_password_entry_histories SET item_key_id = $2::uuid WHERE id = $1::uuid`,
        params: [s.history.sameKey, s.itemKeyId],
      });
      expect(outcome).toBeInstanceOf(RekeyConsistencyError);
      expect(outcome).toMatchObject({ code: REKEY_INCONSISTENCY.HISTORY_ROW_NOT_REKEYED });
    });

    it("throws for an attachment whose cekKeyVersion is the old ItemKey's", async () => {
      const { s, retained } = await rekeyed();
      const outcome = await postcheckAfter(s.entryId, retained, {
        sql: `UPDATE attachments SET cek_key_version = 1 WHERE id = $1::uuid`,
        params: [s.attachment.attId],
      });
      expect(outcome).toBeInstanceOf(RekeyConsistencyError);
      expect(outcome).toMatchObject({ code: REKEY_INCONSISTENCY.ATTACHMENT_NOT_REKEYED });
    });

    it("throws for a retained row carrying the entry's new ItemKey id", async () => {
      const { s, retained } = await rekeyed();
      const outcome = await postcheckAfter(s.entryId, retained, {
        sql: `UPDATE team_password_entry_histories h SET item_key_id = e.item_key_id
                FROM team_password_entries e WHERE h.id = $1::uuid AND e.id = h.entry_id`,
        params: [retained[0]],
      });
      expect(outcome).toBeInstanceOf(RekeyConsistencyError);
      expect(outcome).toMatchObject({ code: REKEY_INCONSISTENCY.RETAINED_ROW_CARRIES_NEW_ID });
    });

    it("throws for a re-keyed row named as retained", async () => {
      const { s, retained } = await rekeyed();
      const outcome = await postcheckAfter(s.entryId, [...retained, s.history.sameKey]);
      expect(outcome).toBeInstanceOf(RekeyConsistencyError);
      expect(outcome).toMatchObject({ code: REKEY_INCONSISTENCY.RETAINED_ROW_CARRIES_NEW_ID });
    });
  });
});
