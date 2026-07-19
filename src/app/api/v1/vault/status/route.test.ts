import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockValidateApiKeyOnly,
  mockEnforceAccessRestriction,
  mockCheck,
  mockCreateRateLimiter,
  mockUserFindUnique,
  mockWithTenantRls,
  mockLogAuditAsync,
} = vi.hoisted(() => {
  const mockCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockValidateApiKeyOnly: vi.fn(),
    mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
    mockCheck,
    // Recording factory: assertRedisFailClosed's factory-attribution step
    // reads mockCreateRateLimiter.mock.{calls,results}. @/lib/security/rate-limiters
    // stays REAL so v1ApiKeyLimiter is this factory's recorded module-load result.
    mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockCheck, clear: vi.fn() })),
    mockUserFindUnique: vi.fn(),
    mockWithTenantRls: vi.fn(async (prisma: unknown, _tenantId: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
    mockLogAuditAsync: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/auth/tokens/api-key", () => ({ validateApiKeyOnly: mockValidateApiKeyOnly }));
vi.mock("@/lib/auth/policy/access-restriction", () => ({ enforceAccessRestriction: mockEnforceAccessRestriction }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  // Used by emitRateLimitFailClosed (rate-limit-audit.ts) on the
  // redisErrored path — required so the fail-closed test's void async audit
  // emission doesn't dead-letter inside the mock module.
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "10.0.0.1",
    userAgent: "test",
    acceptLanguage: null,
  }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withTenantRls: mockWithTenantRls }));
vi.mock("@/lib/logger", () => {
  const noop = vi.fn();
  const child = { info: noop, warn: noop, error: noop };
  return {
    default: { info: noop, warn: noop, error: noop, child: vi.fn().mockReturnValue(child) },
    requestContext: { run: (_s: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
    getLogger: () => child,
  };
});

import { GET } from "./route";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";

// v1ApiKeyLimiter (src/lib/security/rate-limiters.ts) is instantiated once
// at module load time, above. Snapshot the recorded factory call/result
// here (module scope, before any test/beforeEach clears mocks) so
// assertRedisFailClosed's factory-attribution step still has it.
const v1ApiKeyLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const v1ApiKeyLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockCheck;
};

const USER_ID = "user-1";
const TENANT_ID = "tenant-1";
const API_KEY_ID = "key-1";

const validApiKey = { userId: USER_ID, tenantId: TENANT_ID, apiKeyId: API_KEY_ID };
// SA tokens have userId=null; rateLimitKey is the serviceAccountId
const saApiKey = { userId: null, tenantId: TENANT_ID, rateLimitKey: "sa-1", apiKeyId: "sa-1" };

describe("GET /api/v1/vault/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockUserFindUnique.mockResolvedValue({
      encryptedSecretKey: "enc-key",
      keyVersion: 1,
    });
  });

  it("returns 401 when API key is missing or invalid", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_INVALID" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when API key scope is insufficient", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "SCOPE_INSUFFICIENT" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBeDefined();
  });

  it("returns 401 for revoked API key", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_REVOKED" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 401 for expired API key", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_EXPIRED" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 10_000 });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("10");
  });

  it("returns access restriction response when denied", async () => {
    const { NextResponse } = await import("next/server");
    mockEnforceAccessRestriction.mockResolvedValue(
      NextResponse.json({ error: "ACCESS_RESTRICTED" }, { status: 403 }),
    );
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    expect(res.status).toBe(403);
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () => GET(createRequest("GET", "http://localhost/api/v1/vault/status")),
      limiter: v1ApiKeyLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockUserFindUnique],
      limiterFactory: v1ApiKeyLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("returns initialized=true when encryptedSecretKey is set", async () => {
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.initialized).toBe(true);
    expect(json.keyVersion).toBe(1);
  });

  it("returns initialized=false when encryptedSecretKey is null", async () => {
    mockUserFindUnique.mockResolvedValue({
      encryptedSecretKey: null,
      keyVersion: 0,
    });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.initialized).toBe(false);
    expect(json.keyVersion).toBe(0);
  });

  it("returns initialized=false and keyVersion=null when user not found", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.initialized).toBe(false);
    expect(json.keyVersion).toBeNull();
  });

  it("validates API key with VAULT_STATUS scope", async () => {
    await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    expect(mockValidateApiKeyOnly).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("vault:status"),
    );
  });

  it("uses tenant RLS when querying user", async () => {
    await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    expect(mockWithTenantRls).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.any(Function),
    );
  });
});

describe("GET /api/v1/vault/status — SA token path (C2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: saApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
  });

  it("returns the denial response when enforceAccessRestriction denies an SA token", async () => {
    const { NextResponse } = await import("next/server");
    const denial = NextResponse.json({ error: "ACCESS_RESTRICTED" }, { status: 403 });
    mockEnforceAccessRestriction.mockResolvedValue(denial);

    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("ACCESS_RESTRICTED");
    // Must NOT fall through to the { initialized: false } response
    expect(json.initialized).toBeUndefined();
  });

  it("calls enforceAccessRestriction with SYSTEM_ACTOR_ID and SERVICE_ACCOUNT actor type for SA tokens", async () => {
    await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));

    expect(mockEnforceAccessRestriction).toHaveBeenCalledWith(
      expect.anything(),
      SYSTEM_ACTOR_ID,
      TENANT_ID,
      ACTOR_TYPE.SERVICE_ACCOUNT,
    );
  });

  it("returns { initialized: false, keyVersion: null } when SA token is allowed", async () => {
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.initialized).toBe(false);
    expect(json.keyVersion).toBeNull();
    // SA tokens skip the user vault query
    expect(mockWithTenantRls).not.toHaveBeenCalled();
  });

  it("does not call enforceAccessRestriction with SYSTEM_ACTOR_ID on the human path", async () => {
    // Reset to human token
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockUserFindUnique.mockResolvedValue({ encryptedSecretKey: "enc-key", keyVersion: 1 });

    await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));

    // Human path calls enforceAccessRestriction with userId, not SYSTEM_ACTOR_ID
    expect(mockEnforceAccessRestriction).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      TENANT_ID,
    );
    expect(mockEnforceAccessRestriction).not.toHaveBeenCalledWith(
      expect.anything(),
      SYSTEM_ACTOR_ID,
      expect.anything(),
      expect.anything(),
    );
  });
});
