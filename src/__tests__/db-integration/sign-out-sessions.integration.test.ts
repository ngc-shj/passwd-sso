/**
 * Sign-out revokes every session the browser held (issue #962) — real-DB.
 *
 * Auth.js revokes the session of the first cookie it reads; a browser holding
 * both CHIPS variants of the session cookie (or an older cookie name) names
 * more. `events.signOut` hands those tokens to `revokeSignedOutUserSessions`
 * with the signed-out user's id. The ownership condition is part of the
 * DELETE, so this runs against the real table: two sessions of the user go,
 * another user's session named by a cookie in the same request stays.
 *
 * Run:
 *   npx vitest run --config vitest.integration.config.ts sign-out-sessions
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { revokeSignedOutUserSessions } from "@/lib/auth/session/sign-out-sessions";

async function seedSession(ctx: TestContext, userId: string, tenantId: string): Promise<string> {
  const raw = randomUUID();
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
      randomUUID(),
      hashSessionToken(raw),
      userId,
      tenantId,
    );
  });
  return raw;
}

async function sessionExists(ctx: TestContext, raw: string): Promise<boolean> {
  const rows = await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.session.findMany({
      where: { sessionToken: hashSessionToken(raw) },
      select: { id: true },
    });
  });
  return rows.length > 0;
}

describe("revokeSignedOutUserSessions — real-DB integration", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    otherUserId = await ctx.createUser(tenantId);
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  it("revokes both of the user's sessions and leaves another user's session named in the same request", async () => {
    const partitioned = await seedSession(ctx, userId, tenantId);
    const unpartitioned = await seedSession(ctx, userId, tenantId);
    const foreign = await seedSession(ctx, otherUserId, tenantId);
    const otherDevice = await seedSession(ctx, userId, tenantId);

    await revokeSignedOutUserSessions(userId, [partitioned, unpartitioned, foreign]);

    expect(await sessionExists(ctx, partitioned)).toBe(false);
    expect(await sessionExists(ctx, unpartitioned)).toBe(false);
    expect(await sessionExists(ctx, foreign)).toBe(true);
    // A session the request did not name (another device) is untouched.
    expect(await sessionExists(ctx, otherDevice)).toBe(true);
  });
});
