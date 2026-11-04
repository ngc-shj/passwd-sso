/**
 * Integration test (real DB): team attachments under the entry ItemKey
 * (docs/archive/review/team-key-rotation-rekey-plan.md C4) — the mode-2 upload,
 * the migrate route (A13 refusal cells, each with its minus-step control), the
 * download's ItemKey-wrap selection (A5), and, against MinIO, object
 * generations and fail-closed refs (A3, BLOB_REF_INVALID) plus the personal
 * migrate through the blob store.
 *
 * Ciphertext is real (Web Crypto through the shared crypto modules) and every
 * 200 is read back through the download route and decrypted as a client would.
 * Production entry points are driven directly; only the auth, step-up and
 * rate-limit boundaries are mocked (precedent: team-key-rekey-writers). Audit
 * rows are read from audit_outbox, so the outbox worker must be stopped.
 *
 * MinIO is required for the "MinIO" block: set ANCHOR_TEST_S3_ENDPOINT (e.g.
 * http://127.0.0.1:9000) to a MinIO with the root credentials
 * minioadmin/minioadmin. A missing or unready endpoint fails the block; it
 * never skips.
 *
 * Run: docker compose up -d db minio && npm run test:integration -- team-attachment-rekey
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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
import { buildAttachmentAAD, buildItemKeyWrapAAD } from "@/lib/crypto/crypto-aad";
import { decryptBinary, encryptBinary } from "@/lib/crypto/crypto-client";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { collectAttachmentRefsByCreator } from "@/lib/blob-store/cleanup";

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

import { POST as uploadRoute } from "@/app/api/teams/[teamId]/passwords/[id]/attachments/route";
import {
  DELETE as deleteRoute,
  GET as downloadRoute,
} from "@/app/api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/route";
import { PUT as migrateRoute } from "@/app/api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/migrate/route";
import { POST as restoreRoute } from "@/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/restore/route";
import { POST as rotateRoute } from "@/app/api/teams/[teamId]/rotate-key/route";
import { PUT as personalMigrateRoute } from "@/app/api/passwords/[id]/attachments/[attachmentId]/migrate/route";
import { GET as personalDownloadRoute } from "@/app/api/passwords/[id]/attachments/[attachmentId]/route";

const hex = (n: number) => randomBytes(n).toString("hex");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
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

type Team = { teamId: string; admin: string; keys: Map<number, Uint8Array> };
type Entry = { teamId: string; entryId: string; itemKey: Uint8Array | null; itemKeyId: string | null; itemKeyVersion: number };
type Legacy = {
  attId: string;
  plaintext: string;
  ciphertext: Uint8Array;
  iv: string;
  authTag: string;
  filename: string;
  contentType: string;
};
type ItemKeyWrap = {
  source: "entry" | "history";
  historyId: string | null;
  encryptedItemKey: string;
  itemKeyIv: string;
  itemKeyAuthTag: string;
  teamKeyVersion: number;
  itemKeyVersion: number;
};
type Download = {
  encryptedData: string;
  iv: string;
  authTag: string;
  encryptionMode: number;
  keyVersion: number;
  cekEncrypted?: string;
  cekIv?: string;
  cekAuthTag?: string;
  cekKeyVersion?: number;
  cekWrapAadVersion?: number;
  itemKeyWrap?: ItemKeyWrap;
  itemKeyWraps?: ItemKeyWrap[];
};

describe("team attachments under the entry ItemKey — real-DB integration", () => {
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

  /** The blobIv of a history row, as the client reads it before a restore. */
  async function historyBlobIv(historyId: string): Promise<string> {
    const r = await ctx.su.pool.query<{ blob_iv: string }>(
      `SELECT blob_iv FROM team_password_entry_histories WHERE id = $1::uuid`,
      [historyId],
    );
    return r.rows[0].blob_iv;
  }

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

  /** A team at `version` with one ADMIN holding every version's key; the keys are kept in memory. */
  async function seedTeam(version: number): Promise<Team> {
    const teamId = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, $4, now(), now())`,
      teamId, tenantId, `team-${teamId.slice(0, 8)}`, version,
    );
    const versions = Array.from({ length: version }, (_, i) => i + 1);
    const admin = await seedMember(teamId, "ADMIN", versions);
    mockAuth.mockResolvedValue({ user: { id: admin } });
    return { teamId, admin, keys: new Map(versions.map((v) => [v, generateTeamSymmetricKey()])) };
  }

  async function wrapFor(team: Team, entryId: string, teamKeyVersion: number, itemKey: Uint8Array) {
    const teamKey = team.keys.get(teamKeyVersion);
    if (!teamKey) throw new Error(`no team key ${teamKeyVersion}`);
    return wrapItemKey(itemKey, await deriveTeamEncryptionKey(teamKey), buildItemKeyWrapAAD(team.teamId, entryId, teamKeyVersion));
  }

  /** An entry whose live ItemKey (v1+) is really wrapped under the team key at `teamKeyVersion`. */
  async function seedEntry(team: Team, opts: { teamKeyVersion: number; itemKeyVersion: number }): Promise<Entry> {
    const entryId = randomUUID();
    const itemKey = opts.itemKeyVersion >= 1 ? generateItemKey() : null;
    const itemKeyId = itemKey ? randomUUID() : null;
    const wrap = itemKey ? await wrapFor(team, entryId, opts.teamKeyVersion, itemKey) : null;
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
         1, $9, $10, $11, $12, $13, $14::uuid, $9, $10, 'LOGIN', now(), now()
       )`,
      entryId, team.teamId, tenantId, team.admin, hex(32), hex(12), hex(16), hex(12),
      opts.teamKeyVersion, opts.itemKeyVersion,
      wrap?.ciphertext ?? null, wrap?.iv ?? null, wrap?.authTag ?? null, itemKeyId,
    );
    return { teamId: team.teamId, entryId, itemKey, itemKeyId, itemKeyVersion: opts.itemKeyVersion };
  }

  /** A history row holding its own ItemKey (another live ItemKey the entry once had). */
  async function seedHistoryItemKey(team: Team, entry: Entry, teamKeyVersion: number, itemKeyVersion: number) {
    const itemKey = generateItemKey();
    const itemKeyId = randomUUID();
    const wrap = await wrapFor(team, entry.entryId, teamKeyVersion, itemKey);
    const historyId = randomUUID();
    await sql(
      `INSERT INTO team_password_entry_histories (
         id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag,
         aad_version, team_key_version, item_key_version,
         encrypted_item_key, item_key_iv, item_key_auth_tag, item_key_id,
         changed_by_id, changed_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12::uuid, $13::uuid, now())`,
      historyId, entry.entryId, tenantId, hex(32), hex(12), hex(16), teamKeyVersion, itemKeyVersion,
      wrap.ciphertext, wrap.iv, wrap.authTag, itemKeyId, team.admin,
    );
    return { historyId, itemKey, itemKeyId };
  }

  /**
   * A legacy attachment: mode 1 under the entry's ItemKey content key, mode 0
   * under the team key at `keyVersion`. `stored` overrides what encrypted_data
   * holds (a ref on an external backend; the ciphertext by default).
   */
  async function seedLegacy(
    team: Team,
    entry: Entry,
    opts: { mode: 0 | 1; keyVersion: number; stored?: (attId: string, ciphertext: Uint8Array) => Promise<Uint8Array> },
  ): Promise<Legacy> {
    const attId = randomUUID();
    const plaintext = `legacy body ${randomUUID()}`;
    const key = opts.mode === 1
      ? await deriveItemEncryptionKey(entry.itemKey ?? new Uint8Array())
      : await deriveTeamEncryptionKey(team.keys.get(opts.keyVersion) ?? new Uint8Array());
    const enc = await encryptBinary(toArrayBuffer(bytesOf(plaintext)), key, buildAttachmentAAD(entry.entryId, attId));
    const stored = opts.stored ? await opts.stored(attId, enc.ciphertext) : enc.ciphertext;
    const filename = "legacy.pdf";
    const contentType = "application/pdf";
    await sql(
      `INSERT INTO attachments (
         id, filename, content_type, size_bytes, encrypted_data, iv, auth_tag,
         key_version, aad_version, encryption_mode, tenant_id, team_password_entry_id, created_by_id, created_at
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10::uuid, $11::uuid, $12::uuid, now())`,
      attId, filename, contentType, bytesOf(plaintext).length, Buffer.from(stored), enc.iv, enc.authTag,
      opts.keyVersion, opts.mode, tenantId, entry.entryId, team.admin,
    );
    return { attId, plaintext, ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, filename, contentType };
  }

  // ── Client-side payloads (real crypto) ───────────────────────────────────

  /** A fresh CEK wrapped under `itemKey` (scope TW), and `plaintext` encrypted under it. */
  async function mode2Material(entry: Entry, attId: string, itemKey: Uint8Array, itemKeyVersion: number, plaintext: string) {
    const cek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const body = await encryptBinary(toArrayBuffer(bytesOf(plaintext)), cek, buildAttachmentAAD(entry.entryId, attId));
    const cekRaw = new Uint8Array(await crypto.subtle.exportKey("raw", cek));
    const wrapped = await wrapTeamAttachmentCek(cekRaw, await deriveItemCekWrapKey(itemKey), {
      teamId: entry.teamId,
      entryId: entry.entryId,
      attachmentId: attId,
      itemKeyVersion,
      cekWrapAadVersion: 1,
    });
    cekRaw.fill(0);
    return { body, wrapped };
  }

  async function migrateBody(entry: Entry, legacy: Legacy, overrides: Record<string, unknown> = {}) {
    if (!entry.itemKey) throw new Error("migrate needs an ItemKey");
    const { body, wrapped } = await mode2Material(entry, legacy.attId, entry.itemKey, entry.itemKeyVersion, legacy.plaintext);
    return {
      itemKeyId: entry.itemKeyId,
      cekKeyVersion: entry.itemKeyVersion,
      snapshot: { iv: legacy.iv, authTag: legacy.authTag },
      clientHash: sha256(legacy.ciphertext),
      encryptedData: b64(body.ciphertext),
      iv: body.iv,
      authTag: body.authTag,
      cekEncrypted: b64(wrapped.ciphertext),
      cekIv: wrapped.iv,
      cekAuthTag: wrapped.authTag,
      cekWrapAadVersion: 1,
      filename: legacy.filename,
      contentType: legacy.contentType,
      sizeBytes: bytesOf(legacy.plaintext).length,
      aadVersion: 1,
      ...overrides,
    };
  }

  function migrate(entry: Entry, attId: string, body: unknown) {
    return migrateRoute(
      jsonRequest(`http://localhost/api/teams/${entry.teamId}/passwords/${entry.entryId}/attachments/${attId}/migrate`, "PUT", body),
      { params: Promise.resolve({ teamId: entry.teamId, id: entry.entryId, attachmentId: attId }) },
    );
  }

  async function upload(entry: Entry, overrides: Record<string, string> = {}, plaintext = `uploaded ${randomUUID()}`) {
    const itemKey = entry.itemKey ?? generateItemKey();
    const attId = randomUUID();
    const { body, wrapped } = await mode2Material(entry, attId, itemKey, entry.itemKeyVersion || 1, plaintext);
    const fields: Record<string, string> = {
      id: attId,
      iv: body.iv,
      authTag: body.authTag,
      filename: "upload.pdf",
      contentType: "application/pdf",
      sizeBytes: String(bytesOf(plaintext).length),
      aadVersion: "1",
      encryptionMode: "2",
      itemKeyId: entry.itemKeyId ?? randomUUID(),
      cekKeyVersion: String(entry.itemKeyVersion || 1),
      cekEncrypted: b64(wrapped.ciphertext),
      cekIv: wrapped.iv,
      cekAuthTag: wrapped.authTag,
      cekWrapAadVersion: "1",
      ...overrides,
    };
    const form = new FormData();
    form.append("file", new Blob([toArrayBuffer(body.ciphertext)]));
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const encoded = new Request("http://localhost", { method: "POST", body: form });
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const res = await uploadRoute(
      new NextRequest(`http://localhost/api/teams/${entry.teamId}/passwords/${entry.entryId}/attachments`, {
        method: "POST",
        body: bytes,
        headers: {
          "content-type": encoded.headers.get("content-type") ?? "multipart/form-data",
          "content-length": String(bytes.length),
        },
      }),
      { params: Promise.resolve({ teamId: entry.teamId, id: entry.entryId }) },
    );
    return { res, attId, plaintext };
  }

  async function download(entry: Entry, attId: string): Promise<{ status: number; json: Download & { error?: string } }> {
    const res = await downloadRoute(
      new NextRequest(`http://localhost/api/teams/${entry.teamId}/passwords/${entry.entryId}/attachments/${attId}`),
      { params: Promise.resolve({ teamId: entry.teamId, id: entry.entryId, attachmentId: attId }) },
    );
    return { status: res.status, json: (await res.json()) as Download & { error?: string } };
  }

  async function openWrap(team: Team, entryId: string, wrap: ItemKeyWrap, keys: Map<number, Uint8Array>) {
    const teamKey = keys.get(wrap.teamKeyVersion);
    if (!teamKey) throw new Error(`the reader holds no team key ${wrap.teamKeyVersion}`);
    return unwrapItemKey(
      { ciphertext: wrap.encryptedItemKey, iv: wrap.itemKeyIv, authTag: wrap.itemKeyAuthTag },
      await deriveTeamEncryptionKey(teamKey),
      buildItemKeyWrapAAD(team.teamId, entryId, wrap.teamKeyVersion),
    );
  }

  /** Decrypt a download as the client does, with the team keys `keys` (default: all). */
  async function decryptDownload(team: Team, entry: Entry, attId: string, d: Download, keys = team.keys): Promise<string> {
    const body = { ciphertext: Buffer.from(d.encryptedData, "base64"), iv: d.iv, authTag: d.authTag };
    const aad = buildAttachmentAAD(entry.entryId, attId);
    if (d.encryptionMode === 2) {
      if (!d.itemKeyWrap || !d.cekEncrypted || !d.cekIv || !d.cekAuthTag) throw new Error("mode 2 without key material");
      const itemKey = await openWrap(team, entry.entryId, d.itemKeyWrap, keys);
      const cekRaw = await unwrapTeamAttachmentCek(
        { ciphertext: Buffer.from(d.cekEncrypted, "base64"), iv: d.cekIv, authTag: d.cekAuthTag },
        await deriveItemCekWrapKey(itemKey),
        { teamId: team.teamId, entryId: entry.entryId, attachmentId: attId, itemKeyVersion: d.cekKeyVersion ?? 0, cekWrapAadVersion: d.cekWrapAadVersion ?? 0 },
      );
      const cek = await crypto.subtle.importKey("raw", toArrayBuffer(cekRaw), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      return textOf(await decryptBinary(body, cek, aad));
    }
    if (d.encryptionMode === 1) {
      return (await trialDecrypt(team, entry, attId, d, d.itemKeyWraps ?? [], keys)).plaintext;
    }
    const teamKey = keys.get(d.keyVersion);
    if (!teamKey) throw new Error(`the reader holds no team key ${d.keyVersion}`);
    return textOf(await decryptBinary(body, await deriveTeamEncryptionKey(teamKey), aad));
  }

  /** Mode 1: try each returned wrap's ItemKey (the client's trial decryption). */
  async function trialDecrypt(team: Team, entry: Entry, attId: string, d: Download, wraps: ItemKeyWrap[], keys = team.keys) {
    for (const wrap of wraps) {
      try {
        const itemKey = await openWrap(team, entry.entryId, wrap, keys);
        const plain = await decryptBinary(
          { ciphertext: Buffer.from(d.encryptedData, "base64"), iv: d.iv, authTag: d.authTag },
          await deriveItemEncryptionKey(itemKey),
          buildAttachmentAAD(entry.entryId, attId),
        );
        return { plaintext: textOf(plain), wrap };
      } catch {
        // Not this ItemKey; try the next wrap.
      }
    }
    throw new Error("no returned wrap opens the attachment");
  }

  type AttachmentRow = {
    encryption_mode: number;
    iv: string;
    auth_tag: string;
    encrypted_data: Buffer;
    cek_item_key_id: string | null;
    cek_key_version: number | null;
    key_version: number | null;
  };

  async function attachmentRow(attId: string): Promise<AttachmentRow> {
    const r = await ctx.su.pool.query<AttachmentRow>(
      `SELECT encryption_mode, iv, auth_tag, encrypted_data, cek_item_key_id, cek_key_version, key_version
         FROM attachments WHERE id = $1::uuid`,
      [attId],
    );
    return r.rows[0];
  }

  async function migrateAudits(attId: string) {
    const r = await ctx.su.pool.query<{ payload: { userId: string; metadata: unknown } }>(
      `SELECT payload FROM audit_outbox WHERE payload->>'action' = 'TEAM_ATTACHMENT_MIGRATE' AND payload->>'targetId' = $1`,
      [attId],
    );
    return r.rows.map((row) => row.payload);
  }

  // ── Upload (A13, A5) ─────────────────────────────────────────────────────

  describe("upload", () => {
    it("control: a mode-2 upload under the live ItemKey is stored with the locked identity and decrypts", async () => {
      const team = await seedTeam(2);
      const entry = await seedEntry(team, { teamKeyVersion: 2, itemKeyVersion: 2 });
      const { res, attId, plaintext } = await upload(entry);
      expect(res.status).toBe(201);
      const row = await attachmentRow(attId);
      expect(row).toMatchObject({ encryption_mode: 2, cek_item_key_id: entry.itemKeyId, cek_key_version: 2, key_version: 2 });
      const d = await download(entry, attId);
      expect(d.status).toBe(200);
      expect(await decryptDownload(team, entry, attId, d.json)).toBe(plaintext);
    });

    it("CEK_KEY_VERSION_MISMATCH: the current itemKeyId with a wrong cekKeyVersion (control: the control cell above)", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 2 });
      const { res, attId } = await upload(entry, { cekKeyVersion: "1" });
      expect(await errorOf(res)).toEqual({ status: 409, error: "CEK_KEY_VERSION_MISMATCH" });
      expect(await attachmentRow(attId)).toBeUndefined();
      expect((await upload(entry)).res.status).toBe(201);
    });

    it("ENTRY_UPGRADE_REQUIRED: a v0 entry (control: the same entry after it gains an ItemKey)", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 0 });
      const refused = await upload(entry);
      expect(await errorOf(refused.res)).toEqual({ status: 409, error: "ENTRY_UPGRADE_REQUIRED" });
      expect(await attachmentRow(refused.attId)).toBeUndefined();

      // The upgrade's effect on the row: a v1 ItemKey wrapped under team key 1.
      const itemKey = generateItemKey();
      const itemKeyId = randomUUID();
      const wrap = await wrapFor(team, entry.entryId, 1, itemKey);
      await sql(
        `UPDATE team_password_entries SET item_key_version = 1, encrypted_item_key = $2, item_key_iv = $3,
                item_key_auth_tag = $4, item_key_id = $5::uuid, item_key_version_high_water = 1
          WHERE id = $1::uuid`,
        entry.entryId, wrap.ciphertext, wrap.iv, wrap.authTag, itemKeyId,
      );
      const upgraded = { ...entry, itemKey, itemKeyId, itemKeyVersion: 1 };
      expect((await upload(upgraded)).res.status).toBe(201);
    });

    it("ITEM_KEY_CHANGED: a stale itemKeyId, and checked before cekKeyVersion (stale id + wrong version)", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const stale = randomUUID();
      expect(await errorOf((await upload(entry, { itemKeyId: stale })).res)).toEqual({ status: 409, error: "ITEM_KEY_CHANGED" });
      expect(await errorOf((await upload(entry, { itemKeyId: stale, cekKeyVersion: "3" })).res)).toEqual({
        status: 409,
        error: "ITEM_KEY_CHANGED",
      });
      expect((await upload(entry)).res.status).toBe(201);
    });
  });

  // ── Upload after a restore: the re-key rule and the own-entry rule ───────

  async function restoreRow(entry: Entry, historyId: string) {
    return restoreRoute(
      jsonRequest(`http://localhost/api/teams/${entry.teamId}/passwords/${entry.entryId}/history/${historyId}/restore`, "POST", {
        encryptedOverview: { ciphertext: hex(32), iv: hex(12), authTag: hex(16) },
        snapshotBlobIv: await historyBlobIv(historyId),
      }),
      { params: Promise.resolve({ teamId: entry.teamId, id: entry.entryId, historyId }) },
    );
  }

  describe("upload after a restore (ENTRY_REKEY_REQUIRED)", () => {
    it("a restored row whose ItemKey is wrapped under an older team key → 409 ENTRY_REKEY_REQUIRED, nothing stored", async () => {
      const team = await seedTeam(2);
      const entry = await seedEntry(team, { teamKeyVersion: 2, itemKeyVersion: 1 });
      const old = await seedHistoryItemKey(team, entry, 1, 2);
      expect((await restoreRow(entry, old.historyId)).status).toBe(200);
      const restored = { ...entry, itemKey: old.itemKey, itemKeyId: old.itemKeyId, itemKeyVersion: 2 };

      const { res, attId } = await upload(restored);

      expect(await errorOf(res)).toEqual({ status: 409, error: "ENTRY_REKEY_REQUIRED" });
      expect(await attachmentRow(attId)).toBeUndefined();
    });

    it("control: a restored row at the current team key version → 201", async () => {
      const team = await seedTeam(2);
      const entry = await seedEntry(team, { teamKeyVersion: 2, itemKeyVersion: 1 });
      const current = await seedHistoryItemKey(team, entry, 2, 2);
      expect((await restoreRow(entry, current.historyId)).status).toBe(200);
      const restored = { ...entry, itemKey: current.itemKey, itemKeyId: current.itemKeyId, itemKeyVersion: 2 };

      expect((await upload(restored)).res.status).toBe(201);
    });
  });

  describe("own-entry rule on restore and upload (MEMBER: own entries only)", () => {
    async function memberOf(team: Team) {
      return seedMember(team.teamId, "MEMBER", [1]);
    }

    it("a MEMBER on another member's entry → restore and upload refused 403 ONLY_OWN_ENTRIES, nothing written", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const row = await seedHistoryItemKey(team, entry, 1, 2);
      const member = await memberOf(team);
      mockAuth.mockResolvedValue({ user: { id: member } });
      const before = await ctx.su.pool.query(`SELECT * FROM team_password_entries WHERE id = $1::uuid`, [entry.entryId]);

      expect(await errorOf(await restoreRow(entry, row.historyId))).toEqual({ status: 403, error: "ONLY_OWN_ENTRIES" });
      const { res, attId } = await upload(entry);
      expect(await errorOf(res)).toEqual({ status: 403, error: "ONLY_OWN_ENTRIES" });

      expect(await attachmentRow(attId)).toBeUndefined();
      const after = await ctx.su.pool.query(`SELECT * FROM team_password_entries WHERE id = $1::uuid`, [entry.entryId]);
      expect(after.rows).toEqual(before.rows);
    });

    it("control: a MEMBER on an entry they created → restore 200, upload 201", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const member = await memberOf(team);
      await sql(`UPDATE team_password_entries SET created_by_id = $2::uuid WHERE id = $1::uuid`, entry.entryId, member);
      mockAuth.mockResolvedValue({ user: { id: member } });

      expect((await upload(entry)).res.status).toBe(201);
      const row = await seedHistoryItemKey(team, entry, 1, 2);
      expect((await restoreRow(entry, row.historyId)).status).toBe(200);
    });

    it("control: an ADMIN on another member's entry → upload 201, restore 200", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const member = await memberOf(team);
      await sql(`UPDATE team_password_entries SET created_by_id = $2::uuid WHERE id = $1::uuid`, entry.entryId, member);
      mockAuth.mockResolvedValue({ user: { id: team.admin } });

      expect((await upload(entry)).res.status).toBe(201);
      const row = await seedHistoryItemKey(team, entry, 1, 2);
      expect((await restoreRow(entry, row.historyId)).status).toBe(200);
    });
  });

  // ── Upload and delete: the actor's role under the team lock ──────────────

  describe("ACTOR_NOT_PERMITTED on upload and delete: the actor's role, re-read under the team lock", () => {
    /**
     * Park `send` on the team FOR SHARE behind a blocker holding the team
     * row; the blocker optionally changes the actor's role, then commits.
     */
    async function parkedBehindTeamRow(team: Team, send: () => Promise<Response>, demoteTo: "MEMBER" | "VIEWER" | null) {
      const r = race();
      return r.parkBehind(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [team.teamId], send, async (blocker, parkedPid) => {
        expect(await r.waitingQueryOf(parkedPid)).toMatch(/FROM teams WHERE id = .* FOR SHARE/s);
        if (demoteTo) {
          await blocker.query(
            `UPDATE team_members SET role = $3::"TeamRole" WHERE team_id = $1::uuid AND user_id = $2::uuid`,
            [team.teamId, team.admin, demoteTo],
          );
        }
      });
    }

    const attachmentCount = async (entryId: string) =>
      Number((await ctx.su.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM attachments WHERE team_password_entry_id = $1::uuid`,
        [entryId],
      )).rows[0].n);

    function remove(entry: Entry, attId: string) {
      return deleteRoute(
        new NextRequest(`http://localhost/api/teams/${entry.teamId}/passwords/${entry.entryId}/attachments/${attId}`, { method: "DELETE" }),
        { params: Promise.resolve({ teamId: entry.teamId, id: entry.entryId, attachmentId: attId }) },
      );
    }

    it("upload: demoted to VIEWER while parked → 403 ACTOR_NOT_PERMITTED, nothing stored", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const res = await parkedBehindTeamRow(team, async () => (await upload(entry)).res, "VIEWER");
      expect(await errorOf(res)).toEqual({ status: 403, error: "ACTOR_NOT_PERMITTED" });
      expect(await attachmentCount(entry.entryId)).toBe(0);
    });

    it("upload control: the blocker commits without a role change → 201", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const res = await parkedBehindTeamRow(team, async () => (await upload(entry)).res, null);
      expect(res.status).toBe(201);
      expect(await attachmentCount(entry.entryId)).toBe(1);
    });

    it("delete: demoted to MEMBER (no PASSWORD_DELETE) while parked → 403 ACTOR_NOT_PERMITTED, the row stays", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const { attId } = await upload(entry);
      const res = await parkedBehindTeamRow(team, () => remove(entry, attId), "MEMBER");
      expect(await errorOf(res)).toEqual({ status: 403, error: "ACTOR_NOT_PERMITTED" });
      expect(await attachmentRow(attId)).toBeDefined();
    });

    it("delete control: the blocker commits without a role change → 200, the row is gone", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const { attId } = await upload(entry);
      const res = await parkedBehindTeamRow(team, () => remove(entry, attId), null);
      expect(res.status).toBe(200);
      expect(await attachmentRow(attId)).toBeUndefined();
    });
  });

  // ── Download: which ItemKey wrap (A5) ────────────────────────────────────

  describe("download", () => {
    it("after a rotation, a member holding only the new team key downloads a mode-2 attachment before any re-key", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const { attId, plaintext } = await upload(entry);
      const newcomer = await seedMember(team.teamId, "MEMBER", []);

      // Rotate through the route: the ItemKey is re-wrapped (not replaced) under team key 2.
      team.keys.set(2, generateTeamSymmetricKey());
      const live = await ctx.su.pool.query<{ item_key_iv: string }>(
        `SELECT item_key_iv FROM team_password_entries WHERE id = $1::uuid`, [entry.entryId],
      );
      const rewrapped = await wrapFor(team, entry.entryId, 2, entry.itemKey ?? new Uint8Array());
      const rotated = await rotateRoute(
        jsonRequest(`http://localhost/api/teams/${team.teamId}/rotate-key`, "POST", {
          newTeamKeyVersion: 2,
          entries: [{ id: entry.entryId, itemKeyVersion: 1, snapshotIv: live.rows[0].item_key_iv, encryptedItemKey: rewrapped, aadVersion: 1 }],
          memberKeys: [team.admin, newcomer].map((userId) => ({
            userId, encryptedTeamKey: hex(32), teamKeyIv: hex(12), teamKeyAuthTag: hex(16),
            ephemeralPublicKey: hex(32), hkdfSalt: hex(32), keyVersion: 2,
          })),
        }),
        { params: Promise.resolve({ teamId: team.teamId }) },
      );
      expect(rotated.status).toBe(200);

      mockAuth.mockResolvedValue({ user: { id: newcomer } });
      const d = await download(entry, attId);
      expect(d.status).toBe(200);
      expect(d.json.itemKeyWrap).toMatchObject({ source: "entry", teamKeyVersion: 2 });
      const newcomerKeys = new Map([[2, team.keys.get(2) ?? new Uint8Array()]]);
      expect(await decryptDownload(team, entry, attId, d.json, newcomerKeys)).toBe(plaintext);
    });

    it("an attachment uploaded under a previous ItemKey downloads via the history row holding it; with that row gone → ATTACHMENT_KEY_UNAVAILABLE", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const { attId, plaintext } = await upload(entry);
      // A restore switches the live ItemKey to another one; the old one moves to history.
      const other = await seedHistoryItemKey(team, entry, 1, 2);
      const restored = await restoreRoute(
        jsonRequest(`http://localhost/api/teams/${team.teamId}/passwords/${entry.entryId}/history/${other.historyId}/restore`, "POST", {
          encryptedOverview: { ciphertext: hex(32), iv: hex(12), authTag: hex(16) },
          snapshotBlobIv: await historyBlobIv(other.historyId),
        }),
        { params: Promise.resolve({ teamId: team.teamId, id: entry.entryId, historyId: other.historyId }) },
      );
      expect(restored.status).toBe(200);

      const d = await download(entry, attId);
      expect(d.status).toBe(200);
      expect(d.json.itemKeyWrap).toMatchObject({ source: "history", itemKeyVersion: 1 });
      expect(await decryptDownload(team, entry, attId, d.json)).toBe(plaintext);

      await sql(`DELETE FROM team_password_entry_histories WHERE entry_id = $1::uuid AND item_key_id = $2::uuid`, entry.entryId, entry.itemKeyId);
      expect(await errorOf(await downloadRoute(
        new NextRequest(`http://localhost/api/teams/${team.teamId}/passwords/${entry.entryId}/attachments/${attId}`),
        { params: Promise.resolve({ teamId: team.teamId, id: entry.entryId, attachmentId: attId }) },
      ))).toEqual({ status: 409, error: "ATTACHMENT_KEY_UNAVAILABLE" });
    });

    it("a legacy mode-1 attachment whose ItemKey only a history row holds downloads by trial decryption (red: the entry wrap alone fails)", async () => {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const legacy = await seedLegacy(team, entry, { mode: 1, keyVersion: 1 });
      const other = await seedHistoryItemKey(team, entry, 1, 2);
      const restored = await restoreRoute(
        jsonRequest(`http://localhost/api/teams/${team.teamId}/passwords/${entry.entryId}/history/${other.historyId}/restore`, "POST", {
          encryptedOverview: { ciphertext: hex(32), iv: hex(12), authTag: hex(16) },
          snapshotBlobIv: await historyBlobIv(other.historyId),
        }),
        { params: Promise.resolve({ teamId: team.teamId, id: entry.entryId, historyId: other.historyId }) },
      );
      expect(restored.status).toBe(200);

      const d = await download(entry, legacy.attId);
      expect(d.status).toBe(200);
      const wraps = d.json.itemKeyWraps ?? [];
      const opened = await trialDecrypt(team, entry, legacy.attId, d.json, wraps);
      expect(opened.plaintext).toBe(legacy.plaintext);
      expect(opened.wrap.source).toBe("history");
      await expect(
        trialDecrypt(team, entry, legacy.attId, d.json, wraps.filter((w) => w.source === "entry")),
      ).rejects.toThrow("no returned wrap");
    });

    it("a mode-0 attachment at keyVersion 1 on a team at version 2 opens with team key 1 (red: the latest key fails)", async () => {
      const team = await seedTeam(2);
      const entry = await seedEntry(team, { teamKeyVersion: 2, itemKeyVersion: 1 });
      const legacy = await seedLegacy(team, entry, { mode: 0, keyVersion: 1 });

      const d = await download(entry, legacy.attId);
      expect(d.status).toBe(200);
      expect(d.json.keyVersion).toBe(1);
      expect(await decryptDownload(team, entry, legacy.attId, d.json)).toBe(legacy.plaintext);
      await expect(
        decryptDownload(team, entry, legacy.attId, { ...d.json, keyVersion: 2 }),
      ).rejects.toThrow();
    });
  });

  // ── Migrate (A13) ────────────────────────────────────────────────────────

  describe("migrate", () => {
    async function seedMigratable(mode: 0 | 1 = 1) {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const legacy = await seedLegacy(team, entry, { mode, keyVersion: 1 });
      return { team, entry, legacy };
    }

    async function expectRefusedUnchanged(
      entry: Entry,
      legacy: Legacy,
      body: unknown,
      expected: { status: number; error: string },
    ) {
      const before = await attachmentRow(legacy.attId);
      expect(await errorOf(await migrate(entry, legacy.attId, body))).toEqual(expected);
      expect(await attachmentRow(legacy.attId)).toEqual(before);
      expect(await migrateAudits(legacy.attId)).toEqual([]);
    }

    it.each([0, 1] as const)(
      "control: mode %s → 2 under the locked ItemKey, audited in the transaction, and the download decrypts",
      async (mode) => {
        const { team, entry, legacy } = await seedMigratable(mode);
        const res = await migrate(entry, legacy.attId, await migrateBody(entry, legacy));
        expect(res.status).toBe(200);
        expect(await attachmentRow(legacy.attId)).toMatchObject({
          encryption_mode: 2,
          cek_item_key_id: entry.itemKeyId,
          cek_key_version: 1,
        });
        expect(await migrateAudits(legacy.attId)).toEqual([
          expect.objectContaining({ userId: team.admin, metadata: expect.objectContaining({ fromEncryptionMode: mode }) }),
        ]);
        const d = await download(entry, legacy.attId);
        expect(await decryptDownload(team, entry, legacy.attId, d.json)).toBe(legacy.plaintext);
      },
    );

    describe("ACTOR_NOT_PERMITTED: the actor's role, re-read under the team lock", () => {
      /**
       * Park the migrate on the team FOR SHARE behind a blocker holding the
       * team row; the blocker optionally demotes the actor, then commits.
       */
      async function migrateParkedBehind(revoke: boolean) {
        const { team, entry, legacy } = await seedMigratable();
        const body = await migrateBody(entry, legacy);
        const r = race();
        const res = await r.parkBehind(
          `SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`,
          [team.teamId],
          () => migrate(entry, legacy.attId, body),
          async (blocker, parkedPid) => {
            expect(await r.waitingQueryOf(parkedPid)).toMatch(/FROM teams WHERE id = .* FOR SHARE/s);
            if (revoke) {
              await blocker.query(
                `UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1::uuid AND user_id = $2::uuid`,
                [team.teamId, team.admin],
              );
            }
          },
        );
        return { res, legacy };
      }

      it("revoked while parked → 403 ACTOR_NOT_PERMITTED, row unchanged", async () => {
        const { res, legacy } = await migrateParkedBehind(true);
        expect(await errorOf(res)).toEqual({ status: 403, error: "ACTOR_NOT_PERMITTED" });
        expect((await attachmentRow(legacy.attId)).encryption_mode).toBe(1);
      });

      it("control: the blocker commits without revoking → 200", async () => {
        const { res } = await migrateParkedBehind(false);
        expect(res.status).toBe(200);
      });

      it("control: revoked before the request → FORBIDDEN from the gate", async () => {
        const { team, entry, legacy } = await seedMigratable();
        await sql(`UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1::uuid AND user_id = $2::uuid`, team.teamId, team.admin);
        expect(await errorOf(await migrate(entry, legacy.attId, await migrateBody(entry, legacy)))).toEqual({
          status: 403,
          error: "FORBIDDEN",
        });
      });
    });

    it("ITEM_KEY_CHANGED: a stale itemKeyId (control: the current one → 200)", async () => {
      const { entry, legacy } = await seedMigratable();
      await expectRefusedUnchanged(entry, legacy, await migrateBody(entry, legacy, { itemKeyId: randomUUID() }), {
        status: 409, error: "ITEM_KEY_CHANGED",
      });
      expect((await migrate(entry, legacy.attId, await migrateBody(entry, legacy))).status).toBe(200);
    });

    it("ITEM_KEY_CHANGED before CEK_KEY_VERSION_MISMATCH: a stale itemKeyId with a wrong cekKeyVersion", async () => {
      const { entry, legacy } = await seedMigratable();
      await expectRefusedUnchanged(entry, legacy, await migrateBody(entry, legacy, { itemKeyId: randomUUID(), cekKeyVersion: 5 }), {
        status: 409, error: "ITEM_KEY_CHANGED",
      });
    });

    it("CEK_KEY_VERSION_MISMATCH: the current itemKeyId with a wrong cekKeyVersion (control → 200)", async () => {
      const { entry, legacy } = await seedMigratable();
      await expectRefusedUnchanged(entry, legacy, await migrateBody(entry, legacy, { cekKeyVersion: 2 }), {
        status: 409, error: "CEK_KEY_VERSION_MISMATCH",
      });
      expect((await migrate(entry, legacy.attId, await migrateBody(entry, legacy))).status).toBe(200);
    });

    it("ENTRY_UPGRADE_REQUIRED: a v0 entry (control: the entry upgraded → 200)", async () => {
      const team = await seedTeam(1);
      const v0 = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 0 });
      const legacy = await seedLegacy(team, v0, { mode: 0, keyVersion: 1 });
      // The client's view after an upgrade it has not committed: an ItemKey the row lacks.
      const pretend = { ...v0, itemKey: generateItemKey(), itemKeyId: randomUUID(), itemKeyVersion: 1 };
      await expectRefusedUnchanged(pretend, legacy, await migrateBody(pretend, legacy), {
        status: 409, error: "ENTRY_UPGRADE_REQUIRED",
      });

      const wrap = await wrapFor(team, v0.entryId, 1, pretend.itemKey);
      await sql(
        `UPDATE team_password_entries SET item_key_version = 1, encrypted_item_key = $2, item_key_iv = $3,
                item_key_auth_tag = $4, item_key_id = $5::uuid, item_key_version_high_water = 1
          WHERE id = $1::uuid`,
        v0.entryId, wrap.ciphertext, wrap.iv, wrap.authTag, pretend.itemKeyId,
      );
      expect((await migrate(pretend, legacy.attId, await migrateBody(pretend, legacy))).status).toBe(200);
      const d = await download(pretend, legacy.attId);
      expect(await decryptDownload(team, pretend, legacy.attId, d.json)).toBe(legacy.plaintext);
    });

    it("MIGRATE_CAS_FAILED: a stale iv snapshot (control: the current snapshot → 200)", async () => {
      const { entry, legacy } = await seedMigratable();
      await expectRefusedUnchanged(entry, legacy, await migrateBody(entry, legacy, { snapshot: { iv: hex(12), authTag: legacy.authTag } }), {
        status: 409, error: "MIGRATE_CAS_FAILED",
      });
      expect((await migrate(entry, legacy.attId, await migrateBody(entry, legacy))).status).toBe(200);
    });

    it("MIGRATE_CAS_FAILED: a stale authTag snapshot (control: the current snapshot → 200)", async () => {
      const { entry, legacy } = await seedMigratable();
      await expectRefusedUnchanged(entry, legacy, await migrateBody(entry, legacy, { snapshot: { iv: legacy.iv, authTag: hex(16) } }), {
        status: 409, error: "MIGRATE_CAS_FAILED",
      });
      expect((await migrate(entry, legacy.attId, await migrateBody(entry, legacy))).status).toBe(200);
    });

    it("MIGRATE_HASH_MISMATCH: a hash over altered bytes (control → 200)", async () => {
      const { entry, legacy } = await seedMigratable();
      const altered = Uint8Array.from(legacy.ciphertext, (b, i) => (i === 0 ? b ^ 1 : b));
      await expectRefusedUnchanged(entry, legacy, await migrateBody(entry, legacy, { clientHash: sha256(altered) }), {
        status: 409, error: "MIGRATE_HASH_MISMATCH",
      });
      expect((await migrate(entry, legacy.attId, await migrateBody(entry, legacy))).status).toBe(200);
    });

    it("MIGRATE_LENGTH_CHANGED: a ciphertext of another length (control → 200)", async () => {
      const { entry, legacy } = await seedMigratable();
      const longer = await migrateBody(entry, { ...legacy, plaintext: `${legacy.plaintext}!` });
      await expectRefusedUnchanged(entry, legacy, { ...longer, sizeBytes: bytesOf(legacy.plaintext).length }, {
        status: 409, error: "MIGRATE_LENGTH_CHANGED",
      });
      expect((await migrate(entry, legacy.attId, await migrateBody(entry, legacy))).status).toBe(200);
    });

    it("MIGRATE_METADATA_CHANGED: a changed filename (control → 200)", async () => {
      const { entry, legacy } = await seedMigratable();
      await expectRefusedUnchanged(entry, legacy, await migrateBody(entry, legacy, { filename: "renamed.pdf" }), {
        status: 409, error: "MIGRATE_METADATA_CHANGED",
      });
      expect((await migrate(entry, legacy.attId, await migrateBody(entry, legacy))).status).toBe(200);
    });

    it("MIGRATE_NOT_LEGACY: an attachment already in mode 2 (control: its legacy self → 200)", async () => {
      const { entry, legacy } = await seedMigratable();
      expect((await migrate(entry, legacy.attId, await migrateBody(entry, legacy))).status).toBe(200);
      const migrated = await attachmentRow(legacy.attId);
      const again = await migrateBody(entry, legacy, { snapshot: { iv: migrated.iv, authTag: migrated.auth_tag } });
      expect(await errorOf(await migrate(entry, legacy.attId, again))).toEqual({ status: 409, error: "MIGRATE_NOT_LEGACY" });
      expect(await attachmentRow(legacy.attId)).toEqual(migrated);
    });
  });

  // ── MinIO (A3, BLOB_REF_INVALID, personal migrate) ───────────────────────

  describe("MinIO", () => {
    const ENDPOINT_ENV = "ANCHOR_TEST_S3_ENDPOINT";
    const BUCKET = "attachment-rekey-test";
    const prefix = `rekey-${randomUUID()}`;
    let s3: S3Client;

    beforeAll(async () => {
      const endpoint = process.env[ENDPOINT_ENV];
      if (!endpoint) {
        throw new Error(`${ENDPOINT_ENV} is required (a MinIO, e.g. http://127.0.0.1:9000; docker compose up -d minio)`);
      }
      s3 = new S3Client({
        region: "us-east-1",
        endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
      });
      try {
        await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
      }
    });

    afterAll(async () => {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${prefix}/` }));
      const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key ?? "" }));
      if (keys.length > 0) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys } }));
    });

    // Per test: stubs are undone after each test, so a beforeAll stub would
    // reach only the first one.
    beforeEach(() => {
      const endpoint = process.env[ENDPOINT_ENV] ?? "";
      vi.stubEnv("BLOB_BACKEND", "s3");
      vi.stubEnv("AWS_REGION", "us-east-1");
      vi.stubEnv("S3_ATTACHMENTS_BUCKET", BUCKET);
      vi.stubEnv("AWS_ENDPOINT_URL_S3", endpoint);
      vi.stubEnv("AWS_ACCESS_KEY_ID", "minioadmin");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "minioadmin");
      vi.stubEnv("BLOB_OBJECT_PREFIX", prefix);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function objectsUnder(keyPrefix: string): Promise<string[]> {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: keyPrefix }));
      return (listed.Contents ?? []).map((o) => o.Key ?? "").sort();
    }

    /** Store `ciphertext` at the legacy key of a team attachment and return the ref the row holds. */
    function legacyObject(entry: Entry) {
      return async (attId: string, ciphertext: Uint8Array) => {
        const key = `${prefix}/team/${entry.teamId}/${entry.entryId}/${attId}.bin`;
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.from(ciphertext) }));
        return new Uint8Array(Buffer.from(JSON.stringify({ key })));
      };
    }

    async function seedOnMinio() {
      const team = await seedTeam(1);
      const entry = await seedEntry(team, { teamKeyVersion: 1, itemKeyVersion: 1 });
      const legacy = await seedLegacy(team, entry, { mode: 1, keyVersion: 1, stored: legacyObject(entry) });
      const attPrefix = `${prefix}/team/${entry.teamId}/${entry.entryId}/${legacy.attId}`;
      return { team, entry, legacy, attPrefix };
    }

    it("A3: a migrate leaves exactly one object under the attachment prefix — a fresh generation — and it decrypts", async () => {
      const { team, entry, legacy, attPrefix } = await seedOnMinio();
      expect(await objectsUnder(attPrefix)).toEqual([`${attPrefix}.bin`]);

      expect((await migrate(entry, legacy.attId, await migrateBody(entry, legacy))).status).toBe(200);
      const objects = await objectsUnder(attPrefix);
      expect(objects).toHaveLength(1);
      expect(objects[0]).toMatch(new RegExp(`^${attPrefix}/[0-9a-f]{32}\\.bin$`));
      const d = await download(entry, legacy.attId);
      expect(await decryptDownload(team, entry, legacy.attId, d.json)).toBe(legacy.plaintext);
    });

    it("A3: of two concurrent migrates one wins and the other gets MIGRATE_NOT_LEGACY; only the winner's object survives", async () => {
      const { team, entry, legacy, attPrefix } = await seedOnMinio();
      const [bodyA, bodyB] = [await migrateBody(entry, legacy), await migrateBody(entry, legacy)];
      // Both park on the team row (after writing their objects) until released together.
      const blocker = await race().holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [team.teamId]);
      let results: Response[];
      try {
        const pending = [migrate(entry, legacy.attId, bodyA), migrate(entry, legacy.attId, bodyB)];
        const first = await race().waitForBackendBlockedBy(blocker.pid);
        await race().waitForBackendBlockedBy(blocker.pid, [first]);
        await blocker.release();
        results = await Promise.all(pending);
      } finally {
        await blocker.release();
      }
      const outcomes = await Promise.all(results.map(errorOf));
      expect(outcomes.map((o) => o.status).sort()).toEqual([200, 409]);
      expect(outcomes.find((o) => o.status === 409)?.error).toBe("MIGRATE_NOT_LEGACY");

      const objects = await objectsUnder(attPrefix);
      expect(objects).toHaveLength(1);
      const row = await attachmentRow(legacy.attId);
      expect(JSON.parse(row.encrypted_data.toString("utf8"))).toEqual({ key: objects[0] });
      const d = await download(entry, legacy.attId);
      expect(await decryptDownload(team, entry, legacy.attId, d.json)).toBe(legacy.plaintext);
    });

    it.each([
      ["iv", (legacy: Legacy) => ({ iv: hex(12), authTag: legacy.authTag })],
      ["authTag", (legacy: Legacy) => ({ iv: legacy.iv, authTag: hex(16) })],
    ] as const)("MIGRATE_CAS_FAILED on a stale %s: only the legacy object remains (control → 200)", async (_field, snapshot) => {
      const { team, entry, legacy, attPrefix } = await seedOnMinio();
      const refused = await migrate(entry, legacy.attId, await migrateBody(entry, legacy, { snapshot: snapshot(legacy) }));
      expect(await errorOf(refused)).toEqual({ status: 409, error: "MIGRATE_CAS_FAILED" });
      expect(await objectsUnder(attPrefix)).toEqual([`${attPrefix}.bin`]);
      const d = await download(entry, legacy.attId);
      expect(await decryptDownload(team, entry, legacy.attId, d.json)).toBe(legacy.plaintext);

      expect((await migrate(entry, legacy.attId, await migrateBody(entry, legacy))).status).toBe(200);
      expect(await objectsUnder(attPrefix)).toHaveLength(1);
    });

    it("BLOB_REF_INVALID: a row whose stored ref names another row's object (control: its own ref → 200)", async () => {
      const { team, entry, legacy: victim } = await seedOnMinio();
      const victimKey = `${prefix}/team/${entry.teamId}/${entry.entryId}/${victim.attId}.bin`;
      // A second attachment of the same entry whose row points at the victim's object.
      const forged = await seedLegacy(team, entry, {
        mode: 1,
        keyVersion: 1,
        stored: async () => new Uint8Array(Buffer.from(JSON.stringify({ key: victimKey }))),
      });

      const refused = await migrate(entry, forged.attId, await migrateBody(entry, forged));
      expect(await errorOf(refused)).toEqual({ status: 409, error: "BLOB_REF_INVALID" });
      expect((await attachmentRow(forged.attId)).encryption_mode).toBe(1);
      // The victim's object is untouched, and the refused request's new object is gone.
      expect(await objectsUnder(`${prefix}/team/${entry.teamId}/${entry.entryId}/${victim.attId}`)).toEqual([victimKey]);
      expect(await objectsUnder(`${prefix}/team/${entry.teamId}/${entry.entryId}/${forged.attId}`)).toEqual([]);
      expect((await download(entry, forged.attId)).json.error).toBe("BLOB_REF_INVALID");

      expect((await migrate(entry, victim.attId, await migrateBody(entry, victim))).status).toBe(200);
    });

    it("vault reset's creator-scoped collection names a team attachment's team (its ref then validates for cleanup)", async () => {
      const { team, entry, legacy, attPrefix } = await seedOnMinio();
      const refs = await withBypassRls(
        prisma,
        (tx) => collectAttachmentRefsByCreator(tx, team.admin),
        BYPASS_GRANT.VAULT_RESET_EXECUTE,
      );
      expect(refs).toEqual([
        {
          stored: expect.anything(),
          context: { attachmentId: legacy.attId, entryId: entry.entryId, teamId: team.teamId },
        },
      ]);
      expect(JSON.parse(Buffer.from(refs[0].stored).toString("utf8"))).toEqual({ key: `${attPrefix}.bin` });
    });

    it("personal migrate: hashes the stored body read through the blob store and writes the new body to a fresh object", async () => {
      const userId = await ctx.createUser(tenantId);
      await sql(`UPDATE users SET key_version = 1 WHERE id = $1::uuid`, userId);
      const entryId = randomUUID();
      await sql(
        `INSERT INTO password_entries (
           id, user_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag,
           encrypted_overview, overview_iv, overview_auth_tag, key_version, aad_version, entry_type, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $4, $5, $6, 1, 1, 'LOGIN', now(), now())`,
        entryId, userId, tenantId, hex(32), hex(12), hex(16),
      );
      const vaultKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
      const attId = randomUUID();
      const plaintext = `personal ${randomUUID()}`;
      const aad = buildAttachmentAAD(entryId, attId);
      const old = await encryptBinary(toArrayBuffer(bytesOf(plaintext)), vaultKey, aad);
      const attPrefix = `${prefix}/personal/${entryId}/${attId}`;
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${attPrefix}.bin`, Body: Buffer.from(old.ciphertext) }));
      await sql(
        `INSERT INTO attachments (
           id, filename, content_type, size_bytes, encrypted_data, iv, auth_tag,
           key_version, aad_version, encryption_mode, tenant_id, password_entry_id, created_by_id, created_at
         ) VALUES ($1::uuid, 'p.pdf', 'application/pdf', $2, $3, $4, $5, 1, 1, 0, $6::uuid, $7::uuid, $8::uuid, now())`,
        attId, bytesOf(plaintext).length, Buffer.from(JSON.stringify({ key: `${attPrefix}.bin` })),
        old.iv, old.authTag, tenantId, entryId, userId,
      );

      const cek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
      const next = await encryptBinary(toArrayBuffer(bytesOf(plaintext)), cek, aad);
      const wrapped = await encryptBinary(await crypto.subtle.exportKey("raw", cek), vaultKey);
      mockAuth.mockResolvedValue({ user: { id: userId } });
      const res = await personalMigrateRoute(
        jsonRequest(`http://localhost/api/passwords/${entryId}/attachments/${attId}/migrate`, "PUT", {
          oldEncryptedDataHash: sha256(old.ciphertext),
          encryptedData: b64(next.ciphertext),
          iv: next.iv,
          authTag: next.authTag,
          cekEncrypted: b64(wrapped.ciphertext),
          cekIv: wrapped.iv,
          cekAuthTag: wrapped.authTag,
          cekKeyVersion: 1,
          cekWrapAadVersion: 1,
        }),
        { params: Promise.resolve({ id: entryId, attachmentId: attId }) },
      );
      expect(await errorOf(res)).toEqual({ status: 200, error: undefined });

      const objects = await objectsUnder(attPrefix);
      expect(objects).toHaveLength(1);
      expect(objects[0]).toMatch(new RegExp(`^${attPrefix}/[0-9a-f]{32}\\.bin$`));
      const got = await personalDownloadRoute(
        new NextRequest(`http://localhost/api/passwords/${entryId}/attachments/${attId}`),
        { params: Promise.resolve({ id: entryId, attachmentId: attId }) },
      );
      const json = (await got.json()) as { encryptedData: string; iv: string; authTag: string; encryptionMode: number };
      expect(json.encryptionMode).toBe(2);
      const opened = await decryptBinary(
        { ciphertext: Buffer.from(json.encryptedData, "base64"), iv: json.iv, authTag: json.authTag },
        cek,
        aad,
      );
      expect(textOf(opened)).toBe(plaintext);
    });
  });
});
