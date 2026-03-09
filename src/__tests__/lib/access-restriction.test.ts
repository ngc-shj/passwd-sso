import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTenantFindUnique, mockWithBypassRls, mockLogAudit } = vi.hoisted(() => ({
  mockTenantFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { tenant: { findUnique: mockTenantFindUnique } },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
}));
vi.mock("@/lib/tailscale-client", () => ({
  verifyTailscalePeer: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/constants", () => ({
  AUDIT_ACTION: { ACCESS_DENIED: "ACCESS_DENIED" },
  AUDIT_SCOPE: { TENANT: "TENANT" },
}));

import {
  checkAccessRestriction,
  checkAccessRestrictionWithAudit,
  wouldIpBeAllowed,
  invalidateTenantPolicyCache,
  _clearPolicyCache,
} from "@/lib/access-restriction";
import { verifyTailscalePeer } from "@/lib/tailscale-client";
import { NextRequest } from "next/server";

describe("checkAccessRestriction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearPolicyCache();
  });

  it("allows access when no restrictions configured", async () => {
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: [],
      tailscaleEnabled: false,
      tailscaleTailnet: null,
    });

    const result = await checkAccessRestriction("tenant1", "192.168.1.1");
    expect(result.allowed).toBe(true);
  });

  it("allows access when IP matches CIDR", async () => {
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: ["192.168.1.0/24"],
      tailscaleEnabled: false,
      tailscaleTailnet: null,
    });

    const result = await checkAccessRestriction("tenant1", "192.168.1.50");
    expect(result.allowed).toBe(true);
  });

  it("denies access when IP does not match CIDR", async () => {
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: ["192.168.1.0/24"],
      tailscaleEnabled: false,
      tailscaleTailnet: null,
    });

    const result = await checkAccessRestriction("tenant1", "10.0.0.1");
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toContain("IP not in allowed CIDRs");
  });

  it("allows access when Tailscale verifies", async () => {
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: [],
      tailscaleEnabled: true,
      tailscaleTailnet: "my-tailnet",
    });
    vi.mocked(verifyTailscalePeer).mockResolvedValueOnce(true);

    const result = await checkAccessRestriction("tenant1", "100.64.0.1");
    expect(result.allowed).toBe(true);
  });

  it("denies when Tailscale verification fails and no CIDR match", async () => {
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: ["10.0.0.0/8"],
      tailscaleEnabled: true,
      tailscaleTailnet: "my-tailnet",
    });
    vi.mocked(verifyTailscalePeer).mockResolvedValueOnce(false);

    const result = await checkAccessRestriction("tenant1", "192.168.1.1");
    expect(result.allowed).toBe(false);
  });

  it("uses OR logic — CIDR match bypasses Tailscale check", async () => {
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: ["192.168.1.0/24"],
      tailscaleEnabled: true,
      tailscaleTailnet: "my-tailnet",
    });

    const result = await checkAccessRestriction("tenant1", "192.168.1.50");
    expect(result.allowed).toBe(true);
    // Tailscale should not be called since CIDR matched
    expect(verifyTailscalePeer).not.toHaveBeenCalled();
  });

  it("caches policy and uses invalidation", async () => {
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: [],
      tailscaleEnabled: false,
      tailscaleTailnet: null,
    });

    await checkAccessRestriction("tenant1", "192.168.1.1");
    await checkAccessRestriction("tenant1", "192.168.1.2");

    // withBypassRls called only once due to caching
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);

    // After invalidation, should fetch again
    invalidateTenantPolicyCache("tenant1");
    await checkAccessRestriction("tenant1", "192.168.1.3");
    expect(mockWithBypassRls).toHaveBeenCalledTimes(2);
  });
});

describe("wouldIpBeAllowed", () => {
  it("returns true when no restrictions", () => {
    expect(
      wouldIpBeAllowed("10.0.0.1", {
        allowedCidrs: [],
        tailscaleEnabled: false,
        tailscaleTailnet: null,
      }),
    ).toBe(true);
  });

  it("returns true when IP matches CIDR", () => {
    expect(
      wouldIpBeAllowed("192.168.1.50", {
        allowedCidrs: ["192.168.1.0/24"],
        tailscaleEnabled: false,
        tailscaleTailnet: null,
      }),
    ).toBe(true);
  });

  it("returns false when IP does not match CIDR and no Tailscale", () => {
    expect(
      wouldIpBeAllowed("10.0.0.1", {
        allowedCidrs: ["192.168.1.0/24"],
        tailscaleEnabled: false,
        tailscaleTailnet: null,
      }),
    ).toBe(false);
  });

  it("returns true when Tailscale enabled (assumes admin knows)", () => {
    expect(
      wouldIpBeAllowed("10.0.0.1", {
        allowedCidrs: ["192.168.1.0/24"],
        tailscaleEnabled: true,
        tailscaleTailnet: "my-tailnet",
      }),
    ).toBe(true);
  });
});

describe("checkAccessRestrictionWithAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearPolicyCache();
  });

  it("emits audit log when access is denied", async () => {
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: ["192.168.1.0/24"],
      tailscaleEnabled: false,
      tailscaleTailnet: null,
    });

    const req = new NextRequest("http://localhost/api/passwords", {
      headers: { "user-agent": "test-agent" },
    });
    const result = await checkAccessRestrictionWithAudit(
      "tenant1",
      "10.0.0.1",
      "user1",
      req,
    );

    expect(result.allowed).toBe(false);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ACCESS_DENIED",
        scope: "TENANT",
        userId: "user1",
        tenantId: "tenant1",
        metadata: expect.objectContaining({
          clientIp: "10.0.0.1",
          reason: expect.stringContaining("IP not in allowed CIDRs"),
        }),
      }),
    );
  });

  it("does not emit audit log when access is allowed", async () => {
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: ["10.0.0.0/8"],
      tailscaleEnabled: false,
      tailscaleTailnet: null,
    });

    const req = new NextRequest("http://localhost/api/passwords");
    const result = await checkAccessRestrictionWithAudit(
      "tenant1",
      "10.0.0.1",
      "user1",
      req,
    );

    expect(result.allowed).toBe(true);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("denies and logs when clientIp is null and restrictions are active", async () => {
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: ["10.0.0.0/8"],
      tailscaleEnabled: false,
      tailscaleTailnet: null,
    });

    const req = new NextRequest("http://localhost/api/passwords");
    const result = await checkAccessRestrictionWithAudit(
      "tenant1",
      null,
      "user1",
      req,
    );

    expect(result.allowed).toBe(false);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ACCESS_DENIED",
        tenantId: "tenant1",
        metadata: expect.objectContaining({ clientIp: null }),
      }),
    );
  });
});
