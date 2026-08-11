import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockAuth,
  mockAssertOrigin,
  mockRateLimiterCheck,
  mockCreateRateLimiter,
  mockRedisSet,
  mockSessionFindUnique,
  mockCredentialFindFirst,
  mockGenerateAuthenticationOpts,
  mockWithBypassRls,
  mockLogAudit,
} = vi.hoisted(() => {
  const mockRateLimiterCheck = vi.fn();
  return {
    mockAuth: vi.fn(),
    mockAssertOrigin: vi.fn(),
    mockRateLimiterCheck,
    mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockRateLimiterCheck, clear: vi.fn() })),
    mockRedisSet: vi.fn(),
    mockSessionFindUnique: vi.fn(),
    mockCredentialFindFirst: vi.fn(),
    mockGenerateAuthenticationOpts: vi.fn(),
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

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({ set: mockRedisSet }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: {
      findUnique: mockSessionFindUnique,
    },
    webAuthnCredential: {
      findFirst: mockCredentialFindFirst,
    },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
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

// A02-8: route now calls buildPrfExtensions; mock follows the same v1/v2
// convention used in other PRF-options test files.
vi.mock("@/lib/auth/webauthn/webauthn-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/webauthn/webauthn-server")>()),
  generateAuthenticationOpts: mockGenerateAuthenticationOpts,
  buildPrfExtensions: vi.fn(
    (creds: Array<{ credentialId: string; prfSalt: string | null }>) => {
      const hasV1 = creds.length === 0 || creds.some((c) => c.prfSalt === null);
      const hasV2 = creds.some((c) => c.prfSalt !== null);
      const result: { eval?: { first: string }; evalByCredential?: Record<string, { first: string }> } = {};
      if (hasV1) result.eval = { first: "a".repeat(64) };
      if (hasV2) {
        result.evalByCredential = {};
        for (const c of creds) {
          if (c.prfSalt) result.evalByCredential[c.credentialId] = { first: c.prfSalt };
        }
      }
      return result;
    },
  ),
  WEBAUTHN_CHALLENGE_TTL_SECONDS: 300,
}));

vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: unknown) => fn,
}));

import { POST } from "./route";

const rateLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const rateLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimiterCheck;
};

const ROUTE_URL = "http://localhost:3000/api/auth/passkey/reauth/options";

function makeRequest(cookie = "authjs.session-token=sess-1") {
  return createRequest("POST", ROUTE_URL, {
    headers: { origin: "http://localhost:3000", cookie },
  });
}

