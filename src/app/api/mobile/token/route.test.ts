import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockMobileBridgeCodeUpdateMany,
  mockMobileBridgeCodeFindUnique,
  mockWithBypassRls,
  mockCheck,
  mockIssueIosToken,
  mockVerifyDpop,
  mockVerifyPkceS256,
  mockLogAuditAsync,
  mockGetDpopNonceService,
  mockExtractClientIp,
  mockWarn,
  mockError,
} = vi.hoisted(() => ({
  mockMobileBridgeCodeUpdateMany: vi.fn(),
  mockMobileBridgeCodeFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(async (_p: unknown, fn: () => unknown) => fn()),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockIssueIosToken: vi.fn(),
  mockVerifyDpop: vi.fn(),
  mockVerifyPkceS256: vi.fn(),
  mockLogAuditAsync: vi.fn(),
  mockGetDpopNonceService: vi.fn(() => ({
    current: vi.fn().mockResolvedValue("nonce-current"),
    rotateIfDue: vi.fn().mockResolvedValue(undefined),
    isAccepted: vi.fn().mockResolvedValue(true),
  })),
  mockExtractClientIp: vi.fn(() => "1.2.3.4"),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mobileBridgeCode: {
      updateMany: mockMobileBridgeCodeUpdateMany,
      findUnique: mockMobileBridgeCodeFindUnique,
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

vi.mock("@/lib/auth/dpop/nonce", () => ({
  getDpopNonceService: mockGetDpopNonceService,
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

vi.mock("@/lib/url-helpers", () => ({
  getAppOrigin: () => "https://example.test",
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: mockWarn, error: mockError, info: vi.fn() },
  getLogger: () => ({ warn: mockWarn, error: mockError, info: vi.fn() }),
}));

import { POST } from "./route";

const VALID_CODE = "f".repeat(64);
const VALID_VERIFIER = "v".repeat(43);
const VALID_DEVICE_PUBKEY =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhVc7n3kP4cFE_UxRIm2Ki5FNpYlF1JKoYJYgTEbZBuDKaW6BBwQuP-y_3R5_uA0iJZ-vQGRT-rqr_MQ7H4cQ-A";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const TENANT_ID = "22222222-2222-2222-2222-222222222222";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";

function buildBody(overrides: Record<string, unknown> = {}) {
  return {
    code: VALID_CODE,
    code_verifier: VALID_VERIFIER,
    device_pubkey: VALID_DEVICE_PUBKEY,
    ...overrides,
  };
}

function makeReq(body: unknown = buildBody(), headers: Record<string, string> = {}) {
  return createRequest("POST", "https://example.test/api/mobile/token", {
    body,
    headers: { dpop: "fake.dpop.proof", ...headers },
  });
}

function happyDpop(): { ok: true; jkt: string; claims: Record<string, unknown> } {
  return {
    ok: true,
    jkt: "thumbprint-jkt-1",
    claims: { jti: "j1", htm: "POST", htu: "https://example.test/api/mobile/token", iat: 1 },
  };
}

describe("POST /api/mobile/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockExtractClientIp.mockReturnValue("1.2.3.4");
    mockWithBypassRls.mockImplementation(async (_p: unknown, fn: () => unknown) => fn());
    mockMobileBridgeCodeUpdateMany.mockResolvedValue({ count: 1 });
    mockMobileBridgeCodeFindUnique.mockResolvedValue({
      userId: USER_ID,
      tenantId: TENANT_ID,
      state: "state-value",
      codeChallenge: "challenge-value",
      devicePubkey: VALID_DEVICE_PUBKEY,
    });
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
    expect(res.headers.get("dpop-nonce")).toBe("nonce-current");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mockIssueIosToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        tenantId: TENANT_ID,
        devicePubkey: VALID_DEVICE_PUBKEY,
        cnfJkt: "thumbprint-jkt-1",
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
  });

  it("returns 400 when the bridge code is unknown or already used", async () => {
    mockMobileBridgeCodeUpdateMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("MOBILE_BRIDGE_CODE_INVALID");
    expect(mockIssueIosToken).not.toHaveBeenCalled();
  });

  it("rejects a replayed bridge code (1st 200, 2nd 400)", async () => {
    mockMobileBridgeCodeUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const first = await POST(makeReq());
    const second = await POST(makeReq());
    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
  });

  it("returns 400 when PKCE verification fails", async () => {
    mockVerifyPkceS256.mockReturnValue(false);
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("MOBILE_PKCE_MISMATCH");
    expect(mockIssueIosToken).not.toHaveBeenCalled();
  });

  it("returns 400 when device_pubkey does not match the stored value", async () => {
    mockMobileBridgeCodeFindUnique.mockResolvedValueOnce({
      userId: USER_ID,
      tenantId: TENANT_ID,
      state: "s",
      codeChallenge: "c",
      devicePubkey: "different-pubkey",
    });
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("MOBILE_DEVICE_PUBKEY_MISMATCH");
  });

  it("returns 401 when DPoP signature verification fails", async () => {
    mockVerifyDpop.mockResolvedValueOnce({ ok: false, error: "DPOP_SIG_INVALID" });
    const res = await POST(makeReq());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("MOBILE_DPOP_INVALID");
    expect(mockIssueIosToken).not.toHaveBeenCalled();
  });

  it("returns 401 when DPoP header is missing", async () => {
    mockVerifyDpop.mockResolvedValueOnce({ ok: false, error: "DPOP_HEADER_MISSING" });
    const res = await POST(
      createRequest("POST", "https://example.test/api/mobile/token", {
        body: buildBody(),
        // no dpop header
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("MOBILE_DPOP_INVALID");
  });

  it("returns 400 on unknown body field (Zod strict)", async () => {
    const res = await POST(makeReq(buildBody({ redirect_uri: "https://attacker.example" })));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockIssueIosToken).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is malformed (wrong code length)", async () => {
    const res = await POST(makeReq({ code: "tooshort", code_verifier: VALID_VERIFIER, device_pubkey: VALID_DEVICE_PUBKEY }));
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
});
