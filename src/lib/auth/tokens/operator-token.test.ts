import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockHashToken, mockWithBypassRls } = vi.hoisted(() => ({
  mockPrisma: {
    operatorToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  mockHashToken: vi.fn(),
  mockWithBypassRls: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/crypto/crypto-server", () => ({ hashToken: mockHashToken }));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import {
  validateOperatorToken,
  parseOperatorTokenScopes,
  hasOperatorTokenScope,
} from "./operator-token";
import {
  OPERATOR_TOKEN_PREFIX,
  OPERATOR_TOKEN_LAST_USED_THROTTLE_MS,
} from "@/lib/constants/auth/operator-token";

// A valid 46-char plaintext: op_ + 43 base64url chars
const VALID_PLAINTEXT = `${OPERATOR_TOKEN_PREFIX}${"a".repeat(43)}`;

function makeRequest(bearerToken?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (bearerToken !== undefined) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  return new NextRequest("http://localhost:3000/api/test", { headers });
}

function makeTokenRow(overrides: Partial<{
  id: string;
  subjectUserId: string;
  tenantId: string;
  scope: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}> = {}) {
  return {
    id: "token-1",
    subjectUserId: "user-1",
    tenantId: "tenant-1",
    scope: "maintenance",
    expiresAt: new Date(Date.now() + 86400_000),
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

describe("parseOperatorTokenScopes", () => {
  it("parses the maintenance scope", () => {
    expect(parseOperatorTokenScopes("maintenance")).toEqual(["maintenance"]);
  });

  it("drops unknown scopes", () => {
    expect(parseOperatorTokenScopes("maintenance,unknown")).toEqual(["maintenance"]);
  });

  it("returns empty array for empty string", () => {
    expect(parseOperatorTokenScopes("")).toEqual([]);
  });

  it("trims whitespace around scope entries", () => {
    expect(parseOperatorTokenScopes(" maintenance , unknown ")).toEqual(["maintenance"]);
  });
});

describe("hasOperatorTokenScope", () => {
  it("returns true when scope is present", () => {
    expect(hasOperatorTokenScope(["maintenance"], "maintenance")).toBe(true);
  });

  it("returns false when scope is absent", () => {
    expect(hasOperatorTokenScope([], "maintenance")).toBe(false);
  });
});

describe("validateOperatorToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHashToken.mockReturnValue("hashed_token");
    mockWithBypassRls.mockImplementation((_p: unknown, fn: () => unknown) => fn());
  });

  it("returns INVALID_TOKEN_TYPE when Authorization header is missing", async () => {
    const result = await validateOperatorToken(makeRequest());
    expect(result).toEqual({ ok: false, error: "INVALID_TOKEN_TYPE" });
  });

  it("returns INVALID_TOKEN_TYPE when token has wrong prefix (sa_)", async () => {
    const result = await validateOperatorToken(makeRequest("sa_test123"));
    expect(result).toEqual({ ok: false, error: "INVALID_TOKEN_TYPE" });
  });

  it("returns INVALID_TOKEN_TYPE when token has wrong prefix (api_)", async () => {
    const result = await validateOperatorToken(makeRequest("api_test123"));
    expect(result).toEqual({ ok: false, error: "INVALID_TOKEN_TYPE" });
  });

  it("returns OPERATOR_TOKEN_INVALID when op_ prefix present but wrong length", async () => {
    // Has op_ prefix but only 3 chars after — fails the regex
    const result = await validateOperatorToken(makeRequest("op_short"));
    expect(result).toEqual({ ok: false, error: "OPERATOR_TOKEN_INVALID" });
  });

  it("returns OPERATOR_TOKEN_INVALID when token not found in DB", async () => {
    mockPrisma.operatorToken.findUnique.mockResolvedValue(null);

    const result = await validateOperatorToken(makeRequest(VALID_PLAINTEXT));
    expect(result).toEqual({ ok: false, error: "OPERATOR_TOKEN_INVALID" });
  });

  it("returns OPERATOR_TOKEN_REVOKED when token has revokedAt set", async () => {
    mockPrisma.operatorToken.findUnique.mockResolvedValue(
      makeTokenRow({ revokedAt: new Date() }),
    );

    const result = await validateOperatorToken(makeRequest(VALID_PLAINTEXT));
    expect(result).toEqual({ ok: false, error: "OPERATOR_TOKEN_REVOKED" });
  });

  it("returns OPERATOR_TOKEN_EXPIRED when expiresAt is in the past", async () => {
    mockPrisma.operatorToken.findUnique.mockResolvedValue(
      makeTokenRow({ expiresAt: new Date(Date.now() - 1000) }),
    );

    const result = await validateOperatorToken(makeRequest(VALID_PLAINTEXT));
    expect(result).toEqual({ ok: false, error: "OPERATOR_TOKEN_EXPIRED" });
  });

  it("returns valid result for a valid token and fires lastUsedAt update when null", async () => {
    mockPrisma.operatorToken.findUnique.mockResolvedValue(makeTokenRow());
    mockPrisma.operatorToken.update.mockResolvedValue({});

    const result = await validateOperatorToken(makeRequest(VALID_PLAINTEXT));
    expect(result).toEqual({
      ok: true,
      data: {
        tokenId: "token-1",
        subjectUserId: "user-1",
        tenantId: "tenant-1",
        scopes: ["maintenance"],
      },
    });
    // Non-blocking update should be fired (lastUsedAt was null)
    await vi.waitFor(() =>
      expect(mockPrisma.operatorToken.update).toHaveBeenCalledWith({
        where: { id: "token-1" },
        data: { lastUsedAt: expect.any(Date) },
      }),
    );
  });

  it("throttles lastUsedAt update when recently used (within throttle window)", async () => {
    // lastUsedAt = just now → should NOT trigger update
    mockPrisma.operatorToken.findUnique.mockResolvedValue(
      makeTokenRow({ lastUsedAt: new Date() }),
    );

    const result = await validateOperatorToken(makeRequest(VALID_PLAINTEXT));
    expect(result.ok).toBe(true);
    // Give any async update a chance to run, then assert it was NOT called
    await new Promise((r) => setTimeout(r, 10));
    expect(mockPrisma.operatorToken.update).not.toHaveBeenCalled();
  });

  it("fires lastUsedAt update when throttle window has elapsed", async () => {
    vi.useFakeTimers();
    try {
      // Seed lastUsedAt to now
      const lastUsed = new Date();
      mockPrisma.operatorToken.findUnique.mockResolvedValue(
        makeTokenRow({ lastUsedAt: lastUsed }),
      );
      mockPrisma.operatorToken.update.mockResolvedValue({});

      // Advance past the throttle window
      vi.advanceTimersByTime(OPERATOR_TOKEN_LAST_USED_THROTTLE_MS + 1000);

      const result = await validateOperatorToken(makeRequest(VALID_PLAINTEXT));
      expect(result.ok).toBe(true);

      // Let any microtasks flush
      await Promise.resolve();

      expect(mockPrisma.operatorToken.update).toHaveBeenCalledWith({
        where: { id: "token-1" },
        data: { lastUsedAt: expect.any(Date) },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("imports OPERATOR_TOKEN_PREFIX and OPERATOR_TOKEN_LAST_USED_THROTTLE_MS as string/number", () => {
    expect(typeof OPERATOR_TOKEN_PREFIX).toBe("string");
    expect(OPERATOR_TOKEN_PREFIX).toBe("op_");
    expect(typeof OPERATOR_TOKEN_LAST_USED_THROTTLE_MS).toBe("number");
    expect(OPERATOR_TOKEN_LAST_USED_THROTTLE_MS).toBeGreaterThan(0);
  });
});