describe("POST /api/auth/passkey/reauth/options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockAssertOrigin.mockReturnValue(null);
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    // C3: the ALLOW path returns a session bound to a single credential —
    // the route must reach the verifier's ceremony, not fall through to a
    // fixture shape production can't produce.
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      authCredentialId: "cred-row-1",
    });
    mockCredentialFindFirst.mockResolvedValue({
      credentialId: "cred-1",
      transports: ["internal"],
      prfSalt: null,
    });
    mockGenerateAuthenticationOpts.mockResolvedValue({
      challenge: "challenge-1",
      rpId: "localhost",
    });
    mockWithBypassRls.mockImplementation(
      (prisma: unknown, fn: (tx: unknown) => unknown, _purpose: string) => fn(prisma),
    );
  });

  it("returns options and stores a dedicated reauth challenge", async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.options.challenge).toBe("challenge-1");
    expect(json.challengeId).toMatch(/^[0-9a-f]{32}$/);
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^webauthn:challenge:reauth:user-1:[0-9a-f]{32}$/),
      "challenge-1",
      "EX",
      300,
    );
    // A02-8: the route strips `prfSalt` from the credentials list before
    // calling `generateAuthenticationOpts` (the underlying simplewebauthn
    // helper doesn't take it). `prfSalt` is still consulted by
    // `buildPrfExtensions` to choose v1 vs v2 PRF salt.
    expect(mockGenerateAuthenticationOpts).toHaveBeenCalledWith([
      { credentialId: "cred-1", transports: ["internal"] },
    ]);
    // Allow side: zero denial audit rows (assert the count, or an added
    // emission is invisible).
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 401 when the request has no authenticated session", async  () => {
    mockAuth.mockResolvedValue(null);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(mockGenerateAuthenticationOpts).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("returns 401 when the session cookie is absent (no sessionToken)", async () => {
    const res = await POST(makeRequest(""));

    expect(res.status).toBe(401);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("returns 401 when the cookie is valid but the session row is missing (DB miss)", async () => {
    mockSessionFindUnique.mockResolvedValue(null);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limiter denies the request", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 60_000 });

    const res = await POST(makeRequest());

    expect(res.status).toBe(429);
    expect(mockGenerateAuthenticationOpts).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () => POST(makeRequest()),
      limiter: rateLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockRedisSet],
      limiterFactory: rateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  // ── C3: the ceremony must offer exactly the bound credential ──────────

  describe("C3 binding gate", () => {
    it("denies a non-webauthn session with SESSION_STEP_UP_REQUIRED, no challenge written", async () => {
      mockSessionFindUnique.mockResolvedValue({
        provider: "nodemailer",
        authCredentialId: null,
      });

      const res = await POST(makeRequest());

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "SESSION_STEP_UP_REQUIRED" });
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockGenerateAuthenticationOpts).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTH_PASSKEY_REAUTH_UNAVAILABLE",
          metadata: expect.objectContaining({ reason: "provider" }),
        }),
      );
    });

    it("denies a webauthn session with no binding, no challenge written", async () => {
      mockSessionFindUnique.mockResolvedValue({
        provider: "webauthn",
        authCredentialId: null,
      });

      const res = await POST(makeRequest());

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "PASSKEY_REAUTH_UNAVAILABLE" });
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockCredentialFindFirst).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTH_PASSKEY_REAUTH_UNAVAILABLE",
          metadata: expect.objectContaining({ reason: "no_binding" }),
        }),
      );
    });

    it("denies when the bound credential row was deleted, no challenge written", async () => {
      mockSessionFindUnique.mockResolvedValue({
        provider: "webauthn",
        authCredentialId: "cred-row-deleted",
      });
      mockCredentialFindFirst.mockResolvedValue(null);

      const res = await POST(makeRequest());

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "PASSKEY_REAUTH_UNAVAILABLE" });
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTH_PASSKEY_REAUTH_UNAVAILABLE",
          metadata: expect.objectContaining({ reason: "credential_missing" }),
        }),
      );
    });

    it("scopes the bound-credential lookup to this session's id AND this user (never widened by `?? undefined`)", async () => {
      await POST(makeRequest());

      expect(mockCredentialFindFirst).toHaveBeenCalledWith({
        where: { id: "cred-row-1", userId: "user-1" },
        select: { credentialId: true, transports: true, prfSalt: true },
      });
    });
  });

  // ── A02-8: v1/v2/mixed PRF extension shape (T07/T09) ──────────────────

  describe("A02-8 PRF extension shape", () => {
    it("(T09 legacy) sends top-level eval only when every credential has NULL prfSalt", async () => {
      mockCredentialFindFirst.mockResolvedValue({
        credentialId: "cred-1", transports: ["internal"], prfSalt: null,
      });
      const res = await POST(makeRequest());
      const json = (await res.json()) as { options: { extensions?: { prf?: { eval?: { first?: string }; evalByCredential?: Record<string, unknown> } } } };
      expect(res.status).toBe(200);
      expect(json.options.extensions?.prf?.eval?.first).toBeDefined();
      expect(json.options.extensions?.prf?.evalByCredential).toBeUndefined();
    });

    it("(T07 all-v2) sends evalByCredential keyed by credential ids when prfSalt is set", async () => {
      mockCredentialFindFirst.mockResolvedValue({
        credentialId: "cred-A", transports: ["internal"], prfSalt: "a".repeat(64),
      });
      const res = await POST(makeRequest());
      const json = (await res.json()) as { options: { extensions?: { prf?: { eval?: unknown; evalByCredential?: Record<string, unknown> } } } };
      expect(res.status).toBe(200);
      expect(json.options.extensions?.prf?.eval).toBeUndefined();
      expect(json.options.extensions?.prf?.evalByCredential).toHaveProperty("cred-A");
    });
  });
});
