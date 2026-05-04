import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrismaUser, mockPrismaPasswordEntry, mockPrismaAttachment,
  mockPrismaPasswordShare, mockPrismaVaultKey, mockPrismaTag, mockPrismaFolder,
  mockPrismaEmergencyGrant, mockPrismaTeamMemberKey, mockPrismaTeamMember,
  mockPrismaTransaction,
} = vi.hoisted(() => {
  // Shared tx client mock — used inside the $transaction callback
  const txClient = {
    user: { update: vi.fn() },
    passwordEntry: { deleteMany: vi.fn() },
    attachment: { deleteMany: vi.fn() },
    passwordShare: { deleteMany: vi.fn() },
    vaultKey: { deleteMany: vi.fn() },
    tag: { deleteMany: vi.fn() },
    folder: { deleteMany: vi.fn() },
    emergencyAccessGrant: { updateMany: vi.fn() },
    teamMemberKey: { deleteMany: vi.fn() },
    teamMember: { updateMany: vi.fn() },
  };

  return {
    mockPrismaUser: txClient.user,
    mockPrismaPasswordEntry: { count: vi.fn(), ...txClient.passwordEntry },
    mockPrismaAttachment: { count: vi.fn(), ...txClient.attachment },
    mockPrismaPasswordShare: txClient.passwordShare,
    mockPrismaVaultKey: txClient.vaultKey,
    mockPrismaTag: txClient.tag,
    mockPrismaFolder: txClient.folder,
    mockPrismaEmergencyGrant: txClient.emergencyAccessGrant,
    mockPrismaTeamMemberKey: txClient.teamMemberKey,
    mockPrismaTeamMember: txClient.teamMember,
    // Execute the callback with the tx client so individual model mocks are invoked
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrismaTransaction: vi.fn((cb: any) => cb(txClient)),
  };
});

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
    // Default: all model operations succeed
    mockPrismaAttachment.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaPasswordShare.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaVaultKey.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaTag.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaFolder.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaEmergencyGrant.updateMany.mockResolvedValue({ count: 1 });
    mockPrismaTeamMemberKey.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaTeamMember.updateMany.mockResolvedValue({ count: 1 });
    mockPrismaUser.update.mockResolvedValue({});
    // Re-bind the transaction mock to execute the callback (cleared by clearAllMocks)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrismaTransaction.mockImplementation((cb: any) => cb({
        attachment: mockPrismaAttachment,
        passwordShare: mockPrismaPasswordShare,
        passwordEntry: mockPrismaPasswordEntry,
        vaultKey: mockPrismaVaultKey,
        tag: mockPrismaTag,
        folder: mockPrismaFolder,
        emergencyAccessGrant: mockPrismaEmergencyGrant,
        teamMemberKey: mockPrismaTeamMemberKey,
        teamMember: mockPrismaTeamMember,
        user: mockPrismaUser,
      })
    );
  });

  it("returns deleted entry and attachment counts", async () => {
    const result = await executeVaultReset("user-1");
    expect(result).toEqual({ deletedEntries: 10, deletedAttachments: 3 });
  });

  it("runs a single transaction", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
    // Callback form: the argument is a function, not an array
    const txArg = mockPrismaTransaction.mock.calls[0][0];
    expect(typeof txArg).toBe("function");
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

  it("revokes emergency access grants via bulkTransition (matrix-validated)", async () => {
    await executeVaultReset("user-1");
    expect(mockPrismaEmergencyGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: "user-1" }),
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
    mockPrismaAttachment.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaPasswordShare.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaVaultKey.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaTag.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaFolder.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaEmergencyGrant.updateMany.mockResolvedValue({ count: 1 });
    mockPrismaTeamMemberKey.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaTeamMember.updateMany.mockResolvedValue({ count: 1 });
    mockPrismaUser.update.mockResolvedValue({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrismaTransaction.mockImplementation((cb: any) => cb({
        attachment: mockPrismaAttachment,
        passwordShare: mockPrismaPasswordShare,
        passwordEntry: mockPrismaPasswordEntry,
        vaultKey: mockPrismaVaultKey,
        tag: mockPrismaTag,
        folder: mockPrismaFolder,
        emergencyAccessGrant: mockPrismaEmergencyGrant,
        teamMemberKey: mockPrismaTeamMemberKey,
        teamMember: mockPrismaTeamMember,
        user: mockPrismaUser,
      })
    );

    const resultB = await executeVaultReset("admin-target-user");
    expect(resultB).toEqual({ deletedEntries: 10, deletedAttachments: 3 });

    // Callback form: argument is a function
    const txArg = mockPrismaTransaction.mock.calls[0][0];
    expect(typeof txArg).toBe("function");
  });
});
