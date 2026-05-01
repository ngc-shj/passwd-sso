import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────

const { mockFindFirst, mockWithBypassRls } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: { findFirst: mockFindFirst },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

// ─── SUT ────────────────────────────────────────────────────

import {
  hasTenantPermission,
  isTenantRoleAbove,
  getTenantMembership,
  requireTenantMember,
  requireTenantPermission,
  TenantAuthError,
} from "./tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { API_ERROR } from "@/lib/http/api-error-codes";

// ─── Tests ──────────────────────────────────────────────────

// ─── hasTenantPermission ────────────────────────────────────

describe("hasTenantPermission", () => {
  it("OWNER has MEMBER_MANAGE permission", () => {
    expect(
      hasTenantPermission("OWNER", TENANT_PERMISSION.MEMBER_MANAGE),
    ).toBe(true);
  });

  it("OWNER has MEMBER_VAULT_RESET permission", () => {
    expect(
      hasTenantPermission("OWNER", TENANT_PERMISSION.MEMBER_VAULT_RESET),
    ).toBe(true);
  });

  it("ADMIN has MEMBER_MANAGE permission", () => {
    expect(
      hasTenantPermission("ADMIN", TENANT_PERMISSION.MEMBER_MANAGE),
    ).toBe(true);
  });

  it("ADMIN has MEMBER_VAULT_RESET permission", () => {
    expect(
      hasTenantPermission("ADMIN", TENANT_PERMISSION.MEMBER_VAULT_RESET),
    ).toBe(true);
  });

  it("OWNER has TEAM_CREATE permission", () => {
    expect(
      hasTenantPermission("OWNER", TENANT_PERMISSION.TEAM_CREATE),
    ).toBe(true);
  });

  it("ADMIN has TEAM_CREATE permission", () => {
    expect(
      hasTenantPermission("ADMIN", TENANT_PERMISSION.TEAM_CREATE),
    ).toBe(true);
  });

  it("MEMBER has no TEAM_CREATE permission", () => {
    expect(
      hasTenantPermission("MEMBER", TENANT_PERMISSION.TEAM_CREATE),
    ).toBe(false);
  });

  it("MEMBER has no MEMBER_MANAGE permission", () => {
    expect(
      hasTenantPermission("MEMBER", TENANT_PERMISSION.MEMBER_MANAGE),
    ).toBe(false);
  });

  it("MEMBER has no MEMBER_VAULT_RESET permission", () => {
    expect(
      hasTenantPermission("MEMBER", TENANT_PERMISSION.MEMBER_VAULT_RESET),
    ).toBe(false);
  });

  it("OWNER has SCIM_MANAGE permission", () => {
    expect(
      hasTenantPermission("OWNER", TENANT_PERMISSION.SCIM_MANAGE),
    ).toBe(true);
  });

  it("ADMIN has SCIM_MANAGE permission", () => {
    expect(
      hasTenantPermission("ADMIN", TENANT_PERMISSION.SCIM_MANAGE),
    ).toBe(true);
  });

  it("MEMBER has no SCIM_MANAGE permission", () => {
    expect(
      hasTenantPermission("MEMBER", TENANT_PERMISSION.SCIM_MANAGE),
    ).toBe(false);
  });
});

// ─── isTenantRoleAbove ──────────────────────────────────────

describe("isTenantRoleAbove", () => {
  it("OWNER > ADMIN returns true", () => {
    expect(isTenantRoleAbove("OWNER", "ADMIN")).toBe(true);
  });

  it("OWNER > MEMBER returns true", () => {
    expect(isTenantRoleAbove("OWNER", "MEMBER")).toBe(true);
  });

  it("ADMIN > MEMBER returns true", () => {
    expect(isTenantRoleAbove("ADMIN", "MEMBER")).toBe(true);
  });

  it("ADMIN > ADMIN returns false (strict comparison)", () => {
    expect(isTenantRoleAbove("ADMIN", "ADMIN")).toBe(false);
  });

  it("MEMBER > OWNER returns false", () => {
    expect(isTenantRoleAbove("MEMBER", "OWNER")).toBe(false);
  });

  it("OWNER > OWNER returns false (strict comparison)", () => {
    expect(isTenantRoleAbove("OWNER", "OWNER")).toBe(false);
  });
});

// ─── getTenantMembership ────────────────────────────────────

describe("getTenantMembership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation(
      async (_prisma: unknown, fn: () => unknown) => fn(),
    );
  });

  it("returns membership when active record exists", async () => {
    const membership = {
      id: "member-1",
      userId: "user-1",
      tenantId: "tenant-1",
      role: "MEMBER" as const,
      deactivatedAt: null,
    };
    mockFindFirst.mockResolvedValue(membership);

    const result = await getTenantMembership("user-1");

    expect(result).toEqual(membership);
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", deactivatedAt: null },
    });
  });

  it("returns null when no active membership exists", async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await getTenantMembership("user-no-membership");

    expect(result).toBeNull();
  });

  it("calls withBypassRls with prisma and a function", async () => {
    mockFindFirst.mockResolvedValue(null);

    await getTenantMembership("user-1");

    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      expect.any(String),
    );
  });
});

// ─── requireTenantMember ────────────────────────────────────

