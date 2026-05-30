import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextResponse } from "next/server";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockMobileBridgeCodeFindUnique,
  mockMobileBridgeCodeUpdateMany,
  mockWithBypassRls,
  mockCheck,
  mockIssueIosToken,
  mockVerifyDpop,
  mockVerifyPkceS256,
  mockLogAuditAsync,
  mockExtractClientIp,
  mockWarn,
  mockError,
  mockEnforceAccessRestriction,
} = vi.hoisted(() => ({
  mockMobileBridgeCodeFindUnique: vi.fn(),
  mockMobileBridgeCodeUpdateMany: vi.fn(),
  mockWithBypassRls: vi.fn(
    async (_p: unknown, fn: (tx: unknown) => unknown) => fn({
      mobileBridgeCode: {
        findUnique: mockMobileBridgeCodeFindUnique,
        updateMany: mockMobileBridgeCodeUpdateMany,
      },
    }),
  ),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockIssueIosToken: vi.fn(),
  mockVerifyDpop: vi.fn(),
  mockVerifyPkceS256: vi.fn(),
  mockLogAuditAsync: vi.fn(),
  mockExtractClientIp: vi.fn(() => "1.2.3.4"),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mobileBridgeCode: {
      findUnique: mockMobileBridgeCodeFindUnique,
      updateMany: mockMobileBridgeCodeUpdateMany,
    },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));

vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "f".repeat(64),
  hashToken: () => "h".repeat(64),
}));

vi.mock("@/lib/auth/tokens/mobile-token", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  issueIosToken: mockIssueIosToken,
}));

vi.mock("@/lib/auth/dpop/verify", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  verifyDpopProof: mockVerifyDpop,
}));

vi.mock("@/lib/auth/dpop/jti-cache", () => ({
  getJtiCache: () => ({ hasOrRecord: vi.fn().mockResolvedValue(false) }),
}));

vi.mock("@/lib/mcp/oauth-server", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  verifyPkceS256: mockVerifyPkceS256,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: "1.2.3.4",
    userAgent: "test",
    acceptLanguage: null,
  }),
}));

vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: mockExtractClientIp,
  rateLimitKeyFromIp: (ip: string) => ip,
}));

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));

vi.mock("@/lib/url-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/url-helpers")>();
  return { ...actual, getAppOrigin: () => "https://example.test" };
});

vi.mock("@/lib/logger", () => ({
  default: { warn: mockWarn, error: mockError, info: vi.fn() },
  getLogger: () => ({ warn: mockWarn, error: mockError, info: vi.fn() }),
}));

import { POST } from "./route";

const VALID_CODE = "f".repeat(64);
const VALID_VERIFIER = "v".repeat(43);
// RFC 7638 JWK thumbprint: 43 base64url chars (SHA-256 unpadded).
const VALID_DEVICE_JKT = "a".repeat(43);
const USER_ID = "11111111-1111-1111-1111-111111111111";
const TENANT_ID = "22222222-2222-2222-2222-222222222222";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";

function buildBody(overrides: Record<string, unknown> = {}) {
  return {
    code: VALID_CODE,
    code_verifier: VALID_VERIFIER,
    device_jkt: VALID_DEVICE_JKT,
    ...overrides,
  };
}

function makeReq(body: unknown = buildBody(), headers: Record<string, string> = {}) {
  return createRequest("POST", "https://example.test/api/mobile/token", {
    body,
    headers: { dpop: "fake.dpop.proof", ...headers },
  });
}

function freshBridgeRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    state: "state-value",
    codeChallenge: "challenge-value",
    deviceJkt: VALID_DEVICE_JKT,
    usedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function happyDpop(): { ok: true; jkt: string; claims: Record<string, unknown> } {
  return {
    ok: true,
    jkt: VALID_DEVICE_JKT,
    claims: { jti: "j1", htm: "POST", htu: "https://example.test/api/mobile/token", iat: 1 },
  };
}

