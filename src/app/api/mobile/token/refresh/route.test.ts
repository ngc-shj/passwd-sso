import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockExtensionTokenFindUnique,
  mockWithBypassRls,
  mockCheck,
  mockRefreshIosToken,
  mockVerifyDpop,
  mockGetDpopNonceService,
} = vi.hoisted(() => ({
  mockExtensionTokenFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(async (_p: unknown, fn: () => unknown) => fn()),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockRefreshIosToken: vi.fn(),
  mockVerifyDpop: vi.fn(),
  mockGetDpopNonceService: vi.fn(() => ({
    current: vi.fn().mockResolvedValue("nonce-current"),
    rotateIfDue: vi.fn().mockResolvedValue(undefined),
    isAccepted: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionToken: { findUnique: mockExtensionTokenFindUnique },
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

vi.mock("@/lib/auth/dpop/nonce", () => ({
  getDpopNonceService: mockGetDpopNonceService,
}));

vi.mock("@/lib/url-helpers", () => ({
  getAppOrigin: () => "https://example.test",
}));

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
    mockWithBypassRls.mockImplementation(async (_p: unknown, fn: () => unknown) => fn());
    mockExtensionTokenFindUnique.mockResolvedValue(existingRow());
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
    expect(res.headers.get("dpop-nonce")).toBe("nonce-current");
  });

  it("returns 401 with REPLAY_DETECTED code when refreshIosToken signals replay", async () => {
    mockRefreshIosToken.mockResolvedValueOnce({
      ok: false,
      error: "REFRESH_REPLAY_DETECTED",
    });
    const res = await POST(makeRequest());
    const { status, json } = await parseJson(res);
    expect(status).toBe(401);
    expect(json.error).toBe("MOBILE_REFRESH_REPLAY_DETECTED");
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
    expect(json.error).toBe("MOBILE_DPOP_INVALID");
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
    expect(json.error).toBe("MOBILE_REFRESH_FAMILY_EXPIRED");
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    mockCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 60_000 });
    const res = await POST(makeRequest());
    const { status, json } = await parseJson(res);
    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
    expect(mockRefreshIosToken).not.toHaveBeenCalled();
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
