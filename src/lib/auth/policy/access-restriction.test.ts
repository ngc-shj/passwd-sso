import { describe, it, expect, vi, beforeEach } from "vitest";
import { ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";

// T3.4: checkAccessRestrictionWithAudit uses ANONYMOUS_ACTOR_ID when userId is null

// Mocks are hoisted references (not a typed `prisma` import) so a test can
// resolve a partial policy shape without fighting the full Prisma Tenant type.
const {
  mockLogAudit,
  mockTenantFindUnique,
  mockVerifyTailscalePeer,
  mockIsTailscaleIp,
  mockIsIpAllowed,
} = vi.hoisted(() => ({
  mockLogAudit: vi.fn(),
  mockTenantFindUnique: vi.fn().mockResolvedValue({
    allowedCidrs: ["192.168.0.0/24"], // restrictive — will block 1.2.3.4
    tailscaleEnabled: false,
    tailscaleTailnet: null,
  }),
  mockVerifyTailscalePeer: vi.fn().mockResolvedValue(false),
  mockIsTailscaleIp: vi.fn().mockReturnValue(false),
  mockIsIpAllowed: vi.fn().mockReturnValue(false), // IP not in allowlist
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { tenant: { findUnique: mockTenantFindUnique } },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  BYPASS_PURPOSE: { AUTH_FLOW: "auth_flow" },
}));

vi.mock("@/lib/auth/policy/ip-access", () => ({
  isIpAllowed: mockIsIpAllowed,
  isTailscaleIp: mockIsTailscaleIp,
  extractClientIp: vi.fn().mockReturnValue("1.2.3.4"),
}));

vi.mock("@/lib/services/tailscale-client", () => ({
  verifyTailscalePeer: mockVerifyTailscalePeer,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
}));

vi.mock("@/lib/tenant-context", () => ({
  resolveUserTenantId: vi.fn(),
}));

import {
  checkAccessRestriction,
  checkAccessRestrictionWithAudit,
  _clearPolicyCache,
  _policyCache,
  _POLICY_CACHE_MAX_SIZE,
} from "@/lib/auth/policy/access-restriction";
import { NextRequest } from "next/server";

describe("checkAccessRestrictionWithAudit — sentinel fallback", () => {
  beforeEach(() => {
    _clearPolicyCache();
    mockLogAudit.mockReset();
  });

  it("uses ANONYMOUS_ACTOR_ID with ANONYMOUS actorType when userId is null and access is denied", async () => {
    const req = new NextRequest("http://localhost/api/test");
    const result = await checkAccessRestrictionWithAudit("tenant-1", "1.2.3.4", null, req);

    expect(result.allowed).toBe(false);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ANONYMOUS_ACTOR_ID,
        actorType: "ANONYMOUS",
        tenantId: "tenant-1",
      }),
    );
  });

  it("uses provided userId with HUMAN actorType when userId is set and access is denied", async () => {
    const req = new NextRequest("http://localhost/api/test");
    await checkAccessRestrictionWithAudit("tenant-1", "1.2.3.4", "user-abc", req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-abc",
        actorType: "HUMAN",
        tenantId: "tenant-1",
      }),
    );
  });
});

describe("policyCache eviction — TTL sweep before FIFO", () => {
  beforeEach(() => {
    _clearPolicyCache();
  });

  it("evicts expired entries first when the cache fills, preserving fresh entries", async () => {
    // Pre-fill the cache to capacity. Mark every odd-indexed entry as
    // already expired; even-indexed entries remain fresh. With pure FIFO
    // eviction the head ("expired-0") would still be evicted as oldest by
    // insertion order even when other expired entries are deeper in the
    // map — so this test passes trivially under either FIFO or sweep.
    // The interesting assertion is the second one: after the sweep fires
    // it should remove ALL expired entries, leaving the fresh ones intact.
    const now = Date.now();
    for (let i = 0; i < _POLICY_CACHE_MAX_SIZE; i++) {
      _policyCache.set(`tenant-${i}`, {
        policy: {
          allowedCidrs: [],
          tailscaleEnabled: false,
          tailscaleTailnet: null,
        },
        // Half expired, half fresh — interleaved so the FIFO head is fresh.
        expiresAt: i % 2 === 0 ? now + 60_000 : now - 1,
      });
    }
    expect(_policyCache.size).toBe(_POLICY_CACHE_MAX_SIZE);

    // Trigger the eviction path by calling the route through one fresh
    // tenant fetch. The eviction is inline in getTenantAccessPolicy, so we
    // call its public consumer.
    const req = new NextRequest("http://localhost/api/test");
    await checkAccessRestrictionWithAudit("tenant-new", "1.2.3.4", "user-x", req);

    // After the TTL sweep, every expired entry (odd indices) is gone; the
    // fresh entries (even indices) survive. Plus the newly-inserted entry.
    expect(_policyCache.has("tenant-new")).toBe(true);
    for (let i = 0; i < _POLICY_CACHE_MAX_SIZE; i++) {
      if (i % 2 === 0) {
        expect(_policyCache.has(`tenant-${i}`)).toBe(true);
      } else {
        expect(_policyCache.has(`tenant-${i}`)).toBe(false);
      }
    }
  });

  it("falls back to FIFO when every entry is fresh", async () => {
    const now = Date.now();
    for (let i = 0; i < _POLICY_CACHE_MAX_SIZE; i++) {
      _policyCache.set(`tenant-${i}`, {
        policy: {
          allowedCidrs: [],
          tailscaleEnabled: false,
          tailscaleTailnet: null,
        },
        expiresAt: now + 60_000,
      });
    }
    expect(_policyCache.size).toBe(_POLICY_CACHE_MAX_SIZE);

    const req = new NextRequest("http://localhost/api/test");
    await checkAccessRestrictionWithAudit("tenant-new", "1.2.3.4", "user-x", req);

    // All fresh → TTL sweep deletes nothing → FIFO fallback evicts head ("tenant-0").
    expect(_policyCache.has("tenant-0")).toBe(false);
    expect(_policyCache.has("tenant-new")).toBe(true);
    expect(_policyCache.size).toBe(_POLICY_CACHE_MAX_SIZE);
  });
});

