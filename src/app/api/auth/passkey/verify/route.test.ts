import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAssertOrigin,
  mockRateLimiterCheck,
  mockCreateRateLimiter,
  mockAuthorizeWebAuthn,
  mockLogAudit,
  mockPrismaFindUnique,
  mockPrismaTenantFindUnique,
  mockWithBypassRls,
  mockResolveEffectiveSessionTimeouts,
  mockCreateSessionUnderConcurrencyCap,
  mockReportSessionEviction,
} = vi.hoisted(() => {
  const mockRateLimiterCheck = vi.fn();
  return {
    mockAssertOrigin: vi.fn(),
    mockRateLimiterCheck,
    // T4: recording factory so tests can attribute a limiter instance back
    // to the failClosedOnRedisError option it was constructed with.
    mockCreateRateLimiter: vi.fn(() => ({ check: mockRateLimiterCheck, clear: vi.fn() })),
    mockAuthorizeWebAuthn: vi.fn(),
    mockLogAudit: vi.fn(),
    mockPrismaFindUnique: vi.fn(),
    mockPrismaTenantFindUnique: vi.fn(),
    mockWithBypassRls: vi.fn(),
    mockResolveEffectiveSessionTimeouts: vi.fn(),
    mockCreateSessionUnderConcurrencyCap: vi.fn(),
    mockReportSessionEviction: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/auth/session/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));

vi.mock("@/lib/auth/webauthn/webauthn-authorize", () => ({
  authorizeWebAuthn: mockAuthorizeWebAuthn,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({
    ip: null,
    userAgent: null,
    acceptLanguage: null,
  }),
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: null,
    userAgent: null,
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockPrismaFindUnique },
    // The tenant is loaded by id now, not traversed through `user.tenant`.
    tenant: { findUnique: mockPrismaTenantFindUnique },
  },
}));

