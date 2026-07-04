import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockAuth,
  mockBridgeCodeCreate,
  mockBridgeCodeFindMany,
  mockBridgeCodeUpdateMany,
  mockUserFindUnique,
  mockCheck,
  mockCheckIpRateLimit,
  mockCheckRateLimitOrFail,
  mockWithUserTenantRls,
  mockWithBypassRls,
  mockLogAudit,
  mockExtractClientIp,
  mockCheckAccessRestrictionWithAudit,
  mockRequireRecentCurrentAuthMethod,
  mockVerifyDpop,
  mockDerivePasskeyState,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockBridgeCodeCreate: vi.fn(),
  mockBridgeCodeFindMany: vi.fn(),
  mockBridgeCodeUpdateMany: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockCheckIpRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  mockCheckRateLimitOrFail: vi.fn().mockResolvedValue(null),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockLogAudit: vi.fn(),
  mockExtractClientIp: vi.fn(() => "1.2.3.4"),
  mockCheckAccessRestrictionWithAudit: vi.fn().mockResolvedValue({ allowed: true }),
  mockRequireRecentCurrentAuthMethod: vi.fn().mockResolvedValue(null),
  mockVerifyDpop: vi.fn(),
  mockDerivePasskeyState: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionBridgeCode: {
      findMany: mockBridgeCodeFindMany,
      updateMany: mockBridgeCodeUpdateMany,
      create: mockBridgeCodeCreate,
    },
    user: {
      findUnique: mockUserFindUnique,
    },
    // withBypassRls passes `prisma` as the tx; the route acquires a
    // pg_advisory_xact_lock via tx.$executeRaw before the count-then-create.
    $executeRaw: vi.fn().mockResolvedValue(1),
  },
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "a".repeat(64),
  hashToken: () => "h".repeat(64),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/security/rate-limit-audit", () => ({
  checkRateLimitOrFail: mockCheckRateLimitOrFail,
}));
vi.mock("@/lib/security/ip-rate-limit", () => ({
  checkIpRateLimit: mockCheckIpRateLimit,
}));
vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "1.2.3.4", userAgent: "test" }),
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: "1.2.3.4",
    userAgent: "test",
  }),
}));
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: mockExtractClientIp,
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  checkAccessRestrictionWithAudit: mockCheckAccessRestrictionWithAudit,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentCurrentAuthMethod,
}));
vi.mock("@/lib/auth/dpop/verify", () => ({
  verifyDpopProof: mockVerifyDpop,
}));
vi.mock("@/lib/auth/dpop/jti-cache", () => ({
  getJtiCache: vi.fn(() => ({ has: vi.fn(() => false), add: vi.fn() })),
}));
vi.mock("@/lib/auth/dpop/htu-canonical", () => ({
  canonicalHtu: vi.fn(() => "http://localhost:3000/api/extension/bridge-code"),
}));

vi.mock("@/lib/auth/policy/passkey-enforcement", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/policy/passkey-enforcement")>();
  return {
    ...real,
    derivePasskeyState: mockDerivePasskeyState,
  };
});

import { POST } from "./route";
import { __resetAllowlistForTests } from "@/lib/http/cors";
import { _resetPasskeyAuditForTests } from "@/lib/auth/policy/passkey-enforcement";

const ALLOWED_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const VERIFIER_JKT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb";

function makeRequest(): import("next/server").NextRequest {
  return createRequest("POST", "http://localhost:3000/api/extension/bridge-code", {
    headers: { Origin: ALLOWED_ORIGIN, DPoP: "valid-dpop-proof" },
    body: {},
  });
}

