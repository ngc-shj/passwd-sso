import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockAuth,
  mockRateLimiterCheck,
  mockCreateRateLimiter,
  mockGetRedis,
  mockRedisSet,
  mockPrismaCredential,
  mockWithUserTenantRls,
  mockGenerateAuthenticationOpts,
} = vi.hoisted(() => {
  const mockRateLimiterCheck = vi.fn();
  return {
    mockAuth: vi.fn(),
    mockRateLimiterCheck,
    // F: recording factory — assertRedisFailClosed's factory-attribution step
    // reads mockCreateRateLimiter.mock.{calls,results}.
    mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockRateLimiterCheck, clear: vi.fn() })),
    mockGetRedis: vi.fn(),
    mockRedisSet: vi.fn(),
    mockPrismaCredential: { findFirst: vi.fn() },
    mockWithUserTenantRls: vi.fn(),
    mockGenerateAuthenticationOpts: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));
vi.mock("@/lib/prisma", () => ({
  prisma: { webAuthnCredential: mockPrismaCredential },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/auth/webauthn/webauthn-server", () => ({
  generateAuthenticationOpts: mockGenerateAuthenticationOpts,
  // A02-8: buildPrfExtensions is invoked after the credential lookup. Default
  // to a v1-only response so existing tests pass; the A02-8-specific cases
  // override per-test.
  buildPrfExtensions: vi.fn((creds: Array<{ credentialId: string; prfSalt: string | null }>) => {
    const v1 = creds.some((c) => c.prfSalt === null);
    const v2 = creds.some((c) => c.prfSalt !== null);
    const result: { eval?: { first: string }; evalByCredential?: Record<string, { first: string }> } = {};
    if (v1) result.eval = { first: "a".repeat(64) };
    if (v2) {
      result.evalByCredential = {};
      for (const c of creds) {
        if (c.prfSalt) result.evalByCredential[c.credentialId] = { first: c.prfSalt };
      }
    }
    return result;
  }),
  WEBAUTHN_CHALLENGE_TTL_SECONDS: 300,
}));
vi.mock("@/lib/http/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

import { POST } from "./route";

// Module-level `rateLimiter = createRateLimiter(...)` runs at import time,
// above. Snapshot the recorded factory call now (module scope, before any
// test/beforeEach executes) — the global beforeEach's vi.clearAllMocks()
// would otherwise wipe mockCreateRateLimiter.mock.calls/.results before the
// first test runs.
const rateLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const rateLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimiterCheck;
};

const URL = "http://localhost:3000/api/webauthn/credentials/cred-row-1/prf/options";
const params = { params: Promise.resolve({ id: "cred-row-1" }) };

describe("POST /api/webauthn/credentials/[id]/prf/options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockGetRedis.mockReturnValue({ set: mockRedisSet });
    mockRedisSet.mockResolvedValue("OK");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockWithUserTenantRls.mockImplementation(async (_uid: string, fn: any) => fn());
    mockPrismaCredential.findFirst.mockResolvedValue({
      credentialId: "credential-id-base64url",
      transports: ["internal"],
      prfSalt: null,
    });
    mockGenerateAuthenticationOpts.mockResolvedValue({
      challenge: "fresh-challenge",
      allowCredentials: [{ id: "credential-id-base64url" }],
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL), params);
    expect(res.status).toBe(401);
    expect(mockGenerateAuthenticationOpts).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await POST(createRequest("POST", URL), params);
    expect(res.status).toBe(429);
    expect(mockGenerateAuthenticationOpts).not.toHaveBeenCalled();
  });

  it("returns 503 when Redis unavailable", async () => {
    mockGetRedis.mockReturnValue(null);
    const res = await POST(createRequest("POST", URL), params);
    expect(res.status).toBe(503);
  });

  it("fails closed (503, no mutation) when Redis rate-limit check errors", async () => {
    await assertRedisFailClosed({
      invoke: () => POST(createRequest("POST", URL), params),
      limiter: rateLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockRedisSet, mockPrismaCredential.findFirst],
      limiterFactory: rateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("returns 404 when credential not found / not owned by user", async () => {
    mockPrismaCredential.findFirst.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL), params);
    expect(res.status).toBe(404);
    expect(mockGenerateAuthenticationOpts).not.toHaveBeenCalled();
  });

  it("issues a challenge to the DEDICATED PRF Redis key (not the sign-in key)", async () => {
    const res = await POST(createRequest("POST", URL), params);
    expect(res.status).toBe(200);
    // Critical security invariant from #433/S-N1: the rebootstrap flow MUST
    // use a key namespace separate from sign-in's
    // `webauthn:challenge:authenticate:${userId}`. Mixing would let one flow
    // consume the other's challenge (race / DoS / replay).
    expect(mockRedisSet).toHaveBeenCalledWith(
      "webauthn:challenge:prf-rebootstrap:user-1",
      "fresh-challenge",
      "EX",
      300,
    );
  });

  it("restricts allowCredentials to the URL [id] credential only", async () => {
    await POST(createRequest("POST", URL), params);
    expect(mockGenerateAuthenticationOpts).toHaveBeenCalledWith([
      { credentialId: "credential-id-base64url", transports: ["internal"] },
    ]);
  });

  // ── A02-8: per-credential salt (T07/T09) ──────────────────────────────

  describe("A02-8 PRF extension shape", () => {
    it("(T09 legacy) sends top-level eval only when the credential has NULL prfSalt", async () => {
      mockPrismaCredential.findFirst.mockResolvedValue({
        credentialId: "credential-id-base64url",
        transports: ["internal"],
        prfSalt: null,
      });
      const res = await POST(createRequest("POST", URL), params);
      const json = (await res.json()) as { options: { extensions?: { prf?: { eval?: { first?: string }; evalByCredential?: Record<string, unknown> } } } };
      expect(res.status).toBe(200);
      expect(json.options.extensions?.prf?.eval?.first).toBeDefined();
      expect(json.options.extensions?.prf?.evalByCredential).toBeUndefined();
    });

    it("(T07 v2) sends evalByCredential keyed by the credential id when prfSalt is set", async () => {
      mockPrismaCredential.findFirst.mockResolvedValue({
        credentialId: "credential-id-base64url",
        transports: ["internal"],
        prfSalt: "a".repeat(64),
      });
      const res = await POST(createRequest("POST", URL), params);
      const json = (await res.json()) as { options: { extensions?: { prf?: { eval?: unknown; evalByCredential?: Record<string, unknown> } } } };
      expect(res.status).toBe(200);
      expect(json.options.extensions?.prf?.eval).toBeUndefined();
      expect(json.options.extensions?.prf?.evalByCredential).toHaveProperty(
        "credential-id-base64url",
      );
    });
  });
});
