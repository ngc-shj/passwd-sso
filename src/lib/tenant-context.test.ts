import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────

const {
  mockFindMany,
  mockFindUnique,
  mockUserFindUnique,
  mockUserFindMany,
  mockUserUpdate,
  mockWithBypassRls,
  mockWithTenantRls,
} =
  vi.hoisted(() => ({
    mockFindMany: vi.fn(),
    mockFindUnique: vi.fn(),
    mockUserFindUnique: vi.fn(),
    mockUserFindMany: vi.fn(),
    mockUserUpdate: vi.fn(),
    mockWithBypassRls: vi.fn(),
    mockWithTenantRls: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: { findMany: mockFindMany },
    team: { findUnique: mockFindUnique },
    user: { findUnique: mockUserFindUnique, findMany: mockUserFindMany, update: mockUserUpdate },
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
  realignOwningTenantColumn,
  usersActiveInAnotherTenant,
  resolveExistingUsersForTenant,
  usersOwnedByAnotherTenant,
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

// ─── realignOwningTenantColumn ─────────────────────────────

describe("realignOwningTenantColumn", () => {
  // The one writer that moves the column WITHOUT moving the rows it scopes. Its
  // caller keys both its audit emit and its row counts on the value returned
  // here, so "wrote nothing" and "wrote, and it used to be X" have to be
  // distinguishable from the return alone.

  it("writes the new tenant and reports the one it replaced", async () => {
    mockUserFindUnique.mockResolvedValue({ tenantId: "released-by" });

    const previous = await realignOwningTenantColumn(prisma, "user-1", "joined");

    expect(previous).toBe("released-by");
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { tenantId: "joined" },
    });
  });

  it("writes nothing and reports null when the column already agrees", async () => {
    mockUserFindUnique.mockResolvedValue({ tenantId: "joined" });

    expect(await realignOwningTenantColumn(prisma, "user-1", "joined")).toBeNull();
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("writes nothing when there is no user row to realign", async () => {
    mockUserFindUnique.mockResolvedValue(null);

    expect(await realignOwningTenantColumn(prisma, "user-1", "joined")).toBeNull();
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("reads the column itself, not the resolved owner", async () => {
    // The distinction this function exists for. `resolveOwningTenantIdFromClient`
    // would answer "active-membership-tenant" here — the membership the caller
    // has just created — and comparing THAT against the target would report no
    // divergence and never write.
    mockUserFindUnique.mockResolvedValue({
      tenantId: "released-by",
      tenantMemberships: [{ tenantId: "joined" }],
    });

    expect(await realignOwningTenantColumn(prisma, "user-1", "joined")).toBe("released-by");
    expect(mockUserFindUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { tenantId: true },
    });
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

// ─── usersOwnedByAnotherTenant ─────────────────────────────

describe("usersOwnedByAnotherTenant", () => {
  const row = (id: string, column: string, active: string[] = []) => ({
    id,
    tenantId: column,
    tenantMemberships: active.map((tenantId) => ({ tenantId })),
  });

  it("asks nothing for no users", async () => {
    expect(await usersOwnedByAnotherTenant("this-tenant", [])).toEqual(new Set());
    expect(mockWithBypassRls).not.toHaveBeenCalled();
  });

  it("reads each user's column and active memberships, oldest first, under a cross-tenant bypass", async () => {
    mockUserFindMany.mockResolvedValue([]);

    await usersOwnedByAnotherTenant("this-tenant", ["u-1"]);

    expect(mockUserFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["u-1"] } },
      select: {
        id: true,
        tenantId: true,
        tenantMemberships: {
          where: { deactivatedAt: null },
          select: { tenantId: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    expect(mockWithBypassRls).toHaveBeenCalledWith(expect.anything(), expect.any(Function), "cross_tenant_lookup");
  });

  it("names a user filed under another tenant and active nowhere, and not one filed here", async () => {
    // The departed member R6-S2 is about: a membership row here, the column elsewhere.
    mockUserFindMany.mockResolvedValue([row("departed", "other-tenant"), row("own", "this-tenant")]);

    expect(await usersOwnedByAnotherTenant("this-tenant", ["departed", "own"])).toEqual(new Set(["departed"]));
  });

  it("decides by the active membership before the column, in both directions", async () => {
    mockUserFindMany.mockResolvedValue([
      row("active-here", "other-tenant", ["this-tenant"]),
      row("active-there", "this-tenant", ["other-tenant"]),
    ]);

    expect(await usersOwnedByAnotherTenant("this-tenant", ["active-here", "active-there"])).toEqual(
      new Set(["active-there"]),
    );
  });

  it("leaves out a user with no users row, rather than calling them another tenant's", async () => {
    // R7-T5: the documented contract. Reporting a missing row as foreign would
    // refuse a reactivation for a user who does not exist, and no cell said so.
    mockUserFindMany.mockResolvedValue([row("own", "this-tenant")]);

    expect(await usersOwnedByAnotherTenant("this-tenant", ["own", "ghost"])).toEqual(new Set());
  });
});

// ─── resolveExistingUsersForTenant ─────────────────────────
//
// The authority check SCIM POST and directory sync apply before attaching an
// existing user. Ownership, by the same rule as resolveOwningTenantIdFromClient:
// the oldest ACTIVE membership, else the column.

describe("resolveExistingUsersForTenant", () => {
  const user = (over: Record<string, unknown>) => ({
    id: "u-1",
    email: "erin@example.com",
    tenantId: "this-tenant",
    tenantMemberships: [],
    ...over,
  });

  it("opens no bypass for an empty list", async () => {
    expect(await resolveExistingUsersForTenant("this-tenant", [])).toEqual(new Map());
    expect(mockWithBypassRls).not.toHaveBeenCalled();
  });

  it("reads under a bypass, case-insensitively, with this tenant's memberships of any state", async () => {
    mockUserFindMany.mockResolvedValue([]);

    await resolveExistingUsersForTenant("this-tenant", ["erin@example.com"]);

    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { in: ["erin@example.com"], mode: "insensitive" } },
        select: expect.objectContaining({
          tenantMemberships: expect.objectContaining({
            where: { OR: [{ deactivatedAt: null }, { tenantId: "this-tenant" }] },
            orderBy: { createdAt: "asc" },
          }),
        }),
      }),
    );
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      "cross_tenant_lookup",
    );
  });

  it("treats a user whose owning column names this tenant, active nowhere, as owned", async () => {
    mockUserFindMany.mockResolvedValue([user({ email: "Erin@Example.com" })]);

    expect(await resolveExistingUsersForTenant("this-tenant", ["erin@example.com"])).toEqual(
      new Map([["erin@example.com", { kind: "owned", userId: "u-1" }]]),
    );
  });

  it("treats a user active in this tenant as owned even when the column is stale", async () => {
    mockUserFindMany.mockResolvedValue([
      user({ tenantId: "other-tenant", tenantMemberships: [{ tenantId: "this-tenant", deactivatedAt: null }] }),
    ]);

    expect((await resolveExistingUsersForTenant("this-tenant", ["erin@example.com"])).get("erin@example.com"))
      .toEqual({ kind: "owned", userId: "u-1" });
  });

  it("treats a user another tenant released as foreign, although they are active nowhere", async () => {
    // The round-5 S1 case: "active nowhere else" is uniqueness, not authority.
    mockUserFindMany.mockResolvedValue([user({ tenantId: "other-tenant" })]);

    expect((await resolveExistingUsersForTenant("this-tenant", ["erin@example.com"])).get("erin@example.com"))
      .toEqual({ kind: "foreign", userId: "u-1", memberHere: false });
  });

  it("treats a user active in another tenant as foreign even when the column names this one", async () => {
    mockUserFindMany.mockResolvedValue([
      user({ tenantMemberships: [{ tenantId: "other-tenant", deactivatedAt: null }] }),
    ]);

    expect((await resolveExistingUsersForTenant("this-tenant", ["erin@example.com"])).get("erin@example.com"))
      .toEqual({ kind: "foreign", userId: "u-1", memberHere: false });
  });

  it("marks a foreign user who already holds a membership row here", async () => {
    mockUserFindMany.mockResolvedValue([
      user({
        tenantId: "other-tenant",
        tenantMemberships: [{ tenantId: "this-tenant", deactivatedAt: new Date("2025-01-01") }],
      }),
    ]);

    expect((await resolveExistingUsersForTenant("this-tenant", ["erin@example.com"])).get("erin@example.com"))
      .toEqual({ kind: "foreign", userId: "u-1", memberHere: true });
  });

  it("refuses to choose between users whose emails differ only in case", async () => {
    mockUserFindMany.mockResolvedValue([
      user({ id: "u-1", email: "Erin@example.com" }),
      user({ id: "u-2", email: "erin@EXAMPLE.com" }),
    ]);

    expect((await resolveExistingUsersForTenant("this-tenant", ["erin@example.com"])).get("erin@example.com"))
      .toEqual({ kind: "ambiguous", ownedHere: true });
  });

  it("does not call an ambiguity this tenant's own when another tenant's user is among the matches", async () => {
    // Round-7 R7-S2: a producer answering "ambiguous" for such an email told this
    // tenant that another tenant holds a case variant of it.
    mockUserFindMany.mockResolvedValue([
      user({ id: "u-1", email: "Erin@example.com" }),
      user({ id: "u-2", email: "erin@EXAMPLE.com", tenantId: "other-tenant" }),
    ]);

    expect((await resolveExistingUsersForTenant("this-tenant", ["erin@example.com"])).get("erin@example.com"))
      .toEqual({ kind: "ambiguous", ownedHere: false });
  });
});
