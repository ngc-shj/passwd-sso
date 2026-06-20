import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockExtensionTokenFindUnique,
  mockTenantMemberFindUnique,
  mockWithBypassRls,
  mockCheck,
  mockRefreshIosToken,
  mockVerifyDpop,
  mockEnforceAccessRestriction,
} = vi.hoisted(() => ({
  mockExtensionTokenFindUnique: vi.fn(),
  mockTenantMemberFindUnique: vi.fn().mockResolvedValue({ deactivatedAt: null }),
  mockWithBypassRls: vi.fn(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p)),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockRefreshIosToken: vi.fn(),
  mockVerifyDpop: vi.fn(),
  mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionToken: { findUnique: mockExtensionTokenFindUnique },
    tenantMember: { findUnique: mockTenantMemberFindUnique },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));

vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "x".repeat(64),
  hashToken: () => "h".repeat(64),
}));

vi.mock("@/lib/auth/tokens/mobile-token", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  refreshIosToken: mockRefreshIosToken,
}));

vi.mock("@/lib/auth/dpop/verify", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  verifyDpopProof: mockVerifyDpop,
}));

vi.mock("@/lib/auth/dpop/jti-cache", () => ({
  getJtiCache: () => ({ hasOrRecord: vi.fn().mockResolvedValue(false) }),
}));

vi.mock("@/lib/url-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/url-helpers")>();
  return { ...actual, getAppOrigin: () => "https://example.test" };
});

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: "1.2.3.4",
    userAgent: "test",
    acceptLanguage: null,
  }),
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  getLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { POST } from "./route";

const REFRESH_TOKEN = "r".repeat(64);
const USER_ID = "11111111-1111-1111-1111-111111111111";
const TENANT_ID = "22222222-2222-2222-2222-222222222222";

function makeRequest(
  body: unknown = { refresh_token: REFRESH_TOKEN },
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("https://example.test/api/mobile/token/refresh", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      authorization: `DPoP ${REFRESH_TOKEN}`,
      dpop: "fake.proof",
      ...headers,
    },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

function happyDpop() {
  return {
    ok: true as const,
    jkt: "thumbprint-jkt-1",
    claims: { jti: "j", htm: "POST", htu: "https://example.test/api/mobile/token/refresh", iat: 1 },
  };
}

function existingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "tok-id",
    userId: USER_ID,
    tenantId: TENANT_ID,
    tokenHash: "h".repeat(64),
    cnfJkt: "thumbprint-jkt-1",
    scope: "passwords:read,vault:unlock-data",
    expiresAt: new Date("2099-01-01"),
    familyId: "fam-1",
    familyCreatedAt: new Date(),
    revokedAt: null,
    devicePubkey: "device-pubkey-bytes",
    clientKind: "IOS_APP",
    ...overrides,
  };
}

async function parseJson(res: Response): Promise<{ status: number; json: { error?: string } & Record<string, unknown> }> {
  const json = await res.json();
  return { status: res.status, json };
}

