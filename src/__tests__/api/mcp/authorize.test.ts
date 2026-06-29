import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockMcpClientFindFirst, mockUserFindUnique, mockWithBypassRls, mockServerAppUrl, mockDetectLocale, mockRateLimiterCheck, mockRequireRecentSession, mockEmitFailClosed, mockCheckRateLimitOrFail, mockDerivePasskeyState } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockMcpClientFindFirst: vi.fn(),
    mockUserFindUnique: vi.fn(),
    mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
    mockServerAppUrl: vi.fn((path: string) => `http://localhost:3000${path}`),
    mockDetectLocale: vi.fn(() => "en"),
    mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
    mockRequireRecentSession: vi.fn().mockResolvedValue(null),
    mockEmitFailClosed: vi.fn(),
    // Default: helper returns null → route proceeds. Per-test overrides set
    // it to return a response when the test exercises the rate-limited path.
    mockCheckRateLimitOrFail: vi.fn().mockResolvedValue(null),
    mockDerivePasskeyState: vi.fn(),
  }));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/session/step-up", () => ({
  requireRecentSession: mockRequireRecentSession,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpClient: { findFirst: mockMcpClientFindFirst },
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
  BYPASS_PURPOSE: { AUTH_FLOW: "AUTH_FLOW" },
}));
vi.mock("@/lib/url-helpers", () => ({
  serverAppUrl: mockServerAppUrl,
}));
vi.mock("@/i18n/locale-utils", () => ({
  detectBestLocaleFromAcceptLanguage: mockDetectLocale,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/security/rate-limit-audit", () => ({
  emitRateLimitFailClosed: mockEmitFailClosed,
  checkRateLimitOrFail: mockCheckRateLimitOrFail,
}));
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: () => "127.0.0.1",
  rateLimitKeyFromIp: (ip: string) => `rl:${ip}`,
}));
vi.mock("@/lib/auth/policy/passkey-enforcement", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/policy/passkey-enforcement")>();
  return {
    ...real,
    derivePasskeyState: mockDerivePasskeyState,
  };
});

import { GET } from "@/app/api/mcp/authorize/route";

// Valid client registered in DB
// A07-4: isActive must be in WHERE clause; fixture documents the expected shape.
const VALID_CLIENT = {
  redirectUris: ["https://example.com/callback"],
  isActive: true,
};

// Convenience: build URL with common valid OAuth params
function authorizeUrl(overrides: Record<string, string | undefined> = {}): string {
  const base = "http://localhost:3000/api/mcp/authorize";
  const params: Record<string, string> = {
    client_id: "client-abc",
    redirect_uri: "https://example.com/callback",
    response_type: "code",
    code_challenge: "abc123challenge",
    code_challenge_method: "S256",
    scope: "credentials:list",
    state: "random-state",
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v !== undefined) as [string, string][],
    ),
  };
  // Allow callers to omit a param by passing undefined — handled above via filter
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