vi.mock("@/lib/auth/session/session-timeout", () => ({
  resolveEffectiveSessionTimeouts: mockResolveEffectiveSessionTimeouts,
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/http/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

// C2: session creation is delegated to the C1 shared helper. Mocked here so
// this file tests the ROUTE's wiring (what it passes in, when it reports an
// eviction) — the helper's own cap/eviction/lock behavior is covered by
// session-concurrency.test.ts and the db-integration suite.
vi.mock("@/lib/auth/session/session-concurrency", () => ({
  createSessionUnderConcurrencyCap: mockCreateSessionUnderConcurrencyCap,
  reportSessionEviction: mockReportSessionEviction,
}));

import { POST } from "./route";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

// The route constructs its rate limiter once at module load
// (`const rateLimiter = createRateLimiter({...})`). `beforeEach` clears all
// mocks each test, wiping `mockCreateRateLimiter.mock.calls`/`.mock.results`
// — snapshotFactory captures the real construction call/result here (module
// scope, before any beforeEach runs) so `.replay()` can rebuild it after
// each clear for the fail-closed helper's identity-based attribution.
const rateLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const rateLimiterInstance = mockCreateRateLimiter.mock.results[0]?.value as
  | { check: typeof mockRateLimiterCheck }
  | undefined;
if (!rateLimiterInstance) {
  throw new Error(
    "route.test.ts: expected createRateLimiter to have been called once at module load",
  );
}

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/auth/passkey/verify";

const validBody = {
  credentialResponse: JSON.stringify({ id: "cred-1", type: "public-key" }),
  challengeId: "a".repeat(32),
};

const mockUser = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
  credentialRowId: "cred-uuid-1",
};

// Three reads now: email → id, then `resolveOwningTenantIdFromClient`'s select,
// then the tenant by id. The two user reads are keyed off the select so each
// returns only its own fields, as Prisma would. The membership must carry the
// tenant id — a column-only mock resolves through the FALLBACK, which is the
// stale value this bootstrap gate must never admit on.
//
// `membershipTenantId` defaults to `tenantId` so every existing cell keeps the
// agreeing fixture it was written against; only the divergent cell below splits
// them, and it supplies its own `isBootstrap` per id.
function seedUser(
  opts: { tenantId?: string; membershipTenantId?: string; isBootstrap?: boolean } = {},
) {
  const tenantId = opts.tenantId ?? "tenant-1";
  const membershipTenantId = opts.membershipTenantId ?? tenantId;
  mockPrismaFindUnique.mockImplementation(
    async ({ select }: { select: Record<string, unknown> }) =>
      "tenantMemberships" in select
        ? { tenantId, tenantMemberships: [{ tenantId: membershipTenantId }] }
        : { id: mockUser.id },
  );
  mockPrismaTenantFindUnique.mockResolvedValue({ isBootstrap: opts.isBootstrap ?? true });
}

// ── Setup ────────────────────────────────────────────────────

describe("POST /api/auth/passkey/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAssertOrigin.mockReturnValue(null);
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockAuthorizeWebAuthn.mockResolvedValue(mockUser);
    mockResolveEffectiveSessionTimeouts.mockResolvedValue({
      idleMinutes: 480,
      absoluteMinutes: 43200,
      tenantId: "tenant-1",
    });

    // withBypassRls: call the callback directly with the (mocked) prisma
    // client standing in for `tx` — createSessionUnderConcurrencyCap is
    // itself mocked, so nothing inspects the client's shape.
    mockWithBypassRls.mockImplementation(
      (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma),
    );

    // SSO tenant guard: user is in bootstrap tenant (allowed)
    seedUser();

    mockCreateSessionUnderConcurrencyCap.mockResolvedValue({
      session: { userId: "user-1", expires: new Date() },
      eviction: null,
    });
  });

  it("returns 200 with session cookie on success", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);

    // Session cookie set
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("authjs.session-token=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("calls authorizeWebAuthn with correct params", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(mockAuthorizeWebAuthn).toHaveBeenCalledWith({
      credentialResponse: validBody.credentialResponse,
      challengeId: validBody.challengeId,
    });
  });

  it("creates the session through createSessionUnderConcurrencyCap with the passkey fields (C1/C2)", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    // Two bypass scopes: the SSO tenant guard read, and the session mutation.
    expect(mockWithBypassRls).toHaveBeenCalledTimes(2);
    expect(mockCreateSessionUnderConcurrencyCap).toHaveBeenCalledOnce();

    const [, input] = mockCreateSessionUnderConcurrencyCap.mock.calls[0];
    expect(input).toEqual(
      expect.objectContaining({
        userId: "user-1",
        tenantId: "tenant-1",
        sessionToken: expect.any(String),
        expires: expect.any(Date),
        provider: "webauthn",
        passkeyVerifiedAt: expect.any(Date),
        authCredentialId: "cred-uuid-1",
      }),
    );
  });

  it("gates on and stamps the active membership, not the stale User.tenantId", async () => {
    // The cell above seeds the same id in both places, so `tenantId: "tenant-1"`
    // on the session row is satisfied by either source — it cannot distinguish
    // the membership from the column, and neither can the tenant read, which is
    // stubbed to one value for any id.
    //
    // Both ids are bootstrap here, deliberately: the point is not that the gate
    // refuses, but that the id it gated on is the id it then stamps. The route's
    // comment requires those to be the SAME value and the membership's — a
    // session filed under the stale tenant is one `/api/sessions` (which opens
    // the membership) can neither list nor revoke, while reporting success.
    seedUser({
      tenantId: "stale-home-tenant",
      membershipTenantId: "scim-provisioned-tenant",
      isBootstrap: true,
    });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const res = await POST(req);

    // Positive first: sign-in completed. A route that rejected everything would
    // satisfy the two pins below by never reaching the session write.
    expect(res.status).toBe(200);
    expect(mockPrismaTenantFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "scim-provisioned-tenant" } }),
    );
    const [, input] = mockCreateSessionUnderConcurrencyCap.mock.calls[0];
    expect(input).toEqual(
      expect.objectContaining({
        userId: "user-1",
        tenantId: "scim-provisioned-tenant",
      }),
    );
  });

  // C2: passkey sign-in no longer cascades — it matches the other sign-in
  // paths (supersedes owasp-batch-3 C7). Revocation belongs to secret-
  // changing ops and explicit sign-out, not to an ordinary sign-in.
  it("never emits a SESSION_REVOKE_ALL audit entry (no cascade)", async () => {
    mockCreateSessionUnderConcurrencyCap.mockResolvedValue({
      session: { userId: "user-1", expires: new Date() },
      eviction: {
        tenantId: "tenant-1",
        maxSessions: 1,
        evicted: [{ id: "old-s1", sessionToken: "old-digest", ipAddress: null, userAgent: null }],
      },
    });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    const revokeAllCalls = mockLogAudit.mock.calls.filter(
      (args: unknown[]) => (args[0] as { action: string }).action === "SESSION_REVOKE_ALL",
    );
    expect(revokeAllCalls).toHaveLength(0);
  });

  it("calls reportSessionEviction only after createSessionUnderConcurrencyCap's transaction resolves, when an eviction occurred", async () => {
    const eviction = {
      tenantId: "tenant-1",
      maxSessions: 1,
      evicted: [{ id: "old-s1", sessionToken: "old-digest", ipAddress: null, userAgent: null }],
    };
    // Track whether the surrounding withBypassRls callback is still "open"
    // (its promise unsettled) at the moment reportSessionEviction runs —
    // mirrors auth-adapter.test.ts's txOpen pattern.
    let txOpen = false;
    let reportedWhileTxOpen: boolean | null = null;
    mockWithBypassRls.mockImplementation(async (prisma: unknown, fn: (tx: unknown) => unknown) => {
      txOpen = true;
      try {
        return await fn(prisma);
      } finally {
        txOpen = false;
      }
    });
    mockCreateSessionUnderConcurrencyCap.mockResolvedValue({
      session: { userId: "user-1", expires: new Date() },
      eviction,
    });
    mockReportSessionEviction.mockImplementation(async () => {
      reportedWhileTxOpen = txOpen;
    });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(mockReportSessionEviction).toHaveBeenCalledWith(
      eviction,
      expect.objectContaining({ userId: "user-1" }),
    );
    expect(reportedWhileTxOpen).toBe(false);
  });

  it("does not call reportSessionEviction when no eviction occurred", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(mockReportSessionEviction).not.toHaveBeenCalled();
  });

  it("logs AUTH_LOGIN audit event on success", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "PERSONAL",
        action: "AUTH_LOGIN",
        userId: "user-1",
        ip: null,
        userAgent: null,
      }),
    );
  });

  it("returns 403 when origin is invalid", async () => {
    const { NextResponse } = await import("next/server");
    mockAssertOrigin.mockReturnValue(
      NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }),
    );

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://evil.com" },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      // checkIpRateLimit fails-open when extractClientIp returns null; provide an
      // IP so the limiter is actually consulted in this test.
      headers: { origin: "http://localhost:3000", "x-forwarded-for": "203.0.113.5" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      // checkIpRateLimit fails-open when extractClientIp returns null; provide
      // an IP so the limiter is actually consulted.
      headers: { origin: "http://localhost:3000", "x-forwarded-for": "203.0.113.5" },
    });

    await assertRedisFailClosed({
      invoke: () => POST(req),
      limiter: rateLimiterInstance,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockCreateSessionUnderConcurrencyCap],
      limiterFactory: rateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new (await import("next/server")).NextRequest(ROUTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: "not-json",
    } as ConstructorParameters<typeof import("next/server").NextRequest>[1]);
    const { status, json } = await parseResponse(await POST(req));

    // C8 migration: route now uses parseBody → INVALID_JSON for malformed body.
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 when credentialResponse is not a string", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: { credentialResponse: 123, challengeId: "a".repeat(32) },
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    // C8 migration: Zod schema rejects non-string with VALIDATION_ERROR.
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 401 when authorizeWebAuthn returns null", async () => {
    mockAuthorizeWebAuthn.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(401);
    expect(json.error).toBe("AUTHENTICATION_FAILED");
  });

  it("returns 401 for SSO tenant user (non-bootstrap)", async () => {
    seedUser({ tenantId: "tenant-sso", isBootstrap: false });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(401);
    expect(json.error).toBe("AUTHENTICATION_FAILED");
  });

  it("returns 401 when tenant relation is null (orphaned FK)", async () => {
    // The orphaned-FK arm is the separate tenant read returning null now.
    seedUser();
    mockPrismaTenantFindUnique.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));
    expect(status).toBe(401);
    expect(json.error).toBe("AUTHENTICATION_FAILED");
  });

  it("returns 401 when user not found in DB (null result)", async () => {
    mockPrismaFindUnique.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));
    expect(status).toBe(401);
    expect(json.error).toBe("AUTHENTICATION_FAILED");
  });

  it("returns 401 when user has no tenantId", async () => {
    // `User.tenantId` is NOT NULL, so the resolve yields null only when the row
    // itself is gone — the second read, by id, missing it.
    mockPrismaFindUnique.mockImplementation(
      async ({ select }: { select: Record<string, unknown> }) =>
        "tenantMemberships" in select ? null : { id: mockUser.id },
    );

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));
    expect(status).toBe(401);
    expect(json.error).toBe("AUTHENTICATION_FAILED");
  });

  it("includes PRF data in response when credential supports PRF", async () => {
    const prfData = {
      prfEncryptedSecretKey: "enc-key-hex",
      prfSecretKeyIv: "iv-hex",
      prfSecretKeyAuthTag: "tag-hex",
    };
    mockAuthorizeWebAuthn.mockResolvedValue({ ...mockUser, prf: prfData });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.prf).toEqual(prfData);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("omits PRF data when credential does not support PRF", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.prf).toBeUndefined();
  });

  it("propagates a throw from createSessionUnderConcurrencyCap without setting a session cookie", async () => {
    mockCreateSessionUnderConcurrencyCap.mockRejectedValue(new Error("tx rolled back"));

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await expect(POST(req)).rejects.toThrow("tx rolled back");
  });
});
