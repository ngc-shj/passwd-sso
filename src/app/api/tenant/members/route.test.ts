import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTenantMember, mockPrismaAdminVaultReset, mockRequireTenantPermission, mockWithTenantRls, mockFetchUserDisplayMap, TenantAuthError } = vi.hoisted(() => {
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
    mockFetchUserDisplayMap: vi.fn(),
    mockWithTenantRls: vi.fn((p: unknown, _t: unknown, fn: (tx: unknown) => unknown) => fn(p)),
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
vi.mock("@/lib/audit/audit-user-lookup", () => ({
  fetchUserDisplayMap: mockFetchUserDisplayMap,
}));
vi.mock("@/lib/auth/access/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
  withBypassRls: vi.fn((p: unknown, fn: (tx: unknown) => unknown) => fn(p)),
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
    mockFetchUserDisplayMap.mockResolvedValue(
      new Map([
        ["user-1", { id: "user-1", name: "Alice Owner", email: "alice@example.com", image: null }],
        ["user-2", { id: "user-2", name: "Bob Admin", email: "bob@example.com", image: null }],
        ["user-3", { id: "user-3", name: "Carol Member", email: "carol@example.com", image: null }],
      ]),
    );
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

  it("still lists a member whose users row lives in another tenant", async () => {
    // The defect this shape exists for. Identity used to come from a REQUIRED
    // `user` relation inside withTenantRls, so `users_tenant_isolation` filtering
    // one member's row took the WHOLE list down — and a realignment makes that an
    // ordinary state for the tenant that released the user.
    mockFetchUserDisplayMap.mockResolvedValue(
      new Map([
        ["user-1", { id: "user-1", name: "Alice Owner", email: "alice@example.com", image: null }],
        ["user-3", { id: "user-3", name: "Carol Member", email: "carol@example.com", image: null }],
      ]),
    );

    const res = await GET(createRequest("GET", "http://localhost/api/tenant/members"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(3);
    // Explicit nulls for the unresolvable one — distinguishable from a user who
    // simply has no name, and NOT an omission from the list.
    const orphan = body.find((m: { userId: string }) => m.userId === "user-2");
    expect(orphan).toMatchObject({ userId: "user-2", name: null, email: null, image: null });
    // The allow half: the members that DID resolve still carry their identity, so
    // a route that returned nulls for everyone cannot satisfy this cell.
    expect(body.find((m: { userId: string }) => m.userId === "user-1")).toMatchObject({
      name: "Alice Owner",
      email: "alice@example.com",
    });
  });

  it("hydrates identity outside the tenant context, for every listed member", async () => {
    await GET(createRequest("GET", "http://localhost/api/tenant/members"));

    expect(mockFetchUserDisplayMap).toHaveBeenCalledWith(
      ["user-1", "user-2", "user-3"],
      expect.any(String),
    );
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
