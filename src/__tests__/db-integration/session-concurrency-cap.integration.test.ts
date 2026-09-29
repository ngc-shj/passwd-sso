/**
 * passkey-signin-client-token-cascade (C1/C2) — real-DB integration tests.
 *
 * C1 — `createCappedSession` (src/lib/auth/session/session-
 * concurrency.ts), the shared Web-session creator the Auth.js adapter and the
 * passkey sign-in route both delegate to:
 *   - Concurrency: the count-then-evict-then-create sequence is serialized by
 *     `advisoryXactLock`, so N concurrent sign-ins for one user never leave
 *     more than the tenant's `maxConcurrentSessions` live rows.
 *   - Ordering regression (F3-adj-1): eviction orders by `createdAt asc, id
 *     asc`, not `id asc` — `Session.id` is `uuid(4)` (random), so the old
 *     ordering could evict the wrong (non-oldest) session.
 *
 * C2 — `POST /api/auth/passkey/verify` no longer cascades: a successful
 * passkey sign-in must not revoke the user's other bearer credentials or Web
 * sessions (supersedes owasp-batch-3 C7).
 *
 * Mocking policy for the C2 case mirrors long-lived-client-login
 * (client-token-presence.integration.test.ts): rate limiter and app-origin
 * are stubbed (not the focus), `@simplewebauthn/server`'s
 * `verifyAuthenticationResponse` is mocked (importOriginal spread — VE1, no
 * physical authenticator in this harness), and `@/lib/redis` is replaced with
 * an in-memory fake so the WebAuthn challenge round-trip (store → getdel) is
 * real without a live Redis. Everything else — Prisma, `withBypassRls`, the
 * credential lookup, the counter CAS, session creation, audit — is real.
 *
 * Run:
 *   npx vitest run --config vitest.integration.config.ts session-concurrency-cap
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { createCappedSession } from "@/lib/auth/session/session-concurrency";
import { hashSessionToken } from "@/lib/auth/session/session-cache";

// ── C2 mocks (route-level case only) ────────────────────────────

const { mockVerifyAuthenticationResponse, mockRedisStore } = vi.hoisted(() => ({
  mockVerifyAuthenticationResponse: vi.fn(),
  mockRedisStore: new Map<string, string>(),
}));

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return { ...actual, verifyAuthenticationResponse: mockVerifyAuthenticationResponse };
});

// In-memory stand-in for Redis: only `getdel` (challenge consumption) is on
// this route's path. Backed by a real Map so store → getdel is a genuine
// round trip, not a stubbed constant.
vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    getdel: async (key: string) => {
      const v = mockRedisStore.get(key);
      mockRedisStore.delete(key);
      return v ?? null;
    },
  }),
  validateRedisConfig: () => {},
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: vi.fn().mockResolvedValue({ allowed: true }),
    clear: vi.fn(),
  }),
}));

vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: unknown) => fn,
}));

vi.mock("@/lib/url-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/url-helpers")>();
  return { ...actual, getAppOrigin: () => "http://localhost:3000" };
});

import { POST as passkeyVerifyPOST } from "@/app/api/auth/passkey/verify/route";

function randomTokenHash(): string {
  return randomBytes(32).toString("hex");
}

async function setMaxConcurrentSessions(ctx: TestContext, tenantId: string, max: number | null) {
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE tenants SET max_concurrent_sessions = $2 WHERE id = $1::uuid`,
      tenantId,
      max,
    );
  });
}

async function liveSessionCount(ctx: TestContext, userId: string): Promise<number> {
  const rows = await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM sessions WHERE user_id = $1::uuid AND expires > now()`,
      userId,
    );
  });
  return Number(rows[0]!.count);
}

async function sessionDigestExists(ctx: TestContext, digest: string): Promise<boolean> {
  const rows = await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.session.findMany({ where: { sessionToken: digest }, select: { id: true } });
  });
  return rows.length > 0;
}

describe("session-concurrency-cap — real-DB integration (C1)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  });
  afterEach(async () => {
    // Sessions go with the user rows: Session.user is onDelete: Cascade
    // (session-create-cold-timeout-cache.integration.test.ts's precedent).
    await ctx.deleteTestData(tenantId);
  });

  it("N concurrent createCappedSession calls leave at most maxConcurrentSessions live rows", async () => {
    await setMaxConcurrentSessions(ctx, tenantId, 2);

    const N = 8;
    const rawTokens = Array.from({ length: N }, (_, i) => `conc-${i}-${randomUUID()}`);

    const results = await Promise.all(
      rawTokens.map((sessionToken) =>
        createCappedSession({
          userId,
          tenantId,
          sessionToken,
          expires: new Date(Date.now() + 3_600_000),
          ip: null,
          userAgent: null,
          acceptLanguage: null,
          provider: "google",
        }),
      ),
    );

    // All N calls resolved — proves they were created and then contended,
    // not merely rejected/skipped.
    expect(results).toHaveLength(N);

    // Eviction hard-deletes rows, so the lower bound is read from the digests
    // themselves: more than `maxSessions` of the known tokens must now be
    // absent.
    const presence = await Promise.all(
      rawTokens.map((t) => sessionDigestExists(ctx, hashSessionToken(t))),
    );
    const absentCount = presence.filter((exists) => !exists).length;
    expect(absentCount).toBeGreaterThan(2);

    const liveCount = await liveSessionCount(ctx, userId);
    expect(liveCount).toBeLessThanOrEqual(2);
  });

  // F3-adj-1: Session.id is uuid(4) (random), so ordering eviction by `id asc`
  // picks an arbitrary row, not the oldest one. This seeds three sessions
  // whose id order is the OPPOSITE of their createdAt order and asserts the
  // genuinely-oldest one (by createdAt) is evicted — which fails against the
  // pre-fix `orderBy: { id: "asc" }` (that code evicts the row with the
  // LOWEST id, i.e. session A below, which is actually the NEWEST).
  it("evicts the earliest-createdAt session, not the lowest-id one, when the cap is reached", async () => {
    await setMaxConcurrentSessions(ctx, tenantId, 3);

    const now = Date.now();
    // ids chosen so id-asc order (A, B, C) is the reverse of createdAt-asc
    // order (C, B, A).
    const sessionA = { id: "00000000-0000-4000-8000-000000000001", raw: `seed-a-${randomUUID()}`, createdAt: new Date(now) };
    const sessionB = { id: "00000000-0000-4000-8000-000000000002", raw: `seed-b-${randomUUID()}`, createdAt: new Date(now - 2 * 60_000) };
    const sessionC = { id: "00000000-0000-4000-8000-000000000003", raw: `seed-c-${randomUUID()}`, createdAt: new Date(now - 5 * 60_000) };

    for (const s of [sessionA, sessionB, sessionC]) {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', $5, $5)`,
          s.id,
          hashSessionToken(s.raw),
          userId,
          tenantId,
          s.createdAt,
        );
      });
    }

    const newRaw = `seed-new-${randomUUID()}`;
    await createCappedSession({
      userId,
      tenantId,
      sessionToken: newRaw,
      expires: new Date(Date.now() + 3_600_000),
      ip: null,
      userAgent: null,
      acceptLanguage: null,
      provider: "google",
    });

    // The genuinely oldest (C) is gone; the other two, and the new one, survive.
    expect(await sessionDigestExists(ctx, hashSessionToken(sessionC.raw))).toBe(false);
    expect(await sessionDigestExists(ctx, hashSessionToken(sessionA.raw))).toBe(true);
    expect(await sessionDigestExists(ctx, hashSessionToken(sessionB.raw))).toBe(true);
    expect(await sessionDigestExists(ctx, hashSessionToken(newRaw))).toBe(true);
  });
});

describe("POST /api/auth/passkey/verify — real-DB integration (C2, no cascade)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    vi.stubEnv("WEBAUTHN_RP_ID", "localhost");
    vi.stubEnv("WEBAUTHN_RP_ORIGIN", "http://localhost:3000");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await ctx.cleanup();
  });
  beforeEach(async () => {
    mockRedisStore.clear();
    tenantId = await ctx.createTenant();
    // The route's SSO tenant guard admits bootstrap tenants only.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(`UPDATE tenants SET is_bootstrap = true WHERE id = $1::uuid`, tenantId);
    });
    userId = await ctx.createUser(tenantId);
    // Pin the precondition this block depends on: no session cap, so any
    // session that disappears was revoked by the sign-in, not evicted.
    await setMaxConcurrentSessions(ctx, tenantId, null);
  });
  afterEach(async () => {
    // Extension tokens FK-Restrict their tenant; drop them before
    // deleteTestData()'s tenant/user cleanup (mirrors client-token-presence
    // and client-token-family-cap).
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM extension_tokens WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  async function insertCredential(credentialId: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO webauthn_credentials (
           id, user_id, tenant_id, credential_id, public_key, device_type, counter, created_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 0, now())`,
        id,
        userId,
        tenantId,
        credentialId,
        "AQID",
        "singleDevice",
      );
    });
    return id;
  }

  async function insertExtensionTokenFamily(clientKind: "BROWSER_EXTENSION" | "IOS_APP"): Promise<string> {
    const familyId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO extension_tokens (
           id, user_id, tenant_id, token_hash, scope, expires_at, created_at,
           family_id, family_created_at, client_kind, cnf_jkt, last_presence_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, now() + interval '1 day', now(),
           $6::uuid, now(), $7::"ExtensionTokenClientKind", $8, now())`,
        randomUUID(),
        userId,
        tenantId,
        randomTokenHash(),
        "passwords:read",
        familyId,
        clientKind,
        "A".repeat(43),
      );
    });
    return familyId;
  }

  async function insertSecondWebSession(): Promise<{ raw: string }> {
    const raw = `web-${randomUUID()}`;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at, provider)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now(), $5)`,
        randomUUID(),
        hashSessionToken(raw),
        userId,
        tenantId,
        "google",
      );
    });
    return { raw };
  }

  async function activeFamilyRowCount(familyId: string): Promise<number> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.extensionToken.findMany({
        where: { familyId, revokedAt: null },
        select: { id: true },
      });
    });
    return rows.length;
  }

  function buildVerifyRequest(credentialId: string, challengeId: string): NextRequest {
    return new NextRequest("http://localhost:3000/api/auth/passkey/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        credentialResponse: JSON.stringify({ id: credentialId, type: "public-key" }),
        challengeId,
      }),
    });
  }

  it("a successful passkey sign-in leaves an active extension family, an active iOS family and a second Web session untouched", async () => {
    const credentialId = `cred-${randomUUID()}`;
    await insertCredential(credentialId);

    const extensionFamilyId = await insertExtensionTokenFamily("BROWSER_EXTENSION");
    const iosFamilyId = await insertExtensionTokenFamily("IOS_APP");
    const { raw: webSessionRaw } = await insertSecondWebSession();

    // Pre-conditions: both families genuinely active, the Web session genuinely present.
    expect(await activeFamilyRowCount(extensionFamilyId)).toBe(1);
    expect(await activeFamilyRowCount(iosFamilyId)).toBe(1);
    expect(await sessionDigestExists(ctx, hashSessionToken(webSessionRaw))).toBe(true);

    mockVerifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: credentialId,
        newCounter: 1,
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        origin: "http://localhost:3000",
        rpID: "localhost",
      },
    } satisfies Awaited<ReturnType<typeof mockVerifyAuthenticationResponse>>);

    const challengeId = randomBytes(16).toString("hex");
    mockRedisStore.set(`webauthn:challenge:signin:${challengeId}`, "test-challenge");

    const res = await passkeyVerifyPOST(buildVerifyRequest(credentialId, challengeId));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);

    // All three pre-existing credentials survive.
    expect(await activeFamilyRowCount(extensionFamilyId)).toBe(1);
    expect(await activeFamilyRowCount(iosFamilyId)).toBe(1);
    expect(await sessionDigestExists(ctx, hashSessionToken(webSessionRaw))).toBe(true);

    // ...and a new, third session (the passkey one) was created alongside them.
    expect(await liveSessionCount(ctx, userId)).toBe(2);
    const newSession = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.session.findFirst({
        where: { userId, provider: "webauthn" },
        select: { passkeyVerifiedAt: true, authCredentialId: true },
      });
    });
    expect(newSession?.passkeyVerifiedAt).not.toBeNull();
    expect(newSession?.authCredentialId).not.toBeNull();
  });
});
