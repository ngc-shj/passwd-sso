import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { RateLimiterOptions } from "@/lib/security/rate-limit";

const { mockLogAuditAsync, mockLimiterCheck, mockCreateRateLimiter } = vi.hoisted(() => {
  const mockLimiterCheck = vi.fn();
  return {
    mockLogAuditAsync: vi.fn(),
    mockLimiterCheck,
    mockCreateRateLimiter: vi.fn((_options: RateLimiterOptions) => ({ check: mockLimiterCheck, clear: vi.fn() })),
  };
});

vi.mock("@/lib/audit/audit", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  logAuditAsync: mockLogAuditAsync,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));

import {
  API_ROUTE_KEYS,
  auditSessionPasskeyBlock,
  blockedPath,
  isApiDefaultSessionReader,
  isSessionGateOwnGate,
  isSessionGateTierA,
  isSessionGateTierB,
  _resetSessionPasskeyAuditForTests,
} from "./session-passkey-gate";
import { PASSKEY_AUDIT_DEDUP_MS } from "@/lib/auth/policy/passkey-enforcement";

// Read before any per-test reset: the limiter is built once, at import.
const limiterOptions = mockCreateRateLimiter.mock.calls[0]?.[0];

describe("isSessionGateTierA", () => {
  it.each([
    ["GET", "/api/auth/session"],
    ["POST", "/api/auth/session"],
    ["GET", "/api/auth/csrf"],
    ["GET", "/api/auth/providers"],
    ["GET", "/api/auth/error"],
    ["GET", "/api/auth/verify-request"],
    ["GET", "/api/auth/signin"],
    ["POST", "/api/auth/signin"],
    ["POST", "/api/auth/signin/google"],
    ["GET", "/api/auth/callback/google"],
    ["POST", "/api/auth/callback/nodemailer"],
    ["GET", "/api/auth/signout"],
    ["POST", "/api/auth/signout"],
    ["POST", "/api/auth/passkey/options"],
    ["POST", "/api/auth/passkey/options/email"],
    ["POST", "/api/auth/passkey/verify"],
    ["POST", "/api/internal/audit-emit"],
  ])("exempts %s %s", (method, path) => {
    expect(isSessionGateTierA(method, path)).toBe(true);
  });

  // Auth.js drops empty segments when it parses the action, so these are the
  // same request to it; the proxy reads them the same way.
  it.each([
    ["GET", "/api/auth/session/"],
    ["GET", "/api/auth//session"],
    ["GET", "/api/auth/callback//google"],
  ])("reads %s %s as Auth.js does", (method, path) => {
    expect(isSessionGateTierA(method, path)).toBe(true);
  });

  it.each([
    ["GET", "/api/auth/signin/google", "signin/<id> is POST-only"],
    ["GET", "/api/auth/callback", "callback needs a provider ID"],
    ["GET", "/api/auth/callback/google/extra", "a provider ID is one segment"],
    ["GET", "/api/auth/session/extra", "session takes no provider ID"],
    ["PUT", "/api/auth/session", "method not listed"],
    ["POST", "/api/auth/csrf", "csrf is GET-only"],
    ["GET", "/api/authsession", "no prefix match without the separator"],
    ["GET", "/api/auth", "the base is not an action"],
    ["POST", "/api/auth/passkey/reauth/options", "passkey reauth is not exempt"],
    ["POST", "/api/auth/passkey/reauth/verify", "passkey reauth is not exempt"],
    ["GET", "/api/auth/passkey/options", "pre-auth passkey routes are POST-only"],
    ["POST", "/api/auth/passkey/options/", "exact paths outside Auth.js are exact"],
    ["GET", "/api/internal/audit-emit", "audit-emit is POST-only"],
    ["POST", "/api/internal/audit-emit/x", "no prefix match"],
  ])("does not exempt %s %s (%s)", (method, path) => {
    expect(isSessionGateTierA(method, path)).toBe(false);
  });
});

describe("isSessionGateTierB", () => {
  it.each([
    ["GET", "/api/webauthn/credentials"],
    ["POST", "/api/webauthn/register/options"],
    ["POST", "/api/webauthn/register/verify"],
    ["GET", "/api/user/auth-provider"],
    ["DELETE", "/api/vault/delegation"],
  ])("exempts %s %s", (method, path) => {
    expect(isSessionGateTierB(method, path)).toBe(true);
  });

  it.each([
    ["DELETE", "/api/webauthn/credentials/cred-1"],
    ["POST", "/api/webauthn/credentials"],
    ["GET", "/api/webauthn/register/options"],
    ["POST", "/api/vault/delegation"],
    ["DELETE", "/api/vault/delegation/del-1"],
    ["GET", "/api/vault/status"],
    ["GET", "/api/user/passkey-status"],
    ["GET", "/api/webauthn/credentials/"],
  ])("does not exempt %s %s", (method, path) => {
    expect(isSessionGateTierB(method, path)).toBe(false);
  });
});

