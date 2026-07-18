import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockAssertOrigin,
  mockRateLimiterCheck,
  mockCreateRateLimiter,
  mockVerifyAuthenticationAssertion,
  mockSessionUpdate,
  mockPrismaTransaction,
  mockWithBypassRls,
  mockLogAudit,
} = vi.hoisted(() => {
  const mockRateLimiterCheck = vi.fn();
  return {
    mockAuth: vi.fn(),
    mockAssertOrigin: vi.fn(),
    mockRateLimiterCheck,
    // T4: recording factory so tests can attribute the limiter instance
    // back to the failClosedOnRedisError option it was constructed with.
    mockCreateRateLimiter: vi.fn(() => ({ check: mockRateLimiterCheck, clear: vi.fn() })),
    mockVerifyAuthenticationAssertion: vi.fn(),
    mockSessionUpdate: vi.fn(),
    mockPrismaTransaction: vi.fn(),
    mockWithBypassRls: vi.fn(),
    mockLogAudit: vi.fn(),
  };
});

vi.mock("@/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/auth/session/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));

vi.mock("@/lib/auth/webauthn/webauthn-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/webauthn/webauthn-server")>()),
  verifyAuthenticationAssertion: mockVerifyAuthenticationAssertion,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: null,
    userAgent: null,
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockPrismaTransaction,
    // The session mutation now runs directly on the withBypassRls callback's
    // tx (redundant inner $transaction removed), so the outer tx (this prisma
    // mock passed through by mockWithBypassRls) must carry session.update.
    session: { update: mockSessionUpdate },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: unknown) => fn,
}));

import { POST } from "./route";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const ROUTE_URL = "http://localhost:3000/api/auth/passkey/reauth/verify";

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

describe("POST /api/auth/passkey/reauth/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockAssertOrigin.mockReturnValue(null);
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockVerifyAuthenticationAssertion.mockResolvedValue({
      ok: true,
      credentialId: "cred-1",
      storedPrf: {
        encryptedSecretKey: null,
        iv: null,
        authTag: null,
      },
    });
    mockWithBypassRls.mockImplementation(
      (prisma: unknown, fn: (tx: unknown) => unknown, _purpose: string) => fn(prisma),
    );
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn({
        session: { update: mockSessionUpdate },
      }),
    );
    mockSessionUpdate.mockResolvedValue({});
  });

  it("updates passkey freshness on the current session", async () => {
    const res = await POST(
      createRequest("POST", ROUTE_URL, {
        headers: {
          origin: "http://localhost:3000",
          cookie: "authjs.session-token=sess-1",
          "Content-Type": "application/json",
        },
        body: {
          credentialResponse: JSON.stringify({ id: "cred-1", type: "public-key" }),
          challengeId: "a".repeat(32),
        },
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.verifiedAt).toEqual(expect.any(String));
    expect(mockVerifyAuthenticationAssertion).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining({ id: "cred-1" }),
      "webauthn:challenge:reauth:user-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(mockSessionUpdate).toHaveBeenCalledWith({
      where: { sessionToken: "sess-1" },
      data: { passkeyVerifiedAt: expect.any(Date) },
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUTH_PASSKEY_REAUTH",
        metadata: expect.objectContaining({
          credentialId: "cred-1",
        }),
      }),
    );
  });

  it("returns verification errors from the shared assertion helper", async () => {
    mockVerifyAuthenticationAssertion.mockResolvedValue({
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      details: "Credential not found",
    });

    const res = await POST(
      createRequest("POST", ROUTE_URL, {
        headers: {
          origin: "http://localhost:3000",
          cookie: "authjs.session-token=sess-1",
          "Content-Type": "application/json",
        },
        body: {
          credentialResponse: JSON.stringify({ id: "cred-1", type: "public-key" }),
          challengeId: "a".repeat(32),
        },
      }),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "NOT_FOUND",
      details: "Credential not found",
    });
  });

  it("returns 401 when the request has no authenticated session", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await POST(
      createRequest("POST", ROUTE_URL, {
        headers: {
          origin: "http://localhost:3000",
          cookie: "authjs.session-token=sess-1",
          "Content-Type": "application/json",
        },
        body: {
          credentialResponse: JSON.stringify({ id: "cred-1", type: "public-key" }),
          challengeId: "a".repeat(32),
        },
      }),
    );

    expect(res.status).toBe(401);
    expect(mockSessionUpdate).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 401 when the session cookie is absent (no sessionToken)", async () => {
    const res = await POST(
      createRequest("POST", ROUTE_URL, {
        headers: {
          origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: {
          credentialResponse: JSON.stringify({ id: "cred-1", type: "public-key" }),
          challengeId: "a".repeat(32),
        },
      }),
    );

    expect(res.status).toBe(401);
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limiter denies the request", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 60_000 });

    const res = await POST(
      createRequest("POST", ROUTE_URL, {
        headers: {
          origin: "http://localhost:3000",
          cookie: "authjs.session-token=sess-1",
          "Content-Type": "application/json",
        },
        body: {
          credentialResponse: JSON.stringify({ id: "cred-1", type: "public-key" }),
          challengeId: "a".repeat(32),
        },
      }),
    );

    expect(res.status).toBe(429);
    expect(mockVerifyAuthenticationAssertion).not.toHaveBeenCalled();
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      headers: {
        origin: "http://localhost:3000",
        cookie: "authjs.session-token=sess-1",
        "Content-Type": "application/json",
      },
      body: {
        credentialResponse: JSON.stringify({ id: "cred-1", type: "public-key" }),
        challengeId: "a".repeat(32),
      },
    });

    await assertRedisFailClosed({
      invoke: () => POST(req),
      limiter: rateLimiterInstance,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockSessionUpdate],
      limiterFactory: rateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });
});
