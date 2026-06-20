import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockRateLimiterCheck,
  mockGetRedis,
  mockRedisSet,
  mockPrismaFindMany,
  mockWithUserTenantRls,
  mockGenerateRegistrationOpts,
  mockDerivePrfSalt,
  mockDerivePrfSaltV2,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockGetRedis: vi.fn(),
  mockRedisSet: vi.fn(),
  mockPrismaFindMany: vi.fn(),
  mockWithUserTenantRls: vi.fn(),
  mockGenerateRegistrationOpts: vi.fn(),
  mockDerivePrfSalt: vi.fn(),
  mockDerivePrfSaltV2: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: mockGetRedis,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    webAuthnCredential: { findMany: mockPrismaFindMany },
  },
}));

vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

// A02-8: route calls derivePrfSaltV2 with a random per-credential salt.
// The mock is hoisted so tests can assert (a) input matches the salt stored
// in Redis (RT5 — production primitive call-path), (b) output is the value
// the route returns to the client. Tests stubbing PRF-disabled drive
// mockDerivePrfSaltV2.mockImplementation(() => { throw ... }) directly.
vi.mock("@/lib/auth/webauthn/webauthn-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/webauthn/webauthn-server")>()),
  generateRegistrationOpts: mockGenerateRegistrationOpts,
  derivePrfSaltV2: mockDerivePrfSaltV2,
}));

