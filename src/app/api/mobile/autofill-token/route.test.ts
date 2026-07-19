import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

// ─── Hoisted mocks ───────────────────────────────────────────

const { mockCheckAuth, mockIssueAutofill, mockLogAudit, mockWarn, mockError, mockCheck, mockCreateRateLimiter, mockEnforceAccessRestriction } = vi.hoisted(() => {
  const mockCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
  mockCheckAuth: vi.fn(),
  mockIssueAutofill: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockCheck,
  // Recording factory — assertRedisFailClosed's factory-attribution step
  // reads mockCreateRateLimiter.mock.{calls,results}.
  mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockCheck, clear: vi.fn() })),
  mockEnforceAccessRestriction: vi.fn(),
  };
});

vi.mock("@/lib/auth/policy/access-restriction", () => ({ enforceAccessRestriction: mockEnforceAccessRestriction }));
vi.mock("@/lib/auth/session/check-auth", () => ({ checkAuth: mockCheckAuth }));
vi.mock("@/lib/auth/tokens/mobile-token", () => ({ issueAutofillToken: mockIssueAutofill }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: () => ({}),
}));
// checkRateLimitOrFail is un-mocked (production translator stays in path,
// C6/RT5) — mocked at the limiter layer instead. rate-limit-audit.ts imports
// resolveUserTenantId from @/lib/tenant-context, which transitively imports
// @/lib/prisma; mock prisma defensively so that import-time chain resolves
// even though the route always passes tenantId explicitly (never invoking
// resolveUserTenantId at runtime).
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: mockWarn, error: mockError, info: vi.fn(), debug: vi.fn() },
  getLogger: () => ({ warn: mockWarn, error: mockError, info: vi.fn(), debug: vi.fn() }),
}));

import { POST } from "./route";

// Module-scope snapshot (route.ts:26 `const mintLimiter = createRateLimiter(...)`
// runs at import time, above). See fail-closed.ts module doc.
const mintLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const mintLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockCheck;
};

const VALID_JWK = { kty: "EC", crv: "P-256", x: "eHh4", y: "eXl5" };

function post(body: unknown) {
  return createRequest("POST", "http://localhost/api/mobile/autofill-token", { body });
}

describe("POST /api/mobile/autofill-token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogAudit.mockResolvedValue(undefined);
    // Default: rate limit allows the request through.
    mockCheck.mockResolvedValue({ allowed: true });
    // Default: tenant IP access restriction allows (helper returns null).
    mockEnforceAccessRestriction.mockResolvedValue(null);
  });

  it("mints a token bound to the supplied jwk for an authenticated host token", async () => {
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "token", userId: "u1", tenantId: "t1", clientKind: "IOS_APP" } });
    mockIssueAutofill.mockResolvedValue({
      token: "secret-token",
      expiresAt: new Date("2026-06-13T00:05:00.000Z"),
      cnfJkt: "ignored",
      scope: "passwords:write",
    });

    const res = await POST(post({ jwk: VALID_JWK }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(json.token).toBe("secret-token");
    expect(json.scope).toEqual(["passwords:write"]);
    // The mint is rate-limited per authenticated user under the correct key.
    expect(mockCheck).toHaveBeenCalledWith("rl:mobile_autofill_token:u1");
    // The route computes cnf.jkt from the body jwk and binds the token to it.
    const passed = mockIssueAutofill.mock.calls[0][0];
    expect(passed).toMatchObject({ userId: "u1", tenantId: "t1" });
    expect(passed.cnfJkt).toEqual(expect.any(String));
    expect(json.cnfJkt).toBe(passed.cnfJkt);
  });

  it("returns the auth failure response when checkAuth fails", async () => {
    mockCheckAuth.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await POST(post({ jwk: VALID_JWK }));
    expect(res.status).toBe(401);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("rejects a session caller (only the host token may broker an AutoFill token)", async () => {
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "session", userId: "u1" } });
    const res = await POST(post({ jwk: VALID_JWK }));
    expect(res.status).toBe(401);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("rejects a non-IOS_APP token (BROWSER_EXTENSION shares the scope but may not mint)", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "token", userId: "u1", tenantId: "t1", clientKind: "BROWSER_EXTENSION" },
    });
    const res = await POST(post({ jwk: VALID_JWK }));
    expect(res.status).toBe(401);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("denies an off-network IP before minting (tenant IP restriction)", async () => {
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "token", userId: "u1", tenantId: "t1", clientKind: "IOS_APP" } });
    mockEnforceAccessRestriction.mockResolvedValue(
      Response.json({ error: "ACCESS_DENIED" }, { status: 403 }),
    );

    const res = await POST(post({ jwk: VALID_JWK }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("ACCESS_DENIED");
    // Enforced on the authenticated tenantId, and NO token is minted off-network.
    expect(mockEnforceAccessRestriction).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      "t1",
      "HUMAN",
    );
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("rejects an IOS_AUTOFILL token (cannot rotate its own kind)", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "token", userId: "u1", tenantId: "t1", clientKind: "IOS_AUTOFILL" },
    });
    const res = await POST(post({ jwk: VALID_JWK }));
    expect(res.status).toBe(401);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("400 on a malformed jwk (missing coordinates)", async () => {
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "token", userId: "u1", tenantId: "t1", clientKind: "IOS_APP" } });
    const res = await POST(post({ jwk: { kty: "EC", crv: "P-256" } }));
    expect(res.status).toBe(400);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("400 on a non-P-256 jwk", async () => {
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "token", userId: "u1", tenantId: "t1", clientKind: "IOS_APP" } });
    const res = await POST(post({ jwk: { kty: "EC", crv: "P-384", x: "a", y: "b" } }));
    expect(res.status).toBe(400);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("429 when the per-user mint budget is exhausted (does NOT mint)", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "token", userId: "u-rl", tenantId: "t1", clientKind: "IOS_APP" },
    });
    mockCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 5_000 });

    const res = await POST(post({ jwk: VALID_JWK }));
    expect(res.status).toBe(429);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "token", userId: "u-rl", tenantId: "t1", clientKind: "IOS_APP" },
    });

    await assertRedisFailClosed({
      invoke: () => POST(post({ jwk: VALID_JWK })),
      limiter: mintLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockIssueAutofill],
      limiterFactory: mintLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });
});
