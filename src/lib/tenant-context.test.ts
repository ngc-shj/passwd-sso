import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────

const { mockFindMany, mockFindUnique, mockWithBypassRls, mockWithTenantRls } =
  vi.hoisted(() => ({
    mockFindMany: vi.fn(),
    mockFindUnique: vi.fn(),
    mockWithBypassRls: vi.fn(),
    mockWithTenantRls: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: { findMany: mockFindMany },
    team: { findUnique: mockFindUnique },
  },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
  withTenantRls: mockWithTenantRls,
}));

// ─── SUT ────────────────────────────────────────────────────

import {
  resolveUserTenantIdFromClient,
  resolveUserTenantId,
  resolveTeamTenantId,
  withUserTenantRls,
  withTeamTenantRls,
} from "@/lib/tenant-context";
import { prisma } from "@/lib/prisma";

// ─── Tests ──────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: withBypassRls executes the callback directly
  mockWithBypassRls.mockImplementation(
    (_prisma: unknown, fn: () => unknown) => fn(),
  );
  // Default: withTenantRls executes the callback directly
  mockWithTenantRls.mockImplementation(
    (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn(),
  );
});

// ─── resolveUserTenantIdFromClient ─────────────────────────

describe("resolveUserTenantIdFromClient", () => {
  it("returns null when memberships count is 0", async () => {
    mockFindMany.mockResolvedValue([]);

    const result = await resolveUserTenantIdFromClient(prisma, "user-1");

    expect(result).toBeNull();
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { userId: "user-1", deactivatedAt: null },
      select: { tenantId: true },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
  });

  it("returns tenantId when exactly 1 membership exists", async () => {
    mockFindMany.mockResolvedValue([{ tenantId: "tenant-abc" }]);

    const result = await resolveUserTenantIdFromClient(prisma, "user-1");

    expect(result).toBe("tenant-abc");
  });

  it("throws MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED when 2+ memberships exist", async () => {
    mockFindMany.mockResolvedValue([
      { tenantId: "tenant-1" },
      { tenantId: "tenant-2" },
    ]);

    await expect(
      resolveUserTenantIdFromClient(prisma, "user-1"),
    ).rejects.toThrow("MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED");
  });
});

// ─── resolveUserTenantId ───────────────────────────────────

describe("resolveUserTenantId", () => {
  it("calls withBypassRls and resolveUserTenantIdFromClient", async () => {
    mockFindMany.mockResolvedValue([{ tenantId: "tenant-abc" }]);

    const result = await resolveUserTenantId("user-1");

    expect(result).toBe("tenant-abc");
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      prisma,
      expect.any(Function),
    );
    expect(mockFindMany).toHaveBeenCalled();
  });
});

// ─── resolveTeamTenantId ───────────────────────────────────

describe("resolveTeamTenantId", () => {
  it("returns tenantId from team.findUnique", async () => {
    mockFindUnique.mockResolvedValue({ tenantId: "tenant-xyz" });

    const result = await resolveTeamTenantId("team-1");

    expect(result).toBe("tenant-xyz");
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      prisma,
      expect.any(Function),
    );
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: "team-1" },
      select: { tenantId: true },
    });
  });

  it("returns null when team doesn't exist", async () => {
    mockFindUnique.mockResolvedValue(null);

    const result = await resolveTeamTenantId("team-nonexistent");

    expect(result).toBeNull();
  });
});

// ─── withUserTenantRls ─────────────────────────────────────

describe("withUserTenantRls", () => {
  it("throws TENANT_NOT_RESOLVED when resolveUserTenantId returns null", async () => {
    mockFindMany.mockResolvedValue([]);

    await expect(
      withUserTenantRls("user-no-tenant", async () => "result"),
    ).rejects.toThrow("TENANT_NOT_RESOLVED");

    expect(mockWithTenantRls).not.toHaveBeenCalled();
  });

  it("calls withTenantRls with resolved tenantId", async () => {
    mockFindMany.mockResolvedValue([{ tenantId: "tenant-abc" }]);
    mockWithTenantRls.mockResolvedValue("inner-result");

    const result = await withUserTenantRls("user-1", async () => "inner-result");

    expect(result).toBe("inner-result");
    expect(mockWithTenantRls).toHaveBeenCalledWith(
      prisma,
      "tenant-abc",
      expect.any(Function),
    );
  });
});

// ─── withTeamTenantRls ─────────────────────────────────────

describe("withTeamTenantRls", () => {
  it("throws TENANT_NOT_RESOLVED when resolveTeamTenantId returns null", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      withTeamTenantRls("team-no-tenant", async () => "result"),
    ).rejects.toThrow("TENANT_NOT_RESOLVED");

    expect(mockWithTenantRls).not.toHaveBeenCalled();
  });

  it("calls withTenantRls with resolved tenantId", async () => {
    mockFindUnique.mockResolvedValue({ tenantId: "tenant-xyz" });
    mockWithTenantRls.mockResolvedValue("team-result");

    const result = await withTeamTenantRls("team-1", async () => "team-result");

    expect(result).toBe("team-result");
    expect(mockWithTenantRls).toHaveBeenCalledWith(
      prisma,
      "tenant-xyz",
      expect.any(Function),
    );
  });
});
