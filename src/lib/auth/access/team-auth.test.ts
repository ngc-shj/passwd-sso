import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { MockPrisma } from "@/__tests__/helpers/mock-prisma";

// vi.mock is hoisted — factory must not reference outer variables
vi.mock("@/lib/prisma", () => {
  const MODEL_METHODS = [
    "findUnique", "findFirst", "findMany", "create", "update",
    "delete", "deleteMany", "count", "upsert",
  ];
  const modelCache = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const handler: ProxyHandler<object> = {
    get(_target, prop: string) {
      if (prop === "$transaction") return vi.fn(async (fn: unknown) => typeof fn === "function" ? fn(proxy) : Promise.all(fn as Promise<unknown>[]));
      if (prop === "then" || prop === "catch" || prop === "finally") return undefined;
      if (!modelCache.has(prop)) {
        const methods: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const m of MODEL_METHODS) methods[m] = vi.fn();
        modelCache.set(prop, methods);
      }
      return modelCache.get(prop);
    },
  };
  const proxy = new Proxy({}, handler);
  return { prisma: proxy };
});
const { mockResolveUserTenantId } = vi.hoisted(() => ({
  mockResolveUserTenantId: vi.fn(),
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: vi.fn(async (_teamId: string, fn: (tenantId: string, tx: unknown) => unknown) => {
    const { prisma: tx } = await import("@/lib/prisma");
    return fn("tenant-1", tx);
  }),
  resolveUserTenantIdFromClient: mockResolveUserTenantId,
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  BYPASS_PURPOSE: { CROSS_TENANT_LOOKUP: "CROSS_TENANT_LOOKUP" },
}));

vi.mock("@/lib/team/team-policy", () => ({
  withTeamIpRestriction: vi.fn(async () => undefined),
  PolicyViolationError: class PolicyViolationError extends Error {},
}));

import { prisma } from "@/lib/prisma";
import { withTeamIpRestriction } from "@/lib/team/team-policy";
import { TEAM_PERMISSION, TEAM_ROLE } from "@/lib/constants";
import {
  canWriteTeamEntry,
  hasTeamPermission,
  isRoleAbove,
  getTeamMembership,
  requireTeamMember,
  requireTeamPermission,
  getAdminTeamMemberships,
  activeTeamAdmission,
  TeamAuthError,
} from "./team-auth";

const mockPrisma = prisma as unknown as MockPrisma;

describe("canWriteTeamEntry", () => {
  it("lets a MEMBER write only an entry they created", () => {
    expect(canWriteTeamEntry(TEAM_ROLE.MEMBER, "u1", "u1")).toBe(true);
    expect(canWriteTeamEntry(TEAM_ROLE.MEMBER, "u2", "u1")).toBe(false);
  });

  it("lets an OWNER or ADMIN write any entry", () => {
    expect(canWriteTeamEntry(TEAM_ROLE.OWNER, "u2", "u1")).toBe(true);
    expect(canWriteTeamEntry(TEAM_ROLE.ADMIN, "u2", "u1")).toBe(true);
  });

  it("refuses a VIEWER even on an entry they created", () => {
    expect(canWriteTeamEntry(TEAM_ROLE.VIEWER, "u1", "u1")).toBe(false);
  });
});