// C5: the WhoIs tailnet check now lives in checkAccessRestriction itself
// (not just enforceAccessRestriction), so every caller — including browser
// session paths — inherits it. verifyTailscalePeer is mocked one level below
// the function under test, so these tests can observe whether it was called.
describe("checkAccessRestriction — Tailscale tailnet verification (C5)", () => {
  beforeEach(() => {
    _clearPolicyCache();
    mockLogAudit.mockReset();
  });

  it("denies on a WhoIs tailnet mismatch, auditing the mismatch reason", async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      allowedCidrs: [],
      tailscaleEnabled: true,
      tailscaleTailnet: "acme",
    });
    mockIsTailscaleIp.mockReturnValueOnce(true);
    mockVerifyTailscalePeer.mockResolvedValueOnce(false);

    const req = new NextRequest("http://localhost/api/test");
    const result = await checkAccessRestrictionWithAudit(
      "tenant-mismatch",
      "100.64.0.1",
      "user-1",
      req,
    );

    expect(result).toEqual({ allowed: false, reason: "Tailscale tailnet mismatch" });
    expect(mockVerifyTailscalePeer).toHaveBeenCalledWith("100.64.0.1", "acme");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-mismatch",
        metadata: expect.objectContaining({ reason: "Tailscale tailnet mismatch" }),
      }),
    );
  });

  it("allows when the WhoIs tailnet matches the policy", async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      allowedCidrs: [],
      tailscaleEnabled: true,
      tailscaleTailnet: "acme",
    });
    mockIsTailscaleIp.mockReturnValueOnce(true);
    mockVerifyTailscalePeer.mockResolvedValueOnce(true);

    const result = await checkAccessRestriction("tenant-match", "100.64.0.2");

    expect(result).toEqual({ allowed: true });
  });

  it("denies fail-closed when tailscaled is unreachable", async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      allowedCidrs: [],
      tailscaleEnabled: true,
      tailscaleTailnet: "acme",
    });
    mockIsTailscaleIp.mockReturnValueOnce(true);
    // verifyTailscalePeer already fails closed on socket errors/timeouts
    // (asserted in tailscale-client.test.ts); the caller only ever sees its
    // boolean result, which is what this asserts propagates to a denial.
    mockVerifyTailscalePeer.mockResolvedValueOnce(false);

    const result = await checkAccessRestriction("tenant-unreachable", "100.64.0.3");

    expect(result.allowed).toBe(false);
  });

  it("allows via allowedCidrs without calling verifyTailscalePeer (recovery path precedence)", async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      allowedCidrs: ["10.0.0.0/24"],
      tailscaleEnabled: true,
      tailscaleTailnet: "acme",
    });
    mockIsIpAllowed.mockReturnValueOnce(true);

    const result = await checkAccessRestriction("tenant-cidr-precedence", "10.0.0.5");

    expect(result).toEqual({ allowed: true });
    expect(mockVerifyTailscalePeer).not.toHaveBeenCalled();
  });

  it("keeps CGNAT-only behaviour when tailscaleEnabled is set without a pinned tailnet", async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      allowedCidrs: [],
      tailscaleEnabled: true,
      tailscaleTailnet: null,
    });
    mockIsTailscaleIp.mockReturnValueOnce(true);

    const result = await checkAccessRestriction("tenant-no-tailnet", "100.64.0.6");

    expect(result).toEqual({ allowed: true });
    expect(mockVerifyTailscalePeer).not.toHaveBeenCalled();
  });
});
