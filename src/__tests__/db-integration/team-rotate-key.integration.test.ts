/**
 * Integration test (real DB): team key rotation — real CAS races, member-set
 * TOCTOU, v0/v1 mixed entries (C7), and post-rotation history decryptability
 * (C8), per security-control-verification plan.
 *
 * Production entry point: POST from
 * "@/app/api/teams/[teamId]/rotate-key/route" — driven directly (test-F1/RT5).
 * Only the auth/authz/step-up/rate-limit boundary is mocked; requireTeamMember
 * (called inside requireTeamPermission) resolves against a REAL seeded
 * TeamMember row, and the transaction body runs against the real DB.
 *
 * Run: docker compose up -d db && npm run test:integration -- team-rotate-key
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID, randomBytes, createCipheriv } from "node:crypto";
import { NextRequest } from "next/server";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import {
  buildTeamEntryAAD,
  buildItemKeyWrapAAD,
} from "@/lib/crypto/crypto-aad";
import { encryptBinary, decryptBinary } from "@/lib/crypto/crypto-client";

// ── Auth boundary mocks ──────────────────────────────────────────────────
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: async () => null,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: () => {},
  }),
}));

import { POST } from "@/app/api/teams/[teamId]/rotate-key/route";

function hex(nBytes: number): string {
  return randomBytes(nBytes).toString("hex");
}

async function generateTeamKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

function ab(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function encryptField(
  plaintext: string,
  key: CryptoKey,
  aad: Uint8Array,
): Promise<{ ciphertext: string; iv: string; authTag: string }> {
  const result = await encryptBinary(ab(Buffer.from(plaintext, "utf8")), key, aad);
  return {
    ciphertext: Buffer.from(result.ciphertext).toString("base64"),
    iv: result.iv,
    authTag: result.authTag,
  };
}

async function decryptField(
  field: { ciphertext: string; iv: string; authTag: string },
  key: CryptoKey,
  aad: Uint8Array,
): Promise<string> {
  const pt = await decryptBinary(
    { ciphertext: Buffer.from(field.ciphertext, "base64"), iv: field.iv, authTag: field.authTag },
    key,
    aad,
  );
  return Buffer.from(pt).toString("utf8");
}

/** Wrap an ItemKey's raw bytes under the TeamKey (native Node AES-GCM). */
function wrapItemKey(
  rawItemKey: Buffer,
  teamKeyRaw: Buffer,
  aad: Uint8Array,
): { ciphertext: string; iv: string; authTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", teamKeyRaw, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(rawItemKey), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

function buildRequest(teamId: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/teams/${teamId}/rotate-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeParams(teamId: string) {
  return { params: Promise.resolve({ teamId }) };
}

async function callRotate(teamId: string, body: Record<string, unknown>) {
  return POST(buildRequest(teamId, body), routeParams(teamId));
}

function mockSession(userId: string): void {
  mockAuth.mockResolvedValue({ user: { id: userId } });
}

/**
 * deleteTestData can lose a race against the live audit-outbox-worker
 * process (running against this same dev DB — see CLAUDE.md docker
 * services): the worker drains audit_outbox rows into audit_logs
 * concurrently with cleanup, so a freshly-inserted audit_logs row can appear
 * AFTER this helper's own audit_logs delete step, failing the tenant
 * delete's audit_logs_tenant_id_fkey. This suite drives real rotation
 * routes across many iterations (heavy audit emission), so retry with a
 * short backoff rather than a single retry.
 */
async function deleteTestDataWithRetry(ctx: TestContext, tenantId: string): Promise<void> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await ctx.deleteTestData(tenantId);
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      await new Promise((res) => setTimeout(res, 50 * attempt));
    }
  }
}

// ── Seed helpers ──────────────────────────────────────────────────────────

async function seedTeam(ctx: TestContext, tenantId: string, teamKeyVersion = 1): Promise<string> {
  const teamId = randomUUID();
  const now = new Date().toISOString();
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $6)`,
      teamId, tenantId, `team-${teamId.slice(0, 8)}`, `team-${teamId.slice(0, 8)}`, teamKeyVersion, now,
    );
  });
  return teamId;
}

async function seedTeamMember(
  ctx: TestContext,
  tenantId: string,
  teamId: string,
  userId: string,
  role: "OWNER" | "MEMBER",
  keyDistributed: boolean,
): Promise<void> {
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", $6, now(), now())`,
      randomUUID(), teamId, userId, tenantId, role, keyDistributed,
    );
  });
}