vi.mock("@/lib/http/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

import { POST } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/webauthn/register/options";

const mockOptions = {
  challenge: "test-challenge-base64url",
  rp: { name: "passwd-sso", id: "localhost" },
  user: { id: "user-1", name: "user@example.com", displayName: "user@example.com" },
  pubKeyCredParams: [],
  excludeCredentials: [],
  authenticatorSelection: { userVerification: "required" },
};

const existingCredentials = [
  { credentialId: "cred-id-1", transports: ["internal"] },
];

// ── Setup ────────────────────────────────────────────────────

describe("POST /api/webauthn/register/options", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuth.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockGetRedis.mockReturnValue({ set: mockRedisSet });
    mockRedisSet.mockResolvedValue("OK");
    mockPrismaFindMany.mockResolvedValue(existingCredentials);
    mockGenerateRegistrationOpts.mockResolvedValue(mockOptions);
    mockDerivePrfSalt.mockReturnValue("prf-salt-hex");
    // A02-8: mock derivePrfSaltV2 to deterministically echo the input
    // so RT5 tests can assert the cached salt matches the call argument.
    mockDerivePrfSaltV2.mockImplementation((perCredentialSalt: string) => {
      if (!/^[0-9a-f]{64}$/.test(perCredentialSalt)) {
        throw new Error("derivePrfSaltV2 (mock): bad hex");
      }
      return "v2-" + perCredentialSalt.slice(0, 60);
    });
    mockWithUserTenantRls.mockImplementation(
      (_userId: string, fn: () => unknown) => fn(),
    );
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });

    const req = createRequest("POST", ROUTE_URL);
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("returns 503 when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValue(null);

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(503);
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
  });

  it("returns registration options and v2 prfSalt on success", async () => {
    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.options).toBeDefined();
    expect(json.options.challenge).toBe("test-challenge-base64url");
    expect(json.prfSupported).toBe(true);
    // A02-8: response prfSalt is now derivePrfSaltV2(perCredentialSalt).
    // The mock returns a deterministic transform of the input, so we can
    // assert the response carries a v2-prefixed string.
    expect(json.prfSalt).toMatch(/^v2-[0-9a-f]{60}$/);
  });

  it("passes existing credentials to exclude re-registration", async () => {
    const req = createRequest("POST", ROUTE_URL);
    await POST(req);

    expect(mockGenerateRegistrationOpts).toHaveBeenCalledWith(
      "user-1",
      "user@example.com",
      [{ credentialId: "cred-id-1", transports: ["internal"] }],
    );
  });

  it("stores challenge + prfSalt envelope in Redis with 300s TTL", async () => {
    const req = createRequest("POST", ROUTE_URL);
    await POST(req);

    // A02-8: register-options caches a JSON envelope containing both challenge
    // AND the per-credential salt. The Redis key is scoped by a per-flow
    // challengeId (returned to the client) so concurrent register flows from the
    // same user don't overwrite each other; userId stays in the key for scoping.
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^webauthn:challenge:register:user-1:[0-9a-f]{32}$/),
      expect.any(String),
      "EX",
      300,
    );
    const envelope = JSON.parse(mockRedisSet.mock.calls[0][1] as string);
    expect(envelope.challenge).toBe("test-challenge-base64url");
    // RT5: the cached perCredentialSalt MUST be the same value passed to
    // derivePrfSaltV2, so the wrap-side salt and DB-side salt cannot diverge.
    expect(envelope.prfSalt).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the per-flow challengeId and stores it in the Redis key so concurrent flows don't collide", async () => {
    const { json } = await parseResponse(await POST(createRequest("POST", ROUTE_URL)));
    expect(json.challengeId).toMatch(/^[0-9a-f]{32}$/);
    // The key the challenge is stored under must carry that exact challengeId.
    const key = mockRedisSet.mock.calls[0][0] as string;
    expect(key).toBe(`webauthn:challenge:register:user-1:${json.challengeId}`);
  });

  it("returns prfSupported=false and prfSalt=null when PRF is disabled (derivePrfSaltV2 throws)", async () => {
    // A02-8: PRF-disabled drives `derivePrfSaltV2` throw directly (route no
    // longer imports v1 derivePrfSalt).
    mockDerivePrfSaltV2.mockImplementation(() => {
      throw new Error("PRF_SECRET not configured");
    });

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.prfSupported).toBe(false);
    expect(json.prfSalt).toBeNull();
  });

  it("(T01 RT5) caches the same perCredentialSalt that derivePrfSaltV2 receives + envelope stores it", async () => {
    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));
    expect(status).toBe(200);

    // The route calls derivePrfSaltV2 exactly once per request.
    expect(mockDerivePrfSaltV2).toHaveBeenCalledTimes(1);
    const calledWith = mockDerivePrfSaltV2.mock.calls[0][0] as string;
    expect(calledWith).toMatch(/^[0-9a-f]{64}$/);

    // The same value MUST be persisted in the Redis envelope.
    const envelope = JSON.parse(mockRedisSet.mock.calls[0][1] as string);
    expect(envelope.prfSalt).toBe(calledWith);

    // The response prfSalt is derivePrfSaltV2's return — distinct from the
    // cached perCredentialSalt (output ≠ input) so the wrap-side salt and
    // the DB-side salt cannot be swapped.
    expect(json.prfSalt).toBe("v2-" + calledWith.slice(0, 60));
  });

  it("uses email as userName when available", async () => {
    const req = createRequest("POST", ROUTE_URL);
    await POST(req);

    expect(mockGenerateRegistrationOpts).toHaveBeenCalledWith(
      "user-1",
      "user@example.com",
      expect.any(Array),
    );
  });

  it("falls back to name when email is not set", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1", name: "Alice" } });

    const req = createRequest("POST", ROUTE_URL);
    await POST(req);

    expect(mockGenerateRegistrationOpts).toHaveBeenCalledWith(
      "user-1",
      "Alice",
      expect.any(Array),
    );
  });

  it("falls back to userId when both email and name are absent", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });

    const req = createRequest("POST", ROUTE_URL);
    await POST(req);

    expect(mockGenerateRegistrationOpts).toHaveBeenCalledWith(
      "user-1",
      "user-1",
      expect.any(Array),
    );
  });

  it("checks rate limit with user-scoped key", async () => {
    const req = createRequest("POST", ROUTE_URL);
    await POST(req);

    expect(mockRateLimiterCheck).toHaveBeenCalledWith("rl:webauthn_reg_opts:user-1");
  });
});
