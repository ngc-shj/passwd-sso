/**
 * `tenant_members_one_active_per_user` — the partial unique index that makes
 * "at most one ACTIVE membership per user" unrepresentable.
 *
 * Why this is an integration cell and can only be one: the invariant is enforced
 * by the database, below RLS, regardless of which context or writer issues the
 * INSERT. A mocked client cannot refuse anything, and the application guards
 * that used to be the only enforcement are exactly what this index makes
 * non-load-bearing — so a test that went through them would be testing the
 * guards again, not the constraint.
 *
 * The three cells are the boundary, not a sample: one active row is the state
 * the system runs in, a deactivated row alongside it is what "left and may
 * rejoin" needs, and the second active row is the state three separate readers
 * assert cannot happen (`resolveUserTenantIdFromClient` throws on it, and the
 * proxy auth gate reaches that on every request).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, sqlStateOf, type TestContext } from "./helpers";

const SKIP = !process.env.DATABASE_URL;

describe("one active membership per user is unrepresentable", () => {
  let ctx: TestContext;
  const created: string[] = [];

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });
  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });
  afterEach(async () => {
    if (SKIP) return;
    for (const tenantId of created.splice(0).reverse()) {
      await ctx.deleteTestData(tenantId);
    }
  });

  async function newTenant(): Promise<string> {
    const id = await ctx.createTenant();
    created.push(id);
    return id;
  }

  /** Insert a membership directly — no application guard in the path. */
  async function insertMembership(
    tenantId: string,
    userId: string,
    opts: { deactivated?: boolean } = {},
  ): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', $4, now(), now())`,
        randomUUID(),
        tenantId,
        userId,
        opts.deactivated ? new Date() : null,
      );
    });
  }

  it.skipIf(SKIP)("permits a DEACTIVATED membership beside the active one", async () => {
    // The allow half, and it comes first: an index that refused everything would
    // satisfy the deny cell below without enforcing anything about ACTIVE rows.
    // `ctx.createUser` already leaves one active membership in its own tenant.
    const home = await newTenant();
    const userId = await ctx.createUser(home);
    const other = await newTenant();

    await expect(insertMembership(other, userId, { deactivated: true })).resolves.toBeUndefined();
  });

  it.skipIf(SKIP)("refuses a SECOND active membership, from a raw write", async () => {
    const home = await newTenant();
    const userId = await ctx.createUser(home);
    const other = await newTenant();

    await expect(insertMembership(other, userId)).rejects.toSatisfy((e: unknown) => {
      // The SQLSTATE, not the message: a unique violation is 23505 whichever
      // index raised it, and naming the index is what says WHICH invariant held.
      expect(sqlStateOf(e)).toBe("23505");
      expect(String((e as Error).message)).toContain("tenant_members_one_active_per_user");
      return true;
    });
  });

  it.skipIf(SKIP)("permits reactivating after the other membership is deactivated", async () => {
    // The sequence the guard exists to allow: a user genuinely moving tenants.
    // Without this cell the index is indistinguishable from one that pins a user
    // to their first tenant forever.
    const home = await newTenant();
    const userId = await ctx.createUser(home);
    const other = await newTenant();

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenant_members SET deactivated_at = now() WHERE user_id = $1::uuid`,
        userId,
      );
    });

    await expect(insertMembership(other, userId)).resolves.toBeUndefined();
  });
});
