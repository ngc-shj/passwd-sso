import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockAuth,
  mockCreate,
  mockFindMany,
  mockFindUnique,
  mockUpdateMany,
  mockUpdate,
  mockTransaction,
  mockCheck,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCreate: vi.fn(),
  mockFindMany: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionToken: {
      findMany: mockFindMany,
      findUnique: mockFindUnique,
      create: mockCreate,
      updateMany: mockUpdateMany,
      update: mockUpdate,
    },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  generateShareToken: () => "a".repeat(64),
  hashToken: () => "h".repeat(64),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));

import { POST, DELETE } from "./route";

// ─── POST ────────────────────────────────────────────────────

describe("POST /api/extension/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: transaction executes the callback with the mock prisma
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        extensionToken: {
          findMany: mockFindMany,
          create: mockCreate,
          updateMany: mockUpdateMany,
        },
      }),
    );
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("POST", "http://localhost/api/extension/token");
    const res = await POST();
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 429 when rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCheck.mockResolvedValueOnce(false);
    const req = createRequest("POST", "http://localhost/api/extension/token");
    const res = await POST();
    const { status, json } = await parseResponse(res);
    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("issues a token successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);
    mockCreate.mockResolvedValue({
      id: "tok1",
      expiresAt: new Date("2030-01-01"),
      scope: "passwords:read,vault:unlock-data",
    });

    const res = await POST();
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.token).toBe("a".repeat(64));
    expect(json.scope).toContain("passwords:read");
    expect(json.expiresAt).toBeDefined();
  });

  it("revokes oldest token when MAX_ACTIVE exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([
      { id: "t1" },
      { id: "t2" },
      { id: "t3" },
    ]);
    mockCreate.mockResolvedValue({
      id: "t4",
      expiresAt: new Date("2030-01-01"),
      scope: "passwords:read,vault:unlock-data",
    });

    await POST();

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["t1"] } },
      }),
    );
  });
});

// ─── DELETE ──────────────────────────────────────────────────

describe("DELETE /api/extension/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revokes a token successfully via Bearer", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: DEFAULT_SESSION.user.id,
      scope: "passwords:read,vault:unlock-data",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
    });
    mockUpdate.mockResolvedValue({});

    const req = createRequest("DELETE", "http://localhost/api/extension/token", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("returns 404 for non-existent token", async () => {
    mockFindUnique.mockResolvedValue(null);

    const req = createRequest("DELETE", "http://localhost/api/extension/token", {
      headers: { Authorization: `Bearer ${"b".repeat(64)}` },
    });
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("EXTENSION_TOKEN_INVALID");
  });

  it("returns 400 for already revoked token", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: DEFAULT_SESSION.user.id,
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: new Date("2025-01-01"),
    });

    const req = createRequest("DELETE", "http://localhost/api/extension/token", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("EXTENSION_TOKEN_REVOKED");
  });

  it("returns 400 for expired token", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: DEFAULT_SESSION.user.id,
      scope: "passwords:read",
      expiresAt: new Date("2020-01-01"),
      revokedAt: null,
    });

    const req = createRequest("DELETE", "http://localhost/api/extension/token", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("EXTENSION_TOKEN_EXPIRED");
  });

  it("returns 404 when no Bearer header", async () => {
    const req = createRequest("DELETE", "http://localhost/api/extension/token");
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("EXTENSION_TOKEN_INVALID");
  });
});
