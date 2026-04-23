import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockMcpClientFindFirst, mockWithBypassRls, mockServerAppUrl, mockDetectLocale, mockRateLimiterCheck } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockMcpClientFindFirst: vi.fn(),
    mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
    mockServerAppUrl: vi.fn((path: string) => `http://localhost:3000${path}`),
    mockDetectLocale: vi.fn(() => "en"),
    mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  }));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { mcpClient: { findFirst: mockMcpClientFindFirst } },
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
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/auth/ip-access", () => ({
  extractClientIp: () => "127.0.0.1",
  rateLimitKeyFromIp: (ip: string) => `rl:${ip}`,
}));

import { GET } from "@/app/api/mcp/authorize/route";

// Valid client registered in DB
const VALID_CLIENT = {
  redirectUris: ["https://example.com/callback"],
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
      });
      const resMismatch = await GET(createRequest("GET", authorizeUrl()));
      const jsonMismatch = await resMismatch.json();

      expect(resNotFound.status).toBe(resMismatch.status);
      expect(jsonNotFound).toEqual(jsonMismatch);
    });
  });
});
