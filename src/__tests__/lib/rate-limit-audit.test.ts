import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const { mockLogAuditAsync, mockWarn, mockError, mockResolveUserTenantId } = vi.hoisted(() => ({
  mockLogAuditAsync: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockResolveUserTenantId: vi.fn(),
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "203.0.113.5",
    userAgent: "test",
  }),
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: mockWarn, error: mockError, info: vi.fn() }),
}));

vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: () => "203.0.113.5",
  rateLimitKeyFromIp: (ip: string) => ip,
}));

vi.mock("@/lib/tenant-context", () => ({
  resolveUserTenantId: mockResolveUserTenantId,
}));

import {
  __getThrottleStateForTests,
  __resetThrottleForTests,
  emitRateLimitFailClosed,
} from "@/lib/security/rate-limit-audit";

function fakeReq(): NextRequest {
  return { headers: new Headers() } as unknown as NextRequest;
}

beforeEach(() => {
  __resetThrottleForTests();
  mockLogAuditAsync.mockReset();
  mockLogAuditAsync.mockResolvedValue(undefined);
  mockWarn.mockReset();
  mockError.mockReset();
  mockResolveUserTenantId.mockReset();
  mockResolveUserTenantId.mockResolvedValue(null); // default: pre-auth/unresolvable
});

afterEach(() => {
  __resetThrottleForTests();
});

