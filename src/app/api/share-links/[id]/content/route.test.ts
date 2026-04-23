import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockPrismaPasswordShare,
  mockPrismaShareAccessLog,
  mockPrismaExecuteRaw,
  mockWithBypassRls,
  mockVerifyShareAccessToken,
  mockDecryptShareData,
  mockExtractClientIp,
  mockContentLimiterCheck,
} = vi.hoisted(() => ({
  mockPrismaPasswordShare: { findUnique: vi.fn() },
  mockPrismaShareAccessLog: { create: vi.fn().mockResolvedValue({}) },
  mockPrismaExecuteRaw: vi.fn().mockResolvedValue(1),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockVerifyShareAccessToken: vi.fn().mockReturnValue(true),
  mockDecryptShareData: vi.fn(),
  mockExtractClientIp: vi.fn().mockReturnValue("1.2.3.4"),
  mockContentLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: mockPrismaPasswordShare,
    shareAccessLog: mockPrismaShareAccessLog,
    $executeRaw: (...args: unknown[]) => mockPrismaExecuteRaw(...args),
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/auth/share-access-token", () => ({
  verifyShareAccessToken: mockVerifyShareAccessToken,
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  decryptShareData: mockDecryptShareData,
}));
vi.mock("@/lib/auth/ip-access", () => ({
  extractClientIp: mockExtractClientIp,
  rateLimitKeyFromIp: (ip: string) => ip,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockContentLimiterCheck }),
}));
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { GET } from "./route";

const SHARE_ID = "share-abc123";
const ACCESS_TOKEN = "valid-token-xyz";

const MOCK_SHARE = {
  id: SHARE_ID,
  tenantId: "tenant-1",
  shareType: "PASSWORD",
  entryType: "LOGIN",
  encryptedData: "enc-data",
  dataIv: "iv",
  dataAuthTag: "tag",
  sendName: null,
  sendFilename: null,
  sendSizeBytes: null,
  masterKeyVersion: 0,
  expiresAt: new Date(Date.now() + 86400_000), // 1 day in future
  maxViews: null,
  viewCount: 0,
  revokedAt: null,
  accessPasswordHash: "hash123",
};

function createContentRequest(overrides: Record<string, string> = {}) {
  return createRequest("GET", `http://localhost:3000/api/share-links/${SHARE_ID}/content`, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      ...overrides,
    },
  });
}

// Collapse a tagged-template `$executeRaw` call (captured by vi.fn()) into a
// single SQL string for predicate assertions. The first call argument is a
// readonly string[] (the template parts); remaining args are interpolated
// values we don't need for shape verification.
function sqlBodyOf(callArgs: readonly unknown[]): string {
  const strings = callArgs[0];
  return Array.isArray(strings) ? strings.join("?") : String(strings);
}

