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
  mockGenerateAuthenticationOpts,
  mockDerivePrfSalt,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockGetRedis: vi.fn(),
  mockRedisSet: vi.fn(),
  mockPrismaFindMany: vi.fn(),
  mockWithUserTenantRls: vi.fn(),
  mockGenerateAuthenticationOpts: vi.fn(),
  mockDerivePrfSalt: vi.fn(),
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

// A02-8: route now calls buildPrfExtensions, not derivePrfSalt. The mock
// preserves the existing behavior (v1 RP-global salt as `eval.first`) for
// all-NULL prfSalt credential lists so the existing test fixtures keep
// passing; A02-8-specific cases override per-test if needed. The legacy
// `mockDerivePrfSalt` symbol is wired into the mock's v1 path so existing
// `mockDerivePrfSalt.mockImplementation(() => { throw … })` cases still
// route through the buildPrfExtensions PRF-disabled branch.
vi.mock("@/lib/auth/webauthn/webauthn-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/webauthn/webauthn-server")>()),
  generateAuthenticationOpts: mockGenerateAuthenticationOpts,
  buildPrfExtensions: vi.fn(
    (creds: Array<{ credentialId: string; prfSalt: string | null }>) => {
      // Drive PRF-disabled via the legacy mock so existing tests that stub
      // mockDerivePrfSalt.mockImplementation(() => throw) still pass.
      let v1: string;
      try {
        v1 = mockDerivePrfSalt();
      } catch {
        return null;
      }
      const hasV1 = creds.some((c) => c.prfSalt === null);
      const hasV2 = creds.some((c) => c.prfSalt !== null);
      const result: { eval?: { first: string }; evalByCredential?: Record<string, { first: string }> } = {};
      if (hasV1) result.eval = { first: v1 };
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

vi.mock("@/lib/http/api-error-codes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http/api-error-codes")>()),
}));

