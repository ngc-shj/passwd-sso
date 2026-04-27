import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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
      expect(result).toEqual({ ok: false, reason: "MISSING_OR_MALFORMED" });
      expect(mockValidateOperatorToken).not.toHaveBeenCalled();
    });

    it("returns MISSING_OR_MALFORMED for non-Bearer scheme (Basic auth)", async () => {
      const result = await verifyAdminToken(makeRequest("Basic dXNlcjpwYXNz"));
      expect(result).toEqual({ ok: false, reason: "MISSING_OR_MALFORMED" });
      expect(mockValidateOperatorToken).not.toHaveBeenCalled();
    });

    it("returns MISSING_OR_MALFORMED for empty Bearer value", async () => {
      const result = await verifyAdminToken(makeRequest("Bearer "));
      expect(result).toEqual({ ok: false, reason: "MISSING_OR_MALFORMED" });
      expect(mockValidateOperatorToken).not.toHaveBeenCalled();
    });

    it("returns MISSING_OR_MALFORMED for legacy 64-hex token (no op_ prefix)", async () => {
      const legacyHex = "a".repeat(64);
      const result = await verifyAdminToken(makeRequest(`Bearer ${legacyHex}`));
      expect(result).toEqual({ ok: false, reason: "MISSING_OR_MALFORMED" });
      expect(mockValidateOperatorToken).not.toHaveBeenCalled();
    });

    it("returns MISSING_OR_MALFORMED for random non-prefixed string", async () => {
      const result = await verifyAdminToken(makeRequest("Bearer some-random-token"));
      expect(result).toEqual({ ok: false, reason: "MISSING_OR_MALFORMED" });
      expect(mockValidateOperatorToken).not.toHaveBeenCalled();
    });

    it("returns MISSING_OR_MALFORMED for sa_ prefixed token", async () => {
      const result = await verifyAdminToken(makeRequest("Bearer sa_sometoken"));
      expect(result).toEqual({ ok: false, reason: "MISSING_OR_MALFORMED" });
      expect(mockValidateOperatorToken).not.toHaveBeenCalled();
    });
  });

  describe("INVALID cases (DB call fires, token fails validation)", () => {
    it("returns INVALID when validateOperatorToken returns OPERATOR_TOKEN_INVALID", async () => {
      mockValidateOperatorToken.mockResolvedValue({
        ok: false,
        error: "OPERATOR_TOKEN_INVALID",
      });

      const result = await verifyAdminToken(makeRequest(`Bearer ${VALID_OP_TOKEN}`));
      expect(result).toEqual({ ok: false, reason: "INVALID" });
      expect(mockValidateOperatorToken).toHaveBeenCalledOnce();
    });

    it("returns INVALID when validateOperatorToken returns OPERATOR_TOKEN_REVOKED", async () => {
      mockValidateOperatorToken.mockResolvedValue({
        ok: false,
        error: "OPERATOR_TOKEN_REVOKED",
      });

      const result = await verifyAdminToken(makeRequest(`Bearer ${VALID_OP_TOKEN}`));
      expect(result).toEqual({ ok: false, reason: "INVALID" });
    });

    it("returns INVALID when validateOperatorToken returns OPERATOR_TOKEN_EXPIRED", async () => {
      mockValidateOperatorToken.mockResolvedValue({
        ok: false,
        error: "OPERATOR_TOKEN_EXPIRED",
      });

      const result = await verifyAdminToken(makeRequest(`Bearer ${VALID_OP_TOKEN}`));
      expect(result).toEqual({ ok: false, reason: "INVALID" });
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
  });
});