describe("GET /api/share-links/[id]/content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaPasswordShare.findUnique.mockResolvedValue(MOCK_SHARE);
    mockVerifyShareAccessToken.mockReturnValue(true);
    mockContentLimiterCheck.mockResolvedValue({ allowed: true });
    mockPrismaExecuteRaw.mockResolvedValue(1);
    mockPrismaShareAccessLog.create.mockResolvedValue({});
  });

  it("returns 401 when Authorization header is missing", async () => {
    const req = createRequest("GET", `http://localhost:3000/api/share-links/${SHARE_ID}/content`);
    const res = await GET(req, createParams({ id: SHARE_ID }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when access token is invalid", async () => {
    mockVerifyShareAccessToken.mockReturnValue(false);
    const res = await GET(createContentRequest(), createParams({ id: SHARE_ID }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockContentLimiterCheck.mockResolvedValue({ allowed: false });
    const res = await GET(createContentRequest(), createParams({ id: SHARE_ID }));
    expect(res.status).toBe(429);
  });

  it("returns 404 when share not found", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue(null);
    const res = await GET(createContentRequest(), createParams({ id: SHARE_ID }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when share has no access password", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue({
      ...MOCK_SHARE,
      accessPasswordHash: null,
    });
    const res = await GET(createContentRequest(), createParams({ id: SHARE_ID }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when share is revoked", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue({
      ...MOCK_SHARE,
      revokedAt: new Date("2026-01-01"),
    });
    const res = await GET(createContentRequest(), createParams({ id: SHARE_ID }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when share is expired", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue({
      ...MOCK_SHARE,
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await GET(createContentRequest(), createParams({ id: SHARE_ID }));
    expect(res.status).toBe(404);
  });

  it("returns encrypted data for E2E share (masterKeyVersion=0)", async () => {
    const res = await GET(createContentRequest(), createParams({ id: SHARE_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.encryptedData).toBe("enc-data");
    expect(json.dataIv).toBe("iv");
    expect(json.shareType).toBe("PASSWORD");
  });

  it("decrypts and returns data for server-encrypted share (masterKeyVersion>0)", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue({
      ...MOCK_SHARE,
      masterKeyVersion: 1,
    });
    mockDecryptShareData.mockReturnValue(JSON.stringify({ password: "secret" }));

    const res = await GET(createContentRequest(), createParams({ id: SHARE_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ password: "secret" });
    expect(json).not.toHaveProperty("encryptedData");
  });

  it("returns 404 when decryption fails", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue({
      ...MOCK_SHARE,
      masterKeyVersion: 1,
    });
    mockDecryptShareData.mockImplementation(() => { throw new Error("decryption failed"); });

    const res = await GET(createContentRequest(), createParams({ id: SHARE_ID }));
    expect(res.status).toBe(404);
  });

  it("does not increment viewCount for FILE shares (no-op UPDATE only)", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue({
      ...MOCK_SHARE,
      shareType: "FILE",
    });
    const res = await GET(createContentRequest(), createParams({ id: SHARE_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.viewCount).toBe(MOCK_SHARE.viewCount);

    // T2: prove the UPDATE is a no-op write, not an accidental `+ 1`.
    expect(mockPrismaExecuteRaw).toHaveBeenCalledTimes(1);
    const sql = sqlBodyOf(mockPrismaExecuteRaw.mock.calls[0]);
    expect(sql).toMatch(/"view_count"\s*=\s*"view_count"(?!\s*\+)/i);
    expect(sql).not.toMatch(/"view_count"\s*=\s*"view_count"\s*\+\s*1/i);
  });

  // Non-FILE TOCTOU: the JS pre-check reads revokedAt=null / expiresAt=future
  // from findUnique, but the UPDATE must re-assert those predicates. Running
  // the test with findUnique returning a still-valid share and $executeRaw
  // returning 0 simulates the row being revoked/expired/max-views-hit in the
  // interleaving window.
  it("returns 410 when atomic UPDATE matches 0 rows (TOCTOU or maxViews)", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue(MOCK_SHARE);
    mockPrismaExecuteRaw.mockResolvedValue(0);
    const res = await GET(createContentRequest(), createParams({ id: SHARE_ID }));
    expect(res.status).toBe(410);
  });

  // FILE path mirrors the TOCTOU recheck but with a no-op SET (view_count
  // increment is owned by the download route). $executeRaw returning 0
  // simulates revocation/expiry/max-views in the interleaving window.
  it("returns 410 for FILE share when atomic recheck matches 0 rows (TOCTOU or maxViews)", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue({
      ...MOCK_SHARE,
      shareType: "FILE",
    });
    mockPrismaExecuteRaw.mockResolvedValue(0);
    const res = await GET(createContentRequest(), createParams({ id: SHARE_ID }));
    expect(res.status).toBe(410);
  });

  // T1: verify the UPDATE SQL actually contains every TOCTOU predicate so a
  // predicate-dropping regression fails the test instead of silently returning
  // "0 rows" under the mock. Non-FILE path increments view_count.
  it("non-FILE UPDATE SQL re-asserts revoked_at, expires_at, max_views predicates and increments view_count", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue(MOCK_SHARE);
    await GET(createContentRequest(), createParams({ id: SHARE_ID }));

    expect(mockPrismaExecuteRaw).toHaveBeenCalledTimes(1);
    const sql = sqlBodyOf(mockPrismaExecuteRaw.mock.calls[0]);
    expect(sql).toMatch(/"revoked_at"\s+IS\s+NULL/i);
    expect(sql).toMatch(/"expires_at"\s*>\s*NOW\(\)/i);
    expect(sql).toMatch(/"max_views"\s+IS\s+NULL\s+OR\s+"view_count"\s*<\s*"max_views"/i);
    expect(sql).toMatch(/"view_count"\s*=\s*"view_count"\s*\+\s*1/i);
  });

  // T1: FILE path must carry the same predicates; view_count must NOT be
  // incremented here (download route owns that).
  it("FILE recheck SQL re-asserts revoked_at, expires_at, max_views predicates without incrementing view_count", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue({
      ...MOCK_SHARE,
      shareType: "FILE",
    });
    await GET(createContentRequest(), createParams({ id: SHARE_ID }));

    expect(mockPrismaExecuteRaw).toHaveBeenCalledTimes(1);
    const sql = sqlBodyOf(mockPrismaExecuteRaw.mock.calls[0]);
    expect(sql).toMatch(/"revoked_at"\s+IS\s+NULL/i);
    expect(sql).toMatch(/"expires_at"\s*>\s*NOW\(\)/i);
    expect(sql).toMatch(/"max_views"\s+IS\s+NULL\s+OR\s+"view_count"\s*<\s*"max_views"/i);
    // No-op SET, not `+ 1` — download route handles the increment.
    expect(sql).toMatch(/"view_count"\s*=\s*"view_count"(?!\s*\+)/i);
    expect(sql).not.toMatch(/"view_count"\s*=\s*"view_count"\s*\+\s*1/i);
  });
});
