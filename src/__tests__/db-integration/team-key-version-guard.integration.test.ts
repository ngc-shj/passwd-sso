/**
 * Integration test (real DB): team key rotation is serialised with every
 * transaction that changes one of its inputs — the team's entries and its
 * key-holding members — so none can commit next to a rotation and leave
 * state under the pre-rotation key.
 *
 * The team twin of key-version-guard.integration.test.ts. Rotation takes
 * `teams ... FOR NO KEY UPDATE` first; entry creates, bulk imports and full
 * PUTs read the team's version under `FOR SHARE`; key distribution
 * (confirm-key), member removal and vault reset lock the team `FOR SHARE`
 * before touching member rows or keys. Rotation also applies each re-encrypted
 * entry only while the row still holds the ciphertext the client snapshotted.
 *
 * Each race is made deterministic by parking one side mid-transaction on a row
 * lock it needs but that only a test-held "blocker" transaction holds:
 *   - rotation parks at its team_member_keys insert, whose FK check on a
 *     member's users row waits behind the blocker's FOR UPDATE;
 *   - a create parks at its tag-join insert, whose FK check on the team_tags
 *     row waits the same way.
 * The other side then runs to completion or blocks, observed through
 * pg_blocking_pids, before the blocker releases — no fixed sleeps.
 *
 * Production entry points are driven directly; only the auth, step-up and
 * rate-limit boundaries are mocked (precedent: team-rotate-key.integration.test.ts).
 *
 * Run: docker compose up -d db && npm run test:integration -- team-key-version-guard
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import {
  assertRlsApplies,
  createTestContext,
  createPrismaForRole,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { TEAM_KEY_LOCK_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";

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

import { POST as rotateKey } from "@/app/api/teams/[teamId]/rotate-key/route";
import { POST as createEntry } from "@/app/api/teams/[teamId]/passwords/route";
import { PUT as updateEntry } from "@/app/api/teams/[teamId]/passwords/[id]/route";
import { POST as bulkImport } from "@/app/api/teams/[teamId]/passwords/bulk-import/route";
import { DELETE as removeMember } from "@/app/api/teams/[teamId]/members/[memberId]/route";
import { POST as confirmKey } from "@/app/api/teams/[teamId]/members/[memberId]/confirm-key/route";
import { executeVaultReset } from "@/lib/vault/vault-reset";
import { GET as getMemberKey } from "@/app/api/teams/[teamId]/member-key/route";
import { GET as getPendingDistributions } from "@/app/api/teams/pending-key-distributions/route";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { deactivateScimUser } from "@/lib/services/scim-user-service";
import { patchScimGroup } from "@/lib/services/scim-group-service";

const BLOCK_WAIT_MS = 10_000;

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

function newEntryBody(id: string, teamKeyVersion: number, tagIds?: string[]) {
  return {
    id,
    encryptedBlob: encryptedField(),
    encryptedOverview: encryptedField(),
    aadVersion: 1,
    teamKeyVersion,
    ...(tagIds ? { tagIds } : {}),
  };
}

type Seed = {
  teamId: string;
  ownerId: string;
  /** Key-holding MEMBER. */
  memberId: string;
  memberRowId: string;
  /** MEMBER whose key has not been distributed yet. */
  pendingId: string;
  pendingRowId: string;
  existingEntryId: string;
  existingBlobIv: string;
  tagId: string;
};

