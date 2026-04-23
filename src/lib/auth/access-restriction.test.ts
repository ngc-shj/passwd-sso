import { describe, it, expect, vi, beforeEach } from "vitest";
import { ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";

// T3.4: checkAccessRestrictionWithAudit uses ANONYMOUS_ACTOR_ID when userId is null

const { mockLogAudit } = vi.hoisted(() => ({ mockLogAudit: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: {
      findUnique: vi.fn().mockResolvedValue({
        allowedCidrs: ["192.168.0.0/24"], // restrictive — will block 1.2.3.4
        tailscaleEnabled: false,
        tailscaleTailnet: null,
      }),
    },
  },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  BYPASS_PURPOSE: { AUTH_FLOW: "auth_flow" },
}));

vi.mock("@/lib/auth/ip-access", () => ({
  isIpAllowed: vi.fn().mockReturnValue(false), // IP not in allowlist
  isTailscaleIp: vi.fn().mockReturnValue(false),
  extractClientIp: vi.fn().mockReturnValue("1.2.3.4"),
}));

vi.mock("@/lib/services/tailscale-client", () => ({
  verifyTailscalePeer: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
}));

vi.mock("@/lib/tenant-context", () => ({
  resolveUserTenantId: vi.fn(),
}));

import { checkAccessRestrictionWithAudit, _clearPolicyCache } from "@/lib/auth/access-restriction";
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
