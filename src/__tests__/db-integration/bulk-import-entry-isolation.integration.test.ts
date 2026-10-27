/**
 * Integration test (real DB): bulk import isolates a DB-level failure to the
 * entry that caused it.
 *
 * Both bulk-import routes create every entry inside ONE interactive tenant
 * transaction and count a per-entry throw as `failedCount`. A JS-level throw
 * (ownership check, key-version check) leaves the transaction usable, but a
 * statement the database rejects — here a P2002 on the client-supplied `id`
 * — puts the PostgreSQL session into the aborted state: every later
 * statement fails with 25P02, and the final COMMIT silently becomes a
 * ROLLBACK. Without per-entry isolation the route then answers 201 and
 * enqueues ENTRY_CREATE audit rows for entries that no longer exist.
 *
 * Production entry points are driven directly; only the auth and rate-limit
 * boundaries are mocked (precedent: team-rotate-key.integration.test.ts).
 *
 * Run: docker compose up -d db && npm run test:integration -- bulk-import-entry-isolation
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { createTestContext, seedVaultUser, setBypassRlsGucs, type TestContext } from "./helpers";

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: () => {},
  }),
}));

import { POST as personalBulkImport } from "@/app/api/passwords/bulk-import/route";
import { POST as teamBulkImport } from "@/app/api/teams/[teamId]/passwords/bulk-import/route";

function hex(nBytes: number): string {
  return randomBytes(nBytes).toString("hex");
}

function encryptedField() {
  return { ciphertext: hex(32), iv: hex(12), authTag: hex(16) };
}

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The live audit-outbox-worker may drain rows into audit_logs between the
 * route's enqueue and this read, so look in both places.
 */
async function auditedEntryCreateIds(ctx: TestContext, tenantId: string): Promise<string[]> {
  const r = await ctx.su.pool.query<{ target_id: string }>(
    `SELECT payload->>'targetId' AS target_id FROM audit_outbox
      WHERE tenant_id = $1::uuid AND payload->>'action' = 'ENTRY_CREATE'
     UNION
     SELECT target_id FROM audit_logs
      WHERE tenant_id = $1::uuid AND action = 'ENTRY_CREATE'`,
    [tenantId],
  );
  return r.rows.map((row) => row.target_id).sort();
}

async function bulkImportMetadata(ctx: TestContext, tenantId: string): Promise<unknown> {
  const r = await ctx.su.pool.query<{ metadata: unknown }>(
    `SELECT payload->'metadata' AS metadata FROM audit_outbox
      WHERE tenant_id = $1::uuid AND payload->>'action' = 'ENTRY_BULK_IMPORT'
     UNION ALL
     SELECT metadata FROM audit_logs
      WHERE tenant_id = $1::uuid AND action = 'ENTRY_BULK_IMPORT'`,
    [tenantId],
  );
  expect(r.rows).toHaveLength(1);
  return r.rows[0].metadata;
}

describe("bulk import — a DB-level entry failure is isolated (real DB)", () => {
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

  it("personal: an in-batch duplicate id fails alone; the entries around it persist and are the only ones reported", async () => {
    const { userId, keyVersion } = await seedVaultUser(ctx, tenantId);
    mockAuth.mockResolvedValue({ user: { id: userId } });

    const firstId = randomUUID();
    const lastId = randomUUID();
    const entry = (id: string) => ({
      id,
      encryptedBlob: encryptedField(),
      encryptedOverview: encryptedField(),
      keyVersion,
      aadVersion: 1,
    });

    const res = await personalBulkImport(
      jsonRequest("http://localhost/api/passwords/bulk-import", {
        // The second entry reuses the first's id → P2002 on password_entries_pkey.
        entries: [entry(firstId), entry(firstId), entry(lastId)],
      }),
    );

    const persisted = await ctx.su.pool.query<{ id: string }>(
      `SELECT id FROM password_entries WHERE user_id = $1::uuid ORDER BY id`,
      [userId],
    );

    expect({
      status: res.status,
      body: await res.json(),
      persisted: persisted.rows.map((r) => r.id),
      audited: await auditedEntryCreateIds(ctx, tenantId),
    }).toEqual({
      status: 201,
      body: { success: true, importedCount: 2, failedCount: 1 },
      persisted: [firstId, lastId].sort(),
      audited: [firstId, lastId].sort(),
    });
    expect(await bulkImportMetadata(ctx, tenantId)).toMatchObject({
      requestedCount: 3,
      createdCount: 2,
      failedCount: 1,
    });
  });

  it("team: an id colliding with an existing entry fails alone; the entries around it persist and are the only ones reported", async () => {
    const ownerId = await ctx.createUser(tenantId);
    const teamId = randomUUID();
    const existingId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
        teamId, tenantId, `team-${teamId.slice(0, 8)}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'OWNER', true, now(), now())`,
        randomUUID(), teamId, ownerId, tenantId,
      );
      // An entry the team already holds — a re-import of an export that kept
      // its ids collides with it on team_password_entries_pkey.
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
           1, 1, 0, 'LOGIN', now(), now()
         )`,
        existingId, teamId, tenantId, ownerId, hex(32), hex(12), hex(16),
      );
    });
    mockAuth.mockResolvedValue({ user: { id: ownerId } });

    const firstId = randomUUID();
    const lastId = randomUUID();
    const entry = (id: string) => ({
      id,
      encryptedBlob: encryptedField(),
      encryptedOverview: encryptedField(),
      aadVersion: 1,
      teamKeyVersion: 1,
    });

    const res = await teamBulkImport(
      jsonRequest(`http://localhost/api/teams/${teamId}/passwords/bulk-import`, {
        entries: [entry(firstId), entry(existingId), entry(lastId)],
      }),
      { params: Promise.resolve({ teamId }) },
    );

    const persisted = await ctx.su.pool.query<{ id: string }>(
      `SELECT id FROM team_password_entries WHERE team_id = $1::uuid ORDER BY id`,
      [teamId],
    );

    expect({
      status: res.status,
      body: await res.json(),
      persisted: persisted.rows.map((r) => r.id),
      audited: await auditedEntryCreateIds(ctx, tenantId),
    }).toEqual({
      status: 201,
      body: { success: true, importedCount: 2, failedCount: 1 },
      persisted: [existingId, firstId, lastId].sort(),
      audited: [firstId, lastId].sort(),
    });
    expect(await bulkImportMetadata(ctx, tenantId)).toMatchObject({
      requestedCount: 3,
      createdCount: 2,
      failedCount: 1,
    });
  });
});
