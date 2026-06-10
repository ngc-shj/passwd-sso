/**
 * Integration tests (real DB): C1 — password-entry history snapshot is atomic
 * and lost-update-safe.
 *
 * RT5 (primary): race two updateTeamPassword() calls against the same entry.
 *   - Each iteration seeds a fresh entry with blob v0, races writers A(vA) and
 *     B(vB).  After the race asserts:
 *     (a) exactly 2 history rows for that entry
 *     (b) the two snapshot blobs are {v0, firstWriter} where firstWriter ∈ {vA,vB}
 *         and firstWriter != v0 — this is the direct lost-update detector
 *         (without the lock both writers snapshot v0 → history {v0,v0} and
 *         the "firstWriter != v0" assertion fails)
 *     (c) final entry blob = the other writer's blob
 *   - Across ≥50 iterations asserts both A-wins and B-wins occur (RT4).
 *
 * SQL column validity (T2/RT1 for personal + v1 inline handlers):
 *   - Executes the exact personal / v1 SELECT … FOR UPDATE SQL against a seeded
 *     password_entries row and asserts the 5 expected columns are returned.
 *     Catches column-name / ::uuid-cast typos that unit mocks cannot.
 *
 * Run: docker compose up -d db && npm run test:integration -- passwords-history-lost-update
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import {
  createTestContext,
  setBypassRlsGucs,
  createPrismaForRole,
  type TestContext,
} from "./helpers";
import { updateTeamPassword } from "@/lib/services/team-password-service";
import { withTeamTenantRls } from "@/lib/tenant-context";

// ─── Skip guard ──────────────────────────────────────────────────────────────
const SKIP = !process.env.DATABASE_URL;

// ─── Test context ─────────────────────────────────────────────────────────────

describe("C1: password-entry history lost-update safety — integration", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let teamId: string;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });

  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });

  beforeEach(async () => {
    if (SKIP) return;
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    // Create a team with team_key_version=1 (schema default)
    teamId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 1, now(), now())`,
        teamId,
        tenantId,
        `test-team-${teamId.slice(0, 8)}`,
        `team-${teamId.slice(0, 8)}`,
      );
    });
    // Add the user as a team member so RLS passes the team membership check
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO team_members (id, team_id, tenant_id, user_id, role, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ADMIN', now(), now())`,
        randomUUID(),
        teamId,
        tenantId,
        userId,
      );
    });
  });

  afterEach(async () => {
    if (SKIP) return;
    await ctx.deleteTestData(tenantId);
  });

  // ─── Seed helper ─────────────────────────────────────────────────────────────

  async function seedTeamEntry(blob: string): Promise<string> {
    const id = randomUUID();
    const iv = randomBytes(12).toString("hex");
    const tag = randomBytes(16).toString("hex");
    const placeholder = "placeholder";
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO team_password_entries (
           id, team_id, tenant_id, created_by_id, updated_by_id,
           encrypted_blob, blob_iv, blob_auth_tag,
           encrypted_overview, overview_iv, overview_auth_tag,
           team_key_version, aad_version, item_key_version, entry_type,
           created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid,
           $5, $6, $7,
           $8, $9, $10,
           1, 1, 0, 'LOGIN'::"EntryType", now(), now()
         )`,
        id, teamId, tenantId, userId,
        blob, iv, tag,
        placeholder, iv, tag,
      );
    });
    return id;
  }

  // Fetch history rows for a team entry (order by changedAt asc)
  async function fetchHistory(entryId: string): Promise<{ encrypted_blob: string }[]> {
    const rows = await ctx.su.pool.query<{ encrypted_blob: string }>(
      `SELECT encrypted_blob FROM team_password_entry_histories
       WHERE entry_id = $1::uuid
       ORDER BY changed_at ASC`,
      [entryId],
    );
    return rows.rows;
  }

  // Fetch the current blob of a team entry
  async function fetchEntryBlob(entryId: string): Promise<string> {
    const row = await ctx.su.pool.query<{ encrypted_blob: string }>(
      `SELECT encrypted_blob FROM team_password_entries WHERE id = $1::uuid`,
      [entryId],
    );
    return row.rows[0].encrypted_blob;
  }

  // Wrap updateTeamPassword in the required withTeamTenantRls context
  function callUpdateTeamPassword(
    entryId: string,
    blob: string,
    existingBlobSnapshot: string,
  ) {
    const iv = randomBytes(12).toString("hex");
    const tag = randomBytes(16).toString("hex");
    return withTeamTenantRls(teamId, () =>
      updateTeamPassword(teamId, entryId, {
        encryptedBlob: { ciphertext: blob, iv, authTag: tag },
        encryptedOverview: { ciphertext: "overview", iv, authTag: tag },
        aadVersion: 1,
        teamKeyVersion: 1,
        itemKeyVersion: 0,
        userId,
        existingEntry: {
          tenantId,
          encryptedBlob: existingBlobSnapshot,
          blobIv: "placeholder",
          blobAuthTag: "placeholder",
          aadVersion: 1,
          teamKeyVersion: 1,
          itemKeyVersion: 0,
          encryptedItemKey: null,
          itemKeyIv: null,
          itemKeyAuthTag: null,
        },
      }),
    );
  }

  // ─── RT5: lock semantics race ─────────────────────────────────────────────

  it.skipIf(SKIP)(
    "RT5: race updateTeamPassword × 50 iters — no snapshot is lost; both-outcomes occur",
    async () => {
      const ITERS = 50;
      let aWins = 0;
      let bWins = 0;

      // Pre-warm the global prisma pool with two simultaneous connections so
      // subsequent races do not pay connection-setup latency (mirrors raceTwoClients).
      const { prisma: warmPrisma, pool: warmPool } = createPrismaForRole("app");
      try {
        await Promise.all([
          warmPrisma.$executeRaw`SELECT 1`,
          warmPrisma.$executeRaw`SELECT 1`,
        ]);
      } finally {
        await warmPrisma.$disconnect().then(() => warmPool.end());
      }

      for (let i = 0; i < ITERS; i++) {
        // Per-iter unique blobs so cross-iter ambiguity is impossible
        const v0 = `v0-iter${i}-${randomBytes(4).toString("hex")}`;
        const vA = `vA-iter${i}-${randomBytes(4).toString("hex")}`;
        const vB = `vB-iter${i}-${randomBytes(4).toString("hex")}`;

        const entryId = await seedTeamEntry(v0);

        // Race A and B concurrently against the same entry.
        // updateTeamPassword uses the global prisma pool; two concurrent calls
        // acquire different connections and serialise at the FOR UPDATE row lock.
        await Promise.all([
          callUpdateTeamPassword(entryId, vA, v0),
          callUpdateTeamPassword(entryId, vB, v0),
        ]);

        // (a) exactly 2 history rows
        const hist = await fetchHistory(entryId);
        expect(hist).toHaveLength(2);

        // (b) content guard: snapshot blobs must be {v0, firstWriter}
        const blobs = new Set(hist.map((r) => r.encrypted_blob));
        expect(blobs.has(v0)).toBe(true);
        const firstWriter = hist.find((r) => r.encrypted_blob !== v0)?.encrypted_blob;
        expect(firstWriter).toBeDefined();
        expect(firstWriter).not.toBe(v0);
        expect([vA, vB]).toContain(firstWriter);

        // (c) final entry blob = the other writer
        const finalBlob = await fetchEntryBlob(entryId);
        const other = firstWriter === vA ? vB : vA;
        expect(finalBlob).toBe(other);

        // Track winner for RT4 both-outcomes check
        if (firstWriter === vA) bWins++;
        else aWins++;
      }

      // RT4: both outcomes must occur across 50 iters
      expect(aWins).toBeGreaterThan(0);
      expect(bWins).toBeGreaterThan(0);
    },
    // Generous timeout: 50 iters × real DB round-trips
    60_000,
  );

  // ─── SQL column validity (T2/RT1 for personal + v1 inline handlers) ────────

  it.skipIf(SKIP)(
    "SQL validity: personal/v1 SELECT … FOR UPDATE returns the 5 expected columns",
    async () => {
      // Seed a real password_entries row (personal vault)
      const entryId = randomUUID();
      const expectedBlob = `col-check-blob-${randomBytes(4).toString("hex")}`;
      const iv = randomBytes(12).toString("hex");
      const tag = randomBytes(16).toString("hex");

      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO password_entries (
             id, user_id, tenant_id,
             encrypted_blob, blob_iv, blob_auth_tag,
             encrypted_overview, overview_iv, overview_auth_tag,
             key_version, aad_version,
             created_at, updated_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid,
             $4, $5, $6,
             $7, $8, $9,
             3, 2, now(), now()
           )`,
          entryId, userId, tenantId,
          expectedBlob, iv, tag,
          "overview-placeholder", iv, tag,
        );
      });

      // Run the exact personal / v1 FOR UPDATE query using the app role with RLS GUC set.
      // This validates column names and ::uuid cast — typos that unit mocks cannot catch.
      const { prisma: appPrisma, pool: appPool } = createPrismaForRole("app");
      try {
        type PersonalBlobRow = {
          encrypted_blob: string;
          blob_iv: string;
          blob_auth_tag: string;
          key_version: number;
          aad_version: number;
        };

        const rows = await appPrisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          return tx.$queryRaw<PersonalBlobRow[]>`
            SELECT encrypted_blob, blob_iv, blob_auth_tag, key_version, aad_version
            FROM password_entries
            WHERE id = ${entryId}::uuid
            FOR UPDATE
          `;
        });

        expect(rows).toHaveLength(1);
        const row = rows[0];
        // Verify all 5 columns are present with correct values
        expect(row.encrypted_blob).toBe(expectedBlob);
        expect(row.blob_iv).toBe(iv);
        expect(row.blob_auth_tag).toBe(tag);
        expect(row.key_version).toBe(3);
        expect(row.aad_version).toBe(2);
      } finally {
        await appPrisma.$disconnect().then(() => appPool.end());
      }
    },
  );
});