describe("emitRateLimitFailClosed", () => {
  // AC3.1
  it("first call with non-null tenantId invokes logAuditAsync with action+target+scope", async () => {
    await emitRateLimitFailClosed({
      req: fakeReq(),
      scope: "vault.unlock",
      userId: "user-1",
      tenantId: "tenant-1",
    });
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
    const call = mockLogAuditAsync.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      action: "RATE_LIMIT_FAIL_CLOSED",
      targetType: "RateLimiter",
      targetId: "vault.unlock",
      scope: "TENANT",
      actorType: "HUMAN",
      userId: "user-1",
      tenantId: "tenant-1",
    });
    expect(call.metadata).toMatchObject({
      scope: "vault.unlock",
      ip: "203.0.113.5",
      ipBucket: "203.0.113.5",
    });
  });

  // AC3.2
  it("second call within 5-min window for same (scope, userId) is throttled (no second emission)", async () => {
    const args = {
      req: fakeReq(),
      scope: "vault.unlock",
      userId: "user-1",
      tenantId: "tenant-1",
    };
    await emitRateLimitFailClosed(args);
    await emitRateLimitFailClosed(args);
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
  });

  // AC3.3
  it("never propagates errors from logAuditAsync (fire-and-forget)", async () => {
    mockLogAuditAsync.mockRejectedValueOnce(new Error("DB down"));
    await expect(
      emitRateLimitFailClosed({
        req: fakeReq(),
        scope: "vault.unlock",
        userId: "user-1",
        tenantId: "tenant-1",
      }),
    ).resolves.toBeUndefined();
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "vault.unlock" }),
      "rate-limit.fail_closed.emit_error",
    );
  });

  // AC3.4
  it("when userId is null, actorType=ANONYMOUS and userId=ANONYMOUS_ACTOR_ID", async () => {
    await emitRateLimitFailClosed({
      req: fakeReq(),
      scope: "auth.passkey_reauth_verify",
      userId: null,
      tenantId: "tenant-1",
    });
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
    const call = mockLogAuditAsync.mock.calls[0]?.[0];
    expect(call.actorType).toBe("ANONYMOUS");
    expect(call.userId).toBe("00000000-0000-4000-8000-000000000000");
  });

  // AC3.5
  it("metadata contains scope/ip/ipBucket only (no email or token fragments)", async () => {
    await emitRateLimitFailClosed({
      req: fakeReq(),
      scope: "vault.unlock",
      userId: "user-1",
      tenantId: "tenant-1",
    });
    const call = mockLogAuditAsync.mock.calls[0]?.[0];
    expect(Object.keys(call.metadata).sort()).toEqual(["ip", "ipBucket", "scope"]);
  });

  // AC3.6 — true pre-auth (userId null AND no tenant): warn-log only
  it("when userId is null AND tenantId is null, skips logAuditAsync and emits warn log", async () => {
    await emitRateLimitFailClosed({
      req: fakeReq(),
      scope: "auth.passkey_options",
      userId: null,
      tenantId: null,
    });
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
    expect(mockResolveUserTenantId).not.toHaveBeenCalled(); // userId null → no resolution attempt
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "auth.passkey_options" }),
      "rate-limit.fail_closed.pre_auth_skip",
    );
  });

  // F1/S1 fix — post-auth path: tenantId not provided but userId is → resolve via tenant-context
  it("when userId present and tenantId null, resolves tenantId from userId and emits audit", async () => {
    mockResolveUserTenantId.mockResolvedValue("tenant-resolved");
    await emitRateLimitFailClosed({
      req: fakeReq(),
      scope: "vault.unlock",
      userId: "user-1",
      tenantId: null,
    });
    expect(mockResolveUserTenantId).toHaveBeenCalledWith("user-1");
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
    const call = mockLogAuditAsync.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      action: "RATE_LIMIT_FAIL_CLOSED",
      actorType: "HUMAN",
      userId: "user-1",
      tenantId: "tenant-resolved",
    });
  });

  // F1/S1 fix — post-auth fallback: tenant resolution returns null → fall back to warn-log
  it("falls back to warn-log when tenant resolution returns null", async () => {
    mockResolveUserTenantId.mockResolvedValue(null);
    await emitRateLimitFailClosed({
      req: fakeReq(),
      scope: "vault.unlock",
      userId: "orphan-user",
      tenantId: null,
    });
    expect(mockResolveUserTenantId).toHaveBeenCalledWith("orphan-user");
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "vault.unlock" }),
      "rate-limit.fail_closed.pre_auth_skip",
    );
  });

  // F1/S1 fix — resolution throws → fall back to warn-log (never propagates)
  it("falls back to warn-log when tenant resolution throws", async () => {
    mockResolveUserTenantId.mockRejectedValueOnce(new Error("DB down"));
    await emitRateLimitFailClosed({
      req: fakeReq(),
      scope: "vault.unlock",
      userId: "user-1",
      tenantId: null,
    });
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "vault.unlock" }),
      "rate-limit.fail_closed.pre_auth_skip",
    );
  });

  // Caller already knows tenantId → no DB lookup attempted
  it("does not call resolveUserTenantId when caller provides tenantId directly", async () => {
    await emitRateLimitFailClosed({
      req: fakeReq(),
      scope: "vault.delegation",
      userId: "user-1",
      tenantId: "tenant-from-caller",
    });
    expect(mockResolveUserTenantId).not.toHaveBeenCalled();
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
  });

  // AC3.7 — invalid scope regex → fail-safe (warn + drop) + throttle map stays clean
  it("scope failing the regex is dropped with a warn (no throw, no emit, throttle untouched)", async () => {
    await emitRateLimitFailClosed({
      req: fakeReq(),
      scope: "Invalid Scope With Spaces",
      userId: "user-1",
      tenantId: "tenant-1",
    });
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      { scope: "Invalid Scope With Spaces" },
      "rate-limit.fail_closed.invalid_scope",
    );
    // T5 — verify invalid-scope path does NOT pollute the throttle map
    expect(__getThrottleStateForTests().size).toBe(0);
  });

  it("scope regex accepts dotted lower-snake (e.g. mcp.token_refresh)", async () => {
    await emitRateLimitFailClosed({
      req: fakeReq(),
      scope: "mcp.token_refresh",
      userId: "user-1",
      tenantId: "tenant-1",
    });
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      "rate-limit.fail_closed.invalid_scope",
    );
  });

  // AC3.8 — LRU eviction preserves recently-touched entries
  it("LRU eviction preserves the recently-touched t0_key after sustained pressure", async () => {
    // Note: each call adds 1 throttle entry when shouldEmit() returns true.
    // The cap is RATE_LIMIT_MAP_MAX_SIZE (10_000). To verify LRU vs clear-all
    // we touch t0_key, inject 10_500 distinct synthetic keys, periodically
    // re-touch t0_key, and assert it survives.
    const t0_key = "rlfc:vault.unlock:user-t0";

    // Touch t0 first
    await emitRateLimitFailClosed({
      req: fakeReq(),
      scope: "vault.unlock",
      userId: "user-t0",
      tenantId: "tenant-1",
    });
    expect(__getThrottleStateForTests().has(t0_key)).toBe(true);

    const N = 10_500;
    for (let i = 0; i < N; i++) {
      // Each unique userId produces a distinct throttle key (1 entry per call)
      await emitRateLimitFailClosed({
        req: fakeReq(),
        scope: "vault.unlock",
        userId: `user-${i}`,
        tenantId: "tenant-1",
      });
      // Re-touch t0 every 500 iterations: call gets throttled (no audit emit),
      // but the in-window touch bumps t0's insertion order to the tail so LRU
      // eviction protects it.
      if (i % 500 === 0) {
        await emitRateLimitFailClosed({
          req: fakeReq(),
          scope: "vault.unlock",
          userId: "user-t0",
          tenantId: "tenant-1",
        });
      }
    }

    // t0 was touched recently → must survive LRU eviction
    expect(__getThrottleStateForTests().has(t0_key)).toBe(true);
    // The very first synthetic key was evicted long ago
    expect(__getThrottleStateForTests().has("rlfc:vault.unlock:user-0")).toBe(false);
    // Cap respected
    expect(__getThrottleStateForTests().size).toBeLessThanOrEqual(10_000);
  });
});

