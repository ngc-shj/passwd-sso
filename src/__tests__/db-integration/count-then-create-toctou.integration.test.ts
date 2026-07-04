/**
 * Real-DB proof that the per-user advisory lock closes the count-then-create
 * TOCTOU race that C-L1 fixes (session / bridge-code / extension-token /
 * mobile-token / file-send caps).
 *
 * The production sites all run `findMany(active) → evict oldest → create` (or
 * aggregate→check→create) inside an RLS transaction. Without serialization two
 * concurrent issues both read `count < max` and both create, exceeding the cap.
 * The fix prepends `SELECT pg_advisory_xact_lock(hashtext(userId))` so the loser
 * blocks until the winner commits, then sees the updated count.
 *
 * This test replicates the bridge-code CAS by hand (the production path is bound
 * to the singleton prisma and cannot be raced with two injected clients) and
 * races two distinct pooled clients. The WITHOUT-lock case is the mutation-kill:
 * it demonstrates the race is real, so the WITH-lock pass is meaningful.
 *
 * Gated on DATABASE_URL — skips on the no-DB CI job, runs on test:integration.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createTestContext, type TestContext } from "./helpers";

const SKIP = !process.env.DATABASE_URL;

// One "issue" = the bridge-code CAS against a cap of MAX, optionally guarded by
// the same advisory lock the production fix adds. Runs on the app role so RLS is
// live; bypass GUC is set so the cross-user count is visible (mirrors
// withBypassRls). A small sleep widens the count→create window to make the race
// deterministic without the lock.
async function issueBridgeCode(
  client: PrismaClient,
  userId: string,
  tenantId: string,
  max: number,
  useLock: boolean,
): Promise<void> {
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    if (useLock) {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1::text))`,
        userId,
      );
    }
    const active: Array<{ id: string }> = await tx.$queryRawUnsafe(
      `SELECT id FROM extension_bridge_codes
       WHERE user_id = $1::uuid AND expires_at > now()
       ORDER BY created_at ASC`,
      userId,
    );
    const overflow = active.length + 1 - max;
    if (overflow > 0) {
      const toRevoke = active.slice(0, overflow).map((r) => r.id);
      await tx.$executeRawUnsafe(
        `DELETE FROM extension_bridge_codes WHERE id = ANY($1::uuid[])`,
        toRevoke,
      );
    }
    // Widen the window so the un-serialized path reliably interleaves.
    await tx.$executeRawUnsafe(`SELECT pg_sleep(0.15)`);
    await tx.$executeRawUnsafe(
      `INSERT INTO extension_bridge_codes
         (id, code_hash, user_id, tenant_id, scope, expires_at, created_at, cnf_jkt)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'x', now() + interval '5 min', now(), 'jkt')`,
      randomUUID(),
      randomUUID().replace(/-/g, ""),
      userId,
      tenantId,
    );
  });
}

async function activeCount(ctx: TestContext, userId: string): Promise<number> {
  const r: Array<{ n: bigint }> = await ctx.su.prisma.$queryRawUnsafe(
    `SELECT count(*) n FROM extension_bridge_codes WHERE user_id = $1::uuid AND expires_at > now()`,
    userId,
  );
  return Number(r[0].n);
}

describe.skipIf(SKIP)("count-then-create TOCTOU — advisory lock", () => {
  let ctx: TestContext;
  let a: { prisma: PrismaClient };
  let b: { prisma: PrismaClient };
  let tenantId: string;
  let userId: string;
  const MAX = 1; // cap of 1 makes any second concurrent insert a violation

  beforeAll(async () => {
    ctx = await createTestContext();
    a = ctx.app;
    // A second independent app-role client/pool so the two issues race on
    // separate connections (Promise.all on one client would serialize).
    const { createPrismaForRole } = await import("./helpers");
    b = createPrismaForRole("app");
  });

  afterEach(async () => {
    if (tenantId) await ctx.deleteTestData(tenantId);
  });

  afterAll(async () => {
    await b.prisma.$disconnect();
    await ctx.cleanup();
  });

  async function seed(): Promise<void> {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    // Pre-seed one active code so the cap of 1 is already met.
    await ctx.su.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      await tx.$executeRawUnsafe(
        `INSERT INTO extension_bridge_codes
           (id, code_hash, user_id, tenant_id, scope, expires_at, created_at, cnf_jkt)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'x', now() + interval '5 min', now(), 'jkt')`,
        randomUUID(),
        randomUUID().replace(/-/g, ""),
        userId,
        tenantId,
      );
    });
  }

  it("WITHOUT the lock, two concurrent issues exceed the cap (proves the race is real)", async () => {
    await seed();
    await Promise.all([
      issueBridgeCode(a.prisma, userId, tenantId, MAX, false),
      issueBridgeCode(b.prisma, userId, tenantId, MAX, false),
    ]);
    // Both read [1 existing], both compute overflow=1, both evict the SAME one,
    // both insert → 2 survive, exceeding MAX=1.
    expect(await activeCount(ctx, userId)).toBeGreaterThan(MAX);
  });

  it("WITH the lock, two concurrent issues respect the cap (race closed)", async () => {
    await seed();
    await Promise.all([
      issueBridgeCode(a.prisma, userId, tenantId, MAX, true),
      issueBridgeCode(b.prisma, userId, tenantId, MAX, true),
    ]);
    // Winner evicts the pre-seeded one and inserts; loser blocks, then sees the
    // winner's row, evicts it, inserts → exactly MAX survive.
    expect(await activeCount(ctx, userId)).toBe(MAX);
  });
});
