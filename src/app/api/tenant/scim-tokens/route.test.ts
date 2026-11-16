import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";
import { __resetThrottleForTests } from "@/lib/security/rate-limit-audit";

const {
  mockAuth,
  mockPrismaScimToken,
  mockTenantMemberFindMany,
  mockDepartureFindMany,
  mockExecuteRaw,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockHashToken,
  mockGenerateScimToken,
  mockRateLimitCheck,
  mockCreateRateLimiter,
  mockRequireRecentSession,
  TenantAuthError,
} = vi.hoisted(() => {
  class _TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockPrismaScimToken: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    mockTenantMemberFindMany: vi.fn(),
    mockDepartureFindMany: vi.fn(),
    mockExecuteRaw: vi.fn().mockResolvedValue(1),
    mockRequireTenantPermission: vi.fn(),
    mockWithTenantRls: vi.fn((p: unknown, _t: unknown, fn: (tx: unknown) => unknown) => fn(p)),
    mockLogAudit: vi.fn(),
    mockHashToken: vi.fn((t: string) => `hashed:${t}`),
    mockGenerateScimToken: vi.fn(() => "scim_test_plaintext_token"),
    mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
    mockCreateRateLimiter: vi.fn(() => ({
      check: mockRateLimitCheck,
      clear: vi.fn(),
    })),
    mockRequireRecentSession: vi.fn().mockResolvedValue(null),
    TenantAuthError: _TenantAuthError,
  };
});

const { mockLockFootholdWriter } = vi.hoisted(() => ({
  mockLockFootholdWriter: vi.fn(async () => new Map()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant/foothold-write-gate", () => ({ lockFootholdWriter: mockLockFootholdWriter }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    scimToken: mockPrismaScimToken,
    tenantMember: { findMany: mockTenantMemberFindMany },
    tenantMemberDeparture: { findMany: mockDepartureFindMany },
    // The cap-check + create now run under an advisory lock inside one
    // withTenantRls tx (TOCTOU fix); the route calls tx.$executeRaw for the
    // lock before count/create. The withTenantRls mock passes prisma as tx.
    $executeRaw: mockExecuteRaw,
  },
}));
vi.mock("@/lib/auth/access/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: mockHashToken,
}));
vi.mock("@/lib/scim/token-utils", () => ({
  generateScimToken: mockGenerateScimToken,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));

import { GET, POST } from "./route";
import { footholdGateCells } from "@/__tests__/helpers/foothold-gate-cells";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";

// Module-scope snapshot: route.ts's module-level `createRateLimiter(...)`
// call runs at import time above. Must be captured before any
// vi.clearAllMocks() in beforeEach wipes mock.calls/mock.results.
const createLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const createLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimitCheck;
};

const TENANT_ID = "tenant-1";
const ACTOR = { id: "membership-1", tenantId: TENANT_ID, userId: "user-1", role: "OWNER" };

// Asserts the per-tenant advisory lock ($executeRaw with pg_advisory_xact_lock)
// was acquired. Mutation-kill: deleting the lock line from the production
// count-then-create path leaves $executeRaw uncalled with that SQL, so this fails.
function expectAdvisoryLockAcquired(mock: ReturnType<typeof vi.fn>) {
  expect(
    mock.mock.calls.some((c) => String(c[0]).includes("pg_advisory_xact_lock")),
  ).toBe(true);
}

describe("GET /api/tenant/scim-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockTenantMemberFindMany.mockResolvedValue([]);
    mockDepartureFindMany.mockResolvedValue([]);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/scim-tokens"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking SCIM_MANAGE permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(
      new TenantAuthError("FORBIDDEN", 403),
    );

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/scim-tokens"));
    expect(res.status).toBe(403);
  });

  it("rethrows unexpected errors", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("boom"));

    await expect(
      GET(createRequest("GET", "http://localhost/api/tenant/scim-tokens")),
    ).rejects.toThrow("boom");
  });

  it("returns token list for authorized user", async () => {
    const token = { id: "tok-1", description: "CI", createdAt: new Date("2025-01-01"), lastUsedAt: null, expiresAt: null, revokedAt: null, createdById: null, createdBy: null };
    mockPrismaScimToken.findMany.mockResolvedValue([token]);

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/scim-tokens"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { id: "tok-1", description: "CI", createdAt: "2025-01-01T00:00:00.000Z", lastUsedAt: null, expiresAt: null, revokedAt: null, createdBy: null, creatorAuthorized: null },
    ]);
  });

  it("reports creatorAuthorized per token (true / false / null for a token with no creator) and never createdById", async () => {
    const row = (id: string, createdById: string | null) => ({
      id, description: null, createdAt: new Date("2026-02-01T00:00:00Z"), lastUsedAt: null, expiresAt: null, revokedAt: null, createdById, createdBy: null,
    });
    mockPrismaScimToken.findMany.mockResolvedValue([row("ok", "u-admin"), row("demoted", "u-demoted"), row("gone", "u-gone"), row("legacy", null)]);
    mockTenantMemberFindMany.mockResolvedValue([
      { userId: "u-admin", role: "ADMIN", deactivatedAt: null },
      { userId: "u-demoted", role: "MEMBER", deactivatedAt: null },
    ]);

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/scim-tokens"));
    const body = await res.json();

    expect(Object.fromEntries(body.map((t: { id: string; creatorAuthorized: boolean | null }) => [t.id, t.creatorAuthorized]))).toEqual({
      ok: true, demoted: false, gone: false, legacy: null,
    });
    for (const t of body) expect(t).not.toHaveProperty("createdById");
    expect(mockTenantMemberFindMany.mock.calls[0][0].where.tenantId).toBe(TENANT_ID);
  });

  it("reports false for a creator recorded as departed after the token was created", async () => {
    mockPrismaScimToken.findMany.mockResolvedValue([
      { id: "t", description: null, createdAt: new Date("2026-02-01T00:00:00Z"), lastUsedAt: null, expiresAt: null, revokedAt: null, createdById: "u-admin", createdBy: null },
    ]);
    mockTenantMemberFindMany.mockResolvedValue([{ userId: "u-admin", role: "ADMIN", deactivatedAt: null }]);
    mockDepartureFindMany.mockResolvedValue([{ userId: "u-admin", departedAt: new Date("2026-03-01T00:00:00Z") }]);

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/scim-tokens"));
    expect((await res.json())[0].creatorAuthorized).toBe(false);
  });
});