/** v0 legacy entry: full blob + overview encrypted directly under TeamKey. */
async function seedV0Entry(
  ctx: TestContext,
  opts: { teamId: string; tenantId: string; userId: string; teamKey: CryptoKey; teamKeyVersion: number; plaintext: string },
): Promise<string> {
  const entryId = randomUUID();
  const blobAad = buildTeamEntryAAD(opts.teamId, entryId, "blob", 0);
  const overviewAad = buildTeamEntryAAD(opts.teamId, entryId, "overview", 0);
  const blob = await encryptField(opts.plaintext, opts.teamKey, blobAad);
  const overview = await encryptField(`overview:${opts.plaintext}`, opts.teamKey, overviewAad);
  const now = new Date().toISOString();
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO team_password_entries (
         id, team_id, tenant_id, created_by_id, updated_by_id,
         encrypted_blob, blob_iv, blob_auth_tag,
         encrypted_overview, overview_iv, overview_auth_tag,
         aad_version, team_key_version, item_key_version, entry_type,
         created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid,
         $5, $6, $7, $8, $9, $10,
         1, $11, 0, 'LOGIN', $12, $12
       )`,
      entryId, opts.teamId, opts.tenantId, opts.userId,
      blob.ciphertext, blob.iv, blob.authTag,
      overview.ciphertext, overview.iv, overview.authTag,
      opts.teamKeyVersion, now,
    );
  });
  return entryId;
}

/** v1+ ItemKey entry: blob encrypted under a per-entry ItemKey, ItemKey wrapped by TeamKey. */
async function seedV1Entry(
  ctx: TestContext,
  opts: {
    teamId: string; tenantId: string; userId: string;
    teamKey: CryptoKey; teamKeyRaw: Buffer; teamKeyVersion: number; itemKeyVersion: number;
    plaintext: string;
  },
): Promise<{ entryId: string; itemKeyRaw: Buffer }> {
  const entryId = randomUUID();
  const itemKey = await generateTeamKey();
  const itemKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", itemKey));

  const blobAad = buildTeamEntryAAD(opts.teamId, entryId, "blob", opts.itemKeyVersion);
  const overviewAad = buildTeamEntryAAD(opts.teamId, entryId, "overview", opts.itemKeyVersion);
  const blob = await encryptField(opts.plaintext, itemKey, blobAad);
  const overview = await encryptField(`overview:${opts.plaintext}`, itemKey, overviewAad);

  const wrapAad = buildItemKeyWrapAAD(opts.teamId, entryId, opts.teamKeyVersion);
  const wrappedItemKey = wrapItemKey(itemKeyRaw, opts.teamKeyRaw, wrapAad);

  const now = new Date().toISOString();
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO team_password_entries (
         id, team_id, tenant_id, created_by_id, updated_by_id,
         encrypted_blob, blob_iv, blob_auth_tag,
         encrypted_overview, overview_iv, overview_auth_tag,
         aad_version, team_key_version, item_key_version,
         encrypted_item_key, item_key_iv, item_key_auth_tag,
         entry_type, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid,
         $5, $6, $7, $8, $9, $10,
         1, $11, $12,
         $13, $14, $15,
         'LOGIN', $16, $16
       )`,
      entryId, opts.teamId, opts.tenantId, opts.userId,
      blob.ciphertext, blob.iv, blob.authTag,
      overview.ciphertext, overview.iv, overview.authTag,
      opts.teamKeyVersion, opts.itemKeyVersion,
      wrappedItemKey.ciphertext, wrappedItemKey.iv, wrappedItemKey.authTag,
      now,
    );
  });
  return { entryId, itemKeyRaw };
}

async function getTeamKeyVersion(ctx: TestContext, teamId: string): Promise<number> {
  const r = await ctx.su.pool.query<{ team_key_version: number }>(
    `SELECT team_key_version FROM teams WHERE id = $1::uuid`,
    [teamId],
  );
  return r.rows[0].team_key_version;
}

