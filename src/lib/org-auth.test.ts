import { describe, it, expect, vi, beforeEach } from "vitest";

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
import { ORG_PERMISSION, ORG_ROLE } from "@/lib/constants";
import {
  hasOrgPermission,
  isRoleAbove,
  getOrgMembership,
  requireOrgMember,
  requireOrgPermission,
  OrgAuthError,
} from "./org-auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;

describe("hasOrgPermission", () => {
  it("OWNER has all permissions", () => {
    expect(hasOrgPermission(ORG_ROLE.OWNER, ORG_PERMISSION.ORG_DELETE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.OWNER, ORG_PERMISSION.ORG_UPDATE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.OWNER, ORG_PERMISSION.MEMBER_INVITE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.OWNER, ORG_PERMISSION.MEMBER_REMOVE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.OWNER, ORG_PERMISSION.MEMBER_CHANGE_ROLE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.OWNER, ORG_PERMISSION.PASSWORD_CREATE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.OWNER, ORG_PERMISSION.PASSWORD_READ)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.OWNER, ORG_PERMISSION.PASSWORD_UPDATE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.OWNER, ORG_PERMISSION.PASSWORD_DELETE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.OWNER, ORG_PERMISSION.TAG_MANAGE)).toBe(true);
  });

  it("ADMIN cannot delete org", () => {
    expect(hasOrgPermission(ORG_ROLE.ADMIN, ORG_PERMISSION.ORG_DELETE)).toBe(false);
  });

  it("ADMIN has all permissions except org:delete", () => {
    expect(hasOrgPermission(ORG_ROLE.ADMIN, ORG_PERMISSION.ORG_UPDATE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.ADMIN, ORG_PERMISSION.MEMBER_INVITE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.ADMIN, ORG_PERMISSION.MEMBER_REMOVE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.ADMIN, ORG_PERMISSION.MEMBER_CHANGE_ROLE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.ADMIN, ORG_PERMISSION.PASSWORD_CREATE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.ADMIN, ORG_PERMISSION.PASSWORD_READ)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.ADMIN, ORG_PERMISSION.PASSWORD_UPDATE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.ADMIN, ORG_PERMISSION.PASSWORD_DELETE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.ADMIN, ORG_PERMISSION.TAG_MANAGE)).toBe(true);
  });

  it("MEMBER has password:create, read, update and tag:manage", () => {
    expect(hasOrgPermission(ORG_ROLE.MEMBER, ORG_PERMISSION.PASSWORD_CREATE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.MEMBER, ORG_PERMISSION.PASSWORD_READ)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.MEMBER, ORG_PERMISSION.PASSWORD_UPDATE)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.MEMBER, ORG_PERMISSION.TAG_MANAGE)).toBe(true);
  });

  it("MEMBER cannot delete passwords or manage org/members", () => {
    expect(hasOrgPermission(ORG_ROLE.MEMBER, ORG_PERMISSION.PASSWORD_DELETE)).toBe(false);
    expect(hasOrgPermission(ORG_ROLE.MEMBER, ORG_PERMISSION.ORG_DELETE)).toBe(false);
    expect(hasOrgPermission(ORG_ROLE.MEMBER, ORG_PERMISSION.ORG_UPDATE)).toBe(false);
    expect(hasOrgPermission(ORG_ROLE.MEMBER, ORG_PERMISSION.MEMBER_INVITE)).toBe(false);
    expect(hasOrgPermission(ORG_ROLE.MEMBER, ORG_PERMISSION.MEMBER_REMOVE)).toBe(false);
    expect(hasOrgPermission(ORG_ROLE.MEMBER, ORG_PERMISSION.MEMBER_CHANGE_ROLE)).toBe(false);
  });

  it("VIEWER has only password:read", () => {
    expect(hasOrgPermission(ORG_ROLE.VIEWER, ORG_PERMISSION.PASSWORD_READ)).toBe(true);
    expect(hasOrgPermission(ORG_ROLE.VIEWER, ORG_PERMISSION.PASSWORD_CREATE)).toBe(false);
    expect(hasOrgPermission(ORG_ROLE.VIEWER, ORG_PERMISSION.PASSWORD_UPDATE)).toBe(false);
    expect(hasOrgPermission(ORG_ROLE.VIEWER, ORG_PERMISSION.PASSWORD_DELETE)).toBe(false);
    expect(hasOrgPermission(ORG_ROLE.VIEWER, ORG_PERMISSION.TAG_MANAGE)).toBe(false);
    expect(hasOrgPermission(ORG_ROLE.VIEWER, ORG_PERMISSION.ORG_DELETE)).toBe(false);
  });
});