// Build URL omitting specific keys entirely
function authorizeUrlWithout(...omit: string[]): string {
  const base = "http://localhost:3000/api/mcp/authorize";
  const params: Record<string, string> = {
    client_id: "client-abc",
    redirect_uri: "https://example.com/callback",
    response_type: "code",
    code_challenge: "abc123challenge",
    code_challenge_method: "S256",
    scope: "credentials:list",
    state: "random-state",
  };
  for (const key of omit) {
    delete params[key];
  }
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

describe("GET /api/mcp/authorize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMcpClientFindFirst.mockResolvedValue(VALID_CLIENT);
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-uuid" });
    // Default: passkey enforcement off (gate is a no-op for existing tests).
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
  });

  // -------------------------------------------------------------------------
  // Unauthenticated cases
  // -------------------------------------------------------------------------
  describe("unauthenticated", () => {
    beforeEach(() => {
      mockAuth.mockResolvedValue(null);
    });

    it("returns 400 when clientId is missing", async () => {
      const req = createRequest("GET", authorizeUrlWithout("client_id"));
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
    });

    it("returns 400 when redirectUri is missing", async () => {
      const req = createRequest("GET", authorizeUrlWithout("redirect_uri"));
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
    });

    it("returns 400 when clientId does not exist in DB", async () => {
      mockMcpClientFindFirst.mockResolvedValue(null);
      const req = createRequest("GET", authorizeUrl());
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
    });

    it("returns 400 when redirectUri is not registered for the client", async () => {
      mockMcpClientFindFirst.mockResolvedValue({
        redirectUris: ["https://other.example.com/callback"],
        isActive: true,
      });
      const req = createRequest("GET", authorizeUrl());
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
    });

    it("redirects to login when params are valid", async () => {
      const req = createRequest("GET", authorizeUrl());
      const res = await GET(req);
      expect(res.status).toBe(307);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("/api/auth/signin");
      expect(location).toContain("callbackUrl=");
    });

    it("encodes the full authorize URL as callbackUrl in the login redirect", async () => {
      const req = createRequest("GET", authorizeUrl({ state: "my-state" }));
      const res = await GET(req);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain(encodeURIComponent("/api/mcp/authorize"));
      expect(location).toContain(encodeURIComponent("my-state"));
    });
  });

  // -------------------------------------------------------------------------
  // Authenticated cases
  // -------------------------------------------------------------------------
  describe("authenticated", () => {
    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    });

    it("returns 400 when clientId is missing", async () => {
      const req = createRequest("GET", authorizeUrlWithout("client_id"));
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
    });

    it("returns 400 when redirectUri is missing", async () => {
      const req = createRequest("GET", authorizeUrlWithout("redirect_uri"));
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
    });

    it("returns 400 when responseType is not 'code'", async () => {
      const req = createRequest("GET", authorizeUrl({ response_type: "token" }));
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
    });

    it("returns 400 when responseType is missing", async () => {
      const req = createRequest("GET", authorizeUrlWithout("response_type"));
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
    });

    it("returns 400 when codeChallenge is missing", async () => {
      const req = createRequest("GET", authorizeUrlWithout("code_challenge"));
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
    });

    it("returns 400 when codeChallengeMethod is not S256", async () => {
      const req = createRequest("GET", authorizeUrl({ code_challenge_method: "plain" }));
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
      expect(json.error_description).toMatch(/S256/i);
    });

    it("returns 400 when redirectUri is not registered for the client", async () => {
      mockMcpClientFindFirst.mockResolvedValue({
        redirectUris: ["https://other.example.com/callback"],
        isActive: true,
      });
      const req = createRequest("GET", authorizeUrl());
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
    });

    it("returns 400 when clientId does not exist in DB", async () => {
      mockMcpClientFindFirst.mockResolvedValue(null);
      const req = createRequest("GET", authorizeUrl());
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
    });

    it("redirects to consent page when all params are valid", async () => {
      const req = createRequest("GET", authorizeUrl());
      const res = await GET(req);
      expect(res.status).toBe(307);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("/en/mcp/authorize");
    });

    it("forwards all OAuth params to the consent page URL", async () => {
      const req = createRequest("GET", authorizeUrl({ state: "forward-me" }));
      const res = await GET(req);
      const location = res.headers.get("location") ?? "";
      const url = new URL(location);
      expect(url.searchParams.get("client_id")).toBe("client-abc");
      expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/callback");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("code_challenge")).toBe("abc123challenge");
      expect(url.searchParams.get("state")).toBe("forward-me");
    });

    it("uses locale detected from Accept-Language in the consent URL", async () => {
      mockDetectLocale.mockReturnValue("ja");
      const req = createRequest("GET", authorizeUrl(), {
        headers: { "accept-language": "ja,en;q=0.9" },
      });
      const res = await GET(req);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("/ja/mcp/authorize");
    });

    it("accepts request without code_challenge_method (defaults to S256)", async () => {
      const req = createRequest("GET", authorizeUrlWithout("code_challenge_method"));
      const res = await GET(req);
      // Default is S256 so validation passes → redirect to consent
      expect(res.status).toBe(307);
      const location = res.headers.get("location") ?? "";
      const url = new URL(location);
      expect(url.searchParams.get("code_challenge_method")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Anti-enumeration: client-not-found and redirect-uri-mismatch return same error
  // -------------------------------------------------------------------------
  describe("anti-enumeration", () => {
    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    });

    it("returns identical error shape for client-not-found and redirect-uri-mismatch", async () => {
      // Client not found
      mockMcpClientFindFirst.mockResolvedValue(null);
      const resNotFound = await GET(createRequest("GET", authorizeUrl()));
      const jsonNotFound = await resNotFound.json();

      // Client exists but redirect_uri doesn't match
      mockMcpClientFindFirst.mockResolvedValue({
        redirectUris: ["https://attacker.example.com/callback"],
        isActive: true,
      });
      const resMismatch = await GET(createRequest("GET", authorizeUrl()));
      const jsonMismatch = await resMismatch.json();

      expect(resNotFound.status).toBe(resMismatch.status);
      expect(jsonNotFound).toEqual(jsonMismatch);
    });
  });

  // AC4.1 / AC4.4 / AC4.5 — proof-of-pattern fail-closed test (plan
  // rate-limit-fail-closed-on-redis). The 41 other opt-in routes have
  // their fail-closed test case tracked in
  // scripts/checks/fail-closed-test-debt.txt and will be authored in
  // follow-up PRs (one debt-list entry removed per PR).
  describe("redisErrored fail-closed (rate-limiter Redis unavailable)", () => {
    beforeEach(() => {
      mockAuth.mockResolvedValue(null); // pre-auth path is fine for limiter check
    });

    it("returns 503 + Retry-After: 30 + body { error: temporarily_unavailable } when helper returns the OAuth 503 envelope", async () => {
      // Helper handles emit + envelope internally; route just returns
      // whatever the helper hands back. Stub the helper to return the
      // canonical OAuth 503 we'd see in production under Redis-outage.
      mockCheckRateLimitOrFail.mockResolvedValueOnce(
        NextResponse.json(
          { error: "temporarily_unavailable" },
          { status: 503, headers: { "Retry-After": "30" } },
        ),
      );

      const res = await GET(createRequest("GET", authorizeUrl()));

      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("30");
      const json = await res.json();
      expect(json).toEqual({ error: "temporarily_unavailable" });
      expect("error_description" in json).toBe(false);
    });

    // Pattern propagation: assert the route invokes the helper with the
    // canonical args (scope, envelope, rateLimitedEnvelope) so the 41
    // routes following this template copy the right shape.
    it("invokes checkRateLimitOrFail with scope=mcp.authorize and envelope=oauth", async () => {
      await GET(createRequest("GET", authorizeUrl()));

      expect(mockCheckRateLimitOrFail).toHaveBeenCalledTimes(1);
      expect(mockCheckRateLimitOrFail).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "mcp.authorize",
          envelope: "oauth",
        }),
      );
    });
  });
});
