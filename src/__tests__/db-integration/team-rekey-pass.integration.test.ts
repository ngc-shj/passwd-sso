/**
 * Integration test (real DB): the re-key pass end to end
 * (docs/archive/review/team-key-rotation-rekey-plan.md A1, A2, A3, A5, A6, A9,
 * A12 and user operation scenarios 3 and 5) — the React-free client modules
 * (`buildRotationPayload`, `runRekeyPass`, `buildTeamHistoryRestoreBody`) with
 * real Web Crypto, driven over the real route handlers through an in-process
 * fetch adapter.
 *
 * The session is the mocked `auth()` (precedent: team-entry-rekey); only the
 * auth, step-up and rate-limit boundaries are mocked. Team keys live in the
 * test's model: a member's resolver answers the key of each version the member
 * holds (a member-key row exists for it), so a member-key row's own wrap is
 * not exercised here (it is in team-vault-core.crypto.test.tsx). Every 200 is
 * read back from the DB and through the download route and decrypted as a
 * client would. Audit rows are read from audit_outbox, so the outbox worker
 * must be stopped.
 *
 * MinIO is required for the "MinIO" block: set ANCHOR_TEST_S3_ENDPOINT (e.g.
 * http://127.0.0.1:9000) to a MinIO with the root credentials
 * minioadmin/minioadmin. A missing or unready endpoint fails the block; it
 * never skips.
 *
 * Run: docker compose up -d db minio && npm run test:integration -- team-rekey-pass
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
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
import { decryptBinary, decryptData, encryptBinary, encryptData, type EncryptedData } from "@/lib/crypto/crypto-client";
import { normalizeTeamKeyVersion, type ResolveTeamKey } from "@/lib/team/team-key-resolution";
import { buildRotationPayload, type RotateCarry, type RotationSourceEntry } from "@/lib/team/rotation-payload";
import { buildEntryRekeyPayload, buildEntryUpgradePayload, type RekeyEntryData } from "@/lib/team/rekey-payload";
import { runRekeyPass, type RekeyListResponse, type RekeyPassResult } from "@/lib/team/rekey-runner";
import { buildRekeyReport, holderInputsFrom, REKEY_EXIT, REKEY_ISSUE } from "@/lib/team/rekey-report";
import { buildTeamHistoryRestoreBody, type TeamHistoryRowDto } from "@/lib/team/team-history-restore";

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

import { GET as rekeyListGET } from "@/app/api/teams/[teamId]/rekey/route";
import { GET as entryRekeyGET, POST as entryRekeyPOST } from "@/app/api/teams/[teamId]/passwords/[id]/rekey/route";
import { PUT as entryPUT } from "@/app/api/teams/[teamId]/passwords/[id]/route";
import { GET as downloadGET } from "@/app/api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/route";
import { PUT as migratePUT } from "@/app/api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/migrate/route";
import { GET as rotateDataGET } from "@/app/api/teams/[teamId]/rotate-key/data/route";
import { POST as rotatePOST } from "@/app/api/teams/[teamId]/rotate-key/route";
import { GET as historyRowGET } from "@/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/route";
import { POST as restorePOST } from "@/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/restore/route";

const bytesOf = (text: string) => new TextEncoder().encode(text);
const textOf = (buf: ArrayBuffer) => new TextDecoder().decode(buf);
const toArrayBuffer = (u8: Uint8Array) => u8.slice().buffer as ArrayBuffer;
const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const hex = (n: number) => randomBytes(n).toString("hex");
const sorted = (ids: readonly string[]) => [...ids].sort();

/** Flip the first hex digit of a ciphertext: a row no key opens. */
function corrupt(e: EncryptedData): EncryptedData {
  const first = e.ciphertext[0] === "0" ? "1" : "0";
  return { ...e, ciphertext: first + e.ciphertext.slice(1) };
}

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

type Role = "OWNER" | "ADMIN" | "MEMBER";

type Member = {
  role: Role;
  /** Versions the member holds a member-key row for. */
  held: Set<number>;
  /** A version whose member-key row wraps a WRONG team key (K'), with that key. */
  wrong: Map<number, CryptoKey>;
  /** Versions whose member-key row fails to unwrap. */
  invalid: Set<number>;
};

type Team = {
  teamId: string;
  version: number;
  /** Every team key by version (raw bytes; the test's view). */
  keys: Map<number, Uint8Array>;
  members: Map<string, Member>;
};

type Seal = { contentKey: CryptoKey; aadVersion: number; itemKeyVersion: number };

/** An ItemKey with its identity, as an entry or history row holds it. */
type ItemKey = { raw: Uint8Array; id: string; version: number };

type Plain = { blob: string; overview: string };

type Request = { method: string; path: string; status: number; error?: string };

