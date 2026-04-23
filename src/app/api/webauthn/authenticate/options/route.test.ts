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

vi.mock("@/lib/auth/webauthn-server", () => ({
  generateAuthenticationOpts: mockGenerateAuthenticationOpts,
  derivePrfSalt: mockDerivePrfSalt,
}));

vi.mock("@/lib/api-error-codes", () => ({
  API_ERROR: {
    UNAUTHORIZED: "UNAUTHORIZED",
    RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
    SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
    NOT_FOUND: "NOT_FOUND",
  },
}));

vi.mock("@/lib/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

import { POST } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/webauthn/authenticate/options";

const mockCredentials = [
  { credentialId: "cred-id-1", transports: ["internal", "hybrid"] },
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
});
