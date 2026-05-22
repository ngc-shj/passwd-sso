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

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck, clear: vi.fn() }),
}));

// A02-8: route now calls buildPrfExtensions. Default mock returns the v1
// shape for legacy NULL-prfSalt credentials so existing tests pass; A02-8
// cases override per-test.
vi.mock("@/lib/auth/webauthn/webauthn-server", () => ({
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
}));

vi.mock("@/lib/auth/session/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findFirst: mockPrismaUserFindFirst },
    webAuthnCredential: { findMany: mockPrismaWebAuthnFindMany },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/http/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

import { POST } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/auth/passkey/options/email";

const mockCredentials = [
  { credentialId: "cred-1-base64url", transports: ["usb"], prfSalt: null },
  { credentialId: "cred-2-base64url", transports: ["internal"], prfSalt: null },
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
      (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma),
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
    // A02-8: the route strips `prfSalt` from the credentials list before
    // passing to `generateAuthenticationOpts`. The full list (with prfSalt)
    // is consulted separately by `buildPrfExtensions`.
    expect(mockGenerateAuthenticationOpts).toHaveBeenCalledWith(
      mockCredentials.map((c) => ({ credentialId: c.credentialId, transports: c.transports })),
    );
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

  // ── A02-8: v1/v2/mixed PRF extension shape (T07/T08/T09) ──────────────

  describe("A02-8 PRF extension shape", () => {
    it("(T09 legacy) sends top-level eval only when every credential has NULL prfSalt", async () => {
      mockPrismaWebAuthnFindMany.mockResolvedValue([
        { credentialId: "cred-1", transports: ["usb"], prfSalt: null },
      ]);
      const req = createRequest("POST", ROUTE_URL, {
        body: { email: "test@example.com" },
        headers: { origin: "http://localhost:3000" },
      });
      const { status, json } = await parseResponse(await POST(req));

      expect(status).toBe(200);
      expect(json.options.extensions?.prf?.eval?.first).toBeDefined();
      expect(json.options.extensions?.prf?.evalByCredential).toBeUndefined();
      expect(json.prfSalt).toBe(json.options.extensions.prf.eval.first);
    });

    it("(T07 all-v2) sends evalByCredential only when every credential has non-NULL prfSalt", async () => {
      const V2A = "a".repeat(64);
      const V2B = "b".repeat(64);
      mockPrismaWebAuthnFindMany.mockResolvedValue([
        { credentialId: "cred-A", transports: ["internal"], prfSalt: V2A },
        { credentialId: "cred-B", transports: ["usb"], prfSalt: V2B },
      ]);
      const req = createRequest("POST", ROUTE_URL, {
        body: { email: "test@example.com" },
        headers: { origin: "http://localhost:3000" },
      });
      const { status, json } = await parseResponse(await POST(req));

      expect(status).toBe(200);
      expect(json.options.extensions?.prf?.eval).toBeUndefined();
      expect(json.options.extensions?.prf?.evalByCredential).toBeDefined();
      expect(Object.keys(json.options.extensions.prf.evalByCredential).sort()).toEqual(
        ["cred-A", "cred-B"],
      );
      // Top-level prfSalt is null (no v1 fallback path); evalByCredential
      // carries the v2 salts so the browser still has PRF eval input.
      expect(json.prfSalt).toBeNull();
    });

    it("(T07 mixed) sends BOTH eval (for legacy NULL creds) AND evalByCredential (for v2)", async () => {
      const V2 = "a".repeat(64);
      mockPrismaWebAuthnFindMany.mockResolvedValue([
        { credentialId: "cred-legacy", transports: ["usb"], prfSalt: null },
        { credentialId: "cred-v2", transports: ["internal"], prfSalt: V2 },
      ]);
      const req = createRequest("POST", ROUTE_URL, {
        body: { email: "test@example.com" },
        headers: { origin: "http://localhost:3000" },
      });
      const { status, json } = await parseResponse(await POST(req));

      expect(status).toBe(200);
      expect(json.options.extensions?.prf?.eval?.first).toBeDefined();
      // v2 cred is keyed; legacy cred is NOT keyed (falls through to eval).
      expect(json.options.extensions?.prf?.evalByCredential).toHaveProperty("cred-v2");
      expect(json.options.extensions?.prf?.evalByCredential).not.toHaveProperty(
        "cred-legacy",
      );
    });

    it("(F3 enumeration mitigation) unknown-email branch emits v1-only PRF shape (no evalByCredential, no empty {})", async () => {
      mockPrismaUserFindFirst.mockResolvedValue(null);
      const req = createRequest("POST", ROUTE_URL, {
        body: { email: "nobody@example.com" },
        headers: { origin: "http://localhost:3000" },
      });
      const { status, json } = await parseResponse(await POST(req));

      expect(status).toBe(200);
      // Same shape as the all-v1 real-user branch — eval.first present,
      // evalByCredential absent. This is the enumeration-equalization guarantee.
      expect(json.options.extensions?.prf?.eval?.first).toBeDefined();
      expect(json.options.extensions?.prf?.evalByCredential).toBeUndefined();
      expect(json.prfSalt).toBe(json.options.extensions.prf.eval.first);
    });
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
      // checkIpRateLimit fails-open when extractClientIp returns null; provide an
      // IP so the limiter is actually consulted in this test.
      headers: { origin: "http://localhost:3000", "x-forwarded-for": "203.0.113.5" },
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
