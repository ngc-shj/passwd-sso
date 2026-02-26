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
  hasOrgPermission,
  isRoleAbove,
  getOrgMembership,
  requireOrgMember,
  requireOrgPermission,
  OrgAuthError,
} from "./team-auth";

const mockPrisma = prisma as unknown as MockPrisma;

describe("hasOrgPermission", () => {
  it("OWNER has all permissions", () => {
    expect(hasOrgPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.ORG_DELETE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.ORG_UPDATE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.MEMBER_INVITE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.MEMBER_REMOVE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.MEMBER_CHANGE_ROLE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.PASSWORD_CREATE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.PASSWORD_READ)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.PASSWORD_UPDATE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.PASSWORD_DELETE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.TAG_MANAGE)).toBe(true);
  });

  it("ADMIN cannot delete org", () => {
    expect(hasOrgPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.ORG_DELETE)).toBe(false);
  });

  it("ADMIN has all permissions except org:delete", () => {
    expect(hasOrgPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.ORG_UPDATE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.MEMBER_INVITE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.MEMBER_REMOVE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.MEMBER_CHANGE_ROLE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.PASSWORD_CREATE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.PASSWORD_READ)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.PASSWORD_UPDATE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.PASSWORD_DELETE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.TAG_MANAGE)).toBe(true);
  });

  it("MEMBER has password:create, read, update and tag:manage", () => {
    expect(hasOrgPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.PASSWORD_CREATE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.PASSWORD_READ)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.PASSWORD_UPDATE)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.TAG_MANAGE)).toBe(true);
  });

  it("MEMBER cannot delete passwords or manage org/members", () => {
    expect(hasOrgPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.PASSWORD_DELETE)).toBe(false);
    expect(hasOrgPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.ORG_DELETE)).toBe(false);
    expect(hasOrgPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.ORG_UPDATE)).toBe(false);
    expect(hasOrgPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.MEMBER_INVITE)).toBe(false);
    expect(hasOrgPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.MEMBER_REMOVE)).toBe(false);
    expect(hasOrgPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.MEMBER_CHANGE_ROLE)).toBe(false);
  });

  it("VIEWER has only password:read", () => {
    expect(hasOrgPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.PASSWORD_READ)).toBe(true);
    expect(hasOrgPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.PASSWORD_CREATE)).toBe(false);
    expect(hasOrgPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.PASSWORD_UPDATE)).toBe(false);
    expect(hasOrgPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.PASSWORD_DELETE)).toBe(false);
    expect(hasOrgPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.TAG_MANAGE)).toBe(false);
    expect(hasOrgPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.ORG_DELETE)).toBe(false);
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

describe("getOrgMembership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns membership when found (active member)", async () => {
    const membership = { id: "m-1", orgId: "org-1", userId: "u-1", role: TEAM_ROLE.MEMBER };
    mockPrisma.orgMember.findFirst.mockResolvedValue(membership);

    const result = await getOrgMembership("u-1", "org-1");
    expect(result).toEqual(membership);
    expect(mockPrisma.orgMember.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org-1", userId: "u-1", deactivatedAt: null },
    });
  });

  it("returns null when not found", async () => {
    mockPrisma.orgMember.findFirst.mockResolvedValue(null);
    const result = await getOrgMembership("u-1", "org-1");
    expect(result).toBeNull();
  });
});

describe("requireOrgMember", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns membership when found", async () => {
    const membership = { id: "m-1", orgId: "org-1", userId: "u-1", role: TEAM_ROLE.OWNER };
    mockPrisma.orgMember.findFirst.mockResolvedValue(membership);

    const result = await requireOrgMember("u-1", "org-1");
    expect(result).toEqual(membership);
  });

  it("throws OrgAuthError(404) when not found", async () => {
    mockPrisma.orgMember.findFirst.mockResolvedValue(null);

    await expect(requireOrgMember("u-1", "org-1")).rejects.toThrow(OrgAuthError);
    try {
      await requireOrgMember("u-1", "org-1");
    } catch (err) {
      expect(err).toBeInstanceOf(OrgAuthError);
      expect((err as OrgAuthError).status).toBe(404);
    }
  });
});

describe("requireOrgPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns membership when permission is granted", async () => {
    const membership = { id: "m-1", orgId: "org-1", userId: "u-1", role: TEAM_ROLE.OWNER };
    mockPrisma.orgMember.findFirst.mockResolvedValue(membership);

    const result = await requireOrgPermission("u-1", "org-1", TEAM_PERMISSION.ORG_DELETE);
    expect(result).toEqual(membership);
  });

  it("throws OrgAuthError(403) when permission is denied", async () => {
    const membership = { id: "m-1", orgId: "org-1", userId: "u-1", role: TEAM_ROLE.VIEWER };
    mockPrisma.orgMember.findFirst.mockResolvedValue(membership);

    await expect(
      requireOrgPermission("u-1", "org-1", TEAM_PERMISSION.PASSWORD_CREATE)
    ).rejects.toThrow(OrgAuthError);

    try {
      await requireOrgPermission("u-1", "org-1", TEAM_PERMISSION.PASSWORD_CREATE);
    } catch (err) {
      expect((err as OrgAuthError).status).toBe(403);
    }
  });

  it("throws OrgAuthError(404) when not a member", async () => {
    mockPrisma.orgMember.findFirst.mockResolvedValue(null);

    try {
      await requireOrgPermission("u-1", "org-1", TEAM_PERMISSION.PASSWORD_READ);
    } catch (err) {
      expect((err as OrgAuthError).status).toBe(404);
    }
  });
});

describe("SCIM_MANAGE permission", () => {
  it("OWNER has SCIM_MANAGE permission", () => {
    expect(hasOrgPermission(TEAM_ROLE.OWNER, TEAM_PERMISSION.SCIM_MANAGE)).toBe(true);
  });

  it("ADMIN has SCIM_MANAGE permission", () => {
    expect(hasOrgPermission(TEAM_ROLE.ADMIN, TEAM_PERMISSION.SCIM_MANAGE)).toBe(true);
  });

  it("MEMBER does not have SCIM_MANAGE permission", () => {
    expect(hasOrgPermission(TEAM_ROLE.MEMBER, TEAM_PERMISSION.SCIM_MANAGE)).toBe(false);
  });

  it("VIEWER does not have SCIM_MANAGE permission", () => {
    expect(hasOrgPermission(TEAM_ROLE.VIEWER, TEAM_PERMISSION.SCIM_MANAGE)).toBe(false);
  });
});
