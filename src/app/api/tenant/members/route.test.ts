import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTenantMember, mockPrismaAdminVaultReset, mockRequireTenantPermission, mockWithTenantRls, TenantAuthError } = vi.hoisted(() => {
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
    mockPrismaTenantMember: {
      findMany: vi.fn(),
    },
    mockPrismaAdminVaultReset: {
      groupBy: vi.fn(),
    },
    mockRequireTenantPermission: vi.fn(),
    mockWithTenantRls: vi.fn((_p: unknown, _t: unknown, fn: () => unknown) => fn()),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: mockPrismaTenantMember,
    adminVaultReset: mockPrismaAdminVaultReset,
  },
}));
vi.mock("@/lib/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
  withBypassRls: vi.fn((_p: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from "./route";

const TENANT_ID = "tenant-1";
const ACTOR = { id: "membership-owner", tenantId: TENANT_ID, userId: "test-user-id", role: "OWNER" };

const MEMBERS = [
  {
    id: "membership-1",
    userId: "user-1",
    role: "OWNER",
    deactivatedAt: null,
    user: { id: "user-1", name: "Alice Owner", email: "alice@example.com", image: null },
  },
  {
    id: "membership-2",
    userId: "user-2",
    role: "ADMIN",
    deactivatedAt: null,
    user: { id: "user-2", name: "Bob Admin", email: "bob@example.com", image: null },
  },
  {
    id: "membership-3",
    userId: "user-3",
    role: "MEMBER",
    deactivatedAt: null,
    user: { id: "user-3", name: "Carol Member", email: "carol@example.com", image: null },
  },
];

describe("GET /api/tenant/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockPrismaTenantMember.findMany.mockResolvedValue(MEMBERS);
    mockPrismaAdminVaultReset.groupBy.mockResolvedValue([]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost/api/tenant/members"),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when MEMBER role lacks MEMBER_MANAGE permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const res = await GET(
      createRequest("GET", "http://localhost/api/tenant/members"),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("rethrows non-TenantAuthError errors", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("unexpected db error"));
    await expect(
      GET(createRequest("GET", "http://localhost/api/tenant/members")),
    ).rejects.toThrow("unexpected db error");
  });

  it("returns member list with zero pending reset counts when no pending resets", async () => {
    const res = await GET(
      createRequest("GET", "http://localhost/api/tenant/members"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(3);
    expect(json[0]).toMatchObject({
      id: "membership-1",
      userId: "user-1",
      name: "Alice Owner",
      email: "alice@example.com",
      role: "OWNER",
      pendingResets: 0,
    });
    expect(json[1]).toMatchObject({
      id: "membership-2",
      userId: "user-2",
      name: "Bob Admin",
      email: "bob@example.com",
      role: "ADMIN",
      pendingResets: 0,
    });
    expect(json[2]).toMatchObject({
      id: "membership-3",
      userId: "user-3",
      name: "Carol Member",
      email: "carol@example.com",
      role: "MEMBER",
      pendingResets: 0,
    });
    expect(mockWithTenantRls).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.any(Function),
    );
  });

  it("returns member list with correct pending reset counts", async () => {
    mockPrismaAdminVaultReset.groupBy.mockResolvedValue([
      { targetUserId: "user-2", _count: 2 },
      { targetUserId: "user-3", _count: 1 },
    ]);

    const res = await GET(
      createRequest("GET", "http://localhost/api/tenant/members"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].pendingResets).toBe(0); // owner: no pending resets
    expect(json[1].pendingResets).toBe(2); // admin: 2 pending resets
    expect(json[2].pendingResets).toBe(1); // member: 1 pending reset
  });

  it("calls requireTenantPermission with MEMBER_MANAGE permission", async () => {
    await GET(createRequest("GET", "http://localhost/api/tenant/members"));
    expect(mockRequireTenantPermission).toHaveBeenCalledWith(
      "test-user-id",
      "tenant:member:manage",
    );
  });

  it("returns empty list when no members", async () => {
    mockPrismaTenantMember.findMany.mockResolvedValue([]);
    const res = await GET(
      createRequest("GET", "http://localhost/api/tenant/members"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(0);
  });
});
