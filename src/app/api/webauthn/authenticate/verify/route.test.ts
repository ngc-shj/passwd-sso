import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockRateLimiterCheck,
  mockGetRedis,
  mockRedisGetdel,
  mockPrismaCredentialFindFirst,
  mockPrismaExecuteRaw,
  mockWithUserTenantRls,
  mockVerifyAuthentication,
  mockGetRpOrigin,
  mockBase64urlToUint8Array,
  mockParseDeviceFromUserAgent,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockGetRedis: vi.fn(),
  mockRedisGetdel: vi.fn(),
  mockPrismaCredentialFindFirst: vi.fn(),
  mockPrismaExecuteRaw: vi.fn(),
  mockWithUserTenantRls: vi.fn(),
  mockVerifyAuthentication: vi.fn(),
  mockGetRpOrigin: vi.fn(() => "https://example.com"),
  mockBase64urlToUint8Array: vi.fn((s: string) => new Uint8Array(Buffer.from(s, "base64url"))),
  mockParseDeviceFromUserAgent: vi.fn(() => "Chrome on macOS"),
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
    webAuthnCredential: { findFirst: mockPrismaCredentialFindFirst },
    $executeRaw: mockPrismaExecuteRaw,
  },
}));

vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

vi.mock("@/lib/auth/webauthn-server", () => ({
  verifyAuthentication: mockVerifyAuthentication,
  getRpOrigin: mockGetRpOrigin,
  base64urlToUint8Array: mockBase64urlToUint8Array,
}));

vi.mock("@/lib/parse-user-agent", () => ({
  parseDeviceFromUserAgent: mockParseDeviceFromUserAgent,
}));

vi.mock("@/lib/http/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

vi.mock("@/lib/http/api-error-codes", () => ({
  API_ERROR: {
    UNAUTHORIZED: "UNAUTHORIZED",
    RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
    SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
    VALIDATION_ERROR: "VALIDATION_ERROR",
    NOT_FOUND: "NOT_FOUND",
  },
}));

vi.mock("@/lib/http/parse-body", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parseBody: async (req: any, _schema: any) => {
    const body = await req.json();
    if (!body || typeof body !== "object" || !("response" in body)) {
      const { NextResponse } = await import("next/server");
      return {
        ok: false,
        response: NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 }),
      };
    }
    return { ok: true, data: body };
  },
}));

import { POST } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/webauthn/authenticate/verify";

function makeAuthResponse(overrides?: Record<string, unknown>) {
  return {
    id: "cred-id-1",
    rawId: "cred-id-1",
    type: "public-key",
    response: {
      clientDataJSON: "Y2xpZW50RGF0YQ",
      authenticatorData: "YXV0aERhdGE",
      signature: "c2lnbmF0dXJl",
    },
    ...overrides,
  };
}

function makeBody(overrides?: Record<string, unknown>) {
  return {
    response: makeAuthResponse(),
    ...overrides,
  };
}

const mockStoredCredential = {
  id: "db-cred-id",
  credentialId: "cred-id-1",
  publicKey: "cHVibGljS2V5",
  counter: BigInt(5),
  transports: ["internal", "hybrid"],
  prfEncryptedSecretKey: null,
  prfSecretKeyIv: null,
  prfSecretKeyAuthTag: null,
};

const mockVerificationResult = {
  verified: true,
  authenticationInfo: {
    newCounter: 6,
  },
};

// ── Setup ────────────────────────────────────────────────────

describe("POST /api/webauthn/authenticate/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");

    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockGetRedis.mockReturnValue({ getdel: mockRedisGetdel });
    mockRedisGetdel.mockResolvedValue("test-challenge");
    mockPrismaCredentialFindFirst.mockResolvedValue(mockStoredCredential);
    mockPrismaExecuteRaw.mockResolvedValue(1);
    mockVerifyAuthentication.mockResolvedValue(mockVerificationResult);
    // withUserTenantRls: execute the callback directly
    mockWithUserTenantRls.mockImplementation(
      (_userId: string, fn: () => unknown) => fn(),
    );
  });

  // ── Auth & guards ────────────────────────────────────────────

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false });

    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 503 when Redis unavailable", async () => {
    mockGetRedis.mockReturnValue(null);

    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(503);
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
  });

  // ── Validation ───────────────────────────────────────────────

  it("returns 400 for invalid body (missing response field)", async () => {
    const req = createRequest("POST", ROUTE_URL, { body: { notResponse: "foo" } });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when challenge expired/missing from Redis", async () => {
    mockRedisGetdel.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details).toMatch(/challenge expired/i);
  });

  it("returns 503 when WEBAUTHN_RP_ID not set", async () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "");
    // Force the env to be falsy by deleting it
    delete process.env.WEBAUTHN_RP_ID;

    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(503);
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
  });

  it("returns 400 when credential ID missing in response", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: { response: { type: "public-key" } }, // no id field
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details).toMatch(/missing credential id/i);
  });

  it("returns 404 when credential not found in DB", async () => {
    mockPrismaCredentialFindFirst.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  // ── Verification ─────────────────────────────────────────────

  it("returns 400 when verification throws", async () => {
    mockVerifyAuthentication.mockRejectedValue(new Error("bad signature"));

    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when verification.verified is false", async () => {
    mockVerifyAuthentication.mockResolvedValue({
      verified: false,
      authenticationInfo: { newCounter: 6 },
    });

    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 on counter mismatch (CAS check fails — 0 rows updated)", async () => {
    mockPrismaExecuteRaw.mockResolvedValue(0);

    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details).toMatch(/counter mismatch/i);
  });

  it("returns { verified: true } on success", async () => {
    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.verified).toBe(true);
    expect(json.credentialId).toBe("cred-id-1");
  });

  it("does not include prf field when credential has no PRF data", async () => {
    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.prf).toBeUndefined();
  });

  it("returns PRF data when credential has PRF fields", async () => {
    mockPrismaCredentialFindFirst.mockResolvedValue({
      ...mockStoredCredential,
      prfEncryptedSecretKey: "encrypted-key",
      prfSecretKeyIv: "prf-iv",
      prfSecretKeyAuthTag: "prf-auth-tag",
    });

    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.verified).toBe(true);
    expect(json.prf).toEqual({
      prfEncryptedSecretKey: "encrypted-key",
      prfSecretKeyIv: "prf-iv",
      prfSecretKeyAuthTag: "prf-auth-tag",
    });
  });

  it("updates counter and lastUsedAt on success", async () => {
    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    await POST(req);

    expect(mockPrismaExecuteRaw).toHaveBeenCalledTimes(1);
    // withUserTenantRls should have been called twice: findFirst + executeRaw
    expect(mockWithUserTenantRls).toHaveBeenCalledTimes(2);
  });
});
