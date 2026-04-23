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
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockGetRedis: vi.fn(),
  mockRedisSet: vi.fn(),
  mockPrismaFindMany: vi.fn(),
  mockWithUserTenantRls: vi.fn(),
  mockGenerateRegistrationOpts: vi.fn(),
  mockDerivePrfSalt: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/rate-limit", () => ({
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
  generateRegistrationOpts: mockGenerateRegistrationOpts,
  derivePrfSalt: mockDerivePrfSalt,
}));

vi.mock("@/lib/with-request-log", () => ({
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

  it("returns registration options and prfSalt on success", async () => {
    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.options).toBeDefined();
    expect(json.options.challenge).toBe("test-challenge-base64url");
    expect(json.prfSupported).toBe(true);
    expect(json.prfSalt).toBe("prf-salt-hex");
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

  it("stores challenge in Redis with 300s TTL", async () => {
    const req = createRequest("POST", ROUTE_URL);
    await POST(req);

    expect(mockRedisSet).toHaveBeenCalledWith(
      "webauthn:challenge:register:user-1",
      "test-challenge-base64url",
      "EX",
      300,
    );
  });

  it("returns prfSupported=false and prfSalt=null when derivePrfSalt throws", async () => {
    mockDerivePrfSalt.mockImplementation(() => {
      throw new Error("PRF_SECRET not configured");
    });

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.prfSupported).toBe(false);
    expect(json.prfSalt).toBeNull();
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