describe("POST /api/extension/bridge-code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPasskeyAuditForTests();
    vi.stubEnv("EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS", ALLOWED_ORIGIN);
    __resetAllowlistForTests();
    mockCheck.mockResolvedValue({ allowed: true });
    mockCheckIpRateLimit.mockResolvedValue({ allowed: true });
    mockCheckRateLimitOrFail.mockResolvedValue(null);
    mockExtractClientIp.mockReturnValue("1.2.3.4");
    mockCheckAccessRestrictionWithAudit.mockResolvedValue({ allowed: true });
    mockWithBypassRls.mockImplementation(async (p, fn) => fn(p));
    mockWithUserTenantRls.mockImplementation(async (_u, fn) => fn());
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockBridgeCodeFindMany.mockResolvedValue([]);
    mockBridgeCodeCreate.mockResolvedValue({});
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(null);
    mockVerifyDpop.mockResolvedValue({ ok: true, jkt: VERIFIER_JKT, claims: {} });
    // Default: passkey enforcement off (does not block).
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetAllowlistForTests();
  });

  // Audit assertion helper — every failure path emits exactly one
  // EXTENSION_BRIDGE_CODE_ISSUE_FAILURE event with the expected reason.
  function expectFailureEmit(reason: string, opts?: { userId?: string | null; tenantId?: string | null; metadataExtra?: Record<string, unknown> }) {
    const expectedUserId = opts?.userId !== undefined ? opts.userId : null;
    const expectedTenantId = opts?.tenantId !== undefined ? opts.tenantId : null;
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const call = mockLogAudit.mock.calls[0][0];
    expect(call.action).toBe("EXTENSION_BRIDGE_CODE_ISSUE_FAILURE");
    expect(call.scope).toBe("PERSONAL");
    expect(call.metadata).toEqual({ reason, ...opts?.metadataExtra });
    if (expectedUserId === null) {
      // pre-auth: SYSTEM_ACTOR_ID + actorType=SYSTEM
      expect(call.userId).toBe("00000000-0000-4000-8000-000000000001");
      expect(call.actorType).toBe("SYSTEM");
      expect(call).not.toHaveProperty("tenantId");
    } else {
      expect(call.userId).toBe(expectedUserId);
      expect(call).not.toHaveProperty("actorType");
      if (expectedTenantId === null) {
        expect(call).not.toHaveProperty("tenantId");
      } else {
        expect(call.tenantId).toBe(expectedTenantId);
      }
    }
  }

  it("emits failure audit with ip_rate_limit when IP rate-limit returns 429", async () => {
    mockCheckIpRateLimit.mockResolvedValueOnce({ allowed: false });
    mockCheckRateLimitOrFail.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: "RATE_LIMIT_EXCEEDED" }), { status: 429 }),
    );
    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    expectFailureEmit("ip_rate_limit");
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("emits failure audit with ip_rate_limit_redis_fail when IP limiter Redis-fails", async () => {
    mockCheckIpRateLimit.mockResolvedValueOnce({ allowed: false, redisErrored: true });
    mockCheckRateLimitOrFail.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: "SERVICE_UNAVAILABLE" }), { status: 503 }),
    );
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    expectFailureEmit("ip_rate_limit_redis_fail");
  });

  it("emits failure audit with origin_disallowed when Origin is not in allowlist", async () => {
    const reqWithBadOrigin = createRequest("POST", "http://localhost:3000/api/extension/bridge-code", {
      headers: { Origin: "https://evil.example.com", DPoP: "x" },
      body: {},
    });
    const res = await POST(reqWithBadOrigin);
    expect(res.status).toBe(403);
    expectFailureEmit("origin_disallowed");
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("emits failure audit with body_schema_invalid when body contains unknown keys", async () => {
    const reqWithBadBody = createRequest("POST", "http://localhost:3000/api/extension/bridge-code", {
      headers: { Origin: ALLOWED_ORIGIN, DPoP: "x" },
      body: { cnfJkt: "attacker-supplied" },
    });
    const res = await POST(reqWithBadBody);
    expect(res.status).toBe(400);
    expectFailureEmit("body_schema_invalid");
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("returns 401 and emits failure audit with unauthenticated when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
    expectFailureEmit("unauthenticated");
  });

  it("returns 401 and emits failure audit with user_not_found when user record is missing", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockUserFindUnique.mockResolvedValueOnce(null);
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
    expectFailureEmit("user_not_found", { userId: DEFAULT_SESSION.user.id, tenantId: null });
  });

  it("returns 403 and emits failure audit with tenant_access_restricted when tenant IP denies", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCheckAccessRestrictionWithAudit.mockResolvedValueOnce({
      allowed: false,
      reason: "ip not in tenant CIDR",
    });
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("ACCESS_DENIED");
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
    expect(mockVerifyDpop).not.toHaveBeenCalled();
    expectFailureEmit("tenant_access_restricted", { userId: DEFAULT_SESSION.user.id, tenantId: "tenant-1" });
  });

  it("returns 403 and emits failure audit with step_up_required when session step-up is required", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireRecentCurrentAuthMethod.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
    expectFailureEmit("step_up_required", { userId: DEFAULT_SESSION.user.id, tenantId: "tenant-1" });
  });

  it("returns 429 and emits failure audit with rate_limit when per-user rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    // mockCheck is bridgeCodeLimiter.check — default { allowed: true } returns;
    // override to {allowed: false} for the per-user gate.
    mockCheck.mockResolvedValueOnce({ allowed: false });
    mockCheckRateLimitOrFail.mockImplementation(async (args: { scope: string }) => {
      if (args.scope === "extension.bridge_code") {
        return new Response(JSON.stringify({ error: "RATE_LIMIT_EXCEEDED" }), {
          status: 429,
        });
      }
      return null;
    });
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
    expectFailureEmit("rate_limit", { userId: DEFAULT_SESSION.user.id, tenantId: "tenant-1" });
  });

  it("emits failure audit with rate_limit_redis_fail when per-user limiter Redis-fails", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCheck.mockResolvedValueOnce({ allowed: false, redisErrored: true });
    mockCheckRateLimitOrFail.mockImplementation(async (args: { scope: string }) => {
      if (args.scope === "extension.bridge_code") {
        return new Response(JSON.stringify({ error: "SERVICE_UNAVAILABLE" }), {
          status: 503,
        });
      }
      return null;
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    expectFailureEmit("rate_limit_redis_fail", { userId: DEFAULT_SESSION.user.id, tenantId: "tenant-1" });
  });

  it("returns 401 and emits failure audit with dpop_invalid when DPoP verify fails", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockVerifyDpop.mockResolvedValueOnce({ ok: false, error: "DPOP_HTM_MISMATCH" });
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
    expectFailureEmit("dpop_invalid", {
      userId: DEFAULT_SESSION.user.id,
      tenantId: "tenant-1",
      metadataExtra: { dpopError: "DPOP_HTM_MISMATCH" },
    });
  });

  it("returns 500 and emits failure audit with db_error when bridge-code create throws", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockBridgeCodeCreate.mockRejectedValueOnce(new Error("simulated DB write failure"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    expectFailureEmit("db_error", { userId: DEFAULT_SESSION.user.id, tenantId: "tenant-1" });
  });

  it("issues a bridge code on success and emits ONLY the success audit", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json).toMatchObject({
      code: "a".repeat(64),
      expiresAt: expect.any(String),
    });
    expect(json).not.toHaveProperty("token");

    expect(mockBridgeCodeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          codeHash: "h".repeat(64),
          tenantId: "tenant-1",
          // cnfJkt is the verifier-returned thumbprint, NOT a body field.
          cnfJkt: VERIFIER_JKT,
        }),
      }),
    );

    // Exactly one audit emit on success: EXTENSION_BRIDGE_CODE_ISSUE.
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXTENSION_BRIDGE_CODE_ISSUE",
        scope: "PERSONAL",
        tenantId: "tenant-1",
      }),
    );
    expect(mockLogAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "EXTENSION_BRIDGE_CODE_ISSUE_FAILURE" }),
    );
  });

  it("revokes oldest unused codes when BRIDGE_CODE_MAX_ACTIVE is exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockBridgeCodeFindMany.mockResolvedValue([
      { id: "c1" },
      { id: "c2" },
      { id: "c3" },
    ]);
    await POST(makeRequest());
    expect(mockBridgeCodeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["c1"] } },
      }),
    );
    // Single-emit symmetry with the dedicated success test: only the SUCCESS
    // audit fires on this path, never the FAILURE action.
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "EXTENSION_BRIDGE_CODE_ISSUE_FAILURE" }),
    );
  });

  // ── C2: Passkey enforcement gate ──────────────────────────────────────────

  it("C2: off (requirePasskey=false) → bridge code minted", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(201);
    // Non-vacuity: bridge code was actually created.
    expect(mockBridgeCodeCreate).toHaveBeenCalledTimes(1);
  });

  it("C2: on + hasPasskey → bridge code minted", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: true,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(201);
    expect(mockBridgeCodeCreate).toHaveBeenCalledTimes(1);
  });

  it("C2: on + no passkey + within grace → bridge code minted", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    // enabledAt = 3 days ago, grace = 7 days → still within grace
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(201);
    expect(mockBridgeCodeCreate).toHaveBeenCalledTimes(1);
  });

  it("C2: on + no passkey + grace expired → 403 PASSKEY_REQUIRED, no bridge code, audit emitted once", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    // enabledAt = 10 days ago, grace = 7 days → expired
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const res = await POST(makeRequest());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("PASSKEY_REQUIRED");
    // Non-vacuity: bridge code must NOT have been created.
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
    // Exactly one PASSKEY_ENFORCEMENT_BLOCKED audit emit.
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PASSKEY_ENFORCEMENT_BLOCKED",
        metadata: { blockedPath: "/api/extension/bridge-code" },
        tenantId: "tenant-1",
      }),
    );
  });

  it("C2: enabledAt=null → immediate 403 (no grace)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: 7,
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("C2: audit dedup — second blocked attempt on same path does not emit a second audit", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
    await POST(makeRequest());
    await POST(makeRequest());
    // Only one PASSKEY_ENFORCEMENT_BLOCKED emit across both attempts.
    const blockedCalls = mockLogAudit.mock.calls.filter(
      (c) => c[0].action === "PASSKEY_ENFORCEMENT_BLOCKED",
    );
    expect(blockedCalls).toHaveLength(1);
  });

  it("C2: derivePasskeyState throws → fail closed (no bridge code, error propagates)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockDerivePasskeyState.mockRejectedValue(new Error("DB error"));
    await expect(POST(makeRequest())).rejects.toThrow("DB error");
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
  });
});
