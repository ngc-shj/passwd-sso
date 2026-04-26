import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindFirst, mockWithBypassRls } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: { findFirst: mockFindFirst },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { requireMaintenanceOperator } from "./maintenance-auth";
import { TENANT_ROLE } from "@/lib/constants/auth/tenant-role";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";

describe("requireMaintenanceOperator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns operator on active OWNER membership", async () => {
    mockFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: TENANT_ROLE.OWNER });

    const result = await requireMaintenanceOperator("user-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operator).toEqual({ tenantId: "tenant-1", role: "OWNER" });
    }
  });

  it("returns operator on active ADMIN membership", async () => {
    mockFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: TENANT_ROLE.ADMIN });

    const result = await requireMaintenanceOperator("user-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operator.role).toBe("ADMIN");
    }
  });

  it("returns 400 NextResponse when no active admin membership found", async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await requireMaintenanceOperator("user-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toContain("active tenant admin");
    }
  });

  it("filters by OWNER and ADMIN roles only", async () => {
    mockFindFirst.mockResolvedValue(null);

    await requireMaintenanceOperator("user-1");

    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where.role).toEqual({ in: [TENANT_ROLE.OWNER, TENANT_ROLE.ADMIN] });
  });

  it("filters out deactivated members", async () => {
    mockFindFirst.mockResolvedValue(null);

    await requireMaintenanceOperator("user-1");

    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where.deactivatedAt).toBeNull();
  });

  it("orders by createdAt ascending for deterministic multi-tenant resolution", async () => {
    mockFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: TENANT_ROLE.ADMIN });

    await requireMaintenanceOperator("user-1");

    const args = mockFindFirst.mock.calls[0][0];
    expect(args.orderBy).toEqual({ createdAt: "asc" });
  });

  it("does NOT add tenantId to where clause when option is omitted", async () => {
    mockFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: TENANT_ROLE.ADMIN });

    await requireMaintenanceOperator("user-1");

    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("tenantId");
  });

  it("adds tenantId to where clause when option is provided", async () => {
    mockFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: TENANT_ROLE.ADMIN });

    await requireMaintenanceOperator("user-1", { tenantId: "tenant-1" });

    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where.tenantId).toBe("tenant-1");
  });

  it("treats explicit tenantId: undefined the same as omitted option", async () => {
    mockFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: TENANT_ROLE.ADMIN });

    await requireMaintenanceOperator("user-1", { tenantId: undefined });

    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("tenantId");
  });

  it("throws when DB returns a row whose role is unexpectedly outside OWNER/ADMIN", async () => {
    // Simulates schema/enum drift where the where filter is bypassed.
    mockFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "MEMBER" });

    await expect(requireMaintenanceOperator("user-1")).rejects.toThrow(
      /invariant violated/,
    );
  });

  it("uses BYPASS_PURPOSE.SYSTEM_MAINTENANCE for the RLS bypass", async () => {
    mockFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: TENANT_ROLE.ADMIN });

    await requireMaintenanceOperator("user-1");

    // Second arg to withBypassRls is the function, third is the purpose.
    const purpose = mockWithBypassRls.mock.calls[0][2];
    expect(purpose).toBe(BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
  });
});
