import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAuth,
  mockFindFirst,
  mockWithBypassRls,
  mockExtractClientIp,
  mockCheckRateLimit,
  mockRequireRecentSession,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindFirst: vi.fn(),
  mockWithBypassRls: vi.fn(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p)),
  mockExtractClientIp: vi.fn(() => "203.0.113.10"),
  mockCheckRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpClient: {
      findFirst: mockFindFirst,
    },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheckRateLimit }),
}));

vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: mockExtractClientIp,
  rateLimitKeyFromIp: (ip: string) => ip,
}));

vi.mock("@/lib/url-helpers", () => ({
  serverAppUrl: (path: string) => `https://example.test${path}`,
}));

vi.mock("@/i18n/locale-utils", () => ({
  detectBestLocaleFromAcceptLanguage: () => "en",
}));

vi.mock("@/lib/auth/session/step-up", () => ({
  requireRecentSession: mockRequireRecentSession,
}));

import { GET } from "@/app/api/mcp/authorize/route";

const VALID_CLIENT = {
  redirectUris: ["https://client.example/callback"],
};

function createRequest(url: string) {
  const req = new Request(url, { method: "GET" }) as Request & {
    nextUrl: URL;
  };
  req.nextUrl = new URL(url);
  return req;
}

describe("GET /api/mcp/authorize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockFindFirst.mockResolvedValue(VALID_CLIENT);
    mockWithBypassRls.mockImplementation(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p));
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockRequireRecentSession.mockResolvedValue(null);
  });

  it("redirects authenticated users to consent when checks pass", async () => {
    const req = createRequest(
      "https://example.test/api/mcp/authorize?client_id=cli&redirect_uri=https://client.example/callback&response_type=code&scope=credentials:list&code_challenge=abc",
    );
    const res = await GET(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/en/mcp/authorize");
  });

  it("returns 403 when session step-up is required", async () => {
    mockRequireRecentSession.mockResolvedValue(Response.json(
      { error: "SESSION_STEP_UP_REQUIRED" },
      { status: 403 },
    ));

    const req = createRequest(
      "https://example.test/api/mcp/authorize?client_id=cli&redirect_uri=https://client.example/callback&response_type=code&scope=credentials:list&code_challenge=abc",
    );
    const res = await GET(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});
