import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockValidateApiKeyOnly,
  mockEnforceAccessRestriction,
  mockCheck,
  mockCreateRateLimiter,
  mockTagFindMany,
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
    mockTagFindMany: vi.fn(),
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
    tag: { findMany: mockTagFindMany },
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

const mockTags = [
  { id: "t1", name: "Alpha", color: "#ff0000", parentId: null, _count: { passwords: 5 } },
  { id: "t2", name: "Beta", color: null, parentId: "t1", _count: { passwords: 0 } },
];

describe("GET /api/v1/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockTagFindMany.mockResolvedValue(mockTags);
  });

  it("returns 401 when API key is missing or invalid", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_INVALID" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when API key scope is insufficient", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "SCOPE_INSUFFICIENT" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBeDefined();
  });

  it("returns 401 for revoked API key", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_REVOKED" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 401 for expired API key", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_EXPIRED" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 45_000 });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("45");
  });

  it("returns access restriction response when denied", async () => {
    const { NextResponse } = await import("next/server");
    mockEnforceAccessRestriction.mockResolvedValue(
      NextResponse.json({ error: "ACCESS_RESTRICTED" }, { status: 403 }),
    );
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    expect(res.status).toBe(403);
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () => GET(createRequest("GET", "http://localhost/api/v1/tags")),
      limiter: v1ApiKeyLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockTagFindMany],
      limiterFactory: v1ApiKeyLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("returns tags with correct shape", async () => {
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toEqual([
      { id: "t1", name: "Alpha", color: "#ff0000", parentId: null, passwordCount: 5 },
      { id: "t2", name: "Beta", color: null, parentId: "t1", passwordCount: 0 },
    ]);
  });

  it("returns empty array when no tags", async () => {
    mockTagFindMany.mockResolvedValue([]);
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toEqual([]);
  });

  it("passes ACTIVE_ENTRY_WHERE filter in count query", async () => {
    await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    expect(mockTagFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          _count: expect.objectContaining({
            select: expect.objectContaining({
              passwords: expect.objectContaining({
                where: expect.objectContaining({ deletedAt: null, isArchived: false }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("validates API key with TAGS_READ scope", async () => {
    await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    expect(mockValidateApiKeyOnly).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("tags:read"),
    );
  });

  it("orders results by name ascending", async () => {
    await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    expect(mockTagFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { name: "asc" },
      }),
    );
  });
});
