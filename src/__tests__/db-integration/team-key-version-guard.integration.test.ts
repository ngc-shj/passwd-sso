/**
 * Integration test (real DB): team keyVersion guard — a team entry write must
 * never commit under the pre-rotation team key while a rotation is in flight.
 *
 * The team twin of key-version-guard.integration.test.ts. Every write path that
 * stamps `team_key_version` on a team entry (single create, bulk import, full
 * PUT) reads the team's version under `FOR SHARE`, and rotation takes
 * `teams ... FOR UPDATE` before listing entries. Without both locks, under READ
 * COMMITTED a write that read v1 commits next to a rotation to v2 and leaves a
 * live entry under the key a just-removed member still holds.
 *
 * Each race is made deterministic by parking one side mid-transaction on a row
 * lock it needs but that only a test-held "blocker" transaction holds:
 *   - rotation parks at its team_member_keys insert, whose FK check on the
 *     second member's users row waits behind the blocker's FOR UPDATE;
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
  createTestContext,
  createPrismaForRole,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";

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

const BLOCK_WAIT_MS = 10_000;

function hex(nBytes: number): string {
  return randomBytes(nBytes).toString("hex");
}

function encryptedField() {
  return { ciphertext: hex(32), iv: hex(12), authTag: hex(16) };
}

function jsonRequest(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
  memberId: string;
  existingEntryId: string;
  tagId: string;
};

async function seedTeam(ctx: TestContext, tenantId: string, teamKeyVersion: number): Promise<Seed> {
  const ownerId = await ctx.createUser(tenantId);
  const memberId = await ctx.createUser(tenantId);
  const teamId = randomUUID();
  const existingEntryId = randomUUID();
  const tagId = randomUUID();
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, $4, now(), now())`,
      teamId, tenantId, `team-${teamId.slice(0, 8)}`, teamKeyVersion,
    );
    for (const [userId, role] of [[ownerId, "OWNER"], [memberId, "MEMBER"]] as const) {
      await tx.$executeRawUnsafe(
        `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", true, now(), now())`,
        randomUUID(), teamId, userId, tenantId, role,
      );
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO team_password_entries (
         id, team_id, tenant_id, created_by_id, updated_by_id,
         encrypted_blob, blob_iv, blob_auth_tag,
         encrypted_overview, overview_iv, overview_auth_tag,
         aad_version, team_key_version, item_key_version, entry_type,
         created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid,
         $5, $6, $7, $5, $6, $7,
         1, $8, 0, 'LOGIN', now(), now()
       )`,
      existingEntryId, teamId, tenantId, ownerId, hex(32), hex(12), hex(16), teamKeyVersion,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO team_tags (id, name, team_id, tenant_id, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now(), now())`,
      tagId, `tag-${tagId.slice(0, 8)}`, teamId, tenantId,
    );
  });
  return { teamId, ownerId, memberId, existingEntryId, tagId };
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

/** A rotation to v2 whose client snapshot holds only the seeded entry. */
function callRotate(seed: Seed) {
  return rotateKey(
    jsonRequest(`http://localhost/api/teams/${seed.teamId}/rotate-key`, "POST", {
      newTeamKeyVersion: 2,
      entries: [{
        id: seed.existingEntryId,
        itemKeyVersion: 0,
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

describe("team keyVersion guard — real-DB integration", () => {
  let ctx: TestContext;
  let tenantId: string;
  let side: ReturnType<typeof createPrismaForRole>;

  beforeAll(async () => {
    ctx = await createTestContext();
    side = createPrismaForRole("superuser");
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
    await client.query("BEGIN");
    await client.query(lockSql, params);
    const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    let released = false;
    return {
      pid: rows[0].pid,
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
   * Wait until `work` either settles or is observed waiting on `pid`'s locks.
   * Both are legitimate outcomes (the unguarded write runs through, the
   * guarded one waits); the test asserts which one through the final state.
   */
  async function settledOrBlockedBy(work: Promise<unknown>, pid: number): Promise<void> {
    let settled = false;
    void work.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now() + BLOCK_WAIT_MS;
    while (Date.now() < deadline) {
      if (settled) return;
      if ((await backendsBlockedBy(pid)).length > 0) return;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error(`work neither settled nor blocked on pid ${pid} within ${BLOCK_WAIT_MS}ms`);
  }

  /**
   * Park a real rotation inside its transaction (after it has listed the
   * team's entries, at the team_member_keys insert), run `write` against it,
   * then let the rotation finish.
   */
  async function raceWriteAgainstParkedRotation(seed: Seed, write: () => Promise<Response>) {
    const blocker = await holdRowLock(
      `SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`,
      [seed.memberId],
    );
    try {
      mockAuth.mockResolvedValue({ user: { id: seed.ownerId } });
      const rotation = callRotate(seed);
      const rotationPid = await waitForBackendBlockedBy(blocker.pid);

      const writing = write();
      await settledOrBlockedBy(writing, rotationPid);

      await blocker.release();
      return { rotation: await rotation, write: await writing };
    } finally {
      await blocker.release();
    }
  }

  it("a single create cannot commit under the old team key while a rotation is in flight", async () => {
    const seed = await seedTeam(ctx, tenantId, 1);
    const newId = randomUUID();

    const res = await raceWriteAgainstParkedRotation(seed, () =>
      createEntry(
        jsonRequest(`http://localhost/api/teams/${seed.teamId}/passwords`, "POST", newEntryBody(newId, 1)),
        { params: Promise.resolve({ teamId: seed.teamId }) },
      ),
    );

    expect({
      rotation: res.rotation.status,
      write: res.write.status,
      writeError: (await res.write.json()).error,
      version: await teamKeyVersion(ctx, seed.teamId),
      offVersion: await entriesOffCurrentVersion(ctx, seed.teamId),
    }).toEqual({
      rotation: 200,
      write: 409,
      writeError: "TEAM_KEY_VERSION_MISMATCH",
      version: 2,
      offVersion: [],
    });
  });

  it("a bulk import cannot commit under the old team key while a rotation is in flight", async () => {
    const seed = await seedTeam(ctx, tenantId, 1);

    const res = await raceWriteAgainstParkedRotation(seed, () =>
      bulkImport(
        jsonRequest(`http://localhost/api/teams/${seed.teamId}/passwords/bulk-import`, "POST", {
          entries: [newEntryBody(randomUUID(), 1), newEntryBody(randomUUID(), 1)],
        }),
        { params: Promise.resolve({ teamId: seed.teamId }) },
      ),
    );

    expect({
      rotation: res.rotation.status,
      write: res.write.status,
      writeError: (await res.write.json()).error,
      version: await teamKeyVersion(ctx, seed.teamId),
      offVersion: await entriesOffCurrentVersion(ctx, seed.teamId),
    }).toEqual({
      rotation: 200,
      write: 409,
      writeError: "TEAM_KEY_VERSION_MISMATCH",
      version: 2,
      offVersion: [],
    });
  });

  it("a full PUT cannot write the old team key back over an entry a rotation just rewrapped", async () => {
    const seed = await seedTeam(ctx, tenantId, 1);

    const res = await raceWriteAgainstParkedRotation(seed, () =>
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
      rotation: res.rotation.status,
      write: res.write.status,
      writeError: (await res.write.json()).error,
      version: await teamKeyVersion(ctx, seed.teamId),
      offVersion: await entriesOffCurrentVersion(ctx, seed.teamId),
    }).toEqual({
      rotation: 200,
      write: 409,
      writeError: "TEAM_KEY_VERSION_MISMATCH",
      version: 2,
      offVersion: [],
    });
  });

  it("a rotation waits for an in-flight create and then rejects the snapshot that misses it", async () => {
    const seed = await seedTeam(ctx, tenantId, 1);
    const newId = randomUUID();
    // Park the create at its tag-join insert, after it has read the team's version.
    const blocker = await holdRowLock(
      `SELECT id FROM team_tags WHERE id = $1::uuid FOR UPDATE`,
      [seed.tagId],
    );
    let created: Response;
    let rotated: Response;
    try {
      mockAuth.mockResolvedValue({ user: { id: seed.ownerId } });
      const creating = createEntry(
        jsonRequest(
          `http://localhost/api/teams/${seed.teamId}/passwords`,
          "POST",
          newEntryBody(newId, 1, [seed.tagId]),
        ),
        { params: Promise.resolve({ teamId: seed.teamId }) },
      );
      const createPid = await waitForBackendBlockedBy(blocker.pid);

      const rotating = callRotate(seed);
      await settledOrBlockedBy(rotating, createPid);

      await blocker.release();
      [created, rotated] = await Promise.all([creating, rotating]);
    } finally {
      await blocker.release();
    }

    expect({
      create: created.status,
      rotation: rotated.status,
      rotationError: (await rotated.json()).error,
      version: await teamKeyVersion(ctx, seed.teamId),
      offVersion: await entriesOffCurrentVersion(ctx, seed.teamId),
    }).toEqual({
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
});
