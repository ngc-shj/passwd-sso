import { describe, it, expect, vi, beforeEach } from "vitest";
import { createParams } from "../../helpers/request-builder";
import { NextRequest } from "next/server";

const { mockFindUnique, mockCheck, mockAccessLogCreate, mockDecryptShareBinary, mockVerifyAccessToken, mockExecuteRaw } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockAccessLogCreate: vi.fn().mockReturnValue({ catch: vi.fn() }),
  mockDecryptShareBinary: vi.fn().mockReturnValue(Buffer.from("decrypted-file-content")),
  mockVerifyAccessToken: vi.fn().mockReturnValue(true),
  mockExecuteRaw: vi.fn().mockResolvedValue(1),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { findUnique: mockFindUnique },
    shareAccessLog: { create: mockAccessLogCreate },
    $executeRaw: mockExecuteRaw,
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  hashToken: (t: string) => `hashed_${t}`,
  decryptShareBinary: mockDecryptShareBinary,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: (_prisma: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/auth/share-access-token", () => ({
  verifyShareAccessToken: mockVerifyAccessToken,
}));
vi.mock("@/lib/ip-access", () => ({
  extractClientIp: () => "1.2.3.4",
  rateLimitKeyFromIp: (ip: string) => ip,
}));

import { GET } from "@/app/s/[token]/download/route";

const VALID_TOKEN = "a".repeat(64);

