import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAuthOrToken,
  mockPrismaPasswordEntry,
  mockWithBypassRls,
  mockRateLimiterCheck,
  mockLogAudit,
  mockEnforceAccessRestriction,
} = vi.hoisted(() => ({
  mockAuthOrToken: vi.fn(),
  mockPrismaPasswordEntry: {
    findFirst: vi.fn(),
  },
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
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
    passwordEntry: mockPrismaPasswordEntry,
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
  resolveActorType: (auth: { type: string }) => {
    if (auth.type === "mcp_token") return "MCP_AGENT";
    if (auth.type === "service_account") return "SERVICE_ACCOUNT";
    return "HUMAN";
  },
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

import { POST } from "./route";
import { NextRequest } from "next/server";

const VALID_KEY_ID = "entry-abc-123";
const VALID_FINGERPRINT = "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";

const makeRequest = (body: unknown) =>
  new NextRequest("http://localhost/api/vault/ssh/sign-authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/vault/ssh/sign-authorize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthOrToken.mockResolvedValue({
      type: "mcp_token",
      userId: "user-1",
      tenantId: "tenant-1",
      tokenId: "tok-1",
      mcpClientId: "mcpc_abc",
      scopes: ["ssh:sign"],
    });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockPrismaPasswordEntry.findFirst.mockResolvedValue(null);
  });

  // ── Authentication / authorization gates ─────────────────────────────

  it("returns 401 when not authenticated", async () => {
    mockAuthOrToken.mockResolvedValue(null);
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("unauthorized");
  });

  it("returns 403 when scope is insufficient", async () => {
    mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("unauthorized");
  });

  it("returns 403 when token has no userId (SA token)", async () => {
    mockAuthOrToken.mockResolvedValue({ type: "service_account", serviceAccountId: "sa-1" });
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.authorized).toBe(false);
  });

  // ── Rate limiting ─────────────────────────────────────────────────────

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30000 });
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("rate_limit");
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("returns 503 when Redis is unavailable (fail-closed)", async () => {
    mockRateLimiterCheck.mockResolvedValue({ redisErrored: true });
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("service_unavailable");
  });

  // ── Body validation ───────────────────────────────────────────────────

  it("returns 400 when keyId is missing", async () => {
    const res = await POST(makeRequest({ fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("invalid_params");
  });

  it("returns 400 when fingerprint is missing", async () => {
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("invalid_params");
  });

  it("returns 400 when keyId contains invalid characters (spaces, exclamation)", async () => {
    const res = await POST(makeRequest({ keyId: "entry id!", fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("invalid_params");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const req = new NextRequest("http://localhost/api/vault/ssh/sign-authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("invalid_params");
  });

  it("accepts CUID-format keyId (e.g. abc_DEF-123)", async () => {
    // keyId regex /^[a-zA-Z0-9_-]{1,100}$/ must accept CUID-format IDs.
    // This test guards against accidentally switching to z.string().uuid().
    const cuidKeyId = "abc_DEF-123";
    mockPrismaPasswordEntry.findFirst.mockResolvedValue({ id: cuidKeyId });
    const res = await POST(makeRequest({ keyId: cuidKeyId, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorized).toBe(true);
  });

  it("rejects keyId with UUID-invalid-but-regex-invalid chars (dots)", async () => {
    // UUID format with dots is invalid per the regex
    const res = await POST(makeRequest({ keyId: "550e8400-e29b-41d4.a716-446655440000", fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(400);
  });

  // ── Entry lookup authorization ────────────────────────────────────────

  it("returns 403 entry_not_found when another user owns the keyId (findFirst returns null)", async () => {
    // findFirst returns null because userId predicate excludes the other user's entry
    mockPrismaPasswordEntry.findFirst.mockResolvedValue(null);
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("entry_not_found");
  });

  it("returns 403 entry_not_found for archived entry (findFirst returns null)", async () => {
    // isArchived: false predicate in the WHERE clause means archived entries return null
    mockPrismaPasswordEntry.findFirst.mockResolvedValue(null);
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("entry_not_found");
  });

  it("returns 403 entry_not_found for soft-deleted entry (deletedAt not null → findFirst null)", async () => {
    mockPrismaPasswordEntry.findFirst.mockResolvedValue(null);
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("entry_not_found");
  });

  it("returns 403 entry_not_found when entryType is not SSH_KEY (findFirst null)", async () => {
    // entryType: "SSH_KEY" predicate in the WHERE clause excludes non-SSH entries
    mockPrismaPasswordEntry.findFirst.mockResolvedValue(null);
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("entry_not_found");
  });

  // ── Happy path ────────────────────────────────────────────────────────

  it("returns 200 authorized:true when SSH_KEY entry exists and is active", async () => {
    mockPrismaPasswordEntry.findFirst.mockResolvedValue({ id: VALID_KEY_ID });
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorized).toBe(true);
  });

  it("emits SSH_KEY_SIGN audit with actorType MCP_AGENT on authorized path", async () => {
    mockPrismaPasswordEntry.findFirst.mockResolvedValue({ id: VALID_KEY_ID });
    await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SSH_KEY_SIGN",
        actorType: "MCP_AGENT",
        scope: "PERSONAL",
        userId: "user-1",
        targetId: VALID_KEY_ID,
        metadata: expect.objectContaining({ fingerprint: VALID_FINGERPRINT }),
      }),
    );
  });

  it("includes host metadata in audit when host is provided", async () => {
    const host = { hostKeyFingerprint: "SHA256:hostkey123", forwarded: false };
    mockPrismaPasswordEntry.findFirst.mockResolvedValue({ id: VALID_KEY_ID });
    await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT, host }));

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SSH_KEY_SIGN",
        metadata: expect.objectContaining({ fingerprint: VALID_FINGERPRINT, host }),
      }),
    );
  });

  it("emits SSH_KEY_SIGN_DENIED audit on entry_not_found path", async () => {
    mockPrismaPasswordEntry.findFirst.mockResolvedValue(null);
    await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SSH_KEY_SIGN_DENIED",
        actorType: "MCP_AGENT",
        scope: "PERSONAL",
        userId: "user-1",
        targetId: VALID_KEY_ID,
      }),
    );
  });

  it("does not emit audit on 400 invalid_params", async () => {
    const res = await POST(makeRequest({ keyId: "entry id!", fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(400);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("does not emit audit on 401 unauthorized", async () => {
    mockAuthOrToken.mockResolvedValue(null);
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(401);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("does not emit audit on 403 scope_insufficient", async () => {
    mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(403);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("uses userId from token (not body) in entry lookup", async () => {
    mockPrismaPasswordEntry.findFirst.mockResolvedValue({ id: VALID_KEY_ID });
    await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));

    expect(mockPrismaPasswordEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: VALID_KEY_ID,
          entryType: "SSH_KEY",
          isArchived: false,
          deletedAt: null,
        }),
      }),
    );
  });

  it("works without host field (optional)", async () => {
    mockPrismaPasswordEntry.findFirst.mockResolvedValue({ id: VALID_KEY_ID });
    const res = await POST(makeRequest({ keyId: VALID_KEY_ID, fingerprint: VALID_FINGERPRINT }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorized).toBe(true);
  });
});
