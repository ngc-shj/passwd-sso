import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

const {
  mockTx,
  mockPasswordShareFindUnique,
  mockWithBypassRls,
  mockHashToken,
  mockVerifyAccessPassword,
  mockCreateShareAccessToken,
  mockLogAuditInTx,
  mockIpCheck,
  mockTokenCheck,
} = vi.hoisted(() => {
  const tx = {};
  return {
    mockTx: tx,
    mockPasswordShareFindUnique: vi.fn(),
    mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: (tx: unknown) => unknown) => fn(tx)),
    mockHashToken: vi.fn((t: string) => `hashed_${t}`),
    mockVerifyAccessPassword: vi.fn(),
    mockCreateShareAccessToken: vi.fn().mockReturnValue("access-token-xyz"),
    mockLogAuditInTx: vi.fn(),
    mockIpCheck: vi.fn().mockResolvedValue({ allowed: true }),
    mockTokenCheck: vi.fn().mockResolvedValue({ allowed: true }),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { findUnique: mockPasswordShareFindUnique },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/crypto-server", () => ({
  hashToken: mockHashToken,
  verifyAccessPassword: mockVerifyAccessPassword,
}));
vi.mock("@/lib/share-access-token", () => ({
  createShareAccessToken: mockCreateShareAccessToken,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn()
    .mockReturnValueOnce({ check: mockIpCheck, clear: vi.fn() })
    .mockReturnValueOnce({ check: mockTokenCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/ip-access", () => ({
  extractClientIp: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitKeyFromIp: (ip: string) => ip,
}));
vi.mock("@/lib/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));
vi.mock("@/lib/logger", () => {
  const noop = vi.fn();
  const child = { info: noop, warn: noop, error: noop };
  return {
    default: { info: noop, warn: noop, error: noop, child: vi.fn().mockReturnValue(child) },
    requestContext: { run: (_s: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
    getLogger: () => child,
  };
});

import { POST } from "./route";

const futureDate = new Date("2099-12-31T00:00:00Z");

// token must be 64-char hex (SHA-256 hash format, hexHash = hexString(32))
const VALID_TOKEN = "a".repeat(64);

const validBody = {
  token: VALID_TOKEN,
  password: "correct-password",
};

function makeShare(overrides: Record<string, unknown> = {}) {
  return {
    id: "share-1",
    tenantId: "tenant-1",
    accessPasswordHash: "hashed-password",
    expiresAt: futureDate,
    revokedAt: null,
    maxViews: null,
    viewCount: 0,
    ...overrides,
  };
}

describe("POST /api/share-links/verify-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIpCheck.mockResolvedValue({ allowed: true });
    mockTokenCheck.mockResolvedValue({ allowed: true });
    mockPasswordShareFindUnique.mockResolvedValue(makeShare());
    mockVerifyAccessPassword.mockReturnValue(true);
    mockCreateShareAccessToken.mockReturnValue("access-token-xyz");
  });

  it("returns 400 on invalid body (missing token)", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: { password: "only-password" },
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 400 on invalid body (missing password)", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: { token: VALID_TOKEN },
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 400 when token is not a valid 64-char hex string", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: { token: "not-hex", password: "pw" },
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 429 when IP+token rate limit is exceeded", async () => {
    mockIpCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: validBody,
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("returns 429 when global token rate limit is exceeded", async () => {
    mockIpCheck.mockResolvedValue({ allowed: true });
    mockTokenCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: validBody,
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("returns 404 when share not found", async () => {
    mockPasswordShareFindUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: validBody,
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 404 when share is revoked", async () => {
    mockPasswordShareFindUnique.mockResolvedValue(
      makeShare({ revokedAt: new Date("2025-01-01") }),
    );
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: validBody,
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 404 when share is expired", async () => {
    mockPasswordShareFindUnique.mockResolvedValue(
      makeShare({ expiresAt: new Date("2000-01-01") }),
    );
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: validBody,
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 404 when max views reached", async () => {
    mockPasswordShareFindUnique.mockResolvedValue(
      makeShare({ maxViews: 3, viewCount: 3 }),
    );
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: validBody,
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 400 when share has no access password configured", async () => {
    mockPasswordShareFindUnique.mockResolvedValue(
      makeShare({ accessPasswordHash: null }),
    );
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: validBody,
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 403 and logs failed attempt when password is wrong", async () => {
    mockVerifyAccessPassword.mockReturnValue(false);
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: validBody,
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      mockTx,
      "tenant-1",
      expect.objectContaining({ action: "SHARE_ACCESS_VERIFY_FAILED" }),
    );
  });

  it("returns accessToken and logs success when password is correct", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: validBody,
      }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.accessToken).toBe("access-token-xyz");
    expect(mockCreateShareAccessToken).toHaveBeenCalledWith("share-1");
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      mockTx,
      "tenant-1",
      expect.objectContaining({ action: "SHARE_ACCESS_VERIFY_SUCCESS" }),
    );
  });

  it("hashes the token before querying the database", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: validBody,
      }),
    );
    expect(mockHashToken).toHaveBeenCalledWith(VALID_TOKEN);
    expect(mockPasswordShareFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: `hashed_${VALID_TOKEN}` },
      }),
    );
  });

  it("does not require authentication (public endpoint)", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links/verify-access", {
        body: validBody,
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });
});