describe("isSessionGateOwnGate and isApiDefaultSessionReader", () => {
  it.each([
    ["GET", "/api/mobile/authorize", true],
    ["GET", "/api/mcp/authorize", true],
    ["POST", "/api/mcp/authorize/consent", true],
    ["POST", "/api/mobile/authorize", false],
    ["GET", "/api/mobile/authorize/redirect", false],
    ["GET", "/api/mcp/authorize/consent", false],
  ])("own-gate %s %s → %s", (method, path, expected) => {
    expect(isSessionGateOwnGate(method, path)).toBe(expected);
  });

  it.each([
    ["POST", "/api/auth/passkey/reauth/options", true],
    ["POST", "/api/auth/passkey/reauth/verify", true],
    ["GET", "/api/auth/passkey/reauth/options", false],
    ["POST", "/api/mobile/autofill-token", false],
  ])("session reader %s %s → %s", (method, path, expected) => {
    expect(isApiDefaultSessionReader(method, path)).toBe(expected);
  });
});

describe("blockedPath", () => {
  it("is the method and the top-level route directory", () => {
    expect(blockedPath("GET", "/api/passwords/entry-123/history")).toBe("GET /api/passwords");
  });

  it.each(["/api/no-such-dir", "/api/", "/api", "/dashboard", "/api/PASSWORDS"])(
    "collapses the first segment of %s to `other`",
    (path) => {
      expect(blockedPath("GET", path)).toBe("GET /api/other");
    },
  );

  it.each(["HEAD", "OPTIONS", "get", "PROPFIND"])("writes the method %s as OTHER", (method) => {
    expect(blockedPath(method, "/api/passwords")).toBe("OTHER /api/passwords");
  });

  it("keeps every closed-set method", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(blockedPath(method, "/api/tags")).toBe(`${method} /api/tags`);
    }
  });

  it("API_ROUTE_KEYS equals the top-level directories under src/app/api", () => {
    const apiDir = join(process.cwd(), "src", "app", "api");
    const dirs = readdirSync(apiDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect([...API_ROUTE_KEYS].sort()).toEqual(dirs);
  });
});

describe("auditSessionPasskeyBlock", () => {
  function req(): NextRequest {
    return new NextRequest("http://localhost/api/passwords", {
      headers: { "x-forwarded-for": "203.0.113.7", "user-agent": "test-agent" },
    });
  }

  beforeEach(() => {
    mockLogAuditAsync.mockReset().mockResolvedValue(undefined);
    mockLimiterCheck.mockReset().mockResolvedValue({ allowed: true });
  });

  it("builds a Redis-shared max-1 limiter over the dedup window, not fail-closed", () => {
    expect(limiterOptions).toEqual({ windowMs: PASSKEY_AUDIT_DEDUP_MS, max: 1 });
    expect(limiterOptions?.failClosedOnRedisError).toBeUndefined();
  });

  it("keys the limiter on user and blockedPath, and writes the blocked row", async () => {
    await auditSessionPasskeyBlock({
      req: req(),
      userId: "u-1",
      tenantId: "t-1",
      blockedPath: "GET /api/passwords",
    });

    expect(mockLimiterCheck).toHaveBeenCalledWith("rl:passkey_session_gate_audit:u-1:GET /api/passwords");
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "PERSONAL",
        userId: "u-1",
        tenantId: "t-1",
        action: "PASSKEY_ENFORCEMENT_BLOCKED",
        metadata: { blockedPath: "GET /api/passwords" },
      }),
    );
  });

  it("writes nothing when the limiter refuses", async () => {
    mockLimiterCheck.mockResolvedValue({ allowed: false });
    await auditSessionPasskeyBlock({
      req: req(),
      userId: "u-1",
      tenantId: "t-1",
      blockedPath: "GET /api/passwords",
    });
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("the test reset rebuilds the limiter with the same options", () => {
    const before = mockCreateRateLimiter.mock.calls.length;
    _resetSessionPasskeyAuditForTests();
    expect(mockCreateRateLimiter.mock.calls.length).toBe(before + 1);
    expect(mockCreateRateLimiter.mock.calls.at(-1)?.[0]).toEqual(limiterOptions);
  });
});
