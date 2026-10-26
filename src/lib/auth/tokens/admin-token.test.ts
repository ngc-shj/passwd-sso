import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { mockValidateOperatorToken } = vi.hoisted(() => ({
  mockValidateOperatorToken: vi.fn(),
}));

vi.mock("@/lib/auth/tokens/operator-token", () => ({
  validateOperatorToken: mockValidateOperatorToken,
}));

import { verifyAdminToken } from "./admin-token";
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";

// A valid 46-char op_ token plaintext
const VALID_OP_TOKEN = `${OPERATOR_TOKEN_PREFIX}${"a".repeat(43)}`;

function makeRequest(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) {
    headers.Authorization = authHeader;
  }
  return new NextRequest("http://localhost:3000/api/admin/test", { headers });
}

/** Assert a failure result's ready-made response has this status + error code. */
async function expectFailureBody(
  result: { ok: false; response: NextResponse },
  status: number,
  error: string,
) {
  expect(result.response.status).toBe(status);
  await expect(result.response.json()).resolves.toEqual({ error });
}

const VALID_AUTH = {
  tokenId: "token-1",
  subjectUserId: "user-1",
  tenantId: "tenant-1",
  scopes: ["maintenance"] as const,
};

describe("verifyAdminToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("MISSING_OR_MALFORMED cases (no DB call)", () => {
    it("returns MISSING_OR_MALFORMED when Authorization header is absent", async () => {
      const result = await verifyAdminToken(makeRequest());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("MISSING_OR_MALFORMED");
        await expectFailureBody(result, 401, "UNAUTHORIZED");
      }
      expect(mockValidateOperatorToken).not.toHaveBeenCalled();
    });

    it("returns MISSING_OR_MALFORMED for non-Bearer scheme (Basic auth)", async () => {
      const result = await verifyAdminToken(makeRequest("Basic dXNlcjpwYXNz"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("MISSING_OR_MALFORMED");
      expect(mockValidateOperatorToken).not.toHaveBeenCalled();
    });

    it("returns MISSING_OR_MALFORMED for empty Bearer value", async () => {
      const result = await verifyAdminToken(makeRequest("Bearer "));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("MISSING_OR_MALFORMED");
      expect(mockValidateOperatorToken).not.toHaveBeenCalled();
    });

    it("returns MISSING_OR_MALFORMED for legacy 64-hex token (no op_ prefix)", async () => {
      const legacyHex = "a".repeat(64);
      const result = await verifyAdminToken(makeRequest(`Bearer ${legacyHex}`));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("MISSING_OR_MALFORMED");
      expect(mockValidateOperatorToken).not.toHaveBeenCalled();
    });

    it("returns MISSING_OR_MALFORMED for random non-prefixed string", async () => {
      const result = await verifyAdminToken(makeRequest("Bearer some-random-token"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("MISSING_OR_MALFORMED");
      expect(mockValidateOperatorToken).not.toHaveBeenCalled();
    });

    it("returns MISSING_OR_MALFORMED for sa_ prefixed token", async () => {
      const result = await verifyAdminToken(makeRequest("Bearer sa_sometoken"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("MISSING_OR_MALFORMED");
      expect(mockValidateOperatorToken).not.toHaveBeenCalled();
    });
  });

  describe("INVALID cases (DB call fires, token fails validation)", () => {
    it("returns INVALID (401) when validateOperatorToken returns OPERATOR_TOKEN_INVALID", async () => {
      mockValidateOperatorToken.mockResolvedValue({
        ok: false,
        error: "OPERATOR_TOKEN_INVALID",
      });

      const result = await verifyAdminToken(makeRequest(`Bearer ${VALID_OP_TOKEN}`));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("INVALID");
        await expectFailureBody(result, 401, "UNAUTHORIZED");
      }
      expect(mockValidateOperatorToken).toHaveBeenCalledOnce();
    });

    it("returns INVALID (401) when validateOperatorToken returns OPERATOR_TOKEN_REVOKED", async () => {
      mockValidateOperatorToken.mockResolvedValue({
        ok: false,
        error: "OPERATOR_TOKEN_REVOKED",
      });

      const result = await verifyAdminToken(makeRequest(`Bearer ${VALID_OP_TOKEN}`));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("INVALID");
    });

    it("returns INVALID (401) when validateOperatorToken returns OPERATOR_TOKEN_EXPIRED", async () => {
      mockValidateOperatorToken.mockResolvedValue({
        ok: false,
        error: "OPERATOR_TOKEN_EXPIRED",
      });

      const result = await verifyAdminToken(makeRequest(`Bearer ${VALID_OP_TOKEN}`));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("INVALID");
    });

    it("returns PASSKEY_REQUIRED (403) when validateOperatorToken returns PASSKEY_REQUIRED", async () => {
      mockValidateOperatorToken.mockResolvedValue({
        ok: false,
        error: "PASSKEY_REQUIRED",
      });

      const result = await verifyAdminToken(makeRequest(`Bearer ${VALID_OP_TOKEN}`));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("PASSKEY_REQUIRED");
        await expectFailureBody(result, 403, "PASSKEY_REQUIRED");
      }
    });
  });

  describe("success path", () => {
    it("returns ok:true with AdminAuth when validateOperatorToken succeeds", async () => {
      mockValidateOperatorToken.mockResolvedValue({
        ok: true,
        data: VALID_AUTH,
      });

      const result = await verifyAdminToken(makeRequest(`Bearer ${VALID_OP_TOKEN}`));
      expect(result).toEqual({
        ok: true,
        auth: {
          subjectUserId: "user-1",
          tenantId: "tenant-1",
          tokenId: "token-1",
          scopes: ["maintenance"],
        },
      });
    });

    // T-2: fail-closed propagation — a derivation error from the validator
    // must not be swallowed into a success/deny result (paired with the
    // success cell above).
    it("propagates a derivation error from validateOperatorToken rather than swallowing it", async () => {
      mockValidateOperatorToken.mockRejectedValue(new Error("derivation failed"));

      await expect(
        verifyAdminToken(makeRequest(`Bearer ${VALID_OP_TOKEN}`)),
      ).rejects.toThrow("derivation failed");
    });
  });
});
