import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import { NIL_UUID } from "@/lib/constants/app";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockGetRedis,
  mockRedisSet,
  mockRateLimiterCheck,
  mockGenerateAuthenticationOpts,
  mockAssertOrigin,
  mockPrismaUserFindFirst,
  mockPrismaWebAuthnFindMany,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockGetRedis: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockGenerateAuthenticationOpts: vi.fn(),
  mockAssertOrigin: vi.fn(),
  mockPrismaUserFindFirst: vi.fn(),
  mockPrismaWebAuthnFindMany: vi.fn(),
  mockWithBypassRls: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: mockGetRedis,
  validateRedisConfig: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck, clear: vi.fn() }),
}));

vi.mock("@/lib/webauthn-server", () => ({
  generateAuthenticationOpts: mockGenerateAuthenticationOpts,
  derivePrfSalt: () => "a".repeat(64),
}));

vi.mock("@/lib/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findFirst: mockPrismaUserFindFirst },
    webAuthnCredential: { findMany: mockPrismaWebAuthnFindMany },
  },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

import { POST } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/auth/passkey/options/email";

const mockCredentials = [
  { credentialId: "cred-1-base64url", transports: ["usb"] },
  { credentialId: "cred-2-base64url", transports: ["internal"] },
];

// ── Setup ────────────────────────────────────────────────────

describe("POST /api/auth/passkey/options/email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WEBAUTHN_RP_ID", "localhost");

    mockAssertOrigin.mockReturnValue(null);
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockGetRedis.mockReturnValue({ set: mockRedisSet });
    mockRedisSet.mockResolvedValue("OK");
    mockGenerateAuthenticationOpts.mockResolvedValue({
      challenge: "test-challenge-base64url",
      rpId: "localhost",
      allowCredentials: [{ id: "cred-1", type: "public-key" }],
      userVerification: "preferred",
    });
    // withBypassRls: call the callback directly
    mockWithBypassRls.mockImplementation(
      (_prisma: unknown, fn: () => unknown) => fn(),
    );
    // Default: user found, bootstrap tenant
    mockPrismaUserFindFirst.mockResolvedValue({
      id: "user-1",
      tenant: { isBootstrap: true },
    });
    mockPrismaWebAuthnFindMany.mockResolvedValue(mockCredentials);
  });

  it("returns options with allowCredentials for known email", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: { email: "test@example.com" },
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.options).toBeDefined();
    expect(json.challengeId).toMatch(/^[0-9a-f]{32}$/);
    expect(json.prfSalt).toBeDefined();
    expect(mockGenerateAuthenticationOpts).toHaveBeenCalledWith(mockCredentials);
  });

  it("stores challenge in Redis with same key pattern as discoverable flow", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: { email: "test@example.com" },
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

  it("returns dummy credentials for unknown email (user enumeration mitigation)", async () => {
    mockPrismaUserFindFirst.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL, {
      body: { email: "unknown@example.com" },
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.options).toBeDefined();
    expect(json.challengeId).toMatch(/^[0-9a-f]{32}$/);
    // Timing mitigation: dummy DB query with non-existent UUID
    expect(mockPrismaWebAuthnFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: NIL_UUID },
      }),
    );
    // generateAuthenticationOpts was still called (with dummy creds)
    expect(mockGenerateAuthenticationOpts).toHaveBeenCalled();
  });

  it("treats SSO tenant user as unknown (returns dummy credentials)", async () => {
    mockPrismaUserFindFirst.mockResolvedValue({
      id: "user-sso",
      tenant: { isBootstrap: false },
    });

    const req = createRequest("POST", ROUTE_URL, {
      body: { email: "sso@corp.com" },
      headers: { origin: "http://localhost:3000" },
    });
    const { status } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    // Timing mitigation: dummy DB query for SSO tenant user too
    expect(mockPrismaWebAuthnFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: NIL_UUID },
      }),
    );
  });

  it("allows user without tenant (null tenant)", async () => {
    mockPrismaUserFindFirst.mockResolvedValue({
      id: "user-no-tenant",
      tenant: null,
    });

    const req = createRequest("POST", ROUTE_URL, {
      body: { email: "notenant@example.com" },
      headers: { origin: "http://localhost:3000" },
    });
    const { status } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(mockPrismaWebAuthnFindMany).toHaveBeenCalled();
  });

  it("returns dummy credentials when user has zero credentials", async () => {
    mockPrismaWebAuthnFindMany.mockResolvedValue([]);

    const req = createRequest("POST", ROUTE_URL, {
      body: { email: "test@example.com" },
      headers: { origin: "http://localhost:3000" },
    });
    const { status } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    // Should call generateAuthenticationOpts with dummy (not empty array)
    const call = mockGenerateAuthenticationOpts.mock.calls[0][0];
    expect(call.length).toBeGreaterThan(0);
    expect(call).not.toEqual([]);
  });

  it("returns 400 for invalid email format", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: { email: "not-an-email" },
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for missing email", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: {},
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new (await import("next/server")).NextRequest(ROUTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: "not-json",
    } as ConstructorParameters<typeof import("next/server").NextRequest>[1]);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 403 when origin is invalid", async () => {
    const { NextResponse } = await import("next/server");
    mockAssertOrigin.mockReturnValue(
      NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }),
    );

    const req = createRequest("POST", ROUTE_URL, {
      body: { email: "test@example.com" },
      headers: { origin: "http://evil.com" },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false });

    const req = createRequest("POST", ROUTE_URL, {
      body: { email: "test@example.com" },
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 503 when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValue(null);

    const req = createRequest("POST", ROUTE_URL, {
      body: { email: "test@example.com" },
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(503);
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
  });

  it("returns 503 when WEBAUTHN_RP_ID is not set", async () => {
    delete process.env.WEBAUTHN_RP_ID;

    const req = createRequest("POST", ROUTE_URL, {
      body: { email: "test@example.com" },
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(503);
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
  });

  it("response shape is identical for known vs unknown email", async () => {
    // Known email
    const req1 = createRequest("POST", ROUTE_URL, {
      body: { email: "test@example.com" },
      headers: { origin: "http://localhost:3000" },
    });
    const { json: json1 } = await parseResponse(await POST(req1));

    // Unknown email
    mockPrismaUserFindFirst.mockResolvedValue(null);
    const req2 = createRequest("POST", ROUTE_URL, {
      body: { email: "unknown@example.com" },
      headers: { origin: "http://localhost:3000" },
    });
    const { json: json2 } = await parseResponse(await POST(req2));

    // Both should have the same top-level keys
    expect(Object.keys(json1).sort()).toEqual(Object.keys(json2).sort());
    expect(json1.options).toBeDefined();
    expect(json2.options).toBeDefined();
    expect(json1.challengeId).toBeDefined();
    expect(json2.challengeId).toBeDefined();
  });

  it("uses withBypassRls for cross-tenant lookup", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: { email: "test@example.com" },
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(mockWithBypassRls).toHaveBeenCalled();
  });
});
