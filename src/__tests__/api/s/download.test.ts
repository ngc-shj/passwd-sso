import { describe, it, expect, vi, beforeEach } from "vitest";
import { createParams } from "../../helpers/request-builder";
import { NextRequest } from "next/server";

const { mockFindUnique, mockCheck, mockAccessLogCreate } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue(true),
  mockAccessLogCreate: vi.fn().mockReturnValue({ catch: vi.fn() }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { findUnique: mockFindUnique },
    shareAccessLog: { create: mockAccessLogCreate },
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  hashToken: (t: string) => `hashed_${t}`,
  decryptShareBinary: () => Buffer.from("decrypted-file-content"),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
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
    mockCheck.mockResolvedValue(true);
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
    mockCheck.mockResolvedValue(false);

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

  it("does not check viewCount (allows download after page view)", async () => {
    // Even with maxViews reached, download should work
    mockFindUnique.mockResolvedValue(
      makeFileShare({ maxViews: 1, viewCount: 1 })
    );

    const req = createDownloadRequest(VALID_TOKEN);
    const res = await GET(req as never, createParams({ token: VALID_TOKEN }));

    // Should succeed — download does NOT check viewCount
    expect(res.status).toBe(200);
  });
});
