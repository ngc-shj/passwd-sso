/**
 * #1020 (C6): `--count-db-blobs` against real attachments rows, read as the
 * retention-gc worker role through countDbStoredAttachments — the function
 * the entrypoint calls.
 *
 * The database is shared with the other files, so the cells measure deltas:
 * the function's own counts before and after seeding, not absolute totals.
 * Each row sits in a tenant of its own (five tenants), so a count confined
 * to one tenant cannot pass.
 *
 * The rows straddle the SQL size bound (MAX_OBJECT_REF_BYTES): a row over it
 * is counted database-stored by SQL alone, a row of exactly the bound is read
 * and judged by decodeObjectRef — this file, not the unit fake, is the
 * authority on what the real comparison does at the boundary.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  assertRlsApplies,
  createTestContext,
  inRetentionSweepTx,
  retentionGcConnectionString,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { countDbStoredAttachments } from "@/workers/retention-gc-worker/sweep";
import { encodeObjectRef, MAX_OBJECT_REF_BYTES, newBlobGeneration } from "@/lib/blob-store/object-ref";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const WRAPPER = '{"key":""}'.length;

describe("countDbStoredAttachments under the retention-gc role (#1020)", () => {
  let ctx: TestContext;
  const tenants: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    if (ctx) {
      for (const tenantId of tenants) await ctx.deleteTestData(tenantId);
      await ctx.cleanup();
    }
  });

  /** A personal entry in a fresh tenant with one attachments row holding `stored`. */
  async function seed(stored: Buffer): Promise<string> {
    const tenantId = await ctx.createTenant();
    tenants.push(tenantId);
    const userId = await ctx.createUser(tenantId);
    const entryId = randomUUID();
    const attId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO password_entries (id, user_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag, key_version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'b', 'iv', 'tag', 'o', 'oiv', 'otag', 1, now(), now())`,
        entryId, userId, tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO attachments (id, filename, content_type, size_bytes, encrypted_data, iv, auth_tag, key_version,
           encryption_mode, tenant_id, password_entry_id, created_by_id, created_at)
         VALUES ($1::uuid, 'a.bin', 'application/octet-stream', $2, $3, 'iv', 'tag', 1, 0, $4::uuid, $5::uuid, $6::uuid, now())`,
        attId, stored.length, stored, tenantId, entryId, userId,
      );
    });
    return tenantId;
  }

  it("counts rows on both sides of the size bound: total +5, db_stored +3", async () => {
    // The principal is the worker role, which RLS applies to.
    await assertRlsApplies(ctx.retentionWorker.prisma);

    const before = await countDbStoredAttachments(ctx.retentionWorker.prisma);

    // Database-stored: attachment bytes, small.
    const ciphertext = randomBytes(256);
    // Not database-stored: a typical ref.
    const objectRef = Buffer.from(
      encodeObjectRef({ key: `personal/${randomUUID()}/${randomUUID()}/${newBlobGeneration()}.bin` }),
    );
    // Not database-stored: the largest ref encodeObjectRef writes, exactly at
    // the bound, so the page read must include it.
    const maximalRef = Buffer.from(encodeObjectRef({ key: "a".repeat(MAX_OBJECT_REF_BYTES - WRAPPER) }));
    expect(maximalRef.length).toBe(MAX_OBJECT_REF_BYTES);
    // Database-stored: attachment bytes of exactly the bound, read and judged.
    const atBoundBlob = Buffer.alloc(MAX_OBJECT_REF_BYTES, 0xff);
    // Database-stored: one byte over. It would decode as a ref; only its size
    // makes it database-stored.
    const overBound = Buffer.from(JSON.stringify({ key: "k".repeat(MAX_OBJECT_REF_BYTES + 1 - WRAPPER) }), "utf8");
    expect(overBound.length).toBe(MAX_OBJECT_REF_BYTES + 1);

    for (const stored of [ciphertext, objectRef, maximalRef, atBoundBlob, overBound]) await seed(stored);
    expect(new Set(tenants).size).toBe(5);

    const after = await countDbStoredAttachments(ctx.retentionWorker.prisma);
    // total: the five rows. db_stored: ciphertext, atBoundBlob, overBound.
    expect({ total: after.total - before.total, dbStored: after.dbStored - before.dbStored }).toEqual({ total: 5, dbStored: 3 });
  });

  it("--count-db-blobs on the worker entrypoint prints one line agreeing with the function", async () => {
    // Seeded by the cell above (or seeded here when run alone).
    if (tenants.length === 0) await seed(randomBytes(64));
    const adjacentBefore = await countDbStoredAttachments(ctx.retentionWorker.prisma);
    const run = spawnSync("node_modules/.bin/tsx", [resolve(REPO_ROOT, "scripts/retention-gc-worker.ts"), "--count-db-blobs"], {
      // The worker role's URL, as production injects it; DATABASE_URL="" so a
      // local env file cannot supply a broader one.
      env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: "", RETENTION_GC_DATABASE_URL: retentionGcConnectionString() },
      encoding: "utf8",
      timeout: 60_000,
      cwd: REPO_ROOT,
    });
    const adjacentAfter = await countDbStoredAttachments(ctx.retentionWorker.prisma);

    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["db_stored", "level", "msg", "total"]);
    expect(out).toMatchObject({ level: "info", msg: "count-db-blobs" });
    // Nothing changed around the child's run, so its answer is the function's.
    expect(adjacentAfter).toEqual(adjacentBefore);
    expect(out.db_stored).toBe(adjacentBefore.dbStored);
    expect(out.total).toBe(adjacentBefore.total);
  });

  it("sees none of those rows as the same role without the bypass (the RLS positive control)", async () => {
    // Seeded by the cell above (or seeded here when run alone).
    if (tenants.length === 0) await seed(randomBytes(64));
    const count = (tx: Parameters<Parameters<typeof inRetentionSweepTx>[1]>[0]) =>
      tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM attachments WHERE tenant_id = ANY(${tenants}::uuid[])`;

    // Under the production grant the role sees every seeded row ...
    const [withBypass] = await inRetentionSweepTx(ctx.retentionWorker.prisma, count, BYPASS_GRANT.RETENTION_BLOB_ORPHAN_SWEEP);
    expect(Number(withBypass.n)).toBe(tenants.length);

    // ... and without it, scoped to a tenant that owns nothing, none.
    const [withoutBypass] = await ctx.retentionWorker.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${randomUUID()}, true)`;
      return count(tx);
    });
    expect(Number(withoutBypass.n)).toBe(0);
  });
});
