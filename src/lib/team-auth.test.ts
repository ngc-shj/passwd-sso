import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { prisma } from "@/lib/prisma";
import { TEAM_PERMISSION, TEAM_ROLE } from "@/lib/constants";
import {
  hasTeamPermission,
  isRoleAbove,
  getTeamMembership,
  requireTeamMember,
  requireTeamPermission,
  TeamAuthError,
} from "./team-auth";

const mockPrisma = prisma as unknown as MockPrisma;

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

describe("getTeamMembership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns membership when found (active member)", async () => {
    const membership = { id: "m-1", teamId: "team-1", userId: "u-1", role: TEAM_ROLE.MEMBER };
    mockPrisma.teamMember.findFirst.mockResolvedValue(membership);

    const result = await getTeamMembership("u-1", "team-1");
    expect(result).toEqual(membership);
    expect(mockPrisma.teamMember.findFirst).toHaveBeenCalledWith({
      where: { teamId: "team-1", userId: "u-1", deactivatedAt: null },
    });
  });

  it("returns null when not found", async () => {
    mockPrisma.teamMember.findFirst.mockResolvedValue(null);
    const result = await getTeamMembership("u-1", "team-1");
    expect(result).toBeNull();
  });
});

describe("requireTeamMember", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns membership when found", async () => {
    const membership = { id: "m-1", teamId: "team-1", userId: "u-1", role: TEAM_ROLE.OWNER };
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
});

describe("requireTeamPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

describe("SCIM_MANAGE permission", () => {
  it("OWNER has SCIM_MANAGE permission", () => {
    expect(hasTeamPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.SCIM_MANAGE)).toBe(true);
  });

  it("ADMIN has SCIM_MANAGE permission", () => {
    expect(hasTeamPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.SCIM_MANAGE)).toBe(true);
  });

  it("MEMBER does not have SCIM_MANAGE permission", () => {
    expect(hasTeamPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.SCIM_MANAGE)).toBe(false);
  });

  it("VIEWER does not have SCIM_MANAGE permission", () => {
    expect(hasTeamPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.SCIM_MANAGE)).toBe(false);
  });
});
