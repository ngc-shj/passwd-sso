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

// One "issue" = the api-keys CAS against a cap of MAX, mirroring the
// api_keys route (count non-revoked → if < MAX → create), optionally guarded by
// the same advisory lock the production fix adds. The cap in production counts
// `revoked_at IS NULL`, so this replica does too.
async function issueApiKey(
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
    const r: Array<{ n: bigint }> = await tx.$queryRawUnsafe(
      `SELECT count(*) n FROM api_keys
       WHERE user_id = $1::uuid AND revoked_at IS NULL`,
      userId,
    );
    const existing = Number(r[0].n);
    if (existing >= max) return; // cap reached — production throws + maps to 400
    // Widen the window so the un-serialized path reliably interleaves.
    await tx.$executeRawUnsafe(`SELECT pg_sleep(0.15)`);
    await tx.$executeRawUnsafe(
      `INSERT INTO api_keys
         (id, user_id, tenant_id, token_hash, prefix, name, scope, expires_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'api_XXXX', 'k', 'passwords:read',
               now() + interval '30 days', now())`,
      randomUUID(),
      userId,
      tenantId,
      randomUUID().replace(/-/g, ""),
    );
  });
}

async function activeApiKeyCount(ctx: TestContext, userId: string): Promise<number> {
  const r: Array<{ n: bigint }> = await ctx.su.prisma.$queryRawUnsafe(
    `SELECT count(*) n FROM api_keys WHERE user_id = $1::uuid AND revoked_at IS NULL`,
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

// The api_keys route (6th count-then-create site) uses a fixed cap
// (MAX_API_KEYS_PER_USER) and does NOT evict on overflow — it refuses the
// create. So the WITHOUT-lock race is: both read count < cap, both insert →
// the cap is exceeded. The WITH-lock case serializes: the loser blocks, then
// sees the winner's row and refuses → exactly the cap survives.
describe.skipIf(SKIP)("count-then-create TOCTOU — advisory lock (api_keys)", () => {
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

  // api_keys refuses (does not evict) on overflow, so both racers must start
  // from BELOW the cap to exhibit the race. Seed a user with zero active keys;
  // both racers read count=0 (< MAX=1) and both attempt to insert.
  async function seed(): Promise<void> {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  }

  it("WITHOUT the lock, two concurrent issues exceed the cap (proves the race is real)", async () => {
    await seed();
    await Promise.all([
      issueApiKey(a.prisma, userId, tenantId, MAX, false),
      issueApiKey(b.prisma, userId, tenantId, MAX, false),
    ]);
    // Both read count=0 (< MAX), both insert → 2 survive, exceeding MAX=1.
    expect(await activeApiKeyCount(ctx, userId)).toBeGreaterThan(MAX);
  });

  it("WITH the lock, two concurrent issues respect the cap (race closed)", async () => {
    await seed();
    await Promise.all([
      issueApiKey(a.prisma, userId, tenantId, MAX, true),
      issueApiKey(b.prisma, userId, tenantId, MAX, true),
    ]);
    // Winner reads count=0, inserts; loser blocks, then reads count=1 >= MAX and
    // refuses → exactly MAX survive.
    expect(await activeApiKeyCount(ctx, userId)).toBe(MAX);
  });
});
