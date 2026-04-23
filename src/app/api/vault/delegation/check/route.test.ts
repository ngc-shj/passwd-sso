import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAuthOrToken,
  mockPrismaDelegationSession,
  mockWithBypassRls,
  mockRateLimiterCheck,
  mockLogAudit,
  mockEnforceAccessRestriction,
} = vi.hoisted(() => ({
  mockAuthOrToken: vi.fn(),
  mockPrismaDelegationSession: {
    findFirst: vi.fn(),
  },
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockRateLimiterCheck: vi.fn(),
  mockLogAudit: vi.fn(),
  mockEnforceAccessRestriction: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
}));

vi.mock("@/lib/auth/session/auth-or-token", () => ({
  authOrToken: mockAuthOrToken,
  hasUserId: (auth: { type: string }) => "userId" in auth,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    delegationSession: mockPrismaDelegationSession,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "127.0.0.1", userAgent: null, acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "127.0.0.1", userAgent: null, acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: null, acceptLanguage: null }),
}));
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from "./route";
import { NextRequest } from "next/server";

const VALID_CLIENT_ID = "mcpc_f47ac10b58cc4372a5670e02b2c3d479";
const VALID_ENTRY_ID = "entry-abc-123";
const SESSION_ID = "session-id-abc";
const EXPIRES_AT = new Date("2099-01-01T00:00:00Z");

const makeRequest = (params: Record<string, string>) => {
  const url = new URL("http://localhost/api/vault/delegation/check");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString(), { method: "GET" });
};

describe("GET /api/vault/delegation/check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: "user-1" });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockPrismaDelegationSession.findFirst.mockResolvedValue(null);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthOrToken.mockResolvedValue(null);
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("unauthorized");
  });

  it("returns 403 when scope is insufficient", async () => {
    mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.authorized).toBe(false);
  });

  it("accepts Bearer token auth (extension token)", async () => {
    mockAuthOrToken.mockResolvedValue({ type: "token", userId: "user-1", scopes: [] });
    mockPrismaDelegationSession.findFirst.mockResolvedValue({
      id: SESSION_ID,
      expiresAt: EXPIRES_AT,
      entryIds: [VALID_ENTRY_ID],
    });

    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorized).toBe(true);
  });

  it("returns 403 when Bearer token is from outside tenant IP range", async () => {
    mockAuthOrToken.mockResolvedValue({ type: "token", userId: "user-1", scopes: [] });
    const denied = new Response(
      JSON.stringify({ error: "ACCESS_DENIED" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
    mockEnforceAccessRestriction.mockResolvedValueOnce(denied);

    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));

    expect(res.status).toBe(403);
    // Must not look up delegation or log audit when IP is denied
    expect(mockPrismaDelegationSession.findFirst).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30000 });
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("rate_limit");
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("returns 400 when clientId is missing", async () => {
    const res = await GET(makeRequest({ entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when clientId does not start with mcpc_", async () => {
    const res = await GET(makeRequest({ clientId: "not-valid", entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when entryId is missing", async () => {
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when entryId contains invalid characters", async () => {
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: "entry id!" }));
    expect(res.status).toBe(400);
  });

  it("returns 403 with reason no_session when no active delegation exists", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue(null);
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("no_session");
  });

  it("returns 403 with reason entry_not_delegated when entryId is not in session", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue({
      id: SESSION_ID,
      expiresAt: EXPIRES_AT,
      entryIds: ["other-entry-1", "other-entry-2"],
    });

    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("entry_not_delegated");
  });

  it("returns 403 when session has empty entryIds", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue({
      id: SESSION_ID,
      expiresAt: EXPIRES_AT,
      entryIds: [],
    });

    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("entry_not_delegated");
  });

  it("returns 200 with authorized:true when entry is delegated", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue({
      id: SESSION_ID,
      expiresAt: EXPIRES_AT,
      entryIds: [VALID_ENTRY_ID, "other-entry"],
    });

    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorized).toBe(true);
    expect(json.sessionId).toBe(SESSION_ID);
    expect(json.expiresAt).toBe(EXPIRES_AT.toISOString());
  });

  it("fires audit log with correct action on success", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue({
      id: SESSION_ID,
      expiresAt: EXPIRES_AT,
      entryIds: [VALID_ENTRY_ID],
    });

    await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DELEGATION_CHECK",
        scope: "PERSONAL",
        userId: "user-1",
        targetId: VALID_ENTRY_ID,
        metadata: expect.objectContaining({
          clientId: VALID_CLIENT_ID,
          sessionId: SESSION_ID,
        }),
      }),
    );
  });

  it("does not fire audit log on failure", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue(null);
    await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("queries DB with correct userId and clientId via join", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue({
      id: SESSION_ID,
      expiresAt: EXPIRES_AT,
      entryIds: [VALID_ENTRY_ID],
    });

    await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));

    expect(mockPrismaDelegationSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          mcpAccessToken: expect.objectContaining({
            mcpClient: expect.objectContaining({ clientId: VALID_CLIENT_ID }),
          }),
          revokedAt: null,
        }),
      }),
    );
  });
});