describe("team re-key pass — real-DB integration", () => {
  let ctx: TestContext;
  let tenantId: string;

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

  // ── The team model ───────────────────────────────────────────────────────

  async function seedTeam(version: number): Promise<Team> {
    const teamId = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, $4, now(), now())`,
      teamId, tenantId, `team-${teamId.slice(0, 8)}`, version,
    );
    const keys = new Map<number, Uint8Array>();
    for (let v = 1; v <= version; v++) keys.set(v, generateTeamSymmetricKey());
    return { teamId, version, keys, members: new Map() };
  }

  async function insertMemberKey(team: Team, userId: string, keyVersion: number) {
    await sql(
      `INSERT INTO team_member_keys (
         id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv, team_key_auth_tag,
         ephemeral_public_key, hkdf_salt, key_version, wrap_version, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, 1, now(), now())`,
      randomUUID(), team.teamId, tenantId, userId, hex(32), hex(12), hex(16), hex(32), hex(32), keyVersion,
    );
  }

  async function seedMember(team: Team, role: Role, versions: number[], opts: { deactivated?: boolean } = {}): Promise<string> {
    const userId = await ctx.createUser(tenantId);
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, deactivated_at, deactivated_by_tenant, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", true, $6::timestamptz, $7, now(), now())`,
      randomUUID(), team.teamId, userId, tenantId, role,
      opts.deactivated ? new Date().toISOString() : null, opts.deactivated === true,
    );
    for (const v of versions) await insertMemberKey(team, userId, v);
    team.members.set(userId, { role, held: new Set(versions), wrong: new Map(), invalid: new Set() });
    return userId;
  }

  /** A member leaves the tenant: the membership is deactivated, the key rows stay. */
  async function depart(team: Team, userId: string) {
    await sql(
      `UPDATE team_members SET deactivated_at = now(), deactivated_by_tenant = true
        WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      team.teamId, userId,
    );
  }

  /** The member's client-side key resolver: the key of each held version (K' or key_invalid where seeded). */
  function resolverFor(team: Team, userId: string): ResolveTeamKey {
    return async (version) => {
      const v = normalizeTeamKeyVersion(version);
      const m = team.members.get(userId);
      if (!m || !m.held.has(v)) return { reason: "not_available" };
      if (m.invalid.has(v)) return { reason: "key_invalid" };
      const wrong = m.wrong.get(v);
      if (wrong) return { key: wrong };
      const raw = team.keys.get(v);
      if (!raw) return { reason: "not_available" };
      return { key: await deriveTeamEncryptionKey(raw) };
    };
  }

  async function teamKey(team: Team, version: number): Promise<CryptoKey> {
    const raw = team.keys.get(normalizeTeamKeyVersion(version));
    if (!raw) throw new Error(`no team key ${version}`);
    return deriveTeamEncryptionKey(raw);
  }

  async function wrapUnder(team: Team, entryId: string, teamKeyVersion: number, itemKey: Uint8Array) {
    return wrapItemKey(itemKey, await teamKey(team, teamKeyVersion), buildItemKeyWrapAAD(team.teamId, entryId, teamKeyVersion));
  }

  function newItemKey(version: number): ItemKey {
    return { raw: generateItemKey(), id: randomUUID(), version };
  }

  function aadFor(teamId: string, entryId: string, kind: "blob" | "overview", aadVersion: number, itemKeyVersion: number) {
    return aadVersion >= 1 ? buildTeamEntryAAD(teamId, entryId, kind, itemKeyVersion) : undefined;
  }

  function plainFor(label: string): Plain {
    const title = `${label} ${randomUUID()}`;
    return { blob: JSON.stringify({ title, password: randomUUID() }), overview: JSON.stringify({ title }) };
  }

  // ── Seeding (real ciphertext) ────────────────────────────────────────────

  /**
   * A team entry. With `itemKey`: sealed under it and wrapped under the team
   * key at `teamKeyVersion` (`marker` = item_key_team_key_version). Without: a
   * v0 entry sealed directly under the team key at `teamKeyVersion`.
   * `plantedKey`: the ItemKey is wrapped under a key that is not the team's
   * (a planted entry failing authentication under the real one).
   */
  async function seedEntry(
    team: Team,
    opts: {
      id?: string;
      teamKeyVersion: number;
      itemKey?: ItemKey;
      marker: number;
      highWater?: number;
      plain?: Plain;
      planted?: boolean;
    },
  ): Promise<{ entryId: string; plain: Plain }> {
    const entryId = opts.id ?? randomUUID();
    const plain = opts.plain ?? plainFor("entry");
    const ik = opts.itemKey;
    const contentKey = ik ? await deriveItemEncryptionKey(ik.raw) : await teamKey(team, opts.teamKeyVersion);
    const ikv = ik?.version ?? 0;
    const blob = await encryptData(plain.blob, contentKey, buildTeamEntryAAD(team.teamId, entryId, "blob", ikv));
    const overview = await encryptData(plain.overview, contentKey, buildTeamEntryAAD(team.teamId, entryId, "overview", ikv));
    const wrap = !ik
      ? null
      : opts.planted
        ? await wrapItemKey(ik.raw, await deriveTeamEncryptionKey(generateTeamSymmetricKey()), buildItemKeyWrapAAD(team.teamId, entryId, opts.teamKeyVersion))
        : await wrapUnder(team, entryId, opts.teamKeyVersion, ik.raw);
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
         1, $11, $12, $13, $14, $15, $16::uuid, $17, $18, 'LOGIN', now(), now()
       )`,
      entryId, team.teamId, tenantId, firstMember(team),
      blob.ciphertext, blob.iv, blob.authTag, overview.ciphertext, overview.iv, overview.authTag,
      opts.teamKeyVersion, ikv,
      wrap?.ciphertext ?? null, wrap?.iv ?? null, wrap?.authTag ?? null, ik?.id ?? null,
      opts.marker, opts.highWater ?? ikv,
    );
    return { entryId, plain };
  }

  function firstMember(team: Team): string {
    const [first] = team.members.keys();
    if (!first) throw new Error("seed a member first");
    return first;
  }

  /**
   * A history row. `seal` names the content key; `wrap` the ItemKey whose
   * wrap (under the team key at `teamKeyVersion`) the row carries, or null.
   */
  async function seedHistory(
    team: Team,
    entryId: string,
    row: {
      plaintext: string;
      seal: Seal;
      teamKeyVersion: number;
      wrap: Uint8Array | null;
      itemKeyId: string | null;
      corrupted?: boolean;
      changedAt?: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    const sealed = await encryptData(
      row.plaintext,
      row.seal.contentKey,
      aadFor(team.teamId, entryId, "blob", row.seal.aadVersion, row.seal.itemKeyVersion),
    );
    const blob = row.corrupted ? corrupt(sealed) : sealed;
    const wrap = row.wrap ? await wrapUnder(team, entryId, row.teamKeyVersion, row.wrap) : null;
    await sql(
      `INSERT INTO team_password_entry_histories (
         id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag,
         aad_version, team_key_version, item_key_version,
         encrypted_item_key, item_key_iv, item_key_auth_tag, item_key_id,
         changed_by_id, changed_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid, $14::uuid,
                 COALESCE($15::timestamptz, now()))`,
      id, entryId, tenantId, blob.ciphertext, blob.iv, blob.authTag,
      row.seal.aadVersion, row.teamKeyVersion, row.seal.itemKeyVersion,
      wrap?.ciphertext ?? null, wrap?.iv ?? null, wrap?.authTag ?? null, row.itemKeyId,
      firstMember(team), row.changedAt ?? null,
    );
    return id;
  }

  async function sealOf(ik: ItemKey, aadVersion = 1): Promise<Seal> {
    return { contentKey: await deriveItemEncryptionKey(ik.raw), aadVersion, itemKeyVersion: ik.version };
  }

  async function v0Seal(team: Team, teamKeyVersion: number): Promise<Seal> {
    return { contentKey: await teamKey(team, teamKeyVersion), aadVersion: 1, itemKeyVersion: 0 };
  }

  /** A mode-2 attachment whose CEK is wrapped under `ik` (TW scope). */
  async function seedMode2Attachment(team: Team, entryId: string, ik: ItemKey): Promise<{ attId: string; plaintext: string }> {
    const attId = randomUUID();
    const plaintext = `attachment ${randomUUID()}`;
    const cek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const body = await encryptBinary(toArrayBuffer(bytesOf(plaintext)), cek, buildAttachmentAAD(entryId, attId));
    const cekRaw = new Uint8Array(await crypto.subtle.exportKey("raw", cek));
    const wrapped = await wrapTeamAttachmentCek(cekRaw, await deriveItemCekWrapKey(ik.raw), {
      teamId: team.teamId, entryId, attachmentId: attId, itemKeyVersion: ik.version, cekWrapAadVersion: 1,
    });
    cekRaw.fill(0);
    await sql(
      `INSERT INTO attachments (
         id, filename, content_type, size_bytes, encrypted_data, iv, auth_tag,
         key_version, aad_version, encryption_mode,
         cek_encrypted, cek_iv, cek_auth_tag, cek_key_version, cek_wrap_aad_version, cek_item_key_id,
         tenant_id, team_password_entry_id, created_by_id, created_at
       ) VALUES ($1::uuid, 'a.pdf', 'application/pdf', $2, $3, $4, $5, $6, 1, 2,
                 $7, $8, $9, $10, 1, $11::uuid, $12::uuid, $13::uuid, $14::uuid, now())`,
      attId, bytesOf(plaintext).length, Buffer.from(body.ciphertext), body.iv, body.authTag, team.version,
      Buffer.from(wrapped.ciphertext), wrapped.iv, wrapped.authTag, ik.version, ik.id,
      tenantId, entryId, firstMember(team),
    );
    return { attId, plaintext };
  }

  /**
   * A legacy mode-0 attachment sealed under the team key at `keyVersion`.
   * `stored` overrides what encrypted_data holds (a ref on an external backend).
   */
  async function seedMode0Attachment(
    team: Team,
    entryId: string,
    keyVersion: number,
    stored?: (attId: string, ciphertext: Uint8Array) => Promise<Uint8Array>,
  ): Promise<{ attId: string; plaintext: string }> {
    const attId = randomUUID();
    const plaintext = `legacy ${randomUUID()}`;
    const enc = await encryptBinary(toArrayBuffer(bytesOf(plaintext)), await teamKey(team, keyVersion), buildAttachmentAAD(entryId, attId));
    const data = stored ? await stored(attId, enc.ciphertext) : enc.ciphertext;
    await sql(
      `INSERT INTO attachments (
         id, filename, content_type, size_bytes, encrypted_data, iv, auth_tag,
         key_version, aad_version, encryption_mode, tenant_id, team_password_entry_id, created_by_id, created_at
       ) VALUES ($1::uuid, 'legacy.pdf', 'application/pdf', $2, $3, $4, $5, $6, 1, 0, $7::uuid, $8::uuid, $9::uuid, now())`,
      attId, bytesOf(plaintext).length, Buffer.from(data), enc.iv, enc.authTag, keyVersion,
      tenantId, entryId, firstMember(team),
    );
    return { attId, plaintext };
  }

  // ── Client flows over the real routes ────────────────────────────────────

  type Hook = (req: { method: string; path: string }) => Promise<void> | void;

  /**
   * The runner's fetch, served by the route handlers in-process under the
   * mocked session. `before` runs ahead of each request (a concurrent writer,
   * or a thrown error for a closed tab).
   */
  function fetchAdapter(requests: Request[], before?: Hook) {
    return async (path: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      await before?.({ method, path });
      const url = new URL(path, "http://localhost");
      const p = url.pathname;
      const req = new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]);
      let m: RegExpMatchArray | null;
      let res: Response;
      if ((m = p.match(/^\/api\/teams\/([^/]+)\/rekey$/)) && method === "GET") {
        res = await rekeyListGET(req, { params: Promise.resolve({ teamId: m[1] }) });
      } else if ((m = p.match(/^\/api\/teams\/([^/]+)\/passwords\/([^/]+)\/rekey$/))) {
        const params = { params: Promise.resolve({ teamId: m[1], id: m[2] }) };
        res = method === "POST" ? await entryRekeyPOST(req, params) : await entryRekeyGET(req, params);
      } else if ((m = p.match(/^\/api\/teams\/([^/]+)\/passwords\/([^/]+)\/attachments\/([^/]+)\/migrate$/)) && method === "PUT") {
        res = await migratePUT(req, { params: Promise.resolve({ teamId: m[1], id: m[2], attachmentId: m[3] }) });
      } else if ((m = p.match(/^\/api\/teams\/([^/]+)\/passwords\/([^/]+)\/attachments\/([^/]+)$/)) && method === "GET") {
        res = await downloadGET(req, { params: Promise.resolve({ teamId: m[1], id: m[2], attachmentId: m[3] }) });
      } else if ((m = p.match(/^\/api\/teams\/([^/]+)\/passwords\/([^/]+)$/)) && method === "PUT") {
        res = await entryPUT(req, { params: Promise.resolve({ teamId: m[1], id: m[2] }) });
      } else {
        throw new Error(`fetch adapter: no route for ${method} ${path}`);
      }
      const error = res.ok ? undefined : ((await res.clone().json()) as { error?: string }).error;
      requests.push({ method, path, status: res.status, ...(error ? { error } : {}) });
      return res;
    };
  }

  async function runPass(
    team: Team,
    actor: string,
    opts: { pageLimit?: number; before?: Hook } = {},
  ): Promise<{ result: RekeyPassResult; requests: Request[] }> {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    const requests: Request[] = [];
    const result = await runRekeyPass({
      teamId: team.teamId,
      fetch: fetchAdapter(requests, opts.before),
      resolveKey: resolverFor(team, actor),
      invalidateTeamKeys: () => {},
      reauthenticate: async () => true,
      sleep: async () => {},
      ...(opts.pageLimit ? { pageLimit: opts.pageLimit } : {}),
    });
    return { result, requests };
  }

  /**
   * Rotate as the rotation button does: rotate-key/data → buildRotationPayload
   * (each entry opened at its own version, carries for what the actor cannot
   * open) → rotate POST. Every active key-distributed member gets the new
   * version on success.
   */
  async function rotate(team: Team, actor: string) {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    const params = { params: Promise.resolve({ teamId: team.teamId }) };
    const dataRes = await rotateDataGET(new NextRequest(`http://localhost/api/teams/${team.teamId}/rotate-key/data`), params);
    expect(dataRes.status).toBe(200);
    const data = (await dataRes.json()) as { teamKeyVersion: number; entries: RotationSourceEntry[]; actorKeyVersions: number[] };
    const to = data.teamKeyVersion + 1;
    const newRaw = generateTeamSymmetricKey();
    const heldVersions = new Set(data.actorKeyVersions.map(normalizeTeamKeyVersion));
    const payload = await buildRotationPayload(data.entries, resolverFor(team, actor), {
      teamId: team.teamId,
      newTeamKeyVersion: to,
      newTeamEncryptionKey: await deriveTeamEncryptionKey(newRaw),
      heldVersions,
    });
    const members = await ctx.su.pool.query<{ user_id: string }>(
      `SELECT user_id FROM team_members WHERE team_id = $1::uuid AND deactivated_at IS NULL AND key_distributed`,
      [team.teamId],
    );
    const memberIds = members.rows.map((r) => r.user_id);
    const res = await rotatePOST(
      jsonRequest(`http://localhost/api/teams/${team.teamId}/rotate-key`, "POST", {
        newTeamKeyVersion: to,
        entries: payload.entries,
        carry: payload.carry,
        memberKeys: memberIds.map((userId) => ({
          userId, encryptedTeamKey: hex(32), teamKeyIv: hex(12), teamKeyAuthTag: hex(16),
          ephemeralPublicKey: hex(32), hkdfSalt: hex(32), keyVersion: to,
        })),
      }),
      params,
    );
    if (res.status === 200) {
      team.keys.set(to, newRaw);
      team.version = to;
      for (const id of memberIds) team.members.get(id)?.held.add(to);
    }
    return { status: res.status, carry: payload.carry, entries: data.entries, heldVersions };
  }

  /** The rotation button's report of holder-claim carries (team-rotate-key-button.tsx carryReport). */
  async function rotationReport(team: Team, actor: string, r: Awaited<ReturnType<typeof rotate>>) {
    const attemptedByVersion = new Map<number, number>();
    for (const e of r.entries) {
      const v = normalizeTeamKeyVersion(e.teamKeyVersion);
      if (r.heldVersions.has(v)) attemptedByVersion.set(v, (attemptedByVersion.get(v) ?? 0) + 1);
    }
    const at = (reason: string) =>
      r.carry.filter((c) => c.reason === reason).map((c) => ({ entryId: c.id, teamKeyVersion: c.teamKeyVersion }));
    const list = await rekeyList(team, actor);
    return buildRekeyReport({
      undecryptable: at("undecryptable"),
      keyInvalid: at("key_invalid"),
      attemptedByVersion,
      otherHoldersByVersion: holderInputsFrom(list.versionHolders, "?").otherHoldersByVersion,
    });
  }

  async function rekeyList(team: Team, actor: string): Promise<RekeyListResponse> {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    const res = await rekeyListGET(
      new NextRequest(`http://localhost/api/teams/${team.teamId}/rekey`),
      { params: Promise.resolve({ teamId: team.teamId }) },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as RekeyListResponse;
  }

  async function rekeyData(team: Team, actor: string, entryId: string): Promise<RekeyEntryData> {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    const res = await entryRekeyGET(
      new NextRequest(`http://localhost/api/teams/${team.teamId}/passwords/${entryId}/rekey`),
      { params: Promise.resolve({ teamId: team.teamId, id: entryId }) },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as RekeyEntryData;
  }

  // ── Read-back ────────────────────────────────────────────────────────────

  type EntryRow = {
    team_key_version: number; item_key_version: number; item_key_team_key_version: number;
    item_key_id: string | null; aad_version: number;
    encrypted_blob: string; blob_iv: string; blob_auth_tag: string;
    encrypted_overview: string; overview_iv: string; overview_auth_tag: string;
    encrypted_item_key: string | null; item_key_iv: string | null; item_key_auth_tag: string | null;
  };

  async function entryRow(entryId: string): Promise<EntryRow> {
    const r = await ctx.su.pool.query<EntryRow>(`SELECT * FROM team_password_entries WHERE id = $1::uuid`, [entryId]);
    return r.rows[0];
  }

  type HistoryRow = {
    id: string; team_key_version: number; item_key_version: number; aad_version: number; item_key_id: string | null;
    encrypted_blob: string; blob_iv: string; blob_auth_tag: string;
    encrypted_item_key: string | null; item_key_iv: string | null; item_key_auth_tag: string | null;
  };

  async function historyRows(entryId: string): Promise<Map<string, HistoryRow>> {
    const r = await ctx.su.pool.query<HistoryRow>(`SELECT * FROM team_password_entry_histories WHERE entry_id = $1::uuid`, [entryId]);
    return new Map(r.rows.map((row) => [row.id, row]));
  }

  /** Every column of the entry's rows, to prove nothing changed. */
  async function snapshotRows(entryId: string) {
    const [entry, history, attachments] = await Promise.all([
      ctx.su.pool.query(`SELECT * FROM team_password_entries WHERE id = $1::uuid`, [entryId]),
      ctx.su.pool.query(`SELECT * FROM team_password_entry_histories WHERE entry_id = $1::uuid ORDER BY id`, [entryId]),
      ctx.su.pool.query(`SELECT * FROM attachments WHERE team_password_entry_id = $1::uuid ORDER BY id`, [entryId]),
    ]);
    return { entry: entry.rows, history: history.rows, attachments: attachments.rows };
  }

  /**
   * Rows of the team not on the team's current key version — independent of
   * the route's post-check (as in team-entry-rekey): entries off the current
   * team key or marker, history rows off it or not under their entry's
   * ItemKey (retained rows included), attachments not mode 2 under the
   * entry's ItemKey.
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

  async function auditsOf(action: string, targetId: string) {
    const r = await ctx.su.pool.query<{ payload: { userId: string; metadata: Record<string, unknown> } }>(
      `SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 AND payload->>'targetId' = $2`,
      [action, targetId],
    );
    return r.rows.map((row) => row.payload);
  }

  async function unwrapWith(team: Team, entryId: string, row: { encrypted_item_key: string | null; item_key_iv: string | null; item_key_auth_tag: string | null; team_key_version: number }) {
    return unwrapItemKey(
      { ciphertext: row.encrypted_item_key ?? "", iv: row.item_key_iv ?? "", authTag: row.item_key_auth_tag ?? "" },
      await teamKey(team, row.team_key_version),
      buildItemKeyWrapAAD(team.teamId, entryId, row.team_key_version),
    );
  }

  /** Download through the route and open the CEK with `itemKey`, as a client would. */
  async function downloadWith(team: Team, entryId: string, attId: string, itemKey: Uint8Array): Promise<string> {
    const res = await downloadGET(
      new NextRequest(`http://localhost/api/teams/${team.teamId}/passwords/${entryId}/attachments/${attId}`),
      { params: Promise.resolve({ teamId: team.teamId, id: entryId, attachmentId: attId }) },
    );
    expect(res.status).toBe(200);
    const d = (await res.json()) as {
      encryptionMode: number; encryptedData: string; iv: string; authTag: string;
      cekEncrypted: string; cekIv: string; cekAuthTag: string; cekKeyVersion: number; cekWrapAadVersion: number;
    };
    expect(d.encryptionMode).toBe(2);
    const cekRaw = await unwrapTeamAttachmentCek(
      { ciphertext: Buffer.from(d.cekEncrypted, "base64"), iv: d.cekIv, authTag: d.cekAuthTag },
      await deriveItemCekWrapKey(itemKey),
      { teamId: team.teamId, entryId, attachmentId: attId, itemKeyVersion: d.cekKeyVersion, cekWrapAadVersion: d.cekWrapAadVersion },
    );
    const cek = await crypto.subtle.importKey("raw", toArrayBuffer(cekRaw), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    return textOf(await decryptBinary(
      { ciphertext: Buffer.from(d.encryptedData, "base64"), iv: d.iv, authTag: d.authTag },
      cek,
      buildAttachmentAAD(entryId, attId),
    ));
  }

  /**
   * From the DB and the download route: the current team key opens the
   * entry's (new) ItemKey, which opens its blob, overview, every history row
   * in `history` and every attachment in `attachments`; each of `oldItemKeys`
   * fails under the same AAD. Returns the new ItemKey.
   */
  async function expectOnCurrentKey(
    team: Team,
    entryId: string,
    expected: {
      plain: Plain;
      history?: Map<string, string>;
      attachments?: Map<string, string>;
      oldItemKeys?: Uint8Array[];
    },
  ): Promise<Uint8Array> {
    const e = await entryRow(entryId);
    expect(e).toMatchObject({ team_key_version: team.version, item_key_team_key_version: team.version, aad_version: 1 });
    const itemKey = await unwrapWith(team, entryId, e);
    const contentKey = await deriveItemEncryptionKey(itemKey);
    const old = await Promise.all((expected.oldItemKeys ?? []).map((k) => deriveItemEncryptionKey(k)));
    const blobAad = buildTeamEntryAAD(team.teamId, entryId, "blob", e.item_key_version);
    const overviewAad = buildTeamEntryAAD(team.teamId, entryId, "overview", e.item_key_version);
    const blob = { ciphertext: e.encrypted_blob, iv: e.blob_iv, authTag: e.blob_auth_tag };
    const overview = { ciphertext: e.encrypted_overview, iv: e.overview_iv, authTag: e.overview_auth_tag };
    expect(await decryptData(blob, contentKey, blobAad)).toBe(expected.plain.blob);
    expect(await decryptData(overview, contentKey, overviewAad)).toBe(expected.plain.overview);
    for (const k of old) {
      await expect(decryptData(blob, k, blobAad)).rejects.toThrow();
      await expect(decryptData(overview, k, overviewAad)).rejects.toThrow();
    }

    const rows = await historyRows(entryId);
    for (const [id, plaintext] of expected.history ?? []) {
      const h = rows.get(id);
      if (!h) throw new Error(`history row ${id} is gone`);
      expect(h).toMatchObject({ team_key_version: team.version, item_key_version: e.item_key_version, aad_version: 1, item_key_id: e.item_key_id });
      expect(hexOf(await unwrapWith(team, entryId, h))).toBe(hexOf(itemKey));
      const ct = { ciphertext: h.encrypted_blob, iv: h.blob_iv, authTag: h.blob_auth_tag };
      expect(await decryptData(ct, contentKey, blobAad)).toBe(plaintext);
      for (const k of old) await expect(decryptData(ct, k, blobAad)).rejects.toThrow();
    }

    for (const [attId, plaintext] of expected.attachments ?? []) {
      expect(await downloadWith(team, entryId, attId, itemKey)).toBe(plaintext);
      for (const k of expected.oldItemKeys ?? []) await expect(downloadWith(team, entryId, attId, k)).rejects.toThrow();
    }
    return itemKey;
  }

  const posts = (requests: Request[]) => requests.filter((r) => r.method === "POST");

  // ── A1: rotation, then the pass ──────────────────────────────────────────

  it("A1 / scenario 1: after a departure, rotation then the pass leave every row under a new ItemKey only the current team key opens; nothing off-version, pending 0", async () => {
    const team = await seedTeam(1);
    const admin = await seedMember(team, "OWNER", [1]);
    const leaver = await seedMember(team, "MEMBER", [1]);
    const live = newItemKey(1);
    const previous = newItemKey(1);
    const { entryId, plain } = await seedEntry(team, { teamKeyVersion: 1, itemKey: live, marker: 1 });
    const history = new Map<string, string>();
    for (const [label, seal, wrap, itemKeyId] of [
      ["own wrap", await sealOf(live), live.raw, live.id],
      ["aadVersion 0", await sealOf(live, 0), live.raw, live.id],
      ["v0 row", await v0Seal(team, 1), null, null],
      ["previous ItemKey", await sealOf(previous), previous.raw, previous.id],
    ] as const) {
      const text = JSON.stringify({ title: `${label} ${randomUUID()}` });
      history.set(await seedHistory(team, entryId, { plaintext: text, seal, teamKeyVersion: 1, wrap, itemKeyId }), text);
    }
    const attachments = new Map<string, string>();
    for (const ik of [live, previous]) {
      const att = await seedMode2Attachment(team, entryId, ik);
      attachments.set(att.attId, att.plaintext);
    }

    await depart(team, leaver);
    const rotated = await rotate(team, admin);
    expect(rotated).toMatchObject({ status: 200, carry: [] });
    expect((await rekeyList(team, admin)).pendingCount).toBe(1);

    const { result, requests } = await runPass(team, admin);
    expect(result).toMatchObject({ status: "completed", rekeyed: [entryId], retained: [], skipped: [] });
    expect(posts(requests)).toEqual([{ method: "POST", path: `/api/teams/${team.teamId}/passwords/${entryId}/rekey`, status: 200 }]);

    await expectOnCurrentKey(team, entryId, { plain, history, attachments, oldItemKeys: [live.raw, previous.raw] });
    expect(await rowsOffCurrentVersion(team.teamId)).toEqual([]);
    expect(await rekeyList(team, admin)).toMatchObject({ pendingCount: 0, retainedHistoryCount: 0, entryIds: [] });
    // The leaver got no key to the new version.
    const leaverKeys = await ctx.su.pool.query(`SELECT key_version FROM team_member_keys WHERE user_id = $1::uuid ORDER BY key_version`, [leaver]);
    expect(leaverKeys.rows).toEqual([{ key_version: 1 }]);
  });

  // ── A2: stale-version entries and old-version history ────────────────────

  it("A2 / scenario 2: entries and history at older team key versions rotate (each opened at its own version) and re-key", async () => {
    const team = await seedTeam(3);
    const admin = await seedMember(team, "OWNER", [1, 2, 3]);
    // E1: a restored entry still at team key 1. E2: at team key 2, with
    // history under an older ItemKey wrapped at team key 1 and a v0 row at 1.
    const ik1 = newItemKey(1);
    const ik2 = newItemKey(2);
    const ik2old = newItemKey(1);
    const e1 = await seedEntry(team, { teamKeyVersion: 1, itemKey: ik1, marker: 0 });
    const e2 = await seedEntry(team, { teamKeyVersion: 2, itemKey: ik2, marker: 2, highWater: 2 });
    const h1Text = JSON.stringify({ title: `e1 history ${randomUUID()}` });
    const h1 = await seedHistory(team, e1.entryId, { plaintext: h1Text, seal: await sealOf(ik1), teamKeyVersion: 1, wrap: ik1.raw, itemKeyId: ik1.id });
    const h2aText = JSON.stringify({ title: `e2 old ItemKey ${randomUUID()}` });
    const h2a = await seedHistory(team, e2.entryId, { plaintext: h2aText, seal: await sealOf(ik2old), teamKeyVersion: 1, wrap: ik2old.raw, itemKeyId: ik2old.id });
    const h2bText = JSON.stringify({ title: `e2 v0 ${randomUUID()}` });
    const h2b = await seedHistory(team, e2.entryId, { plaintext: h2bText, seal: await v0Seal(team, 1), teamKeyVersion: 1, wrap: null, itemKeyId: null });

    const rotated = await rotate(team, admin);
    expect(rotated).toMatchObject({ status: 200, carry: [] });
    // Rotation re-wrapped each ItemKey (never replaced it) under team key 4.
    for (const [entryId, ik] of [[e1.entryId, ik1], [e2.entryId, ik2]] as const) {
      const row = await entryRow(entryId);
      expect(row).toMatchObject({ team_key_version: 4, item_key_id: ik.id });
      expect(hexOf(await unwrapWith(team, entryId, row))).toBe(hexOf(ik.raw));
    }
    expect((await rekeyList(team, admin)).pendingCount).toBe(2);

    const { result } = await runPass(team, admin);
    expect(result).toMatchObject({ status: "completed", retained: [], skipped: [] });
    expect(sorted(result.rekeyed)).toEqual(sorted([e1.entryId, e2.entryId]));
    await expectOnCurrentKey(team, e1.entryId, { plain: e1.plain, history: new Map([[h1, h1Text]]), oldItemKeys: [ik1.raw] });
    await expectOnCurrentKey(team, e2.entryId, {
      plain: e2.plain,
      history: new Map([[h2a, h2aText], [h2b, h2bText]]),
      oldItemKeys: [ik2.raw, ik2old.raw],
    });
    expect(await rowsOffCurrentVersion(team.teamId)).toEqual([]);
    expect((await rekeyList(team, admin)).pendingCount).toBe(0);
  });

  it("A2: rotate → the v0→v1 upgrade edit leaves the entry pending; the pass then re-keys it", async () => {
    const team = await seedTeam(1);
    const admin = await seedMember(team, "OWNER", [1]);
    const v0 = await seedEntry(team, { teamKeyVersion: 1, marker: 0 });
    expect((await rotate(team, admin)).status).toBe(200);
    expect(await entryRow(v0.entryId)).toMatchObject({ team_key_version: 2, item_key_version: 0 });

    // The upgrade an edit sends (a new ItemKey wrapped under the current key).
    const data = await rekeyData(team, admin, v0.entryId);
    const upgrade = await buildEntryUpgradePayload(team.teamId, data.entry, data.nextItemKeyVersion, data.teamKeyVersion, resolverFor(team, admin));
    if (upgrade.kind !== "payload") throw new Error(`upgrade blocked: ${upgrade.block}`);
    const res = await entryPUT(
      jsonRequest(`http://localhost/api/teams/${team.teamId}/passwords/${v0.entryId}`, "PUT", upgrade.body),
      { params: Promise.resolve({ teamId: team.teamId, id: v0.entryId }) },
    );
    expect(res.status).toBe(200);
    expect(await entryRow(v0.entryId)).toMatchObject({ team_key_version: 2, item_key_version: 1, item_key_team_key_version: 0 });
    expect(await rekeyList(team, admin)).toMatchObject({ pendingCount: 1, entryIds: [v0.entryId] });

    const { result } = await runPass(team, admin);
    expect(result).toMatchObject({ status: "completed", rekeyed: [v0.entryId] });
    await expectOnCurrentKey(team, v0.entryId, { plain: v0.plain });
    expect((await rekeyList(team, admin)).pendingCount).toBe(0);
  });

  // ── A3: v0 entry with a mode-0 attachment ────────────────────────────────

  it("A3: the pass upgrades a v0 entry, migrates its mode-0 attachment (sealed under an older team key) and re-keys it", async () => {
    const team = await seedTeam(2);
    const admin = await seedMember(team, "OWNER", [1, 2]);
    const v0 = await seedEntry(team, { teamKeyVersion: 2, marker: 0 });
    const legacy = await seedMode0Attachment(team, v0.entryId, 1);

    const { result, requests } = await runPass(team, admin);
    expect(result).toMatchObject({ status: "completed", rekeyed: [v0.entryId], skipped: [] });
    const base = `/api/teams/${team.teamId}/passwords/${v0.entryId}`;
    expect(requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual([
      `PUT ${base} 200`,
      `PUT ${base}/attachments/${legacy.attId}/migrate 200`,
      `POST ${base}/rekey 200`,
    ]);
    await expectOnCurrentKey(team, v0.entryId, { plain: v0.plain, attachments: new Map([[legacy.attId, legacy.plaintext]]) });
    expect(await rowsOffCurrentVersion(team.teamId)).toEqual([]);
  });

  // ── A5 / scenario 5: a rotation committing mid-pass ──────────────────────

  it("A5 / scenario 5: a second departure and rotation committing mid-pass → the re-key POST gets TEAM_KEY_VERSION_CHANGED and the runner recovers to pending 0", async () => {
    const team = await seedTeam(1);
    const admin = await seedMember(team, "OWNER", [1]);
    const first = await seedMember(team, "MEMBER", [1]);
    const second = await seedMember(team, "MEMBER", [1]);
    const entries = [];
    for (let i = 0; i < 3; i++) {
      const ik = newItemKey(1);
      entries.push({ ...(await seedEntry(team, { teamKeyVersion: 1, itemKey: ik, marker: 1 })), ik });
    }
    await depart(team, first);
    expect((await rotate(team, admin)).status).toBe(200);

    let rotatedMidPass = false;
    let postCount = 0;
    const { result, requests } = await runPass(team, admin, {
      before: async ({ method }) => {
        if (method !== "POST" || ++postCount !== 2 || rotatedMidPass) return;
        rotatedMidPass = true;
        // Between this entry's GET and its POST: a second member leaves and
        // an admin rotates again.
        await depart(team, second);
        expect((await rotate(team, admin)).status).toBe(200);
        mockAuth.mockResolvedValue({ user: { id: admin } });
      },
    });

    expect(rotatedMidPass).toBe(true);
    expect(posts(requests).filter((r) => r.status === 409)).toEqual([
      expect.objectContaining({ error: "TEAM_KEY_VERSION_CHANGED" }),
    ]);
    expect(result).toMatchObject({ status: "completed", skipped: [] });
    expect(team.version).toBe(3);
    for (const e of entries) {
      await expectOnCurrentKey(team, e.entryId, { plain: e.plain, oldItemKeys: [e.ik.raw] });
    }
    expect(await rowsOffCurrentVersion(team.teamId)).toEqual([]);
    expect((await rekeyList(team, admin)).pendingCount).toBe(0);
    const departedKeys = await ctx.su.pool.query<{ user_id: string; key_version: number }>(
      `SELECT user_id, key_version FROM team_member_keys WHERE team_id = $1::uuid AND user_id = ANY($2::uuid[]) ORDER BY user_id, key_version`,
      [team.teamId, [first, second]],
    );
    expect(departedKeys.rows.filter((r) => r.user_id === first).map((r) => r.key_version)).toEqual([1]);
    expect(departedKeys.rows.filter((r) => r.user_id === second).map((r) => r.key_version)).toEqual([1, 2]);
  });

  // ── A6: retained history through the runner ─────────────────────────────

  /**
   * A team at version 3. The rotating admin A holds 3 only; B (an ADMIN)
   * holds 2 and 3; nobody holds 1. Entry E (pending, live ItemKey L at item
   * key version 2 wrapped under 3) holds five history rows:
   * - `atV`: under ItemKey O wrapped at team key 2 (only B opens it);
   * - `corrupt`: under L's own wrap, blob corrupted (nobody opens it);
   * - `legacy`: under ItemKey X wrapped at team key 1, id NULL (nobody);
   * - `own`: under ItemKey Y with its own wrap at team key 3 (A opens it);
   * - `trial`: under L, wrapped at team key 1, id NULL (A opens it by trial).
   * Entry N is not pending (marker 3).
   */
  async function seedA6() {
    const team = await seedTeam(3);
    const a = await seedMember(team, "OWNER", [3]);
    const b = await seedMember(team, "ADMIN", [2, 3]);
    const L = newItemKey(2);
    const O = newItemKey(1);
    const X = newItemKey(1);
    const Y = newItemKey(1);
    const e = await seedEntry(team, { teamKeyVersion: 3, itemKey: L, marker: 2, highWater: 2 });
    const text = (label: string) => JSON.stringify({ title: `${label} ${randomUUID()}` });
    const plain = new Map<string, string>();
    const add = async (label: string, row: Omit<Parameters<typeof seedHistory>[2], "plaintext">) => {
      const t = text(label);
      const id = await seedHistory(team, e.entryId, { plaintext: t, ...row });
      plain.set(id, t);
      return id;
    };
    const rows = {
      atV: await add("atV", { seal: await sealOf(O), teamKeyVersion: 2, wrap: O.raw, itemKeyId: O.id }),
      corrupt: await add("corrupt", { seal: await sealOf(L), teamKeyVersion: 3, wrap: L.raw, itemKeyId: L.id, corrupted: true }),
      legacy: await add("legacy", { seal: await sealOf(X), teamKeyVersion: 1, wrap: X.raw, itemKeyId: null }),
      own: await add("own", { seal: await sealOf(Y), teamKeyVersion: 3, wrap: Y.raw, itemKeyId: Y.id }),
      trial: await add("trial", { seal: await sealOf(L), teamKeyVersion: 1, wrap: L.raw, itemKeyId: null }),
    };
    const n = await seedEntry(team, { teamKeyVersion: 3, itemKey: newItemKey(1), marker: 3 });
    return { team, a, b, e, n, rows, plain, keys: { L, O, X, Y } };
  }

  /** A's first pass over the A6 seed: the two rows A can open are re-keyed, the three it cannot are retained. */
  async function firstPassA6(s: Awaited<ReturnType<typeof seedA6>>) {
    const retainedBefore = await snapshotRetained(s);
    const { result, requests } = await runPass(s.team, s.a);
    expect(result).toMatchObject({ status: "completed", rekeyed: [s.e.entryId], skipped: [] });
    expect(sorted(result.retained.map((r) => r.historyId))).toEqual(sorted([s.rows.atV, s.rows.corrupt, s.rows.legacy]));
    // The runner never touched the entry that is not pending.
    expect(requests.filter((r) => r.path.includes(s.n.entryId))).toEqual([]);
    expect(await snapshotRetained(s)).toEqual(retainedBefore);
    return { result, requests };
  }

  async function snapshotRetained(s: Awaited<ReturnType<typeof seedA6>>) {
    const r = await ctx.su.pool.query(
      `SELECT * FROM team_password_entry_histories WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[s.rows.atV, s.rows.corrupt, s.rows.legacy]],
    );
    return r.rows;
  }

  it("A6: three rows the re-keyer cannot open are retained (exact ids), two it can are re-keyed; audit, off-version rows and retainedHistoryCount list the retained", async () => {
    const s = await seedA6();
    expect((await rekeyList(s.team, s.a)).retainedHistoryCount).toBe(4);
    await firstPassA6(s);

    const rows = await historyRows(s.e.entryId);
    const entry = await entryRow(s.e.entryId);
    expect(entry.item_key_id).not.toBe(s.keys.L.id);
    for (const id of [s.rows.own, s.rows.trial]) expect(rows.get(id)?.item_key_id).toBe(entry.item_key_id);
    await expectOnCurrentKey(s.team, s.e.entryId, {
      plain: s.e.plain,
      history: new Map([s.rows.own, s.rows.trial].map((id) => [id, s.plain.get(id) ?? ""])),
      oldItemKeys: [s.keys.L.raw, s.keys.Y.raw],
    });

    const [audit] = await auditsOf("TEAM_ENTRY_REKEY", s.e.entryId);
    expect(audit.userId).toBe(s.a);
    expect(audit.metadata.retained).toEqual(expect.arrayContaining([
      { id: s.rows.atV, teamKeyVersion: 2, itemKeyVersion: 1 },
      { id: s.rows.corrupt, teamKeyVersion: 3, itemKeyVersion: 2 },
      { id: s.rows.legacy, teamKeyVersion: 1, itemKeyVersion: 1 },
    ]));
    expect(audit.metadata.retained).toHaveLength(3);
    expect(sorted(await rowsOffCurrentVersion(s.team.teamId))).toEqual(sorted([s.rows.atV, s.rows.corrupt, s.rows.legacy]));
    expect(await rekeyList(s.team, s.a)).toMatchObject({ pendingCount: 0, retainedHistoryCount: 3 });
  });

  it("A6: a direct re-key POST for the entry that is not pending → REKEY_NOT_PENDING, rows unchanged", async () => {
    const s = await seedA6();
    await firstPassA6(s);
    const data = await rekeyData(s.team, s.a, s.n.entryId);
    const built = await buildEntryRekeyPayload(s.team.teamId, data, resolverFor(s.team, s.a));
    if (built.kind !== "payload") throw new Error(`blocked: ${built.block}`);
    const before = await snapshotRows(s.n.entryId);
    const res = await entryRekeyPOST(
      jsonRequest(`http://localhost/api/teams/${s.team.teamId}/passwords/${s.n.entryId}/rekey`, "POST", built.body),
      { params: Promise.resolve({ teamId: s.team.teamId, id: s.n.entryId }) },
    );
    expect(await errorOf(res)).toEqual({ status: 409, error: "REKEY_NOT_PENDING" });
    expect(await snapshotRows(s.n.entryId)).toEqual(before);
    expect(await auditsOf("TEAM_ENTRY_REKEY", s.n.entryId)).toEqual([]);
  });

  it("A6: after the next rotation, the version-2 holder (an ADMIN) re-keying first moves exactly the version-2 row (retainedHistoryCount 3 → 2)", async () => {
    const s = await seedA6();
    await firstPassA6(s);
    expect((await rotate(s.team, s.a)).status).toBe(200);
    expect((await rekeyList(s.team, s.b)).retainedHistoryCount).toBe(3);

    const { result } = await runPass(s.team, s.b);
    expect(result).toMatchObject({ status: "completed", skipped: [] });
    expect(sorted(result.rekeyed)).toEqual(sorted([s.e.entryId, s.n.entryId]));
    expect(sorted(result.retained.map((r) => r.historyId))).toEqual(sorted([s.rows.corrupt, s.rows.legacy]));
    expect(sorted(await rowsOffCurrentVersion(s.team.teamId))).toEqual(sorted([s.rows.corrupt, s.rows.legacy]));
    expect((await rekeyList(s.team, s.b)).retainedHistoryCount).toBe(2);
    await expectOnCurrentKey(s.team, s.e.entryId, {
      plain: s.e.plain,
      history: new Map([s.rows.atV, s.rows.own, s.rows.trial].map((id) => [id, s.plain.get(id) ?? ""])),
      oldItemKeys: [s.keys.L.raw, s.keys.O.raw],
    });
  });

  it("A6: after the next rotation, the rotating admin running first leaves the version-2 row retained (retainedHistoryCount stays 3); the holder then has nothing pending", async () => {
    const s = await seedA6();
    await firstPassA6(s);
    expect((await rotate(s.team, s.a)).status).toBe(200);

    const { result } = await runPass(s.team, s.a);
    expect(result).toMatchObject({ status: "completed", skipped: [] });
    expect(sorted(result.retained.map((r) => r.historyId))).toEqual(sorted([s.rows.atV, s.rows.corrupt, s.rows.legacy]));
    expect((await rekeyList(s.team, s.a)).retainedHistoryCount).toBe(3);

    const after = await runPass(s.team, s.b);
    expect(after.result).toMatchObject({ status: "completed", rekeyed: [] });
    expect(posts(after.requests)).toEqual([]);
    expect(sorted(await rowsOffCurrentVersion(s.team.teamId))).toEqual(sorted([s.rows.atV, s.rows.corrupt, s.rows.legacy]));
  });

  it("A6: a legacy row (NULL id) under a non-live ItemKey the runner holds through another row's wrap is re-keyed by trial decryption", async () => {
    const team = await seedTeam(2);
    const admin = await seedMember(team, "OWNER", [2]);
    const L = newItemKey(2);
    const Y = newItemKey(1);
    const e = await seedEntry(team, { teamKeyVersion: 2, itemKey: L, marker: 1, highWater: 2 });
    const ownText = JSON.stringify({ title: `own ${randomUUID()}` });
    const own = await seedHistory(team, e.entryId, { plaintext: ownText, seal: await sealOf(Y), teamKeyVersion: 2, wrap: Y.raw, itemKeyId: Y.id });
    // Wrapped at team key 1, which nobody holds: only Y (from `own`) opens it.
    const legacyText = JSON.stringify({ title: `legacy ${randomUUID()}` });
    const legacy = await seedHistory(team, e.entryId, { plaintext: legacyText, seal: await sealOf(Y), teamKeyVersion: 1, wrap: Y.raw, itemKeyId: null });

    const { result } = await runPass(team, admin);
    expect(result).toMatchObject({ status: "completed", rekeyed: [e.entryId], retained: [] });
    await expectOnCurrentKey(team, e.entryId, {
      plain: e.plain,
      history: new Map([[own, ownText], [legacy, legacyText]]),
      oldItemKeys: [L.raw, Y.raw],
    });
    expect(await rowsOffCurrentVersion(team.teamId)).toEqual([]);
  });

  // ── A9: paging; scenario 3 ───────────────────────────────────────────────

  /** `n` entry ids in ascending order (the list's keyset order). */
  const ascendingIds = (n: number) => sorted(Array.from({ length: n }, () => randomUUID()));

  it("A9: with page size 2, five pending entries are all re-keyed across pages", async () => {
    const team = await seedTeam(2);
    const admin = await seedMember(team, "OWNER", [2]);
    const ids = ascendingIds(5);
    for (const id of ids) await seedEntry(team, { id, teamKeyVersion: 2, itemKey: newItemKey(1), marker: 1 });

    const { result, requests } = await runPass(team, admin, { pageLimit: 2 });
    expect(result).toMatchObject({ status: "completed", skipped: [] });
    expect(result.rekeyed).toEqual(ids);
    const lists = requests.filter((r) => r.method === "GET" && /\/rekey\?/.test(r.path) && !r.path.includes("/passwords/"));
    expect(lists.map((r) => new URL(r.path, "http://x").searchParams.get("after"))).toEqual([null, ids[1], ids[3], ids[4]]);
    expect(lists.every((r) => r.path.includes("limit=2"))).toBe(true);
    expect((await rekeyList(team, admin)).pendingCount).toBe(0);
    expect(await rowsOffCurrentVersion(team.teamId)).toEqual([]);
  });

  it("A9: a first page full of entries the runner skips does not starve the second page; admin A then admin B finish the pass", async () => {
    const team = await seedTeam(2);
    const a = await seedMember(team, "OWNER", [2]);
    const b = await seedMember(team, "ADMIN", [1, 2]);
    const [s1, s2, r1] = ascendingIds(3);
    // s1, s2 at team key 1, which A does not hold; r1 at the current version.
    for (const id of [s1, s2]) await seedEntry(team, { id, teamKeyVersion: 1, itemKey: newItemKey(1), marker: 1 });
    const ready = await seedEntry(team, { id: r1, teamKeyVersion: 2, itemKey: newItemKey(1), marker: 1 });

    const passA = await runPass(team, a, { pageLimit: 2 });
    expect(passA.result).toMatchObject({ status: "completed", rekeyed: [r1] });
    expect(passA.result.notHeld).toEqual([{ entryId: s1, teamKeyVersion: 1 }, { entryId: s2, teamKeyVersion: 1 }]);
    expect(posts(passA.requests).map((r) => r.path)).toEqual([`/api/teams/${team.teamId}/passwords/${r1}/rekey`]);
    await expectOnCurrentKey(team, r1, { plain: ready.plain });
    const listA = await rekeyList(team, a);
    expect(listA).toMatchObject({ pendingCount: 2, entryIds: [s1, s2] });
    expect(listA.stateCounts).toMatchObject({ needs_rekeyer_holder: 2 });

    const passB = await runPass(team, b, { pageLimit: 2 });
    expect(passB.result).toMatchObject({ status: "completed", skipped: [], notHeld: [] });
    expect(passB.result.rekeyed).toEqual([s1, s2]);
    expect((await rekeyList(team, b)).pendingCount).toBe(0);
    expect(await rowsOffCurrentVersion(team.teamId)).toEqual([]);
  });

  it("scenario 3: the rotating admin's pass stops mid-way (tab closed); another admin finishes it", async () => {
    const team = await seedTeam(1);
    const a = await seedMember(team, "OWNER", [1]);
    const b = await seedMember(team, "ADMIN", [1]);
    const entries = [];
    for (const id of ascendingIds(4)) {
      const ik = newItemKey(1);
      entries.push({ ...(await seedEntry(team, { id, teamKeyVersion: 1, itemKey: ik, marker: 1 })), ik });
    }
    expect((await rotate(team, a)).status).toBe(200);

    let postCount = 0;
    const passA = await runPass(team, a, {
      before: ({ method }) => {
        if (method === "POST" && ++postCount === 3) throw new TypeError("Failed to fetch");
      },
    });
    expect(passA.result).toMatchObject({ status: "stopped", stop: { reason: "transient" } });
    expect(passA.result.rekeyed).toEqual(entries.slice(0, 2).map((e) => e.entryId));
    expect((await rekeyList(team, b)).pendingCount).toBe(2);

    const passB = await runPass(team, b);
    expect(passB.result).toMatchObject({ status: "completed", skipped: [] });
    expect(passB.result.rekeyed).toEqual(entries.slice(2).map((e) => e.entryId));
    for (const e of entries) await expectOnCurrentKey(team, e.entryId, { plain: e.plain, oldItemKeys: [e.ik.raw] });
    expect((await rekeyList(team, b)).pendingCount).toBe(0);
    expect(await rowsOffCurrentVersion(team.teamId)).toEqual([]);
  });

  // ── A12: carry, holder states, reports ───────────────────────────────────

  it("A12: v1 keys held only by a tenant-deactivated member → carried and unrecoverable with the delete warning; reactivated as MEMBER → holder cannot re-key; as ADMIN → needs re-keyer holder; no deactivated holder → no warning", async () => {
    const team = await seedTeam(2);
    const admin = await seedMember(team, "OWNER", [2]);
    const departed = await seedMember(team, "MEMBER", [1, 2], { deactivated: true });
    const e = await seedEntry(team, { teamKeyVersion: 1, itemKey: newItemKey(1), marker: 1 });
    const before = await snapshotRows(e.entryId);

    const rotated = await rotate(team, admin);
    expect(rotated).toMatchObject({ status: 200, carry: [{ id: e.entryId, teamKeyVersion: 1, reason: "not_held" }] });
    expect(await snapshotRows(e.entryId)).toEqual(before);

    const report = async () => {
      const list = await rekeyList(team, admin);
      return {
        list,
        report: buildRekeyReport({ stateCounts: list.stateCounts, ...holderInputsFrom(list.versionHolders, "?") }),
      };
    };

    const deactivated = await report();
    expect(deactivated.list.stateCounts).toMatchObject({ unrecoverable: 1, ready: 0 });
    expect(deactivated.list.versionHolders[1]).toMatchObject({ activeHolderCount: 0, deactivatedHolderCount: 1 });
    expect(deactivated.report.items).toEqual([
      expect.objectContaining({ issue: REKEY_ISSUE.UNRECOVERABLE, count: 1, deactivatedHolder: true, exits: expect.arrayContaining([REKEY_EXIT.DELETE_ENTRY]) }),
    ]);

    // The member returns to the tenant: a holder again, but a MEMBER cannot re-key.
    await sql(`UPDATE team_members SET deactivated_at = NULL, deactivated_by_tenant = false WHERE team_id = $1::uuid AND user_id = $2::uuid`, team.teamId, departed);
    const asMember = await report();
    expect(asMember.list.stateCounts).toMatchObject({ unrecoverable: 0, holder_cannot_rekey: 1 });
    expect(asMember.report.items).toEqual([
      expect.objectContaining({ issue: REKEY_ISSUE.HOLDER_CANNOT_REKEY, count: 1 }),
    ]);
    mockAuth.mockResolvedValue({ user: { id: departed } });
    const memberList = await rekeyListGET(
      new NextRequest(`http://localhost/api/teams/${team.teamId}/rekey`),
      { params: Promise.resolve({ teamId: team.teamId }) },
    );
    expect(memberList.status).toBe(403);

    await sql(`UPDATE team_members SET role = 'ADMIN' WHERE team_id = $1::uuid AND user_id = $2::uuid`, team.teamId, departed);
    const asAdmin = await report();
    expect(asAdmin.list.stateCounts).toMatchObject({ needs_rekeyer_holder: 1 });
    expect(asAdmin.list.holders[1]?.map((h) => h.id)).toEqual([departed]);

    // Control: nobody, active or deactivated, holds version 1 → unrecoverable, no delete warning.
    await sql(`DELETE FROM team_member_keys WHERE team_id = $1::uuid AND user_id = $2::uuid AND key_version = 1`, team.teamId, departed);
    const nobody = await report();
    expect(nobody.list.stateCounts).toMatchObject({ unrecoverable: 1 });
    expect(nobody.report.items).toEqual([
      expect.objectContaining({ issue: REKEY_ISSUE.UNRECOVERABLE, deactivatedHolder: false }),
    ]);
  });

  it("A12: a planted entry among three authentic ones at the same version → the planted carried undecryptable (byte-identical, audited with actor and reason), the authentic re-wrapped, rotation 200, no key suspicion", async () => {
    const team = await seedTeam(1);
    const admin = await seedMember(team, "OWNER", [1]);
    const authentic = [];
    for (let i = 0; i < 3; i++) {
      const ik = newItemKey(1);
      authentic.push({ ...(await seedEntry(team, { teamKeyVersion: 1, itemKey: ik, marker: 1 })), ik });
    }
    const planted = await seedEntry(team, { teamKeyVersion: 1, itemKey: newItemKey(1), marker: 1, planted: true });
    const plantedBefore = await snapshotRows(planted.entryId);
    const wrapsBefore = new Map(await Promise.all(authentic.map(async (e) => [e.entryId, (await entryRow(e.entryId)).encrypted_item_key] as const)));

    const rotated = await rotate(team, admin);
    expect(rotated).toMatchObject({ status: 200, carry: [{ id: planted.entryId, teamKeyVersion: 1, reason: "undecryptable" }] });
    expect(await snapshotRows(planted.entryId)).toEqual(plantedBefore);
    for (const e of authentic) {
      const row = await entryRow(e.entryId);
      expect(row.team_key_version).toBe(2);
      expect(row.encrypted_item_key).not.toBe(wrapsBefore.get(e.entryId));
      expect(hexOf(await unwrapWith(team, e.entryId, row))).toBe(hexOf(e.ik.raw));
    }
    expect(await auditsOf("TEAM_KEY_ROTATION_CARRY", planted.entryId)).toEqual([
      expect.objectContaining({ userId: admin, metadata: { reason: "undecryptable", teamKeyVersion: 1 } }),
    ]);
    const report = await rotationReport(team, admin, rotated);
    expect(report.keySuspectVersions).toEqual([]);
    expect(report.items).toEqual([
      expect.objectContaining({ issue: REKEY_ISSUE.UNDECRYPTABLE, entryIds: [planted.entryId] }),
    ]);
    expect(report.items[0].exits).not.toContain(REKEY_EXIT.DELETE_ENTRY);
  });

  it("A12: X's member key wraps a wrong team key K' for version 1 → X's rotation carries both entries undecryptable (byte-identical, pending), the report suspects the key and names holder Y; Y re-keys them → 200", async () => {
    const team = await seedTeam(2);
    const x = await seedMember(team, "OWNER", [1, 2]);
    const y = await seedMember(team, "ADMIN", [1, 2]);
    // X's row at version 1 unwraps correctly — to the wrong team key.
    team.members.get(x)?.wrong.set(1, await deriveTeamEncryptionKey(generateTeamSymmetricKey()));
    const atV: { entryId: string; plain: Plain; ik: ItemKey }[] = [];
    for (let i = 0; i < 2; i++) {
      const ik = newItemKey(1);
      atV.push({ ...(await seedEntry(team, { teamKeyVersion: 1, itemKey: ik, marker: 1 })), ik });
    }
    const current = await seedEntry(team, { teamKeyVersion: 2, itemKey: newItemKey(1), marker: 1 });
    const before = new Map(await Promise.all(atV.map(async (e) => [e.entryId, await snapshotRows(e.entryId)] as const)));

    const rotated = await rotate(team, x);
    expect(rotated.status).toBe(200);
    expect(sorted(rotated.carry.map((c: RotateCarry) => `${c.id}:${c.reason}:${c.teamKeyVersion}`))).toEqual(
      sorted(atV.map((e) => `${e.entryId}:undecryptable:1`)),
    );
    for (const e of atV) {
      expect(await snapshotRows(e.entryId)).toEqual(before.get(e.entryId));
      expect(await auditsOf("TEAM_KEY_ROTATION_CARRY", e.entryId)).toEqual([
        expect.objectContaining({ userId: x, metadata: { reason: "undecryptable", teamKeyVersion: 1 } }),
      ]);
    }
    expect(await entryRow(current.entryId)).toMatchObject({ team_key_version: 3 });
    const list = await rekeyList(team, x);
    expect(list.pendingCount).toBe(3);
    expect(list.entryIds).toEqual(expect.arrayContaining(atV.map((e) => e.entryId)));

    const report = await rotationReport(team, x, rotated);
    expect(report.keySuspectVersions).toEqual([1]);
    const yEmail = (await ctx.su.pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1::uuid`, [y])).rows[0].email;
    const yName = (await ctx.su.pool.query<{ name: string }>(`SELECT name FROM users WHERE id = $1::uuid`, [y])).rows[0].name;
    expect(report.items).toEqual([
      expect.objectContaining({
        issue: REKEY_ISSUE.UNDECRYPTABLE,
        teamKeyVersion: 1,
        exits: [REKEY_EXIT.ANOTHER_HOLDER_REKEYS],
        holdersByVersion: { 1: [expect.stringMatching(new RegExp(`^(${yName}|${yEmail})$`))] },
      }),
    ]);

    // X's own pass cannot open them either: no POST for them, rows unchanged.
    const passX = await runPass(team, x);
    expect(sorted(passX.result.undecryptable.map((u) => u.entryId))).toEqual(sorted(atV.map((e) => e.entryId)));
    expect(posts(passX.requests).filter((r) => atV.some((e) => r.path.includes(e.entryId)))).toEqual([]);
    for (const e of atV) expect(await snapshotRows(e.entryId)).toEqual(before.get(e.entryId));

    // Control: holder Y, with the correct key, re-keys the same entries.
    const passY = await runPass(team, y);
    expect(passY.result).toMatchObject({ status: "completed", undecryptable: [], skipped: [] });
    expect(sorted(passY.result.rekeyed)).toEqual(sorted(atV.map((e) => e.entryId)));
    for (const r of posts(passY.requests)) expect(r.status).toBe(200);
    for (const e of atV) await expectOnCurrentKey(team, e.entryId, { plain: e.plain, oldItemKeys: [e.ik.raw] });
    expect((await rekeyList(team, y)).pendingCount).toBe(0);
  });

  it.each([
    ["fails to unwrap → its entries carried key_invalid (byte-identical, audited), the rest re-wrapped, rotation 200", true],
    ["is intact (control) → everything re-wrapped", false],
  ] as const)("A12: the actor's member-key row at version 1 %s", async (_label, broken) => {
    const team = await seedTeam(2);
    const admin = await seedMember(team, "OWNER", [1, 2]);
    if (broken) team.members.get(admin)?.invalid.add(1);
    const old = await seedEntry(team, { teamKeyVersion: 1, itemKey: newItemKey(1), marker: 1 });
    const cur = await seedEntry(team, { teamKeyVersion: 2, itemKey: newItemKey(1), marker: 1 });
    const oldBefore = await snapshotRows(old.entryId);

    const rotated = await rotate(team, admin);
    expect(rotated.status).toBe(200);
    expect(await entryRow(cur.entryId)).toMatchObject({ team_key_version: 3 });
    if (broken) {
      expect(rotated.carry).toEqual([{ id: old.entryId, teamKeyVersion: 1, reason: "key_invalid" }]);
      expect(await snapshotRows(old.entryId)).toEqual(oldBefore);
      expect(await auditsOf("TEAM_KEY_ROTATION_CARRY", old.entryId)).toEqual([
        expect.objectContaining({ userId: admin, metadata: { reason: "key_invalid", teamKeyVersion: 1 } }),
      ]);
    } else {
      expect(rotated.carry).toEqual([]);
      expect(await entryRow(old.entryId)).toMatchObject({ team_key_version: 3 });
    }
  });

  it("A12: a restore of a row no member holds → HISTORY_KEY_UNAVAILABLE; restoring a current-version row instead → the rotation re-wraps the entry (no carry) → 200", async () => {
    const team = await seedTeam(2);
    const admin = await seedMember(team, "OWNER", [2]);
    // The live row is at team key 1, which nobody holds.
    const I1 = newItemKey(1);
    const I2 = newItemKey(2);
    const e = await seedEntry(team, { teamKeyVersion: 1, itemKey: I1, marker: 1, highWater: 2 });
    const oldRow = await seedHistory(team, e.entryId, {
      plaintext: JSON.stringify({ title: `old ${randomUUID()}` }), seal: await sealOf(I1), teamKeyVersion: 1, wrap: I1.raw, itemKeyId: I1.id,
    });
    const currentText = JSON.stringify({ title: `current ${randomUUID()}`, password: randomUUID() });
    const currentRow = await seedHistory(team, e.entryId, {
      plaintext: currentText, seal: await sealOf(I2), teamKeyVersion: 2, wrap: I2.raw, itemKeyId: I2.id,
    });

    mockAuth.mockResolvedValue({ user: { id: admin } });
    const restore = async (historyId: string) => {
      const params = { params: Promise.resolve({ teamId: team.teamId, id: e.entryId, historyId }) };
      const got = await historyRowGET(
        new NextRequest(`http://localhost/api/teams/${team.teamId}/passwords/${e.entryId}/history/${historyId}`),
        params,
      );
      expect(got.status).toBe(200);
      const row = (await got.json()) as TeamHistoryRowDto;
      // The overview is re-encrypted under the restored row's own key (D1); a
      // row no held key opens gets a placeholder (the server refuses first).
      const body = row.teamKeyVersion === 2
        ? await buildTeamHistoryRestoreBody(team.teamId, e.entryId, row, async (_t, entryId, keyData) =>
            deriveItemEncryptionKey(await unwrapItemKey(
              { ciphertext: keyData.encryptedItemKey ?? "", iv: keyData.itemKeyIv ?? "", authTag: keyData.itemKeyAuthTag ?? "" },
              await teamKey(team, keyData.teamKeyVersion ?? 1),
              buildItemKeyWrapAAD(team.teamId, entryId, keyData.teamKeyVersion ?? 1),
            )))
        : { encryptedOverview: await encryptData("{}", await deriveItemEncryptionKey(generateItemKey())) };
      return restorePOST(
        jsonRequest(`http://localhost/api/teams/${team.teamId}/passwords/${e.entryId}/history/${historyId}/restore`, "POST", body),
        params,
      );
    };

    const liveBefore = await entryRow(e.entryId);
    expect(await errorOf(await restore(oldRow))).toEqual({ status: 409, error: "HISTORY_KEY_UNAVAILABLE" });
    expect(await entryRow(e.entryId)).toEqual(liveBefore);
    // Without the restore the rotation could only carry the entry (not held).
    expect((await restore(currentRow)).status).toBe(200);
    expect(await entryRow(e.entryId)).toMatchObject({ team_key_version: 2, item_key_id: I2.id });

    const rotated = await rotate(team, admin);
    expect(rotated).toMatchObject({ status: 200, carry: [] });
    const row = await entryRow(e.entryId);
    expect(row.team_key_version).toBe(3);
    const ik = await unwrapWith(team, e.entryId, row);
    expect(hexOf(ik)).toBe(hexOf(I2.raw));
    expect(await decryptData(
      { ciphertext: row.encrypted_blob, iv: row.blob_iv, authTag: row.blob_auth_tag },
      await deriveItemEncryptionKey(ik),
      buildTeamEntryAAD(team.teamId, e.entryId, "blob", 2),
    )).toBe(currentText);
  });

  // ── MinIO: A3 through the runner ─────────────────────────────────────────

  describe("MinIO", () => {
    const ENDPOINT_ENV = "ANCHOR_TEST_S3_ENDPOINT";
    const BUCKET = "attachment-rekey-test";
    const prefix = `rekey-pass-${randomUUID()}`;
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

    // Per test: stubs are undone after each test.
    beforeEach(() => {
      vi.stubEnv("BLOB_BACKEND", "s3");
      vi.stubEnv("AWS_REGION", "us-east-1");
      vi.stubEnv("S3_ATTACHMENTS_BUCKET", BUCKET);
      vi.stubEnv("AWS_ENDPOINT_URL_S3", process.env[ENDPOINT_ENV] ?? "");
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

    it("A3: the pass upgrades a v0 entry and migrates its mode-0 attachment on MinIO — exactly one object (a fresh generation) remains — then re-keys it", async () => {
      const team = await seedTeam(2);
      const admin = await seedMember(team, "OWNER", [1, 2]);
      const v0 = await seedEntry(team, { teamKeyVersion: 2, marker: 0 });
      let attPrefix = "";
      const legacy = await seedMode0Attachment(team, v0.entryId, 1, async (attId, ciphertext) => {
        attPrefix = `${prefix}/team/${team.teamId}/${v0.entryId}/${attId}`;
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${attPrefix}.bin`, Body: Buffer.from(ciphertext) }));
        return new Uint8Array(Buffer.from(JSON.stringify({ key: `${attPrefix}.bin` })));
      });
      expect(await objectsUnder(attPrefix)).toEqual([`${attPrefix}.bin`]);

      const { result } = await runPass(team, admin);
      expect(result).toMatchObject({ status: "completed", rekeyed: [v0.entryId], skipped: [] });
      const objects = await objectsUnder(attPrefix);
      expect(objects).toHaveLength(1);
      expect(objects[0]).toMatch(new RegExp(`^${attPrefix}/[0-9a-f]{32}\\.bin$`));
      await expectOnCurrentKey(team, v0.entryId, { plain: v0.plain, attachments: new Map([[legacy.attId, legacy.plaintext]]) });
      expect(await rowsOffCurrentVersion(team.teamId)).toEqual([]);
    });
  });
});
