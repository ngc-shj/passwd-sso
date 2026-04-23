import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockGetRedis,
  mockRedisSet,
  mockRateLimiterCheck,
  mockGenerateDiscoverableAuthOpts,
  mockAssertOrigin,
} = vi.hoisted(() => ({
  mockGetRedis: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockGenerateDiscoverableAuthOpts: vi.fn(),
  mockAssertOrigin: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: mockGetRedis,
  validateRedisConfig: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck, clear: vi.fn() }),
}));

vi.mock("@/lib/auth/webauthn-server", () => ({
  generateDiscoverableAuthOpts: mockGenerateDiscoverableAuthOpts,
}));

vi.mock("@/lib/auth/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));

vi.mock("@/lib/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

import { POST } from "./route";

// ── Setup ────────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/auth/passkey/options";

describe("POST /api/auth/passkey/options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WEBAUTHN_RP_ID", "localhost");

    mockAssertOrigin.mockReturnValue(null);
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockGetRedis.mockReturnValue({ set: mockRedisSet });
    mockRedisSet.mockResolvedValue("OK");
    mockGenerateDiscoverableAuthOpts.mockResolvedValue({
      challenge: "test-challenge-base64url",
      rpId: "localhost",
      allowCredentials: [],
      userVerification: "required",
    });
  });

  it("returns options and challengeId on success", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.options).toBeDefined();
    expect(json.options.challenge).toBe("test-challenge-base64url");
    expect(json.challengeId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("stores challenge in Redis with TTL", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^webauthn:challenge:signin:[0-9a-f]{32}$/),
      "test-challenge-base64url",
      "EX",
      300,
    );
  });

  it("returns 403 when origin is invalid", async () => {
    const { NextResponse } = await import("next/server");
    mockAssertOrigin.mockReturnValue(
      NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }),
    );

    const req = createRequest("POST", ROUTE_URL, {
      headers: { origin: "http://evil.com" },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30000 });

    const req = createRequest("POST", ROUTE_URL, {
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 503 when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValue(null);

    const req = createRequest("POST", ROUTE_URL, {
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(503);
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
  });

  it("returns 503 when WEBAUTHN_RP_ID is not set", async () => {
    delete process.env.WEBAUTHN_RP_ID;

    const req = createRequest("POST", ROUTE_URL, {
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(503);
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
  });
});
