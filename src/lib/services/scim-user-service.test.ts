import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockTenantMemberFindUnique,
  mockTenantMemberUpdate,
  mockTenantMemberDelete,
  mockTeamMemberDeleteMany,
  mockTeamMemberKeyDeleteMany,
  mockScimExternalMappingFindFirst,
  mockScimExternalMappingDeleteMany,
  mockTransaction,
} = vi.hoisted(() => ({
  mockTenantMemberFindUnique: vi.fn(),
  mockTenantMemberUpdate: vi.fn(),
  mockTenantMemberDelete: vi.fn(),
  mockTeamMemberDeleteMany: vi.fn(),
  mockTeamMemberKeyDeleteMany: vi.fn(),
  mockScimExternalMappingFindFirst: vi.fn(),
  mockScimExternalMappingDeleteMany: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: {
      findUnique: mockTenantMemberFindUnique,
      update: mockTenantMemberUpdate,
      delete: mockTenantMemberDelete,
    },
    teamMember: {
      deleteMany: mockTeamMemberDeleteMany,
    },
    teamMemberKey: {
      deleteMany: mockTeamMemberKeyDeleteMany,
    },
    scimExternalMapping: {
      findFirst: mockScimExternalMappingFindFirst,
      deleteMany: mockScimExternalMappingDeleteMany,
    },
    $transaction: mockTransaction,
  },
}));

import {
  patchScimUser,
  deactivateScimUser,
  ScimUserNotFoundError,
  ScimOwnerProtectedError,
} from "./scim-user-service";

const TENANT_ID = "tenant-1";
const USER_ID = "user-1";
const BASE_URL = "http://localhost:3000/api/scim/v2";

// fetchScimUser makes a second tenantMember.findUnique call with an `include`
// and a scimExternalMapping.findFirst call — we provide a valid shape for both.
function mockFetchScimUser() {
  mockTenantMemberFindUnique.mockResolvedValueOnce({
    userId: USER_ID,
    deactivatedAt: null,
    user: { id: USER_ID, email: "user@example.com", name: "Test User" },
  });
  mockScimExternalMappingFindFirst.mockResolvedValueOnce(null);
}

describe("patchScimUser", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockTenantMemberUpdate.mockResolvedValue({});
  });

  it("throws ScimUserNotFoundError when member does not exist", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce(null);
    mockScimExternalMappingFindFirst.mockResolvedValue(null);

    await expect(
      patchScimUser(TENANT_ID, USER_ID, { active: false }, BASE_URL),
    ).rejects.toThrow(ScimUserNotFoundError);
  });

  it("throws ScimOwnerProtectedError when deactivating the tenant OWNER", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "OWNER",
      deactivatedAt: null,
    });

    await expect(
      patchScimUser(TENANT_ID, USER_ID, { active: false }, BASE_URL),
    ).rejects.toThrow(ScimOwnerProtectedError);
    expect(mockTenantMemberUpdate).not.toHaveBeenCalled();
  });

  it("sets auditAction to SCIM_USER_DEACTIVATE when deactivating an active member", async () => {
    // First call: member lookup (select: id, role, deactivatedAt)
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
      deactivatedAt: null,
    });
    mockFetchScimUser();

    const result = await patchScimUser(TENANT_ID, USER_ID, { active: false }, BASE_URL);

    expect(result.auditAction).toBe("SCIM_USER_DEACTIVATE");
    expect(result.needsSessionInvalidation).toBe(true);
  });

  it("sets auditAction to SCIM_USER_REACTIVATE when reactivating an inactive member", async () => {
    // First call: member lookup (select: id, role, deactivatedAt)
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
      deactivatedAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    mockFetchScimUser();

    const result = await patchScimUser(TENANT_ID, USER_ID, { active: true }, BASE_URL);

    expect(result.auditAction).toBe("SCIM_USER_REACTIVATE");
    expect(result.needsSessionInvalidation).toBe(false);
  });

  it("does not set needsSessionInvalidation when updating an already-active member", async () => {
    // First call: member lookup — already active, active stays true → SCIM_USER_UPDATE
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
      deactivatedAt: null,
    });
    mockFetchScimUser();

    const result = await patchScimUser(TENANT_ID, USER_ID, { active: true }, BASE_URL);

    expect(result.auditAction).toBe("SCIM_USER_UPDATE");
    expect(result.needsSessionInvalidation).toBe(false);
  });

  it("calls tenantMember.update with select fields matching the PR change", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
      deactivatedAt: null,
    });
    mockFetchScimUser();

    await patchScimUser(TENANT_ID, USER_ID, { active: false }, BASE_URL);

    expect(mockTenantMemberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tm1" },
        data: expect.objectContaining({ scimManaged: true, provisioningSource: "SCIM" }),
      }),
    );
  });
});

describe("deactivateScimUser", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: transaction resolves with the array of results
    mockTransaction.mockResolvedValue([]);
  });

  it("throws ScimUserNotFoundError when member does not exist", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce(null);
    mockScimExternalMappingFindFirst.mockResolvedValue(null);

    await expect(deactivateScimUser(TENANT_ID, USER_ID)).rejects.toThrow(ScimUserNotFoundError);
  });

  it("throws ScimOwnerProtectedError when deleting the tenant OWNER", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "OWNER",
      user: { email: "owner@example.com" },
    });

    await expect(deactivateScimUser(TENANT_ID, USER_ID)).rejects.toThrow(ScimOwnerProtectedError);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns userId and userEmail from the selected user relation", async () => {
    // Verifies the `select: { id, role, user: { select: { email } } }` shape is used correctly
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
      user: { email: "user@example.com" },
    });

    const result = await deactivateScimUser(TENANT_ID, USER_ID);

    expect(result.userId).toBe(USER_ID);
    expect(result.userEmail).toBe("user@example.com");
    expect(result.needsSessionInvalidation).toBe(true);
  });

  it("returns null userEmail when user has no email", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
      user: null,
    });

    const result = await deactivateScimUser(TENANT_ID, USER_ID);

    expect(result.userEmail).toBeNull();
  });

  it("runs deletion in a transaction", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
      user: { email: "user@example.com" },
    });

    await deactivateScimUser(TENANT_ID, USER_ID);

    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Array));
  });
});
