import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────

const { mockFindMany, mockFindUnique, mockUserFindUnique, mockWithBypassRls, mockWithTenantRls } =
  vi.hoisted(() => ({
    mockFindMany: vi.fn(),
    mockFindUnique: vi.fn(),
    mockUserFindUnique: vi.fn(),
    mockWithBypassRls: vi.fn(),
    mockWithTenantRls: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: { findMany: mockFindMany },
    team: { findUnique: mockFindUnique },
    user: { findUnique: mockUserFindUnique },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
  withTenantRls: mockWithTenantRls,
}));

// ─── SUT ────────────────────────────────────────────────────

import {
  resolveUserTenantIdFromClient,
  resolveOwningTenantIdFromClient,
  wouldCreateSecondActiveMembership,
  usersActiveInAnotherTenant,
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
    (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma),
  );
  // Default: withTenantRls executes the callback directly
  mockWithTenantRls.mockImplementation(
    (prisma: unknown, _tenantId: unknown, fn: (tx: unknown) => unknown) => fn(prisma),
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


// ─── resolveOwningTenantIdFromClient ───────────────────────
//
// The total sibling. Thirteen call sites depend on it and its arms were pinned
// nowhere — its query shape was asserted only from a caller's test, so a mutant
// flipping `orderBy` or dropping `deactivatedAt` survived the whole suite.

describe("resolveOwningTenantIdFromClient", () => {
  it("prefers the active membership over the User.tenantId column", async () => {
    mockUserFindUnique.mockResolvedValue({
      tenantId: "stale-column-tenant",
      tenantMemberships: [{ tenantId: "active-membership-tenant" }],
    });

    expect(await resolveOwningTenantIdFromClient(prisma, "user-1")).toBe(
      "active-membership-tenant",
    );
  });

  it("falls back to the column when every membership is deactivated", async () => {
    // The fallback's actual population — NOT the sentinel actors, who have no
    // user row at all and return null below.
    mockUserFindUnique.mockResolvedValue({
      tenantId: "last-owning-tenant",
      tenantMemberships: [],
    });

    expect(await resolveOwningTenantIdFromClient(prisma, "user-1")).toBe("last-owning-tenant");
  });

  it("returns null only when the user row is absent", async () => {
    mockUserFindUnique.mockResolvedValue(null);

    expect(await resolveOwningTenantIdFromClient(prisma, "user-1")).toBeNull();
  });

  it("does not throw on a second active membership, unlike its strict sibling", async () => {
    // The entire reason this function exists beside `resolveUserTenantIdFromClient`:
    // it is on paths that must not throw — an audit emit, an escrow release.
    mockUserFindUnique.mockResolvedValue({
      tenantId: "column",
      tenantMemberships: [{ tenantId: "oldest" }],
    });

    await expect(resolveOwningTenantIdFromClient(prisma, "user-1")).resolves.toBe("oldest");
  });

  it("asks for the active memberships oldest-first, one row", async () => {
    // The shape three call sites' behaviour rests on. Asserted here rather than
    // from a caller's test, where it broke on any helper-internal change while
    // proving nothing about the caller.
    mockUserFindUnique.mockResolvedValue({ tenantId: "t", tenantMemberships: [] });

    await resolveOwningTenantIdFromClient(prisma, "user-1");

    expect(mockUserFindUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: {
        tenantId: true,
        tenantMemberships: {
          where: { deactivatedAt: null },
          select: { tenantId: true },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
    });
  });
});

// ─── wouldCreateSecondActiveMembership ─────────────────────

describe("wouldCreateSecondActiveMembership", () => {
  it("is true when the only active membership is another tenant's", async () => {
    mockFindMany.mockResolvedValue([{ tenantId: "other-tenant" }]);

    expect(await wouldCreateSecondActiveMembership("user-1", "this-tenant")).toBe(true);
  });

  it("is false when this tenant's membership is already active", async () => {
    // Nothing is being activated, so nothing can become a second.
    mockFindMany.mockResolvedValue([{ tenantId: "this-tenant" }]);

    expect(await wouldCreateSecondActiveMembership("user-1", "this-tenant")).toBe(false);
  });

  it("is false when the user has no active membership anywhere", async () => {
    // The ordinary reactivation, which must keep working.
    mockFindMany.mockResolvedValue([]);

    expect(await wouldCreateSecondActiveMembership("user-1", "this-tenant")).toBe(false);
  });
});


// ─── usersActiveInAnotherTenant ────────────────────────────
//
// The batch sibling, for directory sync. Its `where` clause survived three
// separate mutations with the suite green — including dropping
// `tenantId: { not: tenantId }`, which makes every member of the SYNCING tenant
// read as "active elsewhere" and stops the sync reactivating anyone.

describe("usersActiveInAnotherTenant", () => {
  it("excludes this tenant's own memberships from the query", async () => {
    mockFindMany.mockResolvedValue([]);

    await usersActiveInAnotherTenant("this-tenant", ["u1"], ["a@example.com"]);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deactivatedAt: null,
          tenantId: { not: "this-tenant" },
        }),
      }),
    );
  });

  it("matches emails case-insensitively, and only supplies the arms it was given", async () => {
    mockFindMany.mockResolvedValue([]);

    await usersActiveInAnotherTenant("this-tenant", [], ["a@example.com"]);

    const { where } = mockFindMany.mock.calls[0][0];
    expect(where.OR).toEqual([
      { user: { email: { in: ["a@example.com"], mode: "insensitive" } } },
    ]);
  });

  it("returns both keys, with emails lower-cased and nulls dropped", async () => {
    mockFindMany.mockResolvedValue([
      { userId: "u1", user: { email: "A@Example.com" } },
      { userId: "u2", user: { email: null } },
    ]);

    const out = await usersActiveInAnotherTenant("this-tenant", ["u1", "u2"], []);

    expect(out.ids).toEqual(new Set(["u1", "u2"]));
    expect(out.emails).toEqual(new Set(["a@example.com"]));
  });

  it("opens no bypass when there is nothing to ask about", async () => {
    // The early return. Without this cell, deleting it is invisible: the query
    // would simply run with two empty OR arms and return nothing.
    const out = await usersActiveInAnotherTenant("this-tenant", [], []);

    expect(out.ids.size).toBe(0);
    expect(mockWithBypassRls).not.toHaveBeenCalled();
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
      expect.any(String),
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
      expect.any(String),
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

  // L2 — session-auth fail-open backstop. If SCIM deactivation's
  // invalidateUserSessions throws, a session may survive un-deleted. This pins
  // the helper-level backstop for session-auth routes that resolve tenant
  // context from the CURRENT USER via withUserTenantRls() / resolveUserTenantId():
  // active membership is resolved with the deactivatedAt:null filter
  // (resolveUserTenantIdFromClient), so a deactivated member has no active tenant
  // and protected handler execution is blocked with TENANT_NOT_RESOLVED.
  // (This is one backstop among several — token/admin/SCIM/maintenance routes
  // resolve tenant differently, e.g. withTenantRls(actor.tenantId) or validator-
  // level membership checks; those are covered by their own tests.) This is the
  // session-side complement to the token-validator backstops in
  // user-session-invalidation.test.ts.
  it("throws TENANT_NOT_RESOLVED for a deactivated member with a surviving session (SCIM fail-open backstop)", async () => {
    // Deactivated member: the deactivatedAt:null filter excludes their only
    // membership, so findMany returns [] (no active tenant).
    mockFindMany.mockResolvedValue([]);

    await expect(
      withUserTenantRls("deactivated-user", async () => "should-not-run"),
    ).rejects.toThrow("TENANT_NOT_RESOLVED");
    expect(mockWithTenantRls).not.toHaveBeenCalled();
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