function createDownloadRequest(token: string): NextRequest {
  return new NextRequest(`http://localhost/s/${token}/download`, {
    headers: { "x-forwarded-for": "1.2.3.4" },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

function makeFileShare(overrides: Record<string, unknown> = {}) {
  return {
    id: "share-1",
    shareType: "FILE",
    sendFilename: "document.pdf",
    sendContentType: "application/pdf",
    encryptedFile: Buffer.from("encrypted"),
    fileIv: "i".repeat(24),
    fileAuthTag: "t".repeat(32),
    masterKeyVersion: 1,
    expiresAt: new Date(Date.now() + 86400_000), // +1 day
    revokedAt: null,
    ...overrides,
  };
}

describe("GET /s/[token]/download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 404 for invalid token format (contains symbols)", async () => {
    const req = createDownloadRequest("abc!@#$");
    const res = await GET(req as never, createParams({ token: "abc!@#$" }));

    expect(res.status).toBe(404);
  });

  it("returns 404 for token too short", async () => {
    const req = createDownloadRequest("abc123");
    const res = await GET(req as never, createParams({ token: "abc123" }));

    expect(res.status).toBe(404);
  });

  it("returns 404 for non-existent token", async () => {
    mockFindUnique.mockResolvedValue(null);

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(404);
  });

  it("returns 410 for expired share", async () => {
    mockFindUnique.mockResolvedValue(
      makeFileShare({ expiresAt: new Date(Date.now() - 1000) })
    );

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(410);
  });

  it("returns 410 for revoked share", async () => {
    mockFindUnique.mockResolvedValue(
      makeFileShare({ revokedAt: new Date() })
    );

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(410);
  });

  it("returns 400 when shareType is TEXT", async () => {
    mockFindUnique.mockResolvedValue(
      makeFileShare({ shareType: "TEXT" })
    );

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(400);
  });

  it("returns 404 when encryptedFile is null (data inconsistency)", async () => {
    mockFindUnique.mockResolvedValue(
      makeFileShare({ encryptedFile: null, fileIv: null, fileAuthTag: null })
    );

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(404);
  });

  it("returns 429 when rate limited", async () => {
    mockCheck.mockResolvedValue({ allowed: false });

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(429);
  });

  it("downloads file successfully with correct headers", async () => {
    mockFindUnique.mockResolvedValue(makeFileShare());

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toContain('filename="download"');
    expect(res.headers.get("Content-Disposition")).toContain("filename*=UTF-8''document.pdf");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate"
    );

    // Verify body content
    const body = await res.arrayBuffer();
    const text = new TextDecoder().decode(body);
    expect(text).toBe("decrypted-file-content");

    // Verify masterKeyVersion was passed to decryptShareBinary
    expect(mockDecryptShareBinary).toHaveBeenCalledWith(
      expect.anything(),
      1
    );
  });

  it("encodes non-ASCII filename in Content-Disposition", async () => {
    mockFindUnique.mockResolvedValue(
      makeFileShare({ sendFilename: "テスト.pdf" })
    );

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent("テスト.pdf")}`
    );
  });

  it("returns 400 when shareType is ENTRY_SHARE", async () => {
    mockFindUnique.mockResolvedValue(
      makeFileShare({ shareType: "ENTRY_SHARE" })
    );

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(400);
  });

  it("returns 410 when maxViews reached", async () => {
    mockFindUnique.mockResolvedValue(
      makeFileShare({ maxViews: 1, viewCount: 1 })
    );
    mockExecuteRaw.mockResolvedValueOnce(0);

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(410);
  });

  it("returns 401 for password-protected share without Authorization header", async () => {
    mockFindUnique.mockResolvedValue(
      makeFileShare({ accessPasswordHash: "some-hash" })
    );

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("SHARE_PASSWORD_REQUIRED");
  });

  it("returns 401 for password-protected share with invalid access token", async () => {
    mockFindUnique.mockResolvedValue(
      makeFileShare({ accessPasswordHash: "some-hash" })
    );
    mockVerifyAccessToken.mockReturnValueOnce(false);

    const req = new NextRequest(`http://localhost/s/${VALID_TOKEN}/download`, {
      headers: {
        "x-forwarded-for": "1.2.3.4",
        authorization: "Bearer invalid-token",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("downloads password-protected file with valid access token", async () => {
    mockFindUnique.mockResolvedValue(
      makeFileShare({ accessPasswordHash: "some-hash" })
    );
    mockVerifyAccessToken.mockReturnValueOnce(true);

    const req = new NextRequest(`http://localhost/s/${VALID_TOKEN}/download`, {
      headers: {
        "x-forwarded-for": "1.2.3.4",
        authorization: "Bearer valid-access-token",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(200);
    expect(mockVerifyAccessToken).toHaveBeenCalledWith("valid-access-token", "share-1");
  });

  // TOCTOU atomicity: findUnique returns a share that still looks valid,
  // but it is revoked/expired between the JS check and the UPDATE. The
  // UPDATE's re-asserted revoked_at/expires_at predicates must match 0
  // rows and the handler must return 410 without streaming the file.
  it("returns 410 when non-protected share is revoked between findUnique and UPDATE (TOCTOU)", async () => {
    mockFindUnique.mockResolvedValue(makeFileShare());
    mockExecuteRaw.mockResolvedValueOnce(0);

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(410);
    expect(mockDecryptShareBinary).not.toHaveBeenCalled();
  });

  it("returns 410 when password-protected share is revoked between findUnique and UPDATE (TOCTOU)", async () => {
    mockFindUnique.mockResolvedValue(
      makeFileShare({ accessPasswordHash: "some-hash" })
    );
    mockVerifyAccessToken.mockReturnValueOnce(true);
    mockExecuteRaw.mockResolvedValueOnce(0);

    const req = new NextRequest(`http://localhost/s/${VALID_TOKEN}/download`, {
      headers: {
        "x-forwarded-for": "1.2.3.4",
        authorization: "Bearer valid-access-token",
      },
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(res.status).toBe(410);
    expect(mockDecryptShareBinary).not.toHaveBeenCalled();
  });

  // T1: the UPDATE's SQL body must contain every TOCTOU predicate so a
  // regression that drops one of them fails the test instead of silently
  // returning "0 rows updated" under the mock.
  it("UPDATE SQL re-asserts revoked_at, expires_at, and max_views predicates", async () => {
    mockFindUnique.mockResolvedValue(makeFileShare());

    const req = createDownloadRequest(VALID_TOKEN);
    await GET(req as never, createParams({ token: VALID_TOKEN }));

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const callArg = mockExecuteRaw.mock.calls[0][0] as unknown;
    const sqlBody = Array.isArray(callArg) ? callArg.join("?") : String(callArg);
    expect(sqlBody).toMatch(/"revoked_at"\s+IS\s+NULL/i);
    expect(sqlBody).toMatch(/"expires_at"\s*>\s*NOW\(\)/i);
    expect(sqlBody).toMatch(/"max_views"\s+IS\s+NULL\s+OR\s+"view_count"\s*<\s*"max_views"/i);
    expect(sqlBody).toMatch(/"view_count"\s*=\s*"view_count"\s*\+\s*1/i);
  });
});