describe("POST /api/tenant/scim-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Real emitRateLimitFailClosed now runs on the 503 path (rate-limit-audit
    // stub removed); reset its module-scoped throttle so a prior test's
    // emission does not swallow this test's (5-min window, per-scope key).
    __resetThrottleForTests();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockPrismaScimToken.count.mockResolvedValue(0);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockRequireRecentSession.mockResolvedValue(null);
  });

  footholdGateCells({
    gate: mockLockFootholdWriter,
    permission: TENANT_PERMISSION.SCIM_MANAGE,
    actorId: "user-1",
    tenantId: TENANT_ID,
    okStatus: 201,
    arrange: () => {
      mockPrismaScimToken.create.mockResolvedValue({
        id: "tok-new",
        description: "CI token",
        expiresAt: null,
        createdAt: new Date("2025-01-01"),
      });
    },
    call: () =>
      POST(createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "CI token" },
      })),
    assertNoWrite: () => expect(mockPrismaScimToken.create).not.toHaveBeenCalled(),
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "test" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking SCIM_MANAGE permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(
      new TenantAuthError("FORBIDDEN", 403),
    );

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "test" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/tenant/scim-tokens", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 403 when session step-up is required", async () => {
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "test" },
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockPrismaScimToken.create).not.toHaveBeenCalled();
  });

  it("returns 409 when token limit is exceeded", async () => {
    mockPrismaScimToken.count.mockResolvedValue(10);
    mockPrismaScimToken.create.mockResolvedValue({
      id: "tok-new",
      description: null,
      expiresAt: null,
      createdAt: new Date(),
    });

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "test" },
      }),
    );
    expect(res.status).toBe(409);
  });

  it("creates token and returns plaintext with 201 and no-store", async () => {
    const created = {
      id: "tok-new",
      description: "CI token",
      expiresAt: new Date("2026-01-01"),
      createdAt: new Date("2025-01-01"),
    };
    mockPrismaScimToken.create.mockResolvedValue(created);

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "CI token", expiresInDays: 365 },
      }),
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.token).toBe("scim_test_plaintext_token");
    expect(body.id).toBe("tok-new");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "SCIM_TOKEN_CREATE",
      }),
    );
    // The count-then-create runs under a per-tenant advisory lock (TOCTOU fix).
    expectAdvisoryLockAcquired(mockExecuteRaw);
  });

  it("returns 400 for invalid expiresInDays (below minimum)", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { expiresInDays: 0 },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for expiresInDays exceeding maximum", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { expiresInDays: 3651 },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("creates a non-expiring token when expiresInDays is null", async () => {
    mockPrismaScimToken.create.mockResolvedValue({
      id: "tok-never",
      description: "permanent",
      expiresAt: null,
      createdAt: new Date("2025-01-01"),
    });

    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "permanent", expiresInDays: null },
      }),
    );
    expect(res.status).toBe(201);
    expect(mockPrismaScimToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ expiresAt: null }) }),
    );
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });
    const res = await POST(
      createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
        body: { description: "test" },
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(mockPrismaScimToken.create).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () =>
        POST(
          createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
            body: { description: "test" },
          }),
        ),
      limiter: createLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockPrismaScimToken.create],
      limiterFactory: createLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("rethrows unexpected errors from POST", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("boom"));

    await expect(
      POST(
        createRequest("POST", "http://localhost/api/tenant/scim-tokens", {
          body: { description: "test" },
        }),
      ),
    ).rejects.toThrow("boom");
  });
});
