import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAuth,
  mockFindFirst,
  mockUserFindUnique,
  mockWithBypassRls,
  mockExtractClientIp,
  mockCheckRateLimit,
  mockRequireRecentSession,
  mockLogAuditAsync,
  mockDerivePasskeyState,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p)),
  mockExtractClientIp: vi.fn(() => "203.0.113.10"),
  mockCheckRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
  mockLogAuditAsync: vi.fn().mockResolvedValue(undefined),
  mockDerivePasskeyState: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpClient: {
      findFirst: mockFindFirst,
    },
    user: {
      findUnique: mockUserFindUnique,
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

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "203.0.113.10",
    userAgent: "test",
    acceptLanguage: null,
  }),
}));

vi.mock("@/lib/auth/policy/passkey-enforcement", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/policy/passkey-enforcement")>();
  return {
    ...real,
    derivePasskeyState: mockDerivePasskeyState,
  };
});

import { GET } from "@/app/api/mcp/authorize/route";
import { _resetPasskeyAuditForTests } from "@/lib/auth/policy/passkey-enforcement";

// A07-4: isActive: true is part of the WHERE clause; fixture documents that
// the test asserts a matching row exists (the Prisma mock returns whatever it
// returns regardless of WHERE shape, but VALID_CLIENT semantically means
// "active client").
const VALID_CLIENT = {
  redirectUris: ["https://client.example/callback"],
  isActive: true,
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
    _resetPasskeyAuditForTests();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockFindFirst.mockResolvedValue(VALID_CLIENT);
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockWithBypassRls.mockImplementation(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p));
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockRequireRecentSession.mockResolvedValue(null);
    mockLogAuditAsync.mockResolvedValue(undefined);
    // Default: passkey enforcement off (does not block).
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
  });

  it("redirects authenticated users to consent when checks pass", async () => {
    const req = createRequest(
      "https://example.test/api/mcp/authorize?client_id=cli&redirect_uri=https://client.example/callback&response_type=code&scope=credentials:list&code_challenge=abc",
    );
    const res = await GET(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/en/mcp/authorize");

    // A07-4: assert the WHERE clause includes isActive: true so revoked
    // clients fail upfront (defense-in-depth — token endpoint already gates).
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
      }),
    );
  });

  // A07-4 T-5: anti-enumeration — inactive / nonexistent / bad-redirect all
  // return the SAME error envelope (same status, same body shape).
  //
  // T-5a uses mockImplementation that filters by `isActive` so the WHERE
  // shape contract is exercised, not just the null-return outcome.
  it("A07-4 T-5a: inactive client is rejected (mockImplementation filters by isActive)", async () => {
    mockFindFirst.mockImplementation(async (args: { where?: { isActive?: boolean } }) => {
      // Simulate real Prisma filtering: row exists but is inactive →
      // WHERE { isActive: true } returns null.
      return args.where?.isActive === true
        ? null
        : { redirectUris: ["https://client.example/callback"], isActive: false };
    });
    const req = createRequest(
      "https://example.test/api/mcp/authorize?client_id=revoked&redirect_uri=https://client.example/callback&response_type=code&scope=credentials:list&code_challenge=abc",
    );
    const res = await GET(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid_request" });
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
      }),
    );
  });

  it("A07-4 T-5b: nonexistent client returns identical envelope to inactive", async () => {
    mockFindFirst.mockResolvedValue(null);
    const req = createRequest(
      "https://example.test/api/mcp/authorize?client_id=nonexistent&redirect_uri=https://client.example/callback&response_type=code&scope=credentials:list&code_challenge=abc",
    );
    const res = await GET(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid_request" });
  });

  it("A07-4 T-5c: active client + bad redirect_uri returns identical envelope", async () => {
    mockFindFirst.mockResolvedValue({
      redirectUris: ["https://other.example/callback"],
      isActive: true,
    });
    const req = createRequest(
      "https://example.test/api/mcp/authorize?client_id=cli&redirect_uri=https://attacker.example/callback&response_type=code&scope=credentials:list&code_challenge=abc",
    );
    const res = await GET(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid_request" });
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

  // ── C6 (GET): Passkey enforcement gate ───────────────────────────────────

  const VALID_AUTHZ_URL =
    "https://example.test/api/mcp/authorize?client_id=cli&redirect_uri=https://client.example/callback&response_type=code&scope=credentials:list&code_challenge=abc";

  it("C6 GET: off (requirePasskey=false) → redirects to consent", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
    const res = await GET(createRequest(VALID_AUTHZ_URL) as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/en/mcp/authorize");
    // Non-vacuity: gate was reached and the mock was interpreted, not bypassed before it.
    expect(mockDerivePasskeyState).toHaveBeenCalledTimes(1);
    // Non-vacuity: reached consent redirect (not refused).
    expect(mockFindFirst).toHaveBeenCalled();
  });

  it("C6 GET: on + hasPasskey → redirects to consent", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: true,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const res = await GET(createRequest(VALID_AUTHZ_URL) as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/en/mcp/authorize");
    // Non-vacuity: gate was reached and the mock was interpreted, not bypassed before it.
    expect(mockDerivePasskeyState).toHaveBeenCalledTimes(1);
  });

  it("C6 GET: on + no passkey + within grace → redirects to consent", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const res = await GET(createRequest(VALID_AUTHZ_URL) as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/en/mcp/authorize");
  });

  it("C6 GET: on + no passkey + grace expired → 403 access_denied+passkey_required, audit emitted once", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const res = await GET(createRequest(VALID_AUTHZ_URL) as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("access_denied");
    expect(json.error_description).toBe("passkey_required");
    // Exactly one PASSKEY_ENFORCEMENT_BLOCKED audit emit.
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PASSKEY_ENFORCEMENT_BLOCKED",
        metadata: { blockedPath: "/api/mcp/authorize" },
      }),
    );
    const blockedCalls = mockLogAuditAsync.mock.calls.filter(
      (c) => c[0].action === "PASSKEY_ENFORCEMENT_BLOCKED",
    );
    expect(blockedCalls).toHaveLength(1);
  });

  it("C6 GET: enabledAt=null → immediate 403 access_denied", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: 7,
    });
    const res = await GET(createRequest(VALID_AUTHZ_URL) as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("access_denied");
  });

  it("C6 GET: audit dedup — second blocked attempt does not emit a second audit", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
    await GET(createRequest(VALID_AUTHZ_URL) as unknown as import("next/server").NextRequest);
    await GET(createRequest(VALID_AUTHZ_URL) as unknown as import("next/server").NextRequest);
    const blockedCalls = mockLogAuditAsync.mock.calls.filter(
      (c) => c[0].action === "PASSKEY_ENFORCEMENT_BLOCKED",
    );
    expect(blockedCalls).toHaveLength(1);
  });

  it("C6 GET: derivePasskeyState throws → fail closed (no consent redirect, error propagates)", async () => {
    mockDerivePasskeyState.mockRejectedValue(new Error("DB error"));
    await expect(
      GET(createRequest(VALID_AUTHZ_URL) as unknown as import("next/server").NextRequest),
    ).rejects.toThrow("DB error");
  });
});