describe("hasTeamPermission", () => {
  it("OWNER has all permissions", () => {
    expect(hasTeamPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.TEAM_DELETE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.TEAM_UPDATE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.MEMBER_INVITE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.MEMBER_REMOVE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.MEMBER_CHANGE_ROLE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.PASSWORD_CREATE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.PASSWORD_READ)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.PASSWORD_UPDATE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.PASSWORD_DELETE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.TAG_MANAGE)).toBe(true);
  });

  it("ADMIN cannot delete team", () => {
    expect(hasTeamPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.TEAM_DELETE)).toBe(false);
  });

  it("ADMIN has all permissions except team:delete", () => {
    expect(hasTeamPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.TEAM_UPDATE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.MEMBER_INVITE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.MEMBER_REMOVE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.MEMBER_CHANGE_ROLE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.PASSWORD_CREATE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.PASSWORD_READ)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.PASSWORD_UPDATE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.PASSWORD_DELETE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.TAG_MANAGE)).toBe(true);
  });

  it("MEMBER has password:create, read, update and tag:manage", () => {
    expect(hasTeamPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.PASSWORD_CREATE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.PASSWORD_READ)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.PASSWORD_UPDATE)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.TAG_MANAGE)).toBe(true);
  });

  it("MEMBER cannot delete passwords or manage team/members", () => {
    expect(hasTeamPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.PASSWORD_DELETE)).toBe(false);
    expect(hasTeamPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.TEAM_DELETE)).toBe(false);
    expect(hasTeamPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.TEAM_UPDATE)).toBe(false);
    expect(hasTeamPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.MEMBER_INVITE)).toBe(false);
    expect(hasTeamPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.MEMBER_REMOVE)).toBe(false);
    expect(hasTeamPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.MEMBER_CHANGE_ROLE)).toBe(false);
  });

  it("VIEWER has only password:read", () => {
    expect(hasTeamPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.PASSWORD_READ)).toBe(true);
    expect(hasTeamPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.PASSWORD_CREATE)).toBe(false);
    expect(hasTeamPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.PASSWORD_UPDATE)).toBe(false);
    expect(hasTeamPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.PASSWORD_DELETE)).toBe(false);
    expect(hasTeamPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.TAG_MANAGE)).toBe(false);
    expect(hasTeamPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.TEAM_DELETE)).toBe(false);
  });
});

describe("isRoleAbove", () => {
  it("OWNER is above ADMIN", () => {
    expect(isRoleAbove(TEAM_ROLE.OWNER, TEAM_ROLE.ADMIN)).toBe(true);
  });

  it("ADMIN is above MEMBER", () => {
    expect(isRoleAbove(TEAM_ROLE.ADMIN, TEAM_ROLE.MEMBER)).toBe(true);
  });

  it("MEMBER is above VIEWER", () => {
    expect(isRoleAbove(TEAM_ROLE.MEMBER, TEAM_ROLE.VIEWER)).toBe(true);
  });

  it("same role is not above itself", () => {
    expect(isRoleAbove(TEAM_ROLE.ADMIN, TEAM_ROLE.ADMIN)).toBe(false);
    expect(isRoleAbove(TEAM_ROLE.OWNER, TEAM_ROLE.OWNER)).toBe(false);
  });

  it("lower role is not above higher role", () => {
    expect(isRoleAbove(TEAM_ROLE.MEMBER, TEAM_ROLE.ADMIN)).toBe(false);
    expect(isRoleAbove(TEAM_ROLE.VIEWER, TEAM_ROLE.OWNER)).toBe(false);
  });
});

const ADMITTED = new Date("2026-01-10T00:00:00Z");
const BEFORE = new Date("2026-01-01T00:00:00Z");
const AFTER = new Date("2026-02-01T00:00:00Z");

/** The tenant rows readTenantRows sees for the actor: the tenant row and/or a departure record. */
function seedTenantRows(opts: { row?: { deactivatedAt: Date | null }; departedAt?: Date } = {}) {
  mockPrisma.tenantMember.findMany.mockResolvedValue(
    opts.row ? [{ userId: "u-1", role: "MEMBER", deactivatedAt: opts.row.deactivatedAt }] : [],
  );
  mockPrisma.tenantMemberDeparture.findMany.mockResolvedValue(
    opts.departedAt ? [{ userId: "u-1", departedAt: opts.departedAt }] : [],
  );
}

