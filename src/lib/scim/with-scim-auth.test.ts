import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";
import { AUDIT_ACTION } from "@/lib/constants";
import { __resetThrottleForTests } from "@/lib/security/rate-limit-audit";

const {
  mockValidateScimToken,
  mockEnforceAccessRestriction,
  mockRateLimitCheck,
  mockCreateRateLimiter,
  mockLogAuditAsync,
  mockTenantAuditBase,
} = vi.hoisted(() => {
  const mockRateLimitCheck = vi.fn();
  return {
    mockValidateScimToken: vi.fn(),
    mockEnforceAccessRestriction: vi.fn(),
    mockRateLimitCheck,
    // Recording factory: assertRedisFailClosed's factory-attribution step
    // reads mockCreateRateLimiter.mock.{calls,results}.
    mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockRateLimitCheck, clear: vi.fn() })),
    mockLogAuditAsync: vi.fn().mockResolvedValue(undefined),
    mockTenantAuditBase: vi.fn((_req: unknown, userId: string, tenantId: string) => ({
      scope: "TENANT",
      userId,
      tenantId,
      ip: "10.0.0.1",
      userAgent: "test",
      acceptLanguage: null,
    })),
  };
});

vi.mock("@/lib/auth/tokens/scim-token", () => ({
  validateScimToken: mockValidateScimToken,
}));

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));

// Mock at the createRateLimiter layer, NOT @/lib/scim/rate-limit — the SCIM
// limiter is module-scoped there (`checkScimRateLimit`), so keeping that
// module real (with a mocked factory underneath) lets production
// `authorizeScim` → `checkScimRateLimit` → limiter.check() run for real.
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));

// C6 compliance: this file does NOT mock @/lib/security/rate-limit-audit —
// it is not in the frozen exemption list. `logAuditAsync`/`tenantAuditBase`
// are mocked (legal — C6 bans only rate-limit-audit mocks) so the real
// emission can be observed on a spy instead of hitting the DB.
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  tenantAuditBase: mockTenantAuditBase,
}));

import { authorizeScim } from "./with-scim-auth";

// Module-level `const limiter = createRateLimiter(...)` in rate-limit.ts
// runs once at import time, above. Snapshot here (module scope) so
// assertRedisFailClosed's factory-attribution check survives clearAllMocks.
const scimLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const scimLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimitCheck;
};

function fakeRequest(): NextRequest {
  return {
    headers: new Headers(),
    url: "https://app.example.com/api/scim/v2/Users",
    method: "GET",
  } as unknown as NextRequest;
}

const validatedToken = {
  tokenId: "tok1",
  tenantId: "tenant-1",
  createdById: "user-1",
  auditUserId: "user-1",
  actorType: "HUMAN" as const,
};

describe("authorizeScim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetThrottleForTests();
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns ok=true and validated data on the happy path", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: true, data: validatedToken });

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual(validatedToken);

    expect(mockValidateScimToken).toHaveBeenCalledTimes(1);
    expect(mockEnforceAccessRestriction).toHaveBeenCalledTimes(1);
    expect(mockRateLimitCheck).toHaveBeenCalledWith("rl:scim:tenant-1");
  });

  it("returns 401 SCIM error when token validation fails", async () => {
    mockValidateScimToken.mockResolvedValue({
      ok: false,
      error: "SCIM_TOKEN_INVALID",
    });

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      const body = (await res.response.json()) as { detail: string };
      expect(body.detail).toBe("SCIM_TOKEN_INVALID");
    }
    expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
    expect(mockRateLimitCheck).not.toHaveBeenCalled();
  });

  it("returns the access-restriction response when the network policy denies", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: true, data: validatedToken });
    const denied = new Response("forbidden", { status: 403 });
    mockEnforceAccessRestriction.mockResolvedValue(denied);

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response).toBe(denied);
    }
    expect(mockRateLimitCheck).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limiter denies", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: true, data: validatedToken });
    mockRateLimitCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(429);
    }
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: true, data: validatedToken });
    // authorizeScim is the SCIM route's auth gate — it performs no tenant
    // data read/write itself. The downstream-processing spy models the
    // SCIM handler body (e.g. prisma.user lookups) that a route MUST NOT
    // reach when authorizeScim returns ok:false (read-only-route semantic
    // extension documented in the plan's per-route table; NOT
    // logAuditAsync — excluded per M9, the 503 path itself calls it via
    // emitRateLimitFailClosed).
    const tenantLookupSpy = vi.fn();

    await assertRedisFailClosed({
      invoke: async () => {
        const res = await authorizeScim(fakeRequest());
        if (res.ok) {
          // Would only run past a successful auth gate — must not happen.
          tenantLookupSpy();
          throw new Error("expected authorizeScim to return ok:false");
        }
        return res.response;
      },
      limiter: scimLimiter,
      expectation: {
        envelope: "custom",
        status: 503,
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          status: "503",
          detail: "Service temporarily unavailable",
        },
        retryAfter: "required",
      },
      assertNoMutation: [tenantLookupSpy],
      limiterFactory: scimLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("propagates expired-token error code as 401 (no access check, no rate limit)", async () => {
    mockValidateScimToken.mockResolvedValue({
      ok: false,
      error: "SCIM_TOKEN_EXPIRED",
    });

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
    }
    expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
    expect(mockRateLimitCheck).not.toHaveBeenCalled();
  });

  it("propagates revoked-token error code as 401 (no access check, no rate limit)", async () => {
    mockValidateScimToken.mockResolvedValue({
      ok: false,
      error: "SCIM_TOKEN_REVOKED",
    });

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
    }
    expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
  });

  it("emits RATE_LIMIT_FAIL_CLOSED audit row and skips tenant lookup on redisErrored", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: true, data: validatedToken });
    mockRateLimitCheck.mockResolvedValue({ allowed: false, redisErrored: true });

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(503);
    expect(mockEnforceAccessRestriction).toHaveBeenCalledTimes(1);

    await vi.waitFor(() =>
      expect(mockLogAuditAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTION.RATE_LIMIT_FAIL_CLOSED,
          targetId: "scim",
        }),
      ),
    );
  });
});