async function seedTeam(ctx: TestContext, tenantId: string, teamKeyVersion: number): Promise<Seed> {
  const ownerId = await ctx.createUser(tenantId);
  const memberId = await ctx.createUser(tenantId);
  const pendingId = await ctx.createUser(tenantId);
  const teamId = randomUUID();
  const memberRowId = randomUUID();
  const pendingRowId = randomUUID();
  const existingEntryId = randomUUID();
  const existingBlobIv = hex(12);
  const tagId = randomUUID();
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, $4, now(), now())`,
      teamId, tenantId, `team-${teamId.slice(0, 8)}`, teamKeyVersion,
    );
    const members = [
      [randomUUID(), ownerId, "OWNER", true],
      [memberRowId, memberId, "MEMBER", true],
      [pendingRowId, pendingId, "MEMBER", false],
    ] as const;
    for (const [rowId, userId, role, keyDistributed] of members) {
      await tx.$executeRawUnsafe(
        `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", $6, now(), now())`,
        rowId, teamId, userId, tenantId, role, keyDistributed,
      );
    }
    for (const userId of [ownerId, memberId]) {
      await tx.$executeRawUnsafe(
        `INSERT INTO team_member_keys (
           id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv, team_key_auth_tag,
           ephemeral_public_key, hkdf_salt, key_version, wrap_version, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, 1, now(), now())`,
        randomUUID(), teamId, tenantId, userId, hex(32), hex(12), hex(16), hex(32), hex(32), teamKeyVersion,
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE users SET ecdh_public_key = $2 WHERE id = $1::uuid`,
      pendingId, hex(32),
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO team_password_entries (
         id, team_id, tenant_id, created_by_id, updated_by_id,
         encrypted_blob, blob_iv, blob_auth_tag,
         encrypted_overview, overview_iv, overview_auth_tag,
         aad_version, team_key_version, item_key_version, entry_type,
         created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid,
         $5, $6, $7, $5, $8, $7,
         1, $9, 0, 'LOGIN', now(), now()
       )`,
      existingEntryId, teamId, tenantId, ownerId, hex(32), existingBlobIv, hex(16), hex(12), teamKeyVersion,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO team_tags (id, name, team_id, tenant_id, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now(), now())`,
      tagId, `tag-${tagId.slice(0, 8)}`, teamId, tenantId,
    );
  });
  return {
    teamId, ownerId, memberId, memberRowId, pendingId, pendingRowId,
    existingEntryId, existingBlobIv, tagId,
  };
}

function memberKey(userId: string, keyVersion: number) {
  return {
    userId,
    encryptedTeamKey: hex(32),
    teamKeyIv: hex(12),
    teamKeyAuthTag: hex(16),
    ephemeralPublicKey: hex(32),
    hkdfSalt: hex(32),
    keyVersion,
  };
}

/**
 * A rotation to v2 whose client snapshot holds only the seeded entry, as it
 * stood at seed time. Member keys go owner first, so the insert's FK checks
 * reach the owner's users row before the member's.
 */
function callRotate(seed: Seed, snapshotIv = seed.existingBlobIv) {
  return rotateKey(
    jsonRequest(`http://localhost/api/teams/${seed.teamId}/rotate-key`, "POST", {
      newTeamKeyVersion: 2,
      entries: [{
        id: seed.existingEntryId,
        itemKeyVersion: 0,
        snapshotIv,
        encryptedBlob: encryptedField(),
        encryptedOverview: encryptedField(),
        aadVersion: 1,
      }],
      memberKeys: [memberKey(seed.ownerId, 2), memberKey(seed.memberId, 2)],
    }),
    { params: Promise.resolve({ teamId: seed.teamId }) },
  );
}

/** Entries of the team whose team_key_version differs from the team's current one. */
async function entriesOffCurrentVersion(ctx: TestContext, teamId: string) {
  const r = await ctx.su.pool.query<{ id: string; team_key_version: number; current: number }>(
    `SELECT e.id, e.team_key_version, t.team_key_version AS current
       FROM team_password_entries e JOIN teams t ON t.id = e.team_id
      WHERE t.id = $1::uuid AND e.team_key_version <> t.team_key_version`,
    [teamId],
  );
  return r.rows;
}

async function teamKeyVersion(ctx: TestContext, teamId: string): Promise<number> {
  const r = await ctx.su.pool.query<{ team_key_version: number }>(
    `SELECT team_key_version FROM teams WHERE id = $1::uuid`,
    [teamId],
  );
  return r.rows[0].team_key_version;
}

async function memberKeyVersions(ctx: TestContext, teamId: string, userId: string): Promise<number[]> {
  const r = await ctx.su.pool.query<{ key_version: number }>(
    `SELECT key_version FROM team_member_keys WHERE team_id = $1::uuid AND user_id = $2::uuid ORDER BY key_version`,
    [teamId, userId],
  );
  return r.rows.map((row) => row.key_version);
}