describe("POST /api/mobile/token/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockWithBypassRls.mockImplementation(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p));
    mockExtensionTokenFindUnique.mockResolvedValue(existingRow());
    mockTenantMemberFindUnique.mockResolvedValue({ deactivatedAt: null });
    mockVerifyDpop.mockResolvedValue(happyDpop());
    mockRefreshIosToken.mockResolvedValue({
      ok: true,
      token: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date(Date.now() + 86_400_000),
        familyId: "fam-1",
        familyCreatedAt: new Date(),
        tokenId: "new-tok-id",
      },
    });
  });

  it("rotates the token pair on a valid request", async () => {
    const res = await POST(makeRequest());
    const { status, json } = await parseJson(res);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 86_400,
      token_type: "DPoP",
    });
    expect(res.headers.get("dpop-nonce")).toBeNull();
  });

  it("rejects an oversized JSON body with no Content-Length before any token lookup (chunked-TE bypass guard)", async () => {
    // 2 MB body streamed with NO Content-Length header. readBytesWithCap is the
    // first thing handlePOST does, so the streaming cap must abort the read and
    // return 413 before the token is looked up or rotated. (Guards the raw-body
    // hash path against the chunked-body DoS that an after-read check missed.)
    const oversized = JSON.stringify({ refresh_token: REFRESH_TOKEN, padding: "x".repeat(2_000_000) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });
    const req = new NextRequest("https://example.test/api/mobile/token/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `DPoP ${REFRESH_TOKEN}`,
        dpop: "fake.proof",
      },
      body: stream,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await POST(req);
    const { status, json } = await parseJson(res);
    expect(status).toBe(413);
    expect(json.error).toBe("PAYLOAD_TOO_LARGE");
    expect(mockExtensionTokenFindUnique).not.toHaveBeenCalled();
    expect(mockRefreshIosToken).not.toHaveBeenCalled();
  });

  it("returns 401 with REPLAY_DETECTED code when refreshIosToken signals replay", async () => {
    mockRefreshIosToken.mockResolvedValueOnce({
      ok: false,
      error: "REFRESH_REPLAY_DETECTED",
    });
    const res = await POST(makeRequest());
    const { status, json } = await parseJson(res);
    expect(status).toBe(401);
    expect(json.error).toBe("MOBILE_REFRESH_REUSE_DETECTED");
  });

  it("returns 200 with the cached token on a legitimate retry (replayed=true)", async () => {
    mockRefreshIosToken.mockResolvedValueOnce({
      ok: true,
      replayed: true,
      token: {
        accessToken: "cached-access",
        refreshToken: "cached-refresh",
        expiresAt: new Date(Date.now() + 86_400_000),
        familyId: "fam-1",
        familyCreatedAt: new Date(),
        tokenId: "cached-tok-id",
      },
    });
    const res = await POST(makeRequest());
    const { status, json } = await parseJson(res);
    expect(status).toBe(200);
    expect(json.access_token).toBe("cached-access");
  });

  it("returns 401 when DPoP proof signature fails", async () => {
    mockVerifyDpop.mockResolvedValueOnce({ ok: false, error: "DPOP_SIG_INVALID" });
    const res = await POST(makeRequest());
    const { status, json } = await parseJson(res);
    expect(status).toBe(401);
    expect(json.error).toBe("MOBILE_TOKEN_BINDING_INVALID");
    expect(mockRefreshIosToken).not.toHaveBeenCalled();
  });

  it("returns 401 when the refresh token is unknown", async () => {
    mockExtensionTokenFindUnique.mockResolvedValueOnce(null);
    const res = await POST(makeRequest());
    const { status, json } = await parseJson(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the row is not an iOS token (clientKind=BROWSER_EXTENSION)", async () => {
    mockExtensionTokenFindUnique.mockResolvedValueOnce(
      existingRow({ clientKind: "BROWSER_EXTENSION" }),
    );
    const res = await POST(makeRequest());
    const { status } = await parseJson(res);
    expect(status).toBe(401);
  });

  it("returns 401 when refreshIosToken signals family expiry", async () => {
    mockRefreshIosToken.mockResolvedValueOnce({
      ok: false,
      error: "REFRESH_TOKEN_FAMILY_EXPIRED",
    });
    const res = await POST(makeRequest());
    const { status, json } = await parseJson(res);
    expect(status).toBe(401);
    expect(json.error).toBe("MOBILE_REFRESH_SESSION_EXPIRED");
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    mockCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 60_000 });
    const res = await POST(makeRequest());
    const { status, json } = await parseJson(res);
    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
    expect(mockRefreshIosToken).not.toHaveBeenCalled();
  });

  it("returns 403 when the tenant access restriction denies the client IP", async () => {
    mockEnforceAccessRestriction.mockResolvedValueOnce(
      NextResponse.json({ error: "ACCESS_DENIED" }, { status: 403 }),
    );
    const res = await POST(makeRequest());
    const { status, json } = await parseJson(res);
    expect(status).toBe(403);
    expect(json.error).toBe("ACCESS_DENIED");
    expect(mockRefreshIosToken).not.toHaveBeenCalled();
  });

  // ── C13: deactivated-user rejection ──────────────────────────
  it("C13: deactivated user ⇒ 401 unauthorized (before DPoP/rate-limit)", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({ deactivatedAt: new Date("2025-01-01") });
    const res = await POST(makeRequest());
    const { status, json } = await parseJson(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
    // refreshIosToken must NOT be called for deactivated users
    expect(mockRefreshIosToken).not.toHaveBeenCalled();
  });

  it("C13: no membership row ⇒ 401 unauthorized", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce(null);
    const res = await POST(makeRequest());
    const { status, json } = await parseJson(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
    expect(mockRefreshIosToken).not.toHaveBeenCalled();
  });

  it("C13: active membership ⇒ unchanged (proceeds to DPoP and rotation)", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({ deactivatedAt: null });
    const res = await POST(makeRequest());
    const { status } = await parseJson(res);
    expect(status).toBe(200);
    expect(mockRefreshIosToken).toHaveBeenCalledOnce();
  });

  it("returns 401 when the bearer header does not match the body refresh_token", async () => {
    const res = await POST(
      makeRequest({ refresh_token: REFRESH_TOKEN }, { authorization: "DPoP somethingelseaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    );
    const { status, json } = await parseJson(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });
});