describe("requireTenantMember", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation(
      async (_prisma: unknown, fn: () => unknown) => fn(),
    );
  });

  it("returns membership when active membership exists", async () => {
    const membership = {
      id: "member-1",
      userId: "user-1",
      tenantId: "tenant-1",
      role: "OWNER" as const,
      deactivatedAt: null,
    };
    mockFindFirst.mockResolvedValue(membership);

    const result = await requireTenantMember("user-1");

    expect(result).toEqual(membership);
  });

  it("throws TenantAuthError with 403 when no active membership exists", async () => {
    mockFindFirst.mockResolvedValue(null);

    await expect(requireTenantMember("user-no-membership")).rejects.toThrow(
      TenantAuthError,
    );
  });

  it("throws TenantAuthError with status 403 when membership is absent", async () => {
    mockFindFirst.mockResolvedValue(null);

    const error = await requireTenantMember("user-deactivated").catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(TenantAuthError);
    expect(error.status).toBe(403);
    expect(error.message).toBe(API_ERROR.FORBIDDEN);
  });

  it("throws TenantAuthError with 403 when user is deactivated (findFirst returns null)", async () => {
    // deactivatedAt filter is applied in the query itself; findFirst returns null
    mockFindFirst.mockResolvedValue(null);

    await expect(requireTenantMember("user-deactivated")).rejects.toMatchObject(
      {
        name: "TenantAuthError",
        status: 403,
        message: API_ERROR.FORBIDDEN,
      },
    );
  });
});

// ─── requireTenantPermission ────────────────────────────────

describe("requireTenantPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation(
      async (_prisma: unknown, fn: () => unknown) => fn(),
    );
  });

  it("returns membership when role has the required permission", async () => {
    const membership = {
      id: "member-1",
      userId: "user-1",
      tenantId: "tenant-1",
      role: "ADMIN" as const,
      deactivatedAt: null,
    };
    mockFindFirst.mockResolvedValue(membership);

    const result = await requireTenantPermission(
      "user-1",
      TENANT_PERMISSION.MEMBER_MANAGE,
    );

    expect(result).toEqual(membership);
  });

  it("throws TenantAuthError with 403 when MEMBER lacks MEMBER_VAULT_RESET", async () => {
    const membership = {
      id: "member-2",
      userId: "user-2",
      tenantId: "tenant-1",
      role: "MEMBER" as const,
      deactivatedAt: null,
    };
    mockFindFirst.mockResolvedValue(membership);

    const error = await requireTenantPermission(
      "user-2",
      TENANT_PERMISSION.MEMBER_VAULT_RESET,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(TenantAuthError);
    expect(error.status).toBe(403);
    expect(error.message).toBe(API_ERROR.FORBIDDEN);
  });

  it("throws TenantAuthError with 403 when MEMBER lacks MEMBER_MANAGE", async () => {
    const membership = {
      id: "member-3",
      userId: "user-3",
      tenantId: "tenant-1",
      role: "MEMBER" as const,
      deactivatedAt: null,
    };
    mockFindFirst.mockResolvedValue(membership);

    await expect(
      requireTenantPermission("user-3", TENANT_PERMISSION.MEMBER_MANAGE),
    ).rejects.toMatchObject({
      name: "TenantAuthError",
      status: 403,
      message: API_ERROR.FORBIDDEN,
    });
  });

  it("returns membership when OWNER has TEAM_CREATE permission", async () => {
    const membership = {
      id: "member-owner",
      userId: "user-owner",
      tenantId: "tenant-1",
      role: "OWNER" as const,
      deactivatedAt: null,
    };
    mockFindFirst.mockResolvedValue(membership);

    const result = await requireTenantPermission(
      "user-owner",
      TENANT_PERMISSION.TEAM_CREATE,
    );
    expect(result).toEqual(membership);
  });

  it("returns membership when ADMIN has TEAM_CREATE permission", async () => {
    const membership = {
      id: "member-4",
      userId: "user-4",
      tenantId: "tenant-1",
      role: "ADMIN" as const,
      deactivatedAt: null,
    };
    mockFindFirst.mockResolvedValue(membership);

    const result = await requireTenantPermission(
      "user-4",
      TENANT_PERMISSION.TEAM_CREATE,
    );
    expect(result).toEqual(membership);
  });

  it("throws TenantAuthError with 403 when MEMBER lacks TEAM_CREATE", async () => {
    mockFindFirst.mockResolvedValue({
      id: "member-5",
      userId: "user-5",
      tenantId: "tenant-1",
      role: "MEMBER" as const,
      deactivatedAt: null,
    });

    await expect(
      requireTenantPermission("user-5", TENANT_PERMISSION.TEAM_CREATE),
    ).rejects.toMatchObject({
      name: "TenantAuthError",
      status: 403,
      message: API_ERROR.FORBIDDEN,
    });
  });

  it("propagates TenantAuthError with 403 when user has no membership", async () => {
    mockFindFirst.mockResolvedValue(null);

    const error = await requireTenantPermission(
      "user-none",
      TENANT_PERMISSION.MEMBER_MANAGE,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(TenantAuthError);
    expect(error.status).toBe(403);
  });
});

// ─── TenantAuthError ────────────────────────────────────────

describe("TenantAuthError", () => {
  it("has name 'TenantAuthError'", () => {
    const err = new TenantAuthError(API_ERROR.FORBIDDEN, 403);
    expect(err.name).toBe("TenantAuthError");
  });

  it("stores the message passed to constructor", () => {
    const err = new TenantAuthError(API_ERROR.FORBIDDEN, 403);
    expect(err.message).toBe(API_ERROR.FORBIDDEN);
  });

  it("stores the status passed to constructor", () => {
    const err = new TenantAuthError(API_ERROR.NOT_FOUND, 404);
    expect(err.status).toBe(404);
  });

  it("is an instance of Error", () => {
    const err = new TenantAuthError(API_ERROR.INTERNAL_ERROR, 500);
    expect(err).toBeInstanceOf(Error);
  });
});
