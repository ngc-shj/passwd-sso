import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { mockAuth, mockAuthOrToken, mockEnforceAccessRestriction } = vi.hoisted(
  () => ({
    mockAuth: vi.fn(),
    mockAuthOrToken: vi.fn(),
    mockEnforceAccessRestriction: vi.fn(),
  }),
);

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth-or-token", () => ({
  authOrToken: mockAuthOrToken,
}));
vi.mock("@/lib/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));

import { checkAuth } from "./check-auth";

function makeRequest(bearerToken?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  return new NextRequest("http://localhost:3000/api/test", { headers });
}

describe("checkAuth", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockAuthOrToken.mockReset();
    mockEnforceAccessRestriction.mockReset();
    // Default: access restriction allows
    mockEnforceAccessRestriction.mockResolvedValue(null);
  });

  // ── Session-only mode ────────────────────────────────────

  describe("session-only mode (no options)", () => {
    it("returns ok with session auth when session is valid", async () => {
      mockAuth.mockResolvedValue({ user: { id: "user-1" } });

      const result = await checkAuth(makeRequest());

      expect(result).toEqual({
        ok: true,
        auth: { type: "session", userId: "user-1" },
      });
      expect(mockAuthOrToken).not.toHaveBeenCalled();
      expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
    });

    it("returns 401 when session is absent", async () => {
      mockAuth.mockResolvedValue(null);

      const result = await checkAuth(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const json = await result.response.json();
        expect(result.response.status).toBe(401);
        expect(json.error).toBe("UNAUTHORIZED");
      }
      expect(mockAuthOrToken).not.toHaveBeenCalled();
    });

    it("returns 401 when session has no user id", async () => {
      mockAuth.mockResolvedValue({ user: {} });

      const result = await checkAuth(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(401);
      }
    });
  });

  // ── Token-aware mode (with scope) ────────────────────────

  describe("token-aware mode (with scope)", () => {
    it("returns session auth when session is valid (scope mode)", async () => {
      mockAuthOrToken.mockResolvedValue({
        type: "session",
        userId: "user-1",
      });

      const result = await checkAuth(makeRequest(), {
        scope: "passwords:read" as any,
      });

      expect(result).toEqual({
        ok: true,
        auth: { type: "session", userId: "user-1" },
      });
      expect(mockAuthOrToken).toHaveBeenCalledWith(
        expect.any(NextRequest),
        "passwords:read",
      );
      // Session auth: no access restriction
      expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
    });

    it("returns extension token auth with access restriction check", async () => {
      const req = makeRequest("ext_token");
      mockAuthOrToken.mockResolvedValue({
        type: "token",
        userId: "user-2",
        scopes: ["passwords:read"],
      });

      const result = await checkAuth(req, {
        scope: "passwords:read" as any,
      });

      expect(result).toEqual({
        ok: true,
        auth: {
          type: "token",
          userId: "user-2",
          scopes: ["passwords:read"],
        },
      });
      expect(mockEnforceAccessRestriction).toHaveBeenCalledWith(
        req,
        "user-2",
        undefined,
      );
    });

    it("returns API key auth with tenantId passed to access restriction", async () => {
      const req = makeRequest("api_key123");
      mockAuthOrToken.mockResolvedValue({
        type: "api_key",
        userId: "user-3",
        tenantId: "tenant-1",
        apiKeyId: "ak-1",
        scopes: ["passwords:read"],
      });

      const result = await checkAuth(req, {
        scope: "passwords:read" as any,
      });

      expect(result).toEqual({
        ok: true,
        auth: {
          type: "api_key",
          userId: "user-3",
          tenantId: "tenant-1",
          apiKeyId: "ak-1",
          scopes: ["passwords:read"],
        },
      });
      expect(mockEnforceAccessRestriction).toHaveBeenCalledWith(
        req,
        "user-3",
        "tenant-1",
      );
    });

    it("returns 403 when scope is insufficient", async () => {
      mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });

      const result = await checkAuth(makeRequest(), {
        scope: "passwords:write" as any,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const json = await result.response.json();
        expect(result.response.status).toBe(403);
        expect(json.error).toBe("EXTENSION_TOKEN_SCOPE_INSUFFICIENT");
      }
    });

    it("returns 401 when no auth succeeds", async () => {
      mockAuthOrToken.mockResolvedValue(null);

      const result = await checkAuth(makeRequest(), {
        scope: "passwords:read" as any,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const json = await result.response.json();
        expect(result.response.status).toBe(401);
        expect(json.error).toBe("UNAUTHORIZED");
      }
    });

    it("returns access denied when enforceAccessRestriction rejects (token)", async () => {
      const req = makeRequest("ext_token");
      mockAuthOrToken.mockResolvedValue({
        type: "token",
        userId: "user-4",
        scopes: ["passwords:read"],
      });
      const deniedResponse = NextResponse.json(
        { error: "ACCESS_DENIED" },
        { status: 403 },
      );
      mockEnforceAccessRestriction.mockResolvedValue(deniedResponse);

      const result = await checkAuth(req, {
        scope: "passwords:read" as any,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response).toBe(deniedResponse);
      }
    });

    it("returns access denied for api_key with tenantId passed to access restriction", async () => {
      const req = makeRequest("api_key_xyz");
      mockAuthOrToken.mockResolvedValue({
        type: "api_key",
        userId: "user-9",
        tenantId: "tenant-2",
        apiKeyId: "ak-2",
        scopes: ["passwords:read"],
      });
      const deniedResponse = NextResponse.json(
        { error: "ACCESS_DENIED" },
        { status: 403 },
      );
      mockEnforceAccessRestriction.mockResolvedValue(deniedResponse);

      const result = await checkAuth(req, {
        scope: "passwords:read" as any,
      });

      expect(result.ok).toBe(false);
      expect(mockEnforceAccessRestriction).toHaveBeenCalledWith(
        req,
        "user-9",
        "tenant-2",
      );
    });
  });

  // ── skipAccessRestriction ────────────────────────────────

  describe("skipAccessRestriction option", () => {
    it("skips access restriction when option is true", async () => {
      mockAuthOrToken.mockResolvedValue({
        type: "token",
        userId: "user-5",
        scopes: ["passwords:read"],
      });

      const result = await checkAuth(makeRequest("ext_token"), {
        scope: "passwords:read" as any,
        skipAccessRestriction: true,
      });

      expect(result.ok).toBe(true);
      expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
    });
  });

  // ── allowTokens option ───────────────────────────────────

  describe("allowTokens option", () => {
    it("enables token auth without scope when allowTokens is true", async () => {
      mockAuthOrToken.mockResolvedValue({
        type: "token",
        userId: "user-6",
        scopes: [],
      });
      // Suppress console.warn for this test
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await checkAuth(makeRequest("ext_token"), {
        allowTokens: true,
      });

      expect(result.ok).toBe(true);
      expect(mockAuthOrToken).toHaveBeenCalledWith(
        expect.any(NextRequest),
        undefined,
      );
      warnSpy.mockRestore();
    });

    it("emits console.warn when allowTokens is true without scope in development", async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        mockAuthOrToken.mockResolvedValue({
          type: "session",
          userId: "user-7",
        });
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        await checkAuth(makeRequest(), { allowTokens: true });

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("allowTokens is true but no scope is set"),
        );
        warnSpy.mockRestore();
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });
  });

  // ── Invalid option combinations ──────────────────────────

  describe("invalid option combinations", () => {
    it("throws when scope is set with allowTokens: false", async () => {
      await expect(
        checkAuth(makeRequest(), {
          scope: "passwords:read" as any,
          allowTokens: false,
        }),
      ).rejects.toThrow(
        "checkAuth: { scope, allowTokens: false } is invalid",
      );
    });
  });

  // ── Token revocation delegation ──────────────────────────

  describe("token revocation delegation", () => {
    it("delegates to authOrToken which handles revoked tokens (returns null)", async () => {
      // authOrToken returns null for revoked tokens
      mockAuthOrToken.mockResolvedValue(null);

      const result = await checkAuth(makeRequest("revoked_token"), {
        scope: "passwords:read" as any,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(401);
      }
    });
  });

  // ── allowTokens + skipAccessRestriction ──────────────────

  describe("allowTokens + skipAccessRestriction", () => {
    it("allows token auth without access restriction check", async () => {
      mockAuthOrToken.mockResolvedValue({
        type: "token",
        userId: "user-8",
        scopes: [],
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await checkAuth(makeRequest("ext_token"), {
        allowTokens: true,
        skipAccessRestriction: true,
      });

      expect(result.ok).toBe(true);
      expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