describe("getTeamMembership", () => {
  const membership = {
    id: "m-1", teamId: "team-1", userId: "u-1", role: TEAM_ROLE.MEMBER,
    admittedAt: ADMITTED, createdAt: BEFORE,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    seedTenantRows({ row: { deactivatedAt: null } });
  });

  it("returns membership when found (active member)", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);

    const result = await getTeamMembership("u-1", "team-1");
    expect(result).toEqual(membership);
    expect(mockPrisma.teamMember.findFirst).toHaveBeenCalledWith({
      where: { teamId: "team-1", userId: "u-1", deactivatedAt: null },
    });
  });

  it("returns null when not found, without reading tenant rows", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(null);
    const result = await getTeamMembership("u-1", "team-1");
    expect(result).toBeNull();
    expect(mockPrisma.tenantMember.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.tenantMemberDeparture.findMany).not.toHaveBeenCalled();
  });

  it("reads the actor's tenant rows in the team's tenant", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);
    await getTeamMembership("u-1", "team-1");
    expect(mockPrisma.tenantMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-1", userId: { in: ["u-1"] } } }),
    );
    expect(mockPrisma.tenantMemberDeparture.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-1", userId: { in: ["u-1"] } } }),
    );
  });

  it("returns null for a leftover whose tenant row is deactivated after admission", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);
    seedTenantRows({ row: { deactivatedAt: AFTER } });
    expect(await getTeamMembership("u-1", "team-1")).toBeNull();
  });

  it("returns null for a leftover known only by its departure record (tenant row active)", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);
    seedTenantRows({ row: { deactivatedAt: null }, departedAt: AFTER });
    expect(await getTeamMembership("u-1", "team-1")).toBeNull();
  });

  it("returns null for a leftover known only by its departure record (tenant row absent)", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);
    seedTenantRows({ departedAt: AFTER });
    expect(await getTeamMembership("u-1", "team-1")).toBeNull();
  });

  it("returns null when the departure equals the admission instant", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);
    seedTenantRows({ departedAt: ADMITTED });
    expect(await getTeamMembership("u-1", "team-1")).toBeNull();
  });

  it("returns the membership of a guest (no tenant row, no departure record)", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);
    seedTenantRows();
    expect(await getTeamMembership("u-1", "team-1")).toEqual(membership);
  });

  it("returns the membership of a member re-admitted after the departure", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);
    // created_at < departure < admitted_at
    seedTenantRows({ row: { deactivatedAt: new Date("2026-01-05T00:00:00Z") } });
    expect(await getTeamMembership("u-1", "team-1")).toEqual(membership);
  });

  it("returns the membership of a re-provisioned user (active tenant row, older departure record)", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);
    seedTenantRows({ row: { deactivatedAt: null }, departedAt: new Date("2026-01-05T00:00:00Z") });
    expect(await getTeamMembership("u-1", "team-1")).toEqual(membership);
  });

  it("anchors a row without admittedAt to createdAt: refused when the departure follows it", async () => {
    // The #1043-C2 residual: re-admitted before admitted_at existed.
    mockPrisma.teamMember.findFirst.mockResolvedValue({ ...membership, admittedAt: null, createdAt: BEFORE });
    seedTenantRows({ row: { deactivatedAt: new Date("2026-01-05T00:00:00Z") } });
    expect(await getTeamMembership("u-1", "team-1")).toBeNull();
  });
});

describe("requireTeamMember", () => {
  const membership = {
    id: "m-1", teamId: "team-1", userId: "u-1", role: TEAM_ROLE.OWNER,
    admittedAt: ADMITTED, createdAt: BEFORE,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    seedTenantRows({ row: { deactivatedAt: null } });
  });

  it("returns membership when found", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);

    const result = await requireTeamMember("u-1", "team-1");
    expect(result).toEqual(membership);
  });

  it("throws TeamAuthError(404) when not found", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(null);

    await expect(requireTeamMember("u-1", "team-1")).rejects.toThrow(TeamAuthError);
    try {
      await requireTeamMember("u-1", "team-1");
    } catch (err) {
      expect(err).toBeInstanceOf(TeamAuthError);
      expect((err as TeamAuthError).status).toBe(404);
    }
  });

  it("throws TeamAuthError(404) for a leftover membership, before the IP restriction check", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);
    seedTenantRows({ row: { deactivatedAt: AFTER } });

    const err = await requireTeamMember("u-1", "team-1", {} as NextRequest).catch((e) => e);
    expect(err).toBeInstanceOf(TeamAuthError);
    expect((err as TeamAuthError).status).toBe(404);
    expect(withTeamIpRestriction).not.toHaveBeenCalled();
  });
});

