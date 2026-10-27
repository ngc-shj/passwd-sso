/**
 * Sessions named by the deleted session cookies are revoked (issue #962) —
 * real-DB.
 *
 * A CHIPS browser can hold the session cookie partitioned and unpartitioned.
 * Auth.js's sign-out revokes at most the first cookie's session, and none when
 * that row is already gone (its deleteSession throws P2025 and Auth.js skips
 * events.signOut). The sign-out route therefore revokes every configured-name
 * session the request named once Auth.js's own deletion line shows the
 * sign-out went through.
 *
 * Run:
 *   npx vitest run --config vitest.integration.config.ts revoke-presented-sessions
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { configuredSessionCookieName } from "@/lib/auth/session/cookie-name";
import { revokePresentedSessions } from "@/lib/auth/session/revoke-presented-sessions";

vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: unknown) => fn,
}));

// The real `next-auth` package imports `next/server`, which this suite's node
// resolver cannot load (see audit-sentinel-claim-denial.integration.test.ts).
// NextAuth's route handlers are `Auth(request, config)` from @auth/core with
// env defaults filled in, so they are rebuilt here from the app's own config
// (src/auth.ts: adapter, cookies, events) — Auth.js, the adapter and the
// database stay real.
vi.mock("next-auth", async () => {
  const { Auth } = await import("@auth/core");
  return {
    default: (config: import("@auth/core").AuthConfig) => {
      const handler = (req: Request) =>
        Auth(req, { ...config, secret: process.env.AUTH_SECRET, trustHost: true });
      return { handlers: { GET: handler, POST: handler }, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
    },
  };
});

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

describe("revokePresentedSessions — real-DB integration", () => {
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

  it("revokes every named session, whoever owns it, and leaves an unnamed one", async () => {
    const partitioned = await seedSession(ctx, userId, tenantId);
    const unpartitioned = await seedSession(ctx, otherUserId, tenantId);
    const otherDevice = await seedSession(ctx, userId, tenantId);

    await revokePresentedSessions([partitioned, unpartitioned, randomUUID()]);

    expect(await sessionExists(ctx, partitioned)).toBe(false);
    expect(await sessionExists(ctx, unpartitioned)).toBe(false);
    expect(await sessionExists(ctx, otherDevice)).toBe(true);
  });

  // S1: through the real route, Auth.js and the real adapter. The first
  // cookie's session is gone, so the adapter's deleteSession throws and
  // Auth.js skips events.signOut; the second cookie's live session must still
  // be revoked.
  it("sign-out revokes the second cookie's live session when the first cookie's session is gone", async () => {
    const name = configuredSessionCookieName();
    const gone = randomUUID();
    const live = await seedSession(ctx, userId, tenantId);
    const otherDevice = await seedSession(ctx, userId, tenantId);

    const route = await import("@/app/api/auth/[...nextauth]/route");
    const origin = new URL(process.env.AUTH_URL || "http://localhost:3000").origin;
    const csrf = await route.GET(new NextRequest(`${origin}/api/auth/csrf`));
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const csrfCookie = csrf.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");

    const res = await route.POST(
      new NextRequest(`${origin}/api/auth/signout`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${name}=${gone}; ${name}=${live}; ${csrfCookie}`,
        },
        body: new URLSearchParams({ csrfToken, callbackUrl: `${origin}/` }),
      }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie().some((line) => line.startsWith(`${name}=;`))).toBe(true);
    expect(await sessionExists(ctx, live)).toBe(false);
    expect(await sessionExists(ctx, otherDevice)).toBe(true);
  });
});
