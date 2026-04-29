import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrismaUser, mockPrismaPasswordEntry, mockPrismaAttachment,
  mockPrismaPasswordShare, mockPrismaVaultKey, mockPrismaTag, mockPrismaFolder,
  mockPrismaEmergencyGrant, mockPrismaTeamMemberKey, mockPrismaTeamMember,
  mockPrismaTransaction,
} = vi.hoisted(() => ({
  mockPrismaUser: { update: vi.fn() },
  mockPrismaPasswordEntry: { count: vi.fn(), deleteMany: vi.fn() },
  mockPrismaAttachment: { count: vi.fn(), deleteMany: vi.fn() },
  mockPrismaPasswordShare: { deleteMany: vi.fn() },
  mockPrismaVaultKey: { deleteMany: vi.fn() },
  mockPrismaTag: { deleteMany: vi.fn() },
  mockPrismaFolder: { deleteMany: vi.fn() },
  mockPrismaEmergencyGrant: { updateMany: vi.fn() },
  mockPrismaTeamMemberKey: { deleteMany: vi.fn() },
  mockPrismaTeamMember: { updateMany: vi.fn() },
  mockPrismaTransaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    passwordEntry: mockPrismaPasswordEntry,
    attachment: mockPrismaAttachment,
    passwordShare: mockPrismaPasswordShare,
    vaultKey: mockPrismaVaultKey,
    tag: mockPrismaTag,
    folder: mockPrismaFolder,
    emergencyAccessGrant: mockPrismaEmergencyGrant,
    teamMemberKey: mockPrismaTeamMemberKey,
    teamMember: mockPrismaTeamMember,
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: vi.fn((_prisma: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { executeVaultReset } from "./vault-reset";

describe("executeVaultReset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaPasswordEntry.count.mockResolvedValue(10);
    mockPrismaAttachment.count.mockResolvedValue(3);
    mockPrismaTransaction.mockResolvedValue([]);
  });

  it("returns deleted entry and attachment counts", async () => {
    const result = await executeVaultReset("user-1");
    expect(result).toEqual({ deletedEntries: 10, deletedAttachments: 3 });
  });

  it("runs a transaction with all 10 expected operations", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
    const txArray = mockPrismaTransaction.mock.calls[0][0];
    expect(txArray).toHaveLength(10);
  });

  it("deletes attachments for the target user", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaAttachment.deleteMany).toHaveBeenCalledWith({
      where: { createdById: "user-1" },
    });
  });

  it("deletes password entries for the target user", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaPasswordEntry.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("deletes vault keys for the target user", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaVaultKey.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("deletes tags for the target user", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaTag.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("revokes emergency access grants", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaEmergencyGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: "user-1" },
        data: expect.objectContaining({ status: "REVOKED" }),
      }),
    );
  });

  it("deletes TeamMemberKey records", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaTeamMemberKey.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("resets keyDistributed on TeamMember records", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaTeamMember.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { keyDistributed: false },
    });
  });

  it("nulls vault and ECDH fields on User", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({
          vaultSetupAt: null,
          encryptedSecretKey: null,
          ecdhPublicKey: null,
          recoveryEncryptedSecretKey: null,
          failedUnlockAttempts: 0,
        }),
      }),
    );
  });

  it("resets exactly 24 vault/recovery/lockout/ECDH fields on User", async () => {
    await executeVaultReset("user-1");
    const updateData = mockPrismaUser.update.mock.calls[0][0].data;
    expect(Object.keys(updateData)).toHaveLength(24);
  });

  it("deletes password shares for the target user", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaPasswordShare.deleteMany).toHaveBeenCalledWith({
      where: { createdById: "user-1" },
    });
  });

  it("deletes folders for the target user", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaFolder.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("works identically regardless of the caller (self-reset or admin)", async () => {
    // The function takes only targetUserId — no caller context
    const resultA = await executeVaultReset("self-user");
    expect(resultA).toEqual({ deletedEntries: 10, deletedAttachments: 3 });

    vi.clearAllMocks();
    mockPrismaPasswordEntry.count.mockResolvedValue(10);
    mockPrismaAttachment.count.mockResolvedValue(3);
    mockPrismaTransaction.mockResolvedValue([]);

    const resultB = await executeVaultReset("admin-target-user");
    expect(resultB).toEqual({ deletedEntries: 10, deletedAttachments: 3 });

    // Same transaction structure
    const txA = mockPrismaTransaction.mock.calls[0][0];
    expect(txA).toHaveLength(10);
  });
});