vi.mock("@/lib/http/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

import { POST } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/webauthn/authenticate/options";

const mockCredentials = [
  { credentialId: "cred-id-1", transports: ["internal", "hybrid"], prfSalt: null },
];

const mockOptions = {
  challenge: "test-challenge",
  rpId: "example.com",
  allowCredentials: [],
};

// ── Setup ────────────────────────────────────────────────────

describe("POST /api/webauthn/authenticate/options", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockGetRedis.mockReturnValue({ set: mockRedisSet });
    mockRedisSet.mockResolvedValue("OK");
    mockPrismaFindMany.mockResolvedValue(mockCredentials);
    mockGenerateAuthenticationOpts.mockResolvedValue(mockOptions);
    mockDerivePrfSalt.mockReturnValue("prf-salt-hex");
    mockWithUserTenantRls.mockImplementation(
      (_userId: string, fn: () => unknown) => fn(),
    );
  });

  // ── credentialId targeting ─────────────────────────────────

  describe("credentialId targeting", () => {
    it("filters by prfSupported when no credentialId provided", async () => {
      const req = createRequest("POST", ROUTE_URL);
      const { status } = await parseResponse(await POST(req));

      expect(status).toBe(200);
      expect(mockPrismaFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1", prfSupported: true },
        }),
      );
    });

    it("filters by specific credentialId when provided", async () => {
      const req = createRequest("POST", ROUTE_URL, {
        body: { credentialId: "target-cred-id" },
      });
      const { status } = await parseResponse(await POST(req));

      expect(status).toBe(200);
      expect(mockPrismaFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1", credentialId: "target-cred-id" },
        }),
      );
    });

    it("falls back to PRF-only when credentialId is non-string", async () => {
      const req = createRequest("POST", ROUTE_URL, {
        body: { credentialId: 12345 },
      });
      await POST(req);

      expect(mockPrismaFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1", prfSupported: true },
        }),
      );
    });

    it("falls back to PRF-only when body is empty", async () => {
      const req = createRequest("POST", ROUTE_URL, {
        body: {},
      });
      await POST(req);

      expect(mockPrismaFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1", prfSupported: true },
        }),
      );
    });

    it("accepts credentialId at max length (256)", async () => {
      const credentialId = "a".repeat(256);
      const req = createRequest("POST", ROUTE_URL, {
        body: { credentialId },
      });
      await POST(req);

      expect(mockPrismaFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1", credentialId },
        }),
      );
    });

    it("falls back to PRF-only when credentialId exceeds max length (257)", async () => {
      const credentialId = "a".repeat(257);
      const req = createRequest("POST", ROUTE_URL, {
        body: { credentialId },
      });
      await POST(req);

      expect(mockPrismaFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1", prfSupported: true },
        }),
      );
    });
  });

  // ── Auth & error handling ──────────────────────────────────

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when no matching credentials found", async () => {
    mockPrismaFindMany.mockResolvedValue([]);

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns options and prfSalt on success", async () => {
    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.options).toBeDefined();
    expect(json.prfSalt).toBe("prf-salt-hex");
  });

  it("returns a per-flow challengeId and stores the challenge under that scoped key", async () => {
    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.challengeId).toMatch(/^[0-9a-f]{32}$/);
    // Concurrent authenticate flows from the same user must not overwrite each
    // other: the Redis key carries both userId (scoping) and the challengeId.
    expect(mockRedisSet).toHaveBeenCalledWith(
      `webauthn:challenge:authenticate:user-1:${json.challengeId}`,
      expect.any(String),
      "EX",
      expect.any(Number),
    );
  });

  it("returns 429 with RATE_LIMIT_EXCEEDED when rate limit is exceeded", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false });

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 503 with SERVICE_UNAVAILABLE when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValue(null);

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(503);
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
  });

  it("returns 200 with prfSalt: null when derivePrfSalt throws", async () => {
    mockDerivePrfSalt.mockImplementation(() => {
      throw new Error("not configured");
    });

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.prfSalt).toBeNull();
  });

  // ── A02-8: v1/v2/mixed PRF extension shape (T07/T08/T09) ──────────────

  describe("A02-8 PRF extension shape", () => {
    it("(T09 legacy) sends top-level eval only when every credential has NULL prfSalt", async () => {
      mockPrismaFindMany.mockResolvedValue([
        { credentialId: "cred-1", transports: ["internal"], prfSalt: null },
      ]);
      const { status, json } = await parseResponse(await POST(createRequest("POST", ROUTE_URL)));
      expect(status).toBe(200);
      expect(json.options.extensions?.prf?.eval?.first).toBeDefined();
      expect(json.options.extensions?.prf?.evalByCredential).toBeUndefined();
    });

    it("(T07 all-v2) sends evalByCredential only when every credential has non-NULL prfSalt", async () => {
      mockPrismaFindMany.mockResolvedValue([
        { credentialId: "cred-A", transports: ["internal"], prfSalt: "a".repeat(64) },
      ]);
      const { status, json } = await parseResponse(await POST(createRequest("POST", ROUTE_URL)));
      expect(status).toBe(200);
      expect(json.options.extensions?.prf?.eval).toBeUndefined();
      expect(json.options.extensions?.prf?.evalByCredential).toHaveProperty("cred-A");
      expect(json.prfSalt).toBeNull();
    });

    it("(T07 mixed) sends BOTH top-level eval (for legacy creds) AND evalByCredential (for v2)", async () => {
      mockPrismaFindMany.mockResolvedValue([
        { credentialId: "cred-legacy", transports: ["usb"], prfSalt: null },
        { credentialId: "cred-v2", transports: ["internal"], prfSalt: "b".repeat(64) },
      ]);
      const { status, json } = await parseResponse(await POST(createRequest("POST", ROUTE_URL)));
      expect(status).toBe(200);
      expect(json.options.extensions?.prf?.eval?.first).toBeDefined();
      expect(json.options.extensions?.prf?.evalByCredential).toHaveProperty("cred-v2");
      expect(json.options.extensions?.prf?.evalByCredential).not.toHaveProperty("cred-legacy");
    });
  });
});