describe("isRoleAbove", () => {
  it("OWNER is above ADMIN", () => {
    expect(isRoleAbove(ORG_ROLE.OWNER, ORG_ROLE.ADMIN)).toBe(true);
  });

  it("ADMIN is above MEMBER", () => {
    expect(isRoleAbove(ORG_ROLE.ADMIN, ORG_ROLE.MEMBER)).toBe(true);
  });

  it("MEMBER is above VIEWER", () => {
    expect(isRoleAbove(ORG_ROLE.MEMBER, ORG_ROLE.VIEWER)).toBe(true);
  });

  it("same role is not above itself", () => {
    expect(isRoleAbove(ORG_ROLE.ADMIN, ORG_ROLE.ADMIN)).toBe(false);
    expect(isRoleAbove(ORG_ROLE.OWNER, ORG_ROLE.OWNER)).toBe(false);
  });

  it("lower role is not above higher role", () => {
    expect(isRoleAbove(ORG_ROLE.MEMBER, ORG_ROLE.ADMIN)).toBe(false);
    expect(isRoleAbove(ORG_ROLE.VIEWER, ORG_ROLE.OWNER)).toBe(false);
  });
});

describe("getOrgMembership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns membership when found", async () => {
    const membership = { id: "m-1", orgId: "org-1", userId: "u-1", role: ORG_ROLE.MEMBER };
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership);

    const result = await getOrgMembership("u-1", "org-1");
    expect(result).toEqual(membership);
    expect(mockPrisma.orgMember.findUnique).toHaveBeenCalledWith({
      where: { orgId_userId: { orgId: "org-1", userId: "u-1" } },
    });
  });

  it("returns null when not found", async () => {
    mockPrisma.orgMember.findUnique.mockResolvedValue(null);
    const result = await getOrgMembership("u-1", "org-1");
    expect(result).toBeNull();
  });
});

describe("requireOrgMember", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns membership when found", async () => {
    const membership = { id: "m-1", orgId: "org-1", userId: "u-1", role: ORG_ROLE.OWNER };
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership);

    const result = await requireOrgMember("u-1", "org-1");
    expect(result).toEqual(membership);
  });

  it("throws OrgAuthError(404) when not found", async () => {
    mockPrisma.orgMember.findUnique.mockResolvedValue(null);

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
    const membership = { id: "m-1", orgId: "org-1", userId: "u-1", role: ORG_ROLE.OWNER };
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership);

    const result = await requireOrgPermission("u-1", "org-1", ORG_PERMISSION.ORG_DELETE);
    expect(result).toEqual(membership);
  });

  it("throws OrgAuthError(403) when permission is denied", async () => {
    const membership = { id: "m-1", orgId: "org-1", userId: "u-1", role: ORG_ROLE.VIEWER };
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership);

    await expect(
      requireOrgPermission("u-1", "org-1", ORG_PERMISSION.PASSWORD_CREATE)
    ).rejects.toThrow(OrgAuthError);

    try {
      await requireOrgPermission("u-1", "org-1", ORG_PERMISSION.PASSWORD_CREATE);
    } catch (err) {
      expect((err as OrgAuthError).status).toBe(403);
    }
  });

  it("throws OrgAuthError(404) when not a member", async () => {
    mockPrisma.orgMember.findUnique.mockResolvedValue(null);

    try {
      await requireOrgPermission("u-1", "org-1", ORG_PERMISSION.PASSWORD_READ);
    } catch (err) {
      expect((err as OrgAuthError).status).toBe(404);
    }
  });
});
