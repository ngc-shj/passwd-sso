import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── vi.hoisted mocks ──────────────────────────────────────────
const { mockFindUnique, mockUpdate } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    scimToken: {
      findUnique: mockFindUnique,
      update: mockUpdate,
    },
  },
}));

vi.mock("@/lib/crypto-server", () => ({
  hashToken: (token: string) => `hashed:${token}`,
}));

import {
  validateScimToken,
  SCIM_SYSTEM_USER_ID,
} from "./scim-token";

// ─── Helpers ────────────────────────────────────────────────────

function bearerRequest(token: string): NextRequest {
  return new NextRequest("http://localhost/api/scim/v2/Users", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function makeToken(overrides: Record<string, unknown> = {}) {
  return {
    id: "tok-1",
    orgId: "org-1",
    createdById: "user-1",
    revokedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("validateScimToken", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T00:00:00Z"));
    mockUpdate.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Success cases ──────────────────────────────────────────

  it("returns ok with valid token data", async () => {
    mockFindUnique.mockResolvedValue(makeToken());

    const result = await validateScimToken(bearerRequest("scim_abc123"));

    expect(result).toEqual({
      ok: true,
      data: {
        tokenId: "tok-1",
        orgId: "org-1",
        createdById: "user-1",
        auditUserId: "user-1",
      },
    });
  });

  it("falls back to SCIM_SYSTEM_USER_ID when createdById is null", async () => {
    mockFindUnique.mockResolvedValue(makeToken({ createdById: null }));

    const result = await validateScimToken(bearerRequest("scim_abc123"));

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        createdById: null,
        auditUserId: SCIM_SYSTEM_USER_ID,
      }),
    });
  });

  // ─── Rejection cases ───────────────────────────────────────

  it("rejects missing Authorization header", async () => {
    const req = new NextRequest("http://localhost/api/scim/v2/Users");
    const result = await validateScimToken(req);

    expect(result).toEqual({ ok: false, error: "SCIM_TOKEN_INVALID" });
  });

  it("rejects non-Bearer auth", async () => {
    const req = new NextRequest("http://localhost/api/scim/v2/Users", {
      headers: { authorization: "Basic abc123" },
    });
    const result = await validateScimToken(req);

    expect(result).toEqual({ ok: false, error: "SCIM_TOKEN_INVALID" });
  });

  it("rejects token without scim_ prefix", async () => {
    const result = await validateScimToken(bearerRequest("no_prefix_token"));

    expect(result).toEqual({ ok: false, error: "SCIM_TOKEN_INVALID" });
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("rejects token with wrong prefix", async () => {
    const result = await validateScimToken(bearerRequest("ext_wrong_prefix"));

    expect(result).toEqual({ ok: false, error: "SCIM_TOKEN_INVALID" });
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("rejects unknown token (DB miss)", async () => {
    mockFindUnique.mockResolvedValue(null);

    const result = await validateScimToken(bearerRequest("scim_unknown"));

    expect(result).toEqual({ ok: false, error: "SCIM_TOKEN_INVALID" });
  });

  it("rejects revoked token", async () => {
    mockFindUnique.mockResolvedValue(
      makeToken({ revokedAt: new Date("2025-01-01") }),
    );

    const result = await validateScimToken(bearerRequest("scim_revoked"));

    expect(result).toEqual({ ok: false, error: "SCIM_TOKEN_REVOKED" });
  });

  it("rejects expired token", async () => {
    // System time = 2025-06-01, expiresAt = 2025-05-31
    mockFindUnique.mockResolvedValue(
      makeToken({ expiresAt: new Date("2025-05-31T00:00:00Z") }),
    );

    const result = await validateScimToken(bearerRequest("scim_expired"));

    expect(result).toEqual({ ok: false, error: "SCIM_TOKEN_EXPIRED" });
  });

  it("accepts token that has not yet expired", async () => {
    // System time = 2025-06-01, expiresAt = 2025-12-31
    mockFindUnique.mockResolvedValue(
      makeToken({ expiresAt: new Date("2025-12-31T00:00:00Z") }),
    );

    const result = await validateScimToken(bearerRequest("scim_valid"));

    expect(result).toEqual({ ok: true, data: expect.objectContaining({ orgId: "org-1" }) });
  });

  // ─── lastUsedAt throttle ────────────────────────────────────

  it("updates lastUsedAt when null (first use)", async () => {
    mockFindUnique.mockResolvedValue(makeToken({ lastUsedAt: null }));

    await validateScimToken(bearerRequest("scim_first"));

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "tok-1" },
      data: { lastUsedAt: new Date("2025-06-01T00:00:00Z") },
    });
  });

  it("updates lastUsedAt when more than 5 minutes have elapsed", async () => {
    const tenMinutesAgo = new Date("2025-05-31T23:50:00Z");
    mockFindUnique.mockResolvedValue(makeToken({ lastUsedAt: tenMinutesAgo }));

    await validateScimToken(bearerRequest("scim_stale"));

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "tok-1" },
      data: { lastUsedAt: new Date("2025-06-01T00:00:00Z") },
    });
  });

  it("skips lastUsedAt update when within 5 minutes", async () => {
    const twoMinutesAgo = new Date("2025-05-31T23:58:00Z");
    mockFindUnique.mockResolvedValue(makeToken({ lastUsedAt: twoMinutesAgo }));

    await validateScimToken(bearerRequest("scim_recent"));

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("does not block on lastUsedAt update failure", async () => {
    mockFindUnique.mockResolvedValue(makeToken({ lastUsedAt: null }));
    mockUpdate.mockRejectedValue(new Error("DB write failed"));

    const result = await validateScimToken(bearerRequest("scim_fail"));

    // Should still return ok
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ orgId: "org-1" }),
    });
  });

  // ─── DB lookup verification ─────────────────────────────────

  it("hashes the token before DB lookup", async () => {
    mockFindUnique.mockResolvedValue(makeToken());

    await validateScimToken(bearerRequest("scim_abc123"));

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { tokenHash: "hashed:scim_abc123" },
      select: {
        id: true,
        orgId: true,
        createdById: true,
        revokedAt: true,
        expiresAt: true,
        lastUsedAt: true,
      },
    });
  });
});