describe("POST /api/mobile/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockExtractClientIp.mockReturnValue("1.2.3.4");
    mockWithBypassRls.mockImplementation(
      async (_p: unknown, fn: (tx: unknown) => unknown) => fn({
      mobileBridgeCode: {
        findUnique: mockMobileBridgeCodeFindUnique,
        updateMany: mockMobileBridgeCodeUpdateMany,
      },
    }),
    );
    mockMobileBridgeCodeFindUnique.mockResolvedValue(freshBridgeRow());
    mockMobileBridgeCodeUpdateMany.mockResolvedValue({ count: 1 });
    mockVerifyPkceS256.mockReturnValue(true);
    mockVerifyDpop.mockResolvedValue(happyDpop());
    mockIssueIosToken.mockResolvedValue({
      accessToken: "acc-tok",
      refreshToken: "ref-tok",
      expiresAt: new Date(Date.now() + 86_400_000),
      familyId: "fam-1",
      familyCreatedAt: new Date(),
      tokenId: TOKEN_ID,
    });
  });

  it("issues a DPoP-bound token pair on a valid request", async () => {
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      access_token: "acc-tok",
      refresh_token: "ref-tok",
      expires_in: 86_400,
      token_type: "DPoP",
    });
    expect(res.headers.get("dpop-nonce")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mockIssueIosToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        tenantId: TENANT_ID,
        deviceJkt: VALID_DEVICE_JKT,
        cnfJkt: VALID_DEVICE_JKT,
      }),
    );
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MOBILE_TOKEN_ISSUED",
        userId: USER_ID,
        tenantId: TENANT_ID,
        targetId: TOKEN_ID,
      }),
    );
    // CAS is the authoritative consumption step.
    expect(mockMobileBridgeCodeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ usedAt: null }),
        data: expect.objectContaining({ usedAt: expect.any(Date) }),
      }),
    );
  });

  it("returns the SAME MOBILE_BRIDGE_CODE_INVALID error when the code is unknown (S7 uniform error)", async () => {
    mockMobileBridgeCodeFindUnique.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("MOBILE_BRIDGE_CODE_INVALID");
    expect(mockIssueIosToken).not.toHaveBeenCalled();
    // CAS must NOT have been attempted when row was missing.
    expect(mockMobileBridgeCodeUpdateMany).not.toHaveBeenCalled();
  });

  it("returns MOBILE_BRIDGE_CODE_INVALID on CAS race-lost (count===0)", async () => {
    mockMobileBridgeCodeUpdateMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("MOBILE_BRIDGE_CODE_INVALID");
    expect(mockIssueIosToken).not.toHaveBeenCalled();
  });

  it("returns MOBILE_BRIDGE_CODE_INVALID (NOT a separate code) when PKCE verification fails — S7 uniform error", async () => {
    mockVerifyPkceS256.mockReturnValue(false);
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("MOBILE_BRIDGE_CODE_INVALID");
    expect(mockIssueIosToken).not.toHaveBeenCalled();
    // C7: PKCE failure must NOT consume the bridge code (legitimate client can retry).
    expect(mockMobileBridgeCodeUpdateMany).not.toHaveBeenCalled();
  });

  it("returns MOBILE_BRIDGE_CODE_INVALID (NOT a separate code) when device_jkt does not match — S7 uniform error", async () => {
    mockMobileBridgeCodeFindUnique.mockResolvedValueOnce(
      freshBridgeRow({ deviceJkt: "b".repeat(43) }),
    );
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("MOBILE_BRIDGE_CODE_INVALID");
    expect(mockMobileBridgeCodeUpdateMany).not.toHaveBeenCalled();
  });

  it("returns MOBILE_BRIDGE_CODE_INVALID (NOT a separate code) when DPoP signature verification fails — S7 uniform error", async () => {
    mockVerifyDpop.mockResolvedValueOnce({ ok: false, error: "DPOP_SIG_INVALID" });
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("MOBILE_BRIDGE_CODE_INVALID");
    expect(mockIssueIosToken).not.toHaveBeenCalled();
    expect(mockMobileBridgeCodeUpdateMany).not.toHaveBeenCalled();
  });

  it("returns MOBILE_BRIDGE_CODE_INVALID when DPoP header is missing — S7 uniform error", async () => {
    mockVerifyDpop.mockResolvedValueOnce({ ok: false, error: "DPOP_HEADER_MISSING" });
    const res = await POST(
      createRequest("POST", "https://example.test/api/mobile/token", {
        body: buildBody(),
        // no dpop header
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("MOBILE_BRIDGE_CODE_INVALID");
  });

  it("returns 400 on unknown body field (Zod strict)", async () => {
    const res = await POST(makeReq(buildBody({ redirect_uri: "https://attacker.example" })));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockIssueIosToken).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is malformed (wrong code length)", async () => {
    const res = await POST(makeReq({ code: "tooshort", code_verifier: VALID_VERIFIER, device_jkt: VALID_DEVICE_JKT }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when device_jkt is not exactly 43 chars (Zod shape gate)", async () => {
    const res = await POST(
      makeReq({ code: VALID_CODE, code_verifier: VALID_VERIFIER, device_jkt: "a".repeat(42) }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 with VALIDATION_ERROR when legacy device_pubkey is sent (T14)", async () => {
    const res = await POST(
      makeReq({ code: VALID_CODE, code_verifier: VALID_VERIFIER, device_pubkey: "legacy-spki" }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    mockCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 60_000 });
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
    expect(mockIssueIosToken).not.toHaveBeenCalled();
  });

  it("returns 403 when the tenant access restriction denies the client IP", async () => {
    mockEnforceAccessRestriction.mockResolvedValueOnce(
      NextResponse.json({ error: "ACCESS_DENIED" }, { status: 403 }),
    );
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("ACCESS_DENIED");
    expect(mockIssueIosToken).not.toHaveBeenCalled();
  });
});
