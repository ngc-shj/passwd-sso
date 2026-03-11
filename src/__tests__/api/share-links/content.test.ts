import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "../../helpers/request-builder";

const {
  mockFindUnique,
  mockCheck,
  mockAccessLogCreate,
  mockExecuteRaw,
  mockVerifyShareAccessToken,
  mockDecryptShareData,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockAccessLogCreate: vi.fn().mockReturnValue({ catch: vi.fn() }),
  mockExecuteRaw: vi.fn().mockResolvedValue(1),
  mockVerifyShareAccessToken: vi.fn().mockReturnValue(true),
  mockDecryptShareData: vi.fn().mockReturnValue('{"title":"Test","password":"secret"}'),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { findUnique: mockFindUnique },
    shareAccessLog: { create: mockAccessLogCreate },
    $executeRaw: mockExecuteRaw,
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  decryptShareData: mockDecryptShareData,
}));
vi.mock("@/lib/share-access-token", () => ({
  verifyShareAccessToken: mockVerifyShareAccessToken,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/ip-access", () => ({
  extractClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: (_prisma: unknown, fn: () => unknown) => fn(),
}));

import { GET } from "@/app/api/share-links/[id]/content/route";

function makeShare(overrides: Record<string, unknown> = {}) {
  return {
    id: "share-1",
    tenantId: "tenant-1",
    shareType: "ENTRY_SHARE",
    entryType: "LOGIN",
    encryptedData: "encrypted-data",
    dataIv: "i".repeat(24),
    dataAuthTag: "t".repeat(32),
    sendName: null,
    sendFilename: null,
    sendSizeBytes: null,
    masterKeyVersion: 1,
    expiresAt: new Date(Date.now() + 86400_000),
    maxViews: null,
    viewCount: 0,
    revokedAt: null,
    accessPasswordHash: "some-hash",
    ...overrides,
  };
}

function createContentRequest(id: string, accessToken?: string) {
  const headers: Record<string, string> = { "x-forwarded-for": "1.2.3.4" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return createRequest("GET", `http://localhost/api/share-links/${id}/content`, {
    headers,
  });
}

describe("GET /api/share-links/[id]/content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockVerifyShareAccessToken.mockReturnValue(true);
    mockExecuteRaw.mockResolvedValue(1);
  });

  it("returns 401 without Authorization header", async () => {
    const req = createContentRequest("share-1");
    const res = await GET(req, createParams({ id: "share-1" }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe("SHARE_PASSWORD_REQUIRED");
  });

  it("returns 401 for invalid access token", async () => {
    mockVerifyShareAccessToken.mockReturnValue(false);
    mockFindUnique.mockResolvedValue(makeShare());

    const req = createContentRequest("share-1", "invalid-token");
    const res = await GET(req, createParams({ id: "share-1" }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 for non-existent share", async () => {
    mockFindUnique.mockResolvedValue(null);

    const req = createContentRequest("share-1", "valid-token");
    const res = await GET(req, createParams({ id: "share-1" }));

    expect(res.status).toBe(404);
  });

  it("returns 404 for non-password-protected share", async () => {
    mockFindUnique.mockResolvedValue(makeShare({ accessPasswordHash: null }));

    const req = createContentRequest("share-1", "valid-token");
    const res = await GET(req, createParams({ id: "share-1" }));

    expect(res.status).toBe(404);
  });

  it("returns 404 for expired share", async () => {
    mockFindUnique.mockResolvedValue(
      makeShare({ expiresAt: new Date(Date.now() - 1000) })
    );

    const req = createContentRequest("share-1", "valid-token");
    const res = await GET(req, createParams({ id: "share-1" }));

    expect(res.status).toBe(404);
  });

  it("returns 404 for revoked share", async () => {
    mockFindUnique.mockResolvedValue(
      makeShare({ revokedAt: new Date() })
    );

    const req = createContentRequest("share-1", "valid-token");
    const res = await GET(req, createParams({ id: "share-1" }));

    expect(res.status).toBe(404);
  });

  it("returns 410 when maxViews reached (atomic check)", async () => {
    mockFindUnique.mockResolvedValue(makeShare());
    mockExecuteRaw.mockResolvedValue(0); // No rows updated

    const req = createContentRequest("share-1", "valid-token");
    const res = await GET(req, createParams({ id: "share-1" }));

    expect(res.status).toBe(410);
  });

  it("returns decrypted data for server-encrypted share", async () => {
    mockFindUnique.mockResolvedValue(makeShare());

    const req = createContentRequest("share-1", "valid-token");
    const res = await GET(req, createParams({ id: "share-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.shareType).toBe("ENTRY_SHARE");
    expect(json.data).toEqual({ title: "Test", password: "secret" });
    expect(json.viewCount).toBe(1); // 0 + 1
    expect(mockAccessLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shareId: "share-1" }),
      })
    );
  });

  it("returns encrypted data for E2E share (masterKeyVersion 0)", async () => {
    mockFindUnique.mockResolvedValue(
      makeShare({
        masterKeyVersion: 0,
        encryptedData: "e2e-encrypted",
        dataIv: "e2e-iv",
        dataAuthTag: "e2e-tag",
      })
    );

    const req = createContentRequest("share-1", "valid-token");
    const res = await GET(req, createParams({ id: "share-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.encryptedData).toBe("e2e-encrypted");
    expect(json.dataIv).toBe("e2e-iv");
    expect(json.dataAuthTag).toBe("e2e-tag");
    expect(json.data).toBeUndefined();
    expect(json.viewCount).toBe(1); // 0 + 1
  });

  it("returns 404 when decryption fails", async () => {
    mockFindUnique.mockResolvedValue(makeShare());
    mockDecryptShareData.mockImplementation(() => {
      throw new Error("decryption failed");
    });

    const req = createContentRequest("share-1", "valid-token");
    const res = await GET(req, createParams({ id: "share-1" }));

    expect(res.status).toBe(404);
  });

  it("returns 429 when rate limited", async () => {
    mockCheck.mockResolvedValue({ allowed: false });

    const req = createContentRequest("share-1", "valid-token");
    const res = await GET(req, createParams({ id: "share-1" }));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });
});
