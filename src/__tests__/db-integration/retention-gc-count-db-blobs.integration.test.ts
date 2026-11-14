/**
 * #1020 (C6): `--count-db-blobs` against real attachments rows, read as the
 * retention-gc worker role through countDbStoredAttachments — the function
 * the entrypoint calls.
 *
 * The database is shared with the other files, so the cells measure deltas:
 * the function's own counts before and after seeding, not absolute totals.
 * Each row sits in a tenant of its own (three tenants), so a count confined
 * to one tenant cannot pass.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { assertRlsApplies, createTestContext, inRetentionSweepTx, setBypassRlsGucs, type TestContext } from "./helpers";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { countDbStoredAttachments } from "@/workers/retention-gc-worker/sweep";
import { encodeObjectRef, MAX_OBJECT_REF_BYTES, newBlobGeneration } from "@/lib/blob-store/object-ref";

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

  it("counts a ciphertext row, an object-ref row and a row just over the bound as total +3, db_stored +2", async () => {
    // The principal is the worker role, which RLS applies to.
    await assertRlsApplies(ctx.retentionWorker.prisma);

    const before = await countDbStoredAttachments(ctx.retentionWorker.prisma);

    const ciphertext = randomBytes(256);
    const objectRef = Buffer.from(
      encodeObjectRef({ key: `personal/${randomUUID()}/${randomUUID()}/${newBlobGeneration()}.bin` }),
    );
    // Would decode as a ref; only its size makes it database-stored.
    const overBound = Buffer.from(
      JSON.stringify({ key: "k".repeat(MAX_OBJECT_REF_BYTES + 1 - '{"key":""}'.length) }),
      "utf8",
    );
    expect(overBound.length).toBe(MAX_OBJECT_REF_BYTES + 1);

    const tenantA = await seed(ciphertext);
    const tenantB = await seed(objectRef);
    await seed(overBound);
    expect(tenantA).not.toBe(tenantB);

    const after = await countDbStoredAttachments(ctx.retentionWorker.prisma);
    expect({ total: after.total - before.total, dbStored: after.dbStored - before.dbStored }).toEqual({ total: 3, dbStored: 2 });
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
