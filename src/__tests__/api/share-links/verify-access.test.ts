import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "../../helpers/request-builder";

const VALID_TOKEN = "a".repeat(64);
const TEST_PASSWORD = "test-password-abc123";
const TEST_HASH = "hashed_password";
const TEST_ACCESS_TOKEN = "payload.signature";

const { mockFindUnique, mockCheck, mockLogAudit } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { findUnique: mockFindUnique },
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  hashToken: (t: string) => `hashed_${t}`,
  verifyAccessPassword: (pw: string, hash: string) =>
    pw === TEST_PASSWORD && hash === TEST_HASH,
}));
vi.mock("@/lib/share-access-token", () => ({
  createShareAccessToken: () => TEST_ACCESS_TOKEN,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/ip-access", () => ({
  extractClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: (_prisma: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/constants")>();
  return { ...actual };
});

import { POST } from "@/app/api/share-links/verify-access/route";

function makeShare(overrides: Record<string, unknown> = {}) {
  return {
    id: "share-1",
    tenantId: "tenant-1",
    accessPasswordHash: TEST_HASH,
    expiresAt: new Date(Date.now() + 86400_000),
    revokedAt: null,
    maxViews: null,
    viewCount: 0,
    ...overrides,
  };
}

function createVerifyRequest(body: unknown) {
  return createRequest("POST", "http://localhost/api/share-links/verify-access", {
    body,
  });
}

describe("POST /api/share-links/verify-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 200 with accessToken for correct password", async () => {
    mockFindUnique.mockResolvedValue(makeShare());
    const req = createVerifyRequest({ token: VALID_TOKEN, password: TEST_PASSWORD });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.accessToken).toBe(TEST_ACCESS_TOKEN);
  });

  it("returns 403 for wrong password", async () => {
    mockFindUnique.mockResolvedValue(makeShare());
    const req = createVerifyRequest({ token: VALID_TOKEN, password: "wrong" });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe("SHARE_PASSWORD_INCORRECT");
  });

  it("returns 404 for non-existent token", async () => {
    mockFindUnique.mockResolvedValue(null);
    const req = createVerifyRequest({ token: VALID_TOKEN, password: TEST_PASSWORD });
    const res = await POST(req);

    expect(res.status).toBe(404);
  });

  it("returns 404 for expired share", async () => {
    mockFindUnique.mockResolvedValue(
      makeShare({ expiresAt: new Date(Date.now() - 1000) })
    );
    const req = createVerifyRequest({ token: VALID_TOKEN, password: TEST_PASSWORD });
    const res = await POST(req);

    expect(res.status).toBe(404);
  });

  it("returns 404 for revoked share", async () => {
    mockFindUnique.mockResolvedValue(
      makeShare({ revokedAt: new Date() })
    );
    const req = createVerifyRequest({ token: VALID_TOKEN, password: TEST_PASSWORD });
    const res = await POST(req);

    expect(res.status).toBe(404);
  });

  it("returns 404 for maxViews reached", async () => {
    mockFindUnique.mockResolvedValue(
      makeShare({ maxViews: 1, viewCount: 1 })
    );
    const req = createVerifyRequest({ token: VALID_TOKEN, password: TEST_PASSWORD });
    const res = await POST(req);

    expect(res.status).toBe(404);
  });

  it("returns 400 for non-password-protected share", async () => {
    mockFindUnique.mockResolvedValue(
      makeShare({ accessPasswordHash: null })
    );
    const req = createVerifyRequest({ token: VALID_TOKEN, password: TEST_PASSWORD });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid token format", async () => {
    const req = createVerifyRequest({ token: "short", password: TEST_PASSWORD });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 429 when rate limited", async () => {
    mockCheck.mockResolvedValue({ allowed: false });
    const req = createVerifyRequest({ token: VALID_TOKEN, password: TEST_PASSWORD });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("logs audit on successful verification", async () => {
    mockFindUnique.mockResolvedValue(makeShare());
    const req = createVerifyRequest({ token: VALID_TOKEN, password: TEST_PASSWORD });
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SHARE_ACCESS_VERIFY_SUCCESS",
        tenantId: "tenant-1",
      })
    );
  });

  it("logs audit on failed verification", async () => {
    mockFindUnique.mockResolvedValue(makeShare());
    const req = createVerifyRequest({ token: VALID_TOKEN, password: "wrong" });
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SHARE_ACCESS_VERIFY_FAILED",
        tenantId: "tenant-1",
      })
    );
  });
});
