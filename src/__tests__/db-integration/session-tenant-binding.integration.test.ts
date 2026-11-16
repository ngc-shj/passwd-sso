/**
 * A session authenticates only in a tenant where its user holds an ACTIVE
 * membership (session-revocation-failure-surfaces, code review round 3 F1/F8).
 *
 * The adapter's `getSessionAndUser` is what every `auth()` resolves a cookie
 * through, so the binding is asserted there, against real rows: the unit test
 * mocks the session read and cannot show that the membership filter reaches
 * `tenant_members` or that `createSession` stamps the tenant the read compares.
 *
 * Deny: a session left under a tenant the user has departed, while they are
 * active in another — the residue an old release can still write during the
 * C9 rollout. Allow: an ordinary session, and one of a user whose
 * `User.tenantId` column names a different tenant than their active
 * membership (the binding is to the membership, never the column). The
 * bootstrap migration's moved session is asserted in
 * tenant-claim-binding.integration.test.ts, which drives that migration.
 *
 * Run: npm run test:integration -- session-tenant-binding
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { createCustomAdapter } from "@/lib/auth/session/auth-adapter";
import { hashSessionToken } from "@/lib/auth/session/session-cache";

describe("getSessionAndUser binds a session to its user's active membership (real DB)", () => {
  let ctx: TestContext;
  let tenantA: string;
  let tenantB: string;
  let userId: string;

  async function su(text: string, ...params: unknown[]): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(text, ...params);
    });
  }

  /** End the membership in A and make the user an active member of B; the column stays on A. */
  async function moveMembershipToB(): Promise<void> {
    await su(`UPDATE tenant_members SET deactivated_at = now() WHERE user_id = $1::uuid`, userId);
    await su(
      `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
      randomUUID(), tenantB, userId,
    );
  }

  /** A session row under `tenantId`, written the way an older release would have; returns its raw token. */
  async function seedSession(tenantId: string): Promise<string> {
    const raw = randomUUID();
    await su(
      `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
      randomUUID(), hashSessionToken(raw), userId, tenantId,
    );
    return raw;
  }

  /** A session created through the adapter, which stamps the tenant itself; returns its raw token. */
  async function createSession(): Promise<string> {
    const raw = randomUUID();
    await createCustomAdapter().createSession!({ sessionToken: raw, userId, expires: new Date(Date.now() + 60_000) });
    return raw;
  }

  async function tenantOfSession(raw: string): Promise<string | undefined> {
    const row = await ctx.su.prisma.session.findUnique({
      where: { sessionToken: hashSessionToken(raw) },
      select: { tenantId: true },
    });
    return row?.tenantId;
  }

  async function columnOf(): Promise<string> {
    const row = await ctx.su.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } });
    return row.tenantId;
  }

  const authenticate = (raw: string) => createCustomAdapter().getSessionAndUser!(raw);

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantA = await ctx.createTenant();
    tenantB = await ctx.createTenant();
    userId = await ctx.createUser(tenantA);
  });
  afterEach(async () => {
    // sessions -> tenants is RESTRICT and deleteTestData sweeps sessions only
    // through the users of the tenant it deletes; a session under B of a user
    // filed under A would block B's delete.
    await su(`DELETE FROM sessions WHERE user_id = $1::uuid`, userId);
    await ctx.deleteTestData(tenantB);
    await ctx.deleteTestData(tenantA);
  });

  it("authenticates a session created for an active member", async () => {
    const raw = await createSession();

    expect(await tenantOfSession(raw)).toBe(tenantA);
    expect(await authenticate(raw)).toMatchObject({ session: { sessionToken: raw, userId }, user: { id: userId } });
  });

  it("refuses a session under a tenant the user left while they are active in another", async () => {
    const residue = await seedSession(tenantA);
    await moveMembershipToB();
    // Positive control: the same user's session under B authenticates, so the
    // refusal is about the session's tenant and not the user.
    const current = await createSession();
    expect(await tenantOfSession(current)).toBe(tenantB);

    expect(await authenticate(residue)).toBeNull();
    expect(await authenticate(current)).toMatchObject({ session: { userId } });
  });

  it("refuses a session of a user active in no tenant", async () => {
    const residue = await seedSession(tenantA);
    await su(`UPDATE tenant_members SET deactivated_at = now() WHERE user_id = $1::uuid`, userId);

    expect(await authenticate(residue)).toBeNull();
  });

  it("authenticates a session of the active membership when the User.tenantId column names another tenant", async () => {
    await moveMembershipToB();
    expect(await columnOf()).toBe(tenantA);

    const raw = await createSession();

    expect(await tenantOfSession(raw)).toBe(tenantB);
    expect(await authenticate(raw)).toMatchObject({ session: { sessionToken: raw, userId }, user: { id: userId } });
  });
});