describe("requireTeamPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedTenantRows({ row: { deactivatedAt: null } });
  });

  it("returns membership when permission is granted", async () => {
    const membership = { id: "m-1", teamId: "team-1", userId: "u-1", role: TEAM_ROLE.OWNER };
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);

    const result = await requireTeamPermission("u-1", "team-1", TEAM_PERMISSION.TEAM_DELETE);
    expect(result).toEqual(membership);
  });

  it("throws TeamAuthError(403) when permission is denied", async () => {
    const membership = { id: "m-1", teamId: "team-1", userId: "u-1", role: TEAM_ROLE.VIEWER };
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);

    await expect(
      requireTeamPermission("u-1", "team-1", TEAM_PERMISSION.PASSWORD_CREATE)
    ).rejects.toThrow(TeamAuthError);

    try {
      await requireTeamPermission("u-1", "team-1", TEAM_PERMISSION.PASSWORD_CREATE);
    } catch (err) {
      expect((err as TeamAuthError).status).toBe(403);
    }
  });

  it("throws TeamAuthError(404) when not a member", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(null);

    try {
      await requireTeamPermission("u-1", "team-1", TEAM_PERMISSION.PASSWORD_READ);
    } catch (err) {
      expect((err as TeamAuthError).status).toBe(404);
    }
  });
});