describe("team key rotation serialisation — real-DB integration", () => {
  let ctx: TestContext;
  let tenantId: string;
  let side: ReturnType<typeof createPrismaForRole>;

  beforeAll(async () => {
    ctx = await createTestContext();
    side = createPrismaForRole("superuser");
    // The SCIM cases run service code through the app client inside its
    // tenant RLS context, as the routes do: the team lock must see `teams`
    // there, which only a role RLS applies to can show.
    await assertRlsApplies(prisma);
  });

  afterAll(async () => {
    await side.prisma.$disconnect();
    await side.pool.end();
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  /** Open a transaction holding `lockSql` until `release()`; returns its backend pid. */
  async function holdRowLock(lockSql: string, params: unknown[]) {
    const client: PoolClient = await side.pool.connect();
    let pid: number;
    try {
      await client.query("BEGIN");
      await client.query(lockSql, params);
      ({ rows: [{ pid }] } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"));
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      throw e;
    }
    let released = false;
    return {
      pid,
      async release() {
        if (released) return;
        released = true;
        try {
          await client.query("COMMIT");
        } finally {
          client.release();
        }
      },
    };
  }

  async function backendsBlockedBy(pid: number): Promise<number[]> {
    const r = await side.pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
      [pid],
    );
    return r.rows.map((row) => row.pid);
  }

  /** Resolve with the first backend observed waiting on `pid`'s locks. */
  async function waitForBackendBlockedBy(pid: number): Promise<number> {
    const deadline = Date.now() + BLOCK_WAIT_MS;
    while (Date.now() < deadline) {
      const [blocked] = await backendsBlockedBy(pid);
      if (blocked !== undefined) return blocked;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error(`no backend blocked on pid ${pid} within ${BLOCK_WAIT_MS}ms`);
  }

  /**
   * Wait until `work` settles or waits on `parkedPid`, and say which. The
   * guarded write waits on the parked transaction; an unguarded one runs
   * through ("settled"). A write that instead waits on the blocker (which then
   * blocks two backends) never reached the race at all, so that throws,
   * naming what it waited in.
   */
  async function settledOrBlocked(
    work: Promise<unknown>,
    parkedPid: number,
    blockerPid: number,
  ): Promise<"settled" | "blocked-on-parked"> {
    let settled = false;
    void work.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now() + BLOCK_WAIT_MS;
    while (Date.now() < deadline) {
      if (settled) return "settled";
      if ((await backendsBlockedBy(parkedPid)).length > 0) return "blocked-on-parked";
      const onBlocker = (await backendsBlockedBy(blockerPid)).filter((pid) => pid !== parkedPid);
      if (onBlocker.length > 0) {
        const r = await side.pool.query<{ query: string }>(
          `SELECT query FROM pg_stat_activity WHERE pid = $1`,
          [onBlocker[0]],
        );
        throw new Error(`write waited on the blocker, not the parked transaction: ${r.rows[0]?.query}`);
      }
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error(`work neither settled nor blocked on pid ${parkedPid} within ${BLOCK_WAIT_MS}ms`);
  }

  /**
   * Park a real rotation inside its transaction (after it has read the team's
   * members and entries, at the team_member_keys insert's FK check on
   * `parkOnUserId`'s users row), run `write` against it, then let the
   * rotation finish. Both requests are always settled before returning.
   */
  async function raceAgainstParkedRotation<T>(seed: Seed, write: () => Promise<T>, parkOnUserId = seed.memberId) {
    const blocker = await holdRowLock(`SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`, [parkOnUserId]);
    let rotation: Promise<Response> | undefined;
    let writing: Promise<T> | undefined;
    try {
      mockAuth.mockResolvedValue({ user: { id: seed.ownerId } });
      rotation = callRotate(seed);
      const rotationPid = await waitForBackendBlockedBy(blocker.pid);
      writing = write();
      const reached = await settledOrBlocked(writing, rotationPid, blocker.pid);
      await blocker.release();
      return { reached, rotation: await rotation, write: await writing };
    } finally {
      await blocker.release();
      // On a failure above, let both finish before afterEach deletes their rows.
      await Promise.allSettled([rotation, writing]);
    }
  }

  /**
   * Hold the lock rotation takes on the team for longer than a writer waits
   * for it, run `request`, and time it. The stand-in releases on its own
   * deadline (below Prisma's 5s transaction timeout), so a writer that does
   * not give up still returns — reporting a status other than the refusal —
   * rather than deadlocking the test against its own blocker.
   */
  async function withRotationStandIn(seed: Seed, request: () => Promise<Response>) {
    const blocker = await holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [seed.teamId]);
    const releaseAfter = setTimeout(() => void blocker.release(), TEAM_KEY_LOCK_TIMEOUT_MS + 1_500);
    try {
      const started = Date.now();
      const response = await request();
      return { response, waitedMs: Date.now() - started };
    } finally {
      clearTimeout(releaseAfter);
      await blocker.release();
    }
  }

  describe("entry writes", () => {
    it("a single create cannot commit under the old team key while a rotation is in flight", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);

      const res = await raceAgainstParkedRotation(seed, () =>
        createEntry(
          jsonRequest(`http://localhost/api/teams/${seed.teamId}/passwords`, "POST", newEntryBody(randomUUID(), 1)),
          { params: Promise.resolve({ teamId: seed.teamId }) },
        ),
      );

      expect({
        reached: res.reached,
        rotation: res.rotation.status,
        write: res.write.status,
        writeError: (await res.write.json()).error,
        version: await teamKeyVersion(ctx, seed.teamId),
        offVersion: await entriesOffCurrentVersion(ctx, seed.teamId),
      }).toEqual({
        reached: "blocked-on-parked",
        rotation: 200,
        write: 409,
        writeError: "TEAM_KEY_VERSION_MISMATCH",
        version: 2,
        offVersion: [],
      });
    });

    it("a one-entry bulk import cannot commit under the old team key while a rotation is in flight", async () => {
      // One entry: with several, a later entry's read of v2 aborts the whole
      // import even without the lock, and the race would prove only the rethrow.
      const seed = await seedTeam(ctx, tenantId, 1);

      const res = await raceAgainstParkedRotation(seed, () =>
        bulkImport(
          jsonRequest(`http://localhost/api/teams/${seed.teamId}/passwords/bulk-import`, "POST", {
            entries: [newEntryBody(randomUUID(), 1)],
          }),
          { params: Promise.resolve({ teamId: seed.teamId }) },
        ),
      );

      expect({
        reached: res.reached,
        rotation: res.rotation.status,
        write: res.write.status,
        writeError: (await res.write.json()).error,
        version: await teamKeyVersion(ctx, seed.teamId),
        offVersion: await entriesOffCurrentVersion(ctx, seed.teamId),
      }).toEqual({
        reached: "blocked-on-parked",
        rotation: 200,
        write: 409,
        writeError: "TEAM_KEY_VERSION_MISMATCH",
        version: 2,
        offVersion: [],
      });
    });

    it("a full PUT cannot write the old team key back over an entry a rotation just rewrapped", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);

      const res = await raceAgainstParkedRotation(seed, () =>
        updateEntry(
          jsonRequest(
            `http://localhost/api/teams/${seed.teamId}/passwords/${seed.existingEntryId}`,
            "PUT",
            {
              encryptedBlob: encryptedField(),
              encryptedOverview: encryptedField(),
              aadVersion: 1,
              teamKeyVersion: 1,
              itemKeyVersion: 0,
            },
          ),
          { params: Promise.resolve({ teamId: seed.teamId, id: seed.existingEntryId }) },
        ),
      );

      expect({
        reached: res.reached,
        rotation: res.rotation.status,
        write: res.write.status,
        writeError: (await res.write.json()).error,
        version: await teamKeyVersion(ctx, seed.teamId),
        offVersion: await entriesOffCurrentVersion(ctx, seed.teamId),
      }).toEqual({
        reached: "blocked-on-parked",
        rotation: 200,
        write: 409,
        writeError: "TEAM_KEY_VERSION_MISMATCH",
        version: 2,
        offVersion: [],
      });
    });

    it("a rotation waits for an in-flight create and then rejects the snapshot that misses it", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);
      // Park the create at its tag-join insert, after it has read the team's version.
      const blocker = await holdRowLock(`SELECT id FROM team_tags WHERE id = $1::uuid FOR UPDATE`, [seed.tagId]);
      let creating: Promise<Response> | undefined;
      let rotating: Promise<Response> | undefined;
      let created: Response;
      let rotated: Response;
      let reached: string;
      try {
        mockAuth.mockResolvedValue({ user: { id: seed.ownerId } });
        creating = createEntry(
          jsonRequest(
            `http://localhost/api/teams/${seed.teamId}/passwords`,
            "POST",
            newEntryBody(randomUUID(), 1, [seed.tagId]),
          ),
          { params: Promise.resolve({ teamId: seed.teamId }) },
        );
        const createPid = await waitForBackendBlockedBy(blocker.pid);

        rotating = callRotate(seed);
        reached = await settledOrBlocked(rotating, createPid, blocker.pid);

        await blocker.release();
        [created, rotated] = await Promise.all([creating, rotating]);
      } finally {
        await blocker.release();
        await Promise.allSettled([creating, rotating]);
      }

      expect({
        reached,
        create: created.status,
        rotation: rotated.status,
        rotationError: (await rotated.json()).error,
        version: await teamKeyVersion(ctx, seed.teamId),
        offVersion: await entriesOffCurrentVersion(ctx, seed.teamId),
      }).toEqual({
        reached: "blocked-on-parked",
        create: 201,
        rotation: 400,
        rotationError: "ENTRY_COUNT_MISMATCH",
        version: 1,
        offVersion: [],
      });
    });

    it("a bulk import carrying a stale team key version fails as a whole with 409 and persists nothing", async () => {
      const seed = await seedTeam(ctx, tenantId, 2);
      mockAuth.mockResolvedValue({ user: { id: seed.ownerId } });

      const res = await bulkImport(
        jsonRequest(`http://localhost/api/teams/${seed.teamId}/passwords/bulk-import`, "POST", {
          entries: [newEntryBody(randomUUID(), 2), newEntryBody(randomUUID(), 1)],
        }),
        { params: Promise.resolve({ teamId: seed.teamId }) },
      );

      const persisted = await ctx.su.pool.query<{ id: string }>(
        `SELECT id FROM team_password_entries WHERE team_id = $1::uuid`,
        [seed.teamId],
      );
      expect({
        status: res.status,
        error: (await res.json()).error,
        persisted: persisted.rows.map((r) => r.id),
      }).toEqual({
        status: 409,
        error: "TEAM_KEY_VERSION_MISMATCH",
        persisted: [seed.existingEntryId],
      });
    });

    it("a write that waits past the lock timeout on a rotation answers 409, not an expired transaction", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);
      mockAuth.mockResolvedValue({ user: { id: seed.ownerId } });

      const res = await withRotationStandIn(seed, () =>
        createEntry(
          jsonRequest(`http://localhost/api/teams/${seed.teamId}/passwords`, "POST", newEntryBody(randomUUID(), 1)),
          { params: Promise.resolve({ teamId: seed.teamId }) },
        ),
      );

      expect({ status: res.response.status, error: (await res.response.json()).error }).toEqual({
        status: 409,
        error: "TEAM_KEY_VERSION_MISMATCH",
      });
      expect(res.waitedMs).toBeGreaterThanOrEqual(TEAM_KEY_LOCK_TIMEOUT_MS);
      expect(res.waitedMs).toBeLessThan(TEAM_KEY_LOCK_TIMEOUT_MS + 1_500);
      expect(await ctx.su.pool.query(
        `SELECT 1 FROM team_password_entries WHERE team_id = $1::uuid AND id <> $2::uuid`,
        [seed.teamId, seed.existingEntryId],
      ).then((r) => r.rowCount)).toBe(0);
    }, 15_000);

    it("past the rotation lock, the write's other waits keep their own timeout", async () => {
      // The bounded wait covers the team lock only: an entry insert whose FK
      // check waits on the creator's users row longer than that bound must
      // still go through.
      const seed = await seedTeam(ctx, tenantId, 1);
      mockAuth.mockResolvedValue({ user: { id: seed.ownerId } });
      const blocker = await holdRowLock(`SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`, [seed.ownerId]);
      const releaseAfter = setTimeout(() => void blocker.release(), TEAM_KEY_LOCK_TIMEOUT_MS + 500);
      let res: Response;
      try {
        res = await createEntry(
          jsonRequest(`http://localhost/api/teams/${seed.teamId}/passwords`, "POST", newEntryBody(randomUUID(), 1)),
          { params: Promise.resolve({ teamId: seed.teamId }) },
        );
      } finally {
        clearTimeout(releaseAfter);
        await blocker.release();
      }

      expect(res.status).toBe(201);
    }, 15_000);
  });

  describe("rotation snapshot", () => {
    it("a rotation built from a snapshot an edit has since replaced is rejected and leaves the edit intact", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);
      mockAuth.mockResolvedValue({ user: { id: seed.ownerId } });

      // The edit lands after the client fetched rotate-key/data (its
      // snapshot is the seeded blob) and before it posts the rotation: a
      // v0 → v1 upgrade, as the UI does on every edit of a v0 entry.
      const edit = await updateEntry(
        jsonRequest(
          `http://localhost/api/teams/${seed.teamId}/passwords/${seed.existingEntryId}`,
          "PUT",
          {
            encryptedBlob: encryptedField(),
            encryptedOverview: encryptedField(),
            aadVersion: 1,
            teamKeyVersion: 1,
            itemKeyVersion: 1,
            encryptedItemKey: encryptedField(),
          },
        ),
        { params: Promise.resolve({ teamId: seed.teamId, id: seed.existingEntryId }) },
      );
      expect(edit.status).toBe(200);
      const edited = await ctx.su.pool.query(
        `SELECT blob_iv, item_key_version, item_key_iv, team_key_version
           FROM team_password_entries WHERE id = $1::uuid`,
        [seed.existingEntryId],
      );

      const rotated = await callRotate(seed);

      const after = await ctx.su.pool.query(
        `SELECT blob_iv, item_key_version, item_key_iv, team_key_version
           FROM team_password_entries WHERE id = $1::uuid`,
        [seed.existingEntryId],
      );
      expect({
        status: rotated.status,
        error: (await rotated.json()).error,
        version: await teamKeyVersion(ctx, seed.teamId),
        entry: after.rows[0],
      }).toEqual({
        status: 400,
        error: "ENTRY_COUNT_MISMATCH",
        version: 1,
        entry: edited.rows[0],
      });
    });

    it("a rotation built from the current snapshot is applied", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);
      mockAuth.mockResolvedValue({ user: { id: seed.ownerId } });

      const rotated = await callRotate(seed);

      expect({
        status: rotated.status,
        version: await teamKeyVersion(ctx, seed.teamId),
        offVersion: await entriesOffCurrentVersion(ctx, seed.teamId),
      }).toEqual({ status: 200, version: 2, offVersion: [] });
    });
  });

  describe("member keys", () => {
    it("removing a member while a rotation is in flight leaves them no key to the new version", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);

      const res = await raceAgainstParkedRotation(seed, () =>
        removeMember(
          jsonRequest(`http://localhost/api/teams/${seed.teamId}/members/${seed.memberRowId}`, "DELETE"),
          { params: Promise.resolve({ teamId: seed.teamId, memberId: seed.memberRowId }) },
        ),
      );

      expect({
        reached: res.reached,
        rotation: res.rotation.status,
        removal: res.write.status,
        version: await teamKeyVersion(ctx, seed.teamId),
        removedMemberKeys: await memberKeyVersions(ctx, seed.teamId, seed.memberId),
      }).toEqual({
        reached: "blocked-on-parked",
        rotation: 200,
        removal: 200,
        version: 2,
        removedMemberKeys: [],
      });
    });

    it("a vault reset while a rotation is in flight leaves the reset user no key to the new version", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);

      // Parked on the owner's users row: the reset itself locks the member's.
      const res = await raceAgainstParkedRotation(
        seed,
        () => executeVaultReset(seed.memberId),
        seed.ownerId,
      );

      expect({
        reached: res.reached,
        rotation: res.rotation.status,
        version: await teamKeyVersion(ctx, seed.teamId),
        resetUserKeys: await memberKeyVersions(ctx, seed.teamId, seed.memberId),
      }).toEqual({
        reached: "blocked-on-parked",
        rotation: 200,
        version: 2,
        resetUserKeys: [],
      });
    });

    it("a removal that waits past the lock timeout on a rotation answers 409 and removes nothing", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);
      mockAuth.mockResolvedValue({ user: { id: seed.ownerId } });

      const res = await withRotationStandIn(seed, () =>
        removeMember(
          jsonRequest(`http://localhost/api/teams/${seed.teamId}/members/${seed.memberRowId}`, "DELETE"),
          { params: Promise.resolve({ teamId: seed.teamId, memberId: seed.memberRowId }) },
        ),
      );

      const member = await ctx.su.pool.query(`SELECT 1 FROM team_members WHERE id = $1::uuid`, [seed.memberRowId]);
      expect({
        status: res.response.status,
        error: (await res.response.json()).error,
        memberRows: member.rowCount,
        memberKeys: await memberKeyVersions(ctx, seed.teamId, seed.memberId),
      }).toEqual({ status: 409, error: "CONFLICT", memberRows: 1, memberKeys: [1] });
    }, 15_000);

    it("a SCIM user deletion while a rotation is in flight leaves the user no key to the new version", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);
      await ctx.su.pool.query(
        `UPDATE tenant_members SET role = 'MEMBER' WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        [tenantId, seed.memberId],
      );

      const res = await raceAgainstParkedRotation(seed, () =>
        withTenantRls(prisma, tenantId, () => deactivateScimUser(tenantId, seed.memberId)),
      );

      const memberships = await ctx.su.pool.query(
        `SELECT 1 FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`,
        [seed.teamId, seed.memberId],
      );
      expect({
        reached: res.reached,
        rotation: res.rotation.status,
        version: await teamKeyVersion(ctx, seed.teamId),
        memberships: memberships.rowCount,
        deletedUserKeys: await memberKeyVersions(ctx, seed.teamId, seed.memberId),
      }).toEqual({
        reached: "blocked-on-parked",
        rotation: 200,
        version: 2,
        memberships: 0,
        deletedUserKeys: [],
      });
    });

    it("a SCIM group removal while a rotation is in flight waits for it, then deactivates the member", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);
      const externalGroupId = `grp-${seed.teamId.slice(0, 8)}`;
      await ctx.su.pool.query(
        `INSERT INTO scim_group_mappings (id, tenant_id, team_id, external_group_id, role, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'MEMBER', now(), now())`,
        [randomUUID(), tenantId, seed.teamId, externalGroupId],
      );

      // Deactivation keeps keys by design, so what the lock buys is the order:
      // the rotation that read this member as key-holding commits first, and
      // the next rotation sees them deactivated — never a key issued to a
      // member already deactivated.
      const res = await raceAgainstParkedRotation(seed, () =>
        withTenantRls(prisma, tenantId, (tx) =>
          patchScimGroup(tenantId, externalGroupId, [{ op: "remove", userId: seed.memberId }], "http://localhost/scim/v2", tx),
        ),
      );

      const member = await ctx.su.pool.query<{ deactivated: boolean }>(
        `SELECT deactivated_at IS NOT NULL AS deactivated FROM team_members WHERE id = $1::uuid`,
        [seed.memberRowId],
      );
      expect({
        reached: res.reached,
        rotation: res.rotation.status,
        deactivated: member.rows[0].deactivated,
      }).toEqual({ reached: "blocked-on-parked", rotation: 200, deactivated: true });
    });

    it("distributing the old key while a rotation is in flight is refused, leaving the member pending", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);

      const res = await raceAgainstParkedRotation(seed, () =>
        confirmKey(
          jsonRequest(
            `http://localhost/api/teams/${seed.teamId}/members/${seed.pendingRowId}/confirm-key`,
            "POST",
            { ...memberKey(seed.pendingId, 1), userId: undefined },
          ),
          { params: Promise.resolve({ teamId: seed.teamId, memberId: seed.pendingRowId }) },
        ),
      );

      const pending = await ctx.su.pool.query<{ key_distributed: boolean }>(
        `SELECT key_distributed FROM team_members WHERE id = $1::uuid`,
        [seed.pendingRowId],
      );
      expect({
        reached: res.reached,
        rotation: res.rotation.status,
        distribution: res.write.status,
        distributionError: (await res.write.json()).error,
        keyDistributed: pending.rows[0].key_distributed,
        pendingKeys: await memberKeyVersions(ctx, seed.teamId, seed.pendingId),
      }).toEqual({
        reached: "blocked-on-parked",
        rotation: 200,
        distribution: 409,
        distributionError: "TEAM_KEY_VERSION_MISMATCH",
        keyDistributed: false,
        pendingKeys: [],
      });
    });
  });

  describe("tenant departure", () => {
    async function setTenantActive(userId: string, active: boolean) {
      await ctx.su.pool.query(
        `UPDATE tenant_members SET deactivated_at = ${active ? "NULL" : "now()"} WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        [tenantId, userId],
      );
    }

    async function memberKeyAs(seed: Seed, userId: string) {
      mockAuth.mockResolvedValue({ user: { id: userId } });
      return getMemberKey(
        jsonRequest(`http://localhost/api/teams/${seed.teamId}/member-key`, "GET"),
        { params: Promise.resolve({ teamId: seed.teamId }) },
      );
    }

    async function pendingFor(seed: Seed): Promise<string[]> {
      mockAuth.mockResolvedValue({ user: { id: seed.ownerId } });
      // The route's own signature takes no argument; withRequestLog reads the request.
      const res = await (getPendingDistributions as (req: NextRequest) => Promise<Response>)(
        jsonRequest("http://localhost/api/teams/pending-key-distributions", "GET"),
      );
      const rows = (await res.json()) as { userId: string }[];
      return rows.map((row) => row.userId).sort();
    }

    function rotateHoldersOnly(seed: Seed, holders: string[]) {
      mockAuth.mockResolvedValue({ user: { id: seed.ownerId } });
      return rotateKey(
        jsonRequest(`http://localhost/api/teams/${seed.teamId}/rotate-key`, "POST", {
          newTeamKeyVersion: 2,
          entries: [{
            id: seed.existingEntryId,
            itemKeyVersion: 0,
            snapshotIv: seed.existingBlobIv,
            encryptedBlob: encryptedField(),
            encryptedOverview: encryptedField(),
            aadVersion: 1,
          }],
          memberKeys: holders.map((userId) => memberKey(userId, 2)),
        }),
        { params: Promise.resolve({ teamId: seed.teamId }) },
      );
    }

    it("a member who departed the team's tenant is served no key", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);
      expect((await memberKeyAs(seed, seed.memberId)).status).toBe(200);

      await setTenantActive(seed.memberId, false);

      expect((await memberKeyAs(seed, seed.memberId)).status).toBe(404);
    });

    it("a pending member who departed is neither listed for distribution nor distributable", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);
      expect(await pendingFor(seed)).toEqual([seed.pendingId]);

      await setTenantActive(seed.pendingId, false);

      expect(await pendingFor(seed)).toEqual([]);
      const res = await confirmKey(
        jsonRequest(
          `http://localhost/api/teams/${seed.teamId}/members/${seed.pendingRowId}/confirm-key`,
          "POST",
          { ...memberKey(seed.pendingId, 1), userId: undefined },
        ),
        { params: Promise.resolve({ teamId: seed.teamId, memberId: seed.pendingRowId }) },
      );
      expect(res.status).toBe(404);
      expect(await memberKeyVersions(ctx, seed.teamId, seed.pendingId)).toEqual([]);
    });

    it("a rotation neither requires nor accepts a departed member, and leaves them pending", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);
      await setTenantActive(seed.memberId, false);

      const refused = await rotateHoldersOnly(seed, [seed.ownerId, seed.memberId]);
      expect({ status: refused.status, details: (await refused.json()).details })
        .toEqual({ status: 400, details: { unknownUserId: seed.memberId } });

      const rotated = await rotateHoldersOnly(seed, [seed.ownerId]);
      const member = await ctx.su.pool.query<{ key_distributed: boolean }>(
        `SELECT key_distributed FROM team_members WHERE id = $1::uuid`,
        [seed.memberRowId],
      );
      expect({
        status: rotated.status,
        departedKeys: await memberKeyVersions(ctx, seed.teamId, seed.memberId),
        keyDistributed: member.rows[0].key_distributed,
      }).toEqual({ status: 200, departedKeys: [1], keyDistributed: false });
    });

    it("reactivated with no rotation in between, the member is served their key again", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);
      await setTenantActive(seed.memberId, false);
      await setTenantActive(seed.memberId, true);

      expect((await memberKeyAs(seed, seed.memberId)).status).toBe(200);
      expect(await pendingFor(seed)).toEqual([seed.pendingId]);
    });

    it("reactivated after a rotation, the member is listed for distribution of the new key", async () => {
      const seed = await seedTeam(ctx, tenantId, 1);
      // Distribution lists only members it can wrap a key to.
      await ctx.su.pool.query(`UPDATE users SET ecdh_public_key = $2 WHERE id = $1::uuid`, [seed.memberId, hex(32)]);
      await setTenantActive(seed.memberId, false);
      expect((await rotateHoldersOnly(seed, [seed.ownerId])).status).toBe(200);
      await setTenantActive(seed.memberId, true);

      // A member again, but the new key is not theirs yet: pending, not served the old one.
      const served = await memberKeyAs(seed, seed.memberId);
      expect({ status: served.status, error: (await served.json()).error })
        .toEqual({ status: 403, error: "KEY_NOT_DISTRIBUTED" });
      expect(await pendingFor(seed)).toEqual([seed.memberId, seed.pendingId].sort());
    });

    it("a member with no row in the team's tenant has not departed", async () => {
      // A member invited from another tenant: no tenant_members row here.
      const seed = await seedTeam(ctx, tenantId, 1);
      await ctx.su.pool.query(
        `DELETE FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        [tenantId, seed.memberId],
      );

      expect((await memberKeyAs(seed, seed.memberId)).status).toBe(200);
    });
  });
});