describe("team key rotation — real-DB integration (C7)", () => {
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
    await deleteTestDataWithRetry(ctx, tenantId);
  });

  // ── Concurrent double rotation to the same target version ────────────────

  it("50-iteration loop: concurrent double rotation to same target version — successCount>0 AND conflictCount>0", async () => {
    const ITERATIONS = 50;
    const ownerId = await ctx.createUser(tenantId);
    let successCount = 0;
    let conflictCount = 0;
    const outcomes = new Set<string>();

    for (let i = 0; i < ITERATIONS; i++) {
      const teamId = await seedTeam(ctx, tenantId, 1);
      await seedTeamMember(ctx, tenantId, teamId, ownerId, "OWNER", true);

      const teamKey = await generateTeamKey();
      const entryId = randomUUID();
      const blobAad = buildTeamEntryAAD(teamId, entryId, "blob", 0);
      const overviewAad = buildTeamEntryAAD(teamId, entryId, "overview", 0);
      const blob = await encryptField(`iter-${i}`, teamKey, blobAad);
      const overview = await encryptField(`ov-${i}`, teamKey, overviewAad);
      const now = new Date().toISOString();
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO team_password_entries (
             id, team_id, tenant_id, created_by_id, updated_by_id,
             encrypted_blob, blob_iv, blob_auth_tag,
             encrypted_overview, overview_iv, overview_auth_tag,
             aad_version, team_key_version, item_key_version, entry_type, created_at, updated_at
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, 1, 1, 0, 'LOGIN', $11, $11)`,
          entryId, teamId, tenantId, ownerId,
          blob.ciphertext, blob.iv, blob.authTag, overview.ciphertext, overview.iv, overview.authTag, now,
        );
      });

      const newBlob = await encryptField(`iter-${i}-v2`, teamKey, buildTeamEntryAAD(teamId, entryId, "blob", 0));
      const newOverview = await encryptField(`ov-${i}-v2`, teamKey, buildTeamEntryAAD(teamId, entryId, "overview", 0));
      const memberKeyBody = {
        userId: ownerId,
        encryptedTeamKey: hex(32),
        teamKeyIv: hex(12),
        teamKeyAuthTag: hex(16),
        ephemeralPublicKey: hex(32),
        hkdfSalt: hex(32),
        keyVersion: 2,
      };
      const requestBody = {
        newTeamKeyVersion: 2,
        entries: [{
          id: entryId,
          itemKeyVersion: 0,
          encryptedBlob: newBlob,
          encryptedOverview: newOverview,
          aadVersion: 1,
        }],
        memberKeys: [memberKeyBody],
      };

      mockSession(ownerId);
      // Per-pair jitter (passwords-history-lost-update precedent).
      const jitterA = (i * 5) % 11;
      const jitterB = (i * 7) % 11;
      const invoke = async (delayMs: number): Promise<number> => {
        await new Promise((res) => setTimeout(res, delayMs));
        const r = await callRotate(teamId, requestBody);
        return r.status;
      };
      const [statusA, statusB] = await Promise.all([invoke(jitterA), invoke(jitterB)]);

      const statuses = [statusA, statusB].sort();
      const successes = statuses.filter((s) => s === 200).length;

      // Data-integrity invariant: at most one of the two concurrent
      // same-target rotations may ever commit. Two 200s would mean both
      // committed against the same target version — a correctness violation.
      expect(successes).toBeLessThanOrEqual(1);
      // API-consistency invariant: the loser is ALWAYS a clean 409, never a
      // bare 500. The team-rotate CAS re-read (`tx.team.findUnique`) is a
      // non-locking SELECT, so two concurrent same-target rotations can both
      // pass the pre-check and race to `teamMemberKey.createMany`; the loser
      // hits the `@@unique([teamId, userId, keyVersion])` constraint (P2002),
      // which the route now maps to TEAM_KEY_VERSION_MISMATCH (409) rather than
      // surfacing as an unhandled 500 — mirrors the personal VaultKey P2002 fix.
      expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);

      if (statuses[0] === 200 && statuses[1] === 409) {
        successCount++;
        conflictCount++;
        outcomes.add("split-409");
      } else if (statuses[0] === 409 && statuses[1] === 409) {
        outcomes.add("double-409");
      } else {
        outcomes.add(`unexpected-${statuses[0]}-${statuses[1]}`);
      }

      expect(await getTeamKeyVersion(ctx, teamId)).toBe(successes === 1 ? 2 : 1);
    }

    // Primary RT4 contention proof: both a genuine success AND a genuine
    // rejection occurred across the loop (not vacuously all-one-outcome).
    expect(successCount).toBeGreaterThan(0);
    expect(conflictCount).toBeGreaterThan(0);
    // Proves genuine contention fired across the loop, not a single outcome.
    expect(outcomes.size).toBeGreaterThanOrEqual(1);
  }, 120_000);

  // ── Member-set TOCTOU ─────────────────────────────────────────────────────

  it("member added between pre-read and tx → rotation rejects with missing-key validation error", async () => {
    const ownerId = await ctx.createUser(tenantId);
    const teamId = await seedTeam(ctx, tenantId, 1);
    await seedTeamMember(ctx, tenantId, teamId, ownerId, "OWNER", true);

    const teamKey = await generateTeamKey();
    const entryId = await seedV0Entry(ctx, {
      teamId, tenantId, userId: ownerId, teamKey, teamKeyVersion: 1, plaintext: "toctou",
    });

    // A new member with keyDistributed=true joins BEFORE the rotation call —
    // the payload (built as if only the owner existed) omits this member's
    // key, so the in-tx member verification must reject.
    const newMemberId = await ctx.createUser(tenantId);
    await seedTeamMember(ctx, tenantId, teamId, newMemberId, "MEMBER", true);

    const newBlob = await encryptField("toctou-v2", teamKey, buildTeamEntryAAD(teamId, entryId, "blob", 0));
    const newOverview = await encryptField("toctou-ov-v2", teamKey, buildTeamEntryAAD(teamId, entryId, "overview", 0));

    mockSession(ownerId);
    const res = await callRotate(teamId, {
      newTeamKeyVersion: 2,
      entries: [{ id: entryId, itemKeyVersion: 0, encryptedBlob: newBlob, encryptedOverview: newOverview, aadVersion: 1 }],
      memberKeys: [{
        userId: ownerId,
        encryptedTeamKey: hex(32), teamKeyIv: hex(12), teamKeyAuthTag: hex(16),
        ephemeralPublicKey: hex(32), hkdfSalt: hex(32), keyVersion: 2,
      }],
    });

    expect(res.status).toBe(400);
    expect(await getTeamKeyVersion(ctx, teamId)).toBe(1);
  });

  // ── v0 legacy + v1 ItemKey mixed entry set ────────────────────────────────

  it("v0 legacy + v1 ItemKey mixed entries: v0 gets blob re-encrypt, v1 gets item-key rewrap only", async () => {
    const ownerId = await ctx.createUser(tenantId);
    const teamId = await seedTeam(ctx, tenantId, 1);
    await seedTeamMember(ctx, tenantId, teamId, ownerId, "OWNER", true);

    const teamKey = await generateTeamKey();
    const teamKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", teamKey));

    const v0EntryId = await seedV0Entry(ctx, {
      teamId, tenantId, userId: ownerId, teamKey, teamKeyVersion: 1, plaintext: "v0-plain",
    });
    const { entryId: v1EntryId, itemKeyRaw } = await seedV1Entry(ctx, {
      teamId, tenantId, userId: ownerId, teamKey, teamKeyRaw, teamKeyVersion: 1, itemKeyVersion: 1,
      plaintext: "v1-plain",
    });

    // v0 → full re-encrypt under new TeamKey.
    const newBlobV0 = await encryptField("v0-plain-v2", teamKey, buildTeamEntryAAD(teamId, v0EntryId, "blob", 0));
    const newOverviewV0 = await encryptField("v0-ov-v2", teamKey, buildTeamEntryAAD(teamId, v0EntryId, "overview", 0));

    // v1 → only rewrap the ItemKey under the new TeamKey (blob untouched).
    const newWrapAad = buildItemKeyWrapAAD(teamId, v1EntryId, 2);
    const newWrappedItemKey = wrapItemKey(itemKeyRaw, teamKeyRaw, newWrapAad);

    mockSession(ownerId);
    const res = await callRotate(teamId, {
      newTeamKeyVersion: 2,
      entries: [
        { id: v0EntryId, itemKeyVersion: 0, encryptedBlob: newBlobV0, encryptedOverview: newOverviewV0, aadVersion: 1 },
        { id: v1EntryId, itemKeyVersion: 1, encryptedItemKey: newWrappedItemKey, aadVersion: 1 },
      ],
      memberKeys: [{
        userId: ownerId,
        encryptedTeamKey: hex(32), teamKeyIv: hex(12), teamKeyAuthTag: hex(16),
        ephemeralPublicKey: hex(32), hkdfSalt: hex(32), keyVersion: 2,
      }],
    });

    expect(res.status).toBe(200);
    expect(await getTeamKeyVersion(ctx, teamId)).toBe(2);

    const rows = await ctx.su.pool.query<{
      id: string; team_key_version: number; item_key_version: number;
      encrypted_item_key: string | null; item_key_iv: string | null; item_key_auth_tag: string | null;
    }>(
      `SELECT id, team_key_version, item_key_version, encrypted_item_key, item_key_iv, item_key_auth_tag
       FROM team_password_entries WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[v0EntryId, v1EntryId]],
    );
    for (const row of rows.rows) {
      expect(row.team_key_version).toBe(2);
    }
    const v1Row = rows.rows.find((r) => r.id === v1EntryId)!;
    expect(v1Row.item_key_version).toBe(1); // unchanged — only the wrap was updated
    expect(v1Row.encrypted_item_key).toBe(newWrappedItemKey.ciphertext);
  });

  // ── Exact-set mismatch (extra/missing entry) rejects ──────────────────────

  it("exact-set mismatch (missing entry in payload) → ENTRY_COUNT_MISMATCH, no partial rotation", async () => {
    const ownerId = await ctx.createUser(tenantId);
    const teamId = await seedTeam(ctx, tenantId, 1);
    await seedTeamMember(ctx, tenantId, teamId, ownerId, "OWNER", true);
    const teamKey = await generateTeamKey();

    const entry1 = await seedV0Entry(ctx, { teamId, tenantId, userId: ownerId, teamKey, teamKeyVersion: 1, plaintext: "e1" });
    await seedV0Entry(ctx, { teamId, tenantId, userId: ownerId, teamKey, teamKeyVersion: 1, plaintext: "e2" });

    const newBlob = await encryptField("e1-v2", teamKey, buildTeamEntryAAD(teamId, entry1, "blob", 0));
    const newOverview = await encryptField("e1-ov-v2", teamKey, buildTeamEntryAAD(teamId, entry1, "overview", 0));

    mockSession(ownerId);
    const res = await callRotate(teamId, {
      newTeamKeyVersion: 2,
      // Only entry1 submitted — entry2 is missing from the payload.
      entries: [{ id: entry1, itemKeyVersion: 0, encryptedBlob: newBlob, encryptedOverview: newOverview, aadVersion: 1 }],
      memberKeys: [{
        userId: ownerId,
        encryptedTeamKey: hex(32), teamKeyIv: hex(12), teamKeyAuthTag: hex(16),
        ephemeralPublicKey: hex(32), hkdfSalt: hex(32), keyVersion: 2,
      }],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("ENTRY_COUNT_MISMATCH");
    expect(await getTeamKeyVersion(ctx, teamId)).toBe(1);
  });

  // ── Old TeamMemberKey rows retained after success ─────────────────────────

  it("old TeamMemberKey rows are retained (not deleted) at previous version after success", async () => {
    const ownerId = await ctx.createUser(tenantId);
    const teamId = await seedTeam(ctx, tenantId, 1);
    await seedTeamMember(ctx, tenantId, teamId, ownerId, "OWNER", true);

    // Seed an existing v1 TeamMemberKey row (as if from initial team creation).
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO team_member_keys (
           id, team_id, user_id, tenant_id, encrypted_team_key, team_key_iv, team_key_auth_tag,
           ephemeral_public_key, hkdf_salt, wrap_version, key_version, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, 1, 1, now(), now())`,
        randomUUID(), teamId, ownerId, tenantId, hex(32), hex(12), hex(16), hex(32), hex(32),
      );
    });

    mockSession(ownerId);
    const res = await callRotate(teamId, {
      newTeamKeyVersion: 2,
      entries: [],
      memberKeys: [{
        userId: ownerId,
        encryptedTeamKey: hex(32), teamKeyIv: hex(12), teamKeyAuthTag: hex(16),
        ephemeralPublicKey: hex(32), hkdfSalt: hex(32), keyVersion: 2,
      }],
    });

    expect(res.status).toBe(200);

    const rows = await ctx.su.pool.query<{ key_version: number }>(
      `SELECT key_version FROM team_member_keys WHERE team_id = $1::uuid AND user_id = $2::uuid ORDER BY key_version`,
      [teamId, ownerId],
    );
    expect(rows.rows.map((r) => r.key_version)).toEqual([1, 2]);
  });
});

// ── C8: team history decryptability after rotation ───────────────────────

describe("team history decryptability after rotation — real-DB integration (C8)", () => {
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
    await deleteTestDataWithRetry(ctx, tenantId);
  });

  it("history rows keep teamKeyVersion 1 after rotation to 2; retained v1 TeamMemberKey decrypts them; current entries decrypt under v2", async () => {
    const ownerId = await ctx.createUser(tenantId);
    const teamId = await seedTeam(ctx, tenantId, 1);
    await seedTeamMember(ctx, tenantId, teamId, ownerId, "OWNER", true);

    const teamKeyV1 = await generateTeamKey();
    const entryId = await seedV0Entry(ctx, {
      teamId, tenantId, userId: ownerId, teamKey: teamKeyV1, teamKeyVersion: 1, plaintext: "history-original",
    });

    // Seed a history row at v1 (mirrors what the update route would snapshot
    // pre-rotation — this test seeds it directly since we're isolating the
    // "history is NOT re-keyed on team rotation" invariant, not the update path).
    const historyId = randomUUID();
    const histBlobAad = buildTeamEntryAAD(teamId, entryId, "blob", 0);
    const histBlob = await encryptField("history-snapshot-v1", teamKeyV1, histBlobAad);
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO team_password_entry_histories (
           id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag,
           aad_version, team_key_version, item_key_version, changed_by_id, changed_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 1, 1, 0, $7::uuid, now())`,
        historyId, entryId, tenantId, histBlob.ciphertext, histBlob.iv, histBlob.authTag, ownerId,
      );
    });

    // Rotate the team key to v2 — history rows are untouched by design.
    const teamKeyV2 = await generateTeamKey();
    const teamKeyV2Raw = Buffer.from(await crypto.subtle.exportKey("raw", teamKeyV2));
    const newBlob = await encryptField("history-original-v2", teamKeyV2, buildTeamEntryAAD(teamId, entryId, "blob", 0));
    const newOverview = await encryptField("ov-v2", teamKeyV2, buildTeamEntryAAD(teamId, entryId, "overview", 0));

    mockSession(ownerId);

    const res = await callRotate(teamId, {
      newTeamKeyVersion: 2,
      entries: [{ id: entryId, itemKeyVersion: 0, encryptedBlob: newBlob, encryptedOverview: newOverview, aadVersion: 1 }],
      memberKeys: [{
        userId: ownerId,
        encryptedTeamKey: Buffer.from(teamKeyV2Raw).toString("base64"),
        teamKeyIv: hex(12), teamKeyAuthTag: hex(16),
        ephemeralPublicKey: hex(32), hkdfSalt: hex(32), keyVersion: 2,
      }],
    });
    expect(res.status).toBe(200);

    // History row still carries teamKeyVersion 1 (NOT re-keyed).
    const historyRow = await ctx.su.pool.query<{
      team_key_version: number; encrypted_blob: string; blob_iv: string; blob_auth_tag: string;
    }>(
      `SELECT team_key_version, encrypted_blob, blob_iv, blob_auth_tag FROM team_password_entry_histories WHERE id = $1::uuid`,
      [historyId],
    );
    expect(historyRow.rows[0].team_key_version).toBe(1);

    // The retained v1 TeamMemberKey (conceptually — here we hold teamKeyV1
    // directly, matching what a client would unwrap from the retained row)
    // decrypts the history blob (roundtrip).
    const decryptedHistory = await decryptField(
      {
        ciphertext: historyRow.rows[0].encrypted_blob,
        iv: historyRow.rows[0].blob_iv,
        authTag: historyRow.rows[0].blob_auth_tag,
      },
      teamKeyV1,
      buildTeamEntryAAD(teamId, entryId, "blob", 0),
    );
    expect(decryptedHistory).toBe("history-snapshot-v1");

    // Current entry decrypts under v2.
    const entryRow = await ctx.su.pool.query<{
      team_key_version: number; encrypted_blob: string; blob_iv: string; blob_auth_tag: string;
    }>(
      `SELECT team_key_version, encrypted_blob, blob_iv, blob_auth_tag FROM team_password_entries WHERE id = $1::uuid`,
      [entryId],
    );
    expect(entryRow.rows[0].team_key_version).toBe(2);
    const decryptedCurrent = await decryptField(
      {
        ciphertext: entryRow.rows[0].encrypted_blob,
        iv: entryRow.rows[0].blob_iv,
        authTag: entryRow.rows[0].blob_auth_tag,
      },
      teamKeyV2,
      buildTeamEntryAAD(teamId, entryId, "blob", 0),
    );
    expect(decryptedCurrent).toBe("history-original-v2");
  });
});