describe("getAdminTeamMemberships", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.tenantMember.findMany.mockResolvedValue([]);
    mockPrisma.tenantMemberDeparture.findMany.mockResolvedValue([]);
  });

  const created = new Date("2026-01-01T00:00:00.000Z");
  const departed = new Date("2026-02-01T00:00:00.000Z");
  const adminRow = (id: string, tenantId: string, extra: Record<string, unknown> = {}) => ({
    id: `m-${id}`,
    userId: "u-1",
    tenantId,
    role: TEAM_ROLE.ADMIN,
    admittedAt: null,
    createdAt: created,
    team: { id: `team-${id}`, name: id, slug: id, tenant: { id: tenantId, name: tenantId } },
    ...extra,
  });

  it("flags isCrossTenant=false for teams in the user's home tenant", async () => {
    mockResolveUserTenantId.mockResolvedValue("home-tenant");
    mockPrisma.teamMember.findMany.mockResolvedValue([
      {
        id: "m-1",
        userId: "u-1",
        tenantId: "home-tenant",
        admittedAt: null,
        createdAt: created,
        role: TEAM_ROLE.OWNER,
        team: {
          id: "team-1",
          name: "Acme Team",
          slug: "acme",
          tenant: { id: "home-tenant", name: "Acme Corp" },
        },
      },
    ]);

    const result = await getAdminTeamMemberships("u-1");

    expect(result).toHaveLength(1);
    expect(result[0].team).toEqual({
      id: "team-1",
      name: "Acme Team",
      slug: "acme",
      tenantName: "Acme Corp",
      isCrossTenant: false,
    });
  });

  it("flags isCrossTenant=true and surfaces the team's home-tenant name for guest teams", async () => {
    mockResolveUserTenantId.mockResolvedValue("home-tenant");
    mockPrisma.teamMember.findMany.mockResolvedValue([
      {
        id: "m-2",
        userId: "u-1",
        tenantId: "other-tenant",
        admittedAt: null,
        createdAt: created,
        role: TEAM_ROLE.ADMIN,
        team: {
          id: "team-2",
          name: "Guest Team",
          slug: "guest",
          tenant: { id: "other-tenant", name: "Other Corp" },
        },
      },
    ]);

    const result = await getAdminTeamMemberships("u-1");

    expect(result[0].team).toEqual({
      id: "team-2",
      name: "Guest Team",
      slug: "guest",
      tenantName: "Other Corp",
      isCrossTenant: true,
    });
  });

  it("filters by ADMIN/OWNER and active deactivatedAt", async () => {
    mockResolveUserTenantId.mockResolvedValue("home-tenant");
    mockPrisma.teamMember.findMany.mockResolvedValue([]);

    await getAdminTeamMemberships("u-1");

    expect(mockPrisma.teamMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "u-1",
          role: { in: [TEAM_ROLE.ADMIN, TEAM_ROLE.OWNER] },
          deactivatedAt: null,
        },
      }),
    );
  });

  it("omits a leftover admin membership: the user left the team's tenant after admission", async () => {
    mockResolveUserTenantId.mockResolvedValue("home-tenant");
    mockPrisma.teamMember.findMany.mockResolvedValue([adminRow("left", "t-1")]);
    mockPrisma.tenantMemberDeparture.findMany.mockResolvedValue([{ userId: "u-1", departedAt: departed }]);

    expect(await getAdminTeamMemberships("u-1")).toEqual([]);
    expect(mockPrisma.tenantMemberDeparture.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t-1", userId: { in: ["u-1"] } } }),
    );
  });

  it("matches each (tenant, user) pair: departed from t-1 but a guest of t-2 keeps the t-2 team", async () => {
    mockResolveUserTenantId.mockResolvedValue("home-tenant");
    mockPrisma.teamMember.findMany.mockResolvedValue([adminRow("one", "t-1"), adminRow("two", "t-2")]);
    mockPrisma.tenantMemberDeparture.findMany.mockImplementation((async ({ where }: { where: { tenantId: string } }) =>
      where.tenantId === "t-1" ? [{ userId: "u-1", departedAt: departed }] : []) as never);

    const result = await getAdminTeamMemberships("u-1");

    expect(result.map((m) => m.team.id)).toEqual(["team-two"]);
  });

  it("lists a re-admitted admin: the departure predates admittedAt", async () => {
    mockResolveUserTenantId.mockResolvedValue("home-tenant");
    mockPrisma.teamMember.findMany.mockResolvedValue([
      adminRow("back", "t-1", { admittedAt: new Date("2026-03-01T00:00:00.000Z") }),
    ]);
    mockPrisma.tenantMemberDeparture.findMany.mockResolvedValue([{ userId: "u-1", departedAt: departed }]);

    expect((await getAdminTeamMemberships("u-1")).map((m) => m.team.id)).toEqual(["team-back"]);
  });
});

describe("activeTeamAdmission", () => {
  const created = new Date("2026-01-01T00:00:00.000Z");
  const admitted = new Date("2026-03-01T00:00:00.000Z");

  beforeEach(() => vi.clearAllMocks());

  it("returns admittedAt when the column is set", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue({ role: TEAM_ROLE.ADMIN, admittedAt: admitted, createdAt: created });
    await expect(activeTeamAdmission(prisma, "t", "u")).resolves.toEqual({ role: TEAM_ROLE.ADMIN, admittedAt: admitted });
    expect(mockPrisma.teamMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: "t", userId: "u", deactivatedAt: null } }),
    );
  });

  it("falls back to createdAt for a row admitted before the column existed", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue({ role: TEAM_ROLE.OWNER, admittedAt: null, createdAt: created });
    await expect(activeTeamAdmission(prisma, "t", "u")).resolves.toEqual({ role: TEAM_ROLE.OWNER, admittedAt: created });
  });

  it("returns null without an active membership", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(null);
    await expect(activeTeamAdmission(prisma, "t", "u")).resolves.toBeNull();
  });
});
