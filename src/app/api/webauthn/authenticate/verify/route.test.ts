import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockRateLimiterCheck,
  mockWithUserTenantRls,
  mockVerifyAuthenticationAssertion,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockWithUserTenantRls: vi.fn(),
  mockVerifyAuthenticationAssertion: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

vi.mock("@/lib/auth/webauthn/webauthn-server", () => ({
  verifyAuthenticationAssertion: mockVerifyAuthenticationAssertion,
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

const validBody = {
  response: { id: "cred-1", rawId: "cred-1", type: "public-key", response: {} },
};

function successResult(prfPresent = true) {
  return {
    ok: true as const,
    credentialId: "cred-1",
    storedPrf: {
      encryptedSecretKey: prfPresent ? "encrypted-key" : null,
      iv: prfPresent ? "iv-hex" : null,
      authTag: prfPresent ? "tag-hex" : null,
    },
  };
}

describe("POST /api/webauthn/authenticate/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    // withUserTenantRls forwards to its callback
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockWithUserTenantRls.mockImplementation(async (_uid: string, fn: any) => fn());
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", ROUTE_URL, { body: validBody }));
    const { status, json: body } = await parseResponse(res);
    expect(status).toBe(401);
    expect(body.error).toBe("UNAUTHORIZED");
    expect(mockVerifyAuthenticationAssertion).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });
    const res = await POST(createRequest("POST", ROUTE_URL, { body: validBody }));
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(mockVerifyAuthenticationAssertion).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body (missing response field)", async () => {
    const res = await POST(createRequest("POST", ROUTE_URL, { body: { wrong: "field" } }));
    const { status, json: body } = await parseResponse(res);
    expect(status).toBe(400);
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(mockVerifyAuthenticationAssertion).not.toHaveBeenCalled();
  });

  it("delegates assertion verification to verifyAuthenticationAssertion with sign-in challenge key", async () => {
    mockVerifyAuthenticationAssertion.mockResolvedValue(successResult(false));
    await POST(createRequest("POST", ROUTE_URL, { body: validBody, headers: { "user-agent": "Test/1.0" } }));
    expect(mockVerifyAuthenticationAssertion).toHaveBeenCalledWith(
      expect.anything(), // prisma instance
      "user-1",
      validBody.response,
      "webauthn:challenge:authenticate:user-1",
      "Test/1.0",
    );
    // The route MUST run the helper inside withUserTenantRls so RLS context covers
    // the credential lookup and counter CAS — see helper's caller obligations.
    expect(mockWithUserTenantRls).toHaveBeenCalledWith("user-1", expect.any(Function));
  });

  it("propagates helper failure status + code (e.g., 404 NOT_FOUND)", async () => {
    mockVerifyAuthenticationAssertion.mockResolvedValue({
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      details: "Credential not found",
    });
    const res = await POST(createRequest("POST", ROUTE_URL, { body: validBody }));
    const { status, json: body } = await parseResponse(res);
    expect(status).toBe(404);
    expect(body.error).toBe("NOT_FOUND");
    expect(body.details).toBe("Credential not found");
  });

  it("propagates helper 503 (e.g., Redis unavailable)", async () => {
    mockVerifyAuthenticationAssertion.mockResolvedValue({
      ok: false,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
    });
    const res = await POST(createRequest("POST", ROUTE_URL, { body: validBody }));
    const { status, json: body } = await parseResponse(res);
    expect(status).toBe(503);
    expect(body.error).toBe("SERVICE_UNAVAILABLE");
  });

  it("falls back to VALIDATION_ERROR when helper code is unknown", async () => {
    mockVerifyAuthenticationAssertion.mockResolvedValue({
      ok: false,
      status: 400,
      code: "SOME_UNKNOWN_CODE",
    });
    const res = await POST(createRequest("POST", ROUTE_URL, { body: validBody }));
    const { status, json: body } = await parseResponse(res);
    expect(status).toBe(400);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("returns { verified: true, credentialId } on success without PRF", async () => {
    mockVerifyAuthenticationAssertion.mockResolvedValue(successResult(false));
    const res = await POST(createRequest("POST", ROUTE_URL, { body: validBody }));
    const { status, json: body } = await parseResponse(res);
    expect(status).toBe(200);
    expect(body.verified).toBe(true);
    expect(body.credentialId).toBe("cred-1");
    expect(body.prf).toBeUndefined();
  });

  it("returns PRF data when credential has PRF fields", async () => {
    mockVerifyAuthenticationAssertion.mockResolvedValue(successResult(true));
    const res = await POST(createRequest("POST", ROUTE_URL, { body: validBody }));
    const { status, json: body } = await parseResponse(res);
    expect(status).toBe(200);
    expect(body.verified).toBe(true);
    expect(body.prf).toEqual({
      prfEncryptedSecretKey: "encrypted-key",
      prfSecretKeyIv: "iv-hex",
      prfSecretKeyAuthTag: "tag-hex",
    });
  });
});
