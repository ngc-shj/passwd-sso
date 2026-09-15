import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrismaUser, mockPrismaPasswordEntry, mockPrismaAttachment,
  mockPrismaPasswordShare, mockPrismaVaultKey, mockPrismaTag, mockPrismaFolder,
  mockPrismaEmergencyGrant, mockPrismaTeamMemberKey, mockPrismaTeamMember,
  mockPrismaTransaction, mockWithBypassRls, mockQueryRaw, mockLogAuditInTx,
} = vi.hoisted(() => {
  // assertCurrentKeyVersion-style row lock — the early users FOR UPDATE
  // added for lock-order consistency with rotation. Result value is
  // irrelevant (the reset body doesn't read it), so any resolved value works.
  const mockQueryRaw = vi.fn().mockResolvedValue([{ id: "user-1" }]);

  // Shared tx client mock — used inside the $transaction callback
  const txClient = {
    user: { update: vi.fn() },
    passwordEntry: { deleteMany: vi.fn() },
    attachment: { deleteMany: vi.fn() },
    passwordShare: { deleteMany: vi.fn(), count: vi.fn() },
    vaultKey: { deleteMany: vi.fn(), count: vi.fn() },
    tag: { deleteMany: vi.fn(), count: vi.fn() },
    folder: { deleteMany: vi.fn(), count: vi.fn() },
    emergencyAccessGrant: { updateMany: vi.fn(), count: vi.fn() },
    teamMemberKey: { deleteMany: vi.fn() },
    teamMember: { updateMany: vi.fn() },
    $queryRaw: mockQueryRaw,
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
    mockQueryRaw,
    mockLogAuditInTx: vi.fn(),
    // Execute the callback with the tx client so individual model mocks are invoked
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrismaTransaction: vi.fn((cb: any) => cb(txClient)),
    // withBypassRls invokes the callback directly with the passed-in tx (the prisma mock),
    // which carries all the model-method mocks the reset body calls.
    mockWithBypassRls: vi.fn((prismaArg: unknown, fn: (tx: unknown) => unknown) => fn(prismaArg)),
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
    $queryRaw: mockQueryRaw,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { executeVaultReset, type VaultResetAtomicAudit } from "./vault-reset";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

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
    mockQueryRaw.mockResolvedValue([{ id: "user-1" }]);
    mockPrismaTag.count.mockResolvedValue(0);
    mockPrismaFolder.count.mockResolvedValue(0);
    mockPrismaVaultKey.count.mockResolvedValue(0);
    mockPrismaPasswordShare.count.mockResolvedValue(0);
    mockPrismaEmergencyGrant.count.mockResolvedValue(0);
    // Re-bind withBypassRls to invoke its callback (cleared by clearAllMocks)
    mockWithBypassRls.mockImplementation(
      (prismaArg: unknown, fn: (tx: unknown) => unknown) => fn(prismaArg),
    );
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
        $queryRaw: mockQueryRaw,
      })
    );
  });

  it("returns deleted entry and attachment counts", async () => {
    const result = await executeVaultReset("user-1");
    expect(result).toEqual({ deletedEntries: 10, deletedAttachments: 3 });
  });

  it("runs a single transaction", async () => {
    await executeVaultReset("user-1");
    // Atomicity is now provided by the outer withBypassRls callback (the redundant
    // inner prisma.$transaction was folded away). The mutating body runs in a single
    // withBypassRls call: one count pass + one delete/update pass = 2 invocations,
    // and the delete/update body must be driven via the callback form (required for
    // bulkTransition — S4).
    expect(mockWithBypassRls).toHaveBeenCalledTimes(2);
    const bodyCallback = mockWithBypassRls.mock.calls[1][1];
    expect(typeof bodyCallback).toBe("function");
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
    // Without options the reset is the same for any caller
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
    mockWithBypassRls.mockImplementation(
      (prismaArg: unknown, fn: (tx: unknown) => unknown) => fn(prismaArg),
    );
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

    // Same atomicity path regardless of caller: mutating body driven via the
    // withBypassRls callback form (the second withBypassRls call).
    const bodyCallback = mockWithBypassRls.mock.calls[1][1];
    expect(typeof bodyCallback).toBe("function");
  });

  describe("tenant-scoped reset", () => {
    const AUDIT: VaultResetAtomicAudit = {
      tenantId: "tenant-a",
      params: {
        scope: AUDIT_SCOPE.TENANT,
        action: AUDIT_ACTION.ADMIN_VAULT_RESET_EXECUTE,
        userId: "user-1",
      },
    };

    /**
     * What the scope check finds under tenants OTHER than the authorizing one.
     * A count without a tenant predicate is the reset's own pre-count and keeps
     * its default, so the two questions cannot be answered by one blanket stub.
     */
    function holdOutside(outside: Partial<Record<string, number>>) {
      const scoped =
        (model: string, fallback: number) =>
        async ({ where }: { where: { tenantId?: unknown } }) =>
          where.tenantId === undefined ? fallback : (outside[model] ?? 0);
      mockPrismaPasswordEntry.count.mockImplementation(scoped("passwordEntry", 10));
      mockPrismaAttachment.count.mockImplementation(scoped("attachment", 3));
      mockPrismaTag.count.mockImplementation(scoped("tag", 0));
      mockPrismaFolder.count.mockImplementation(scoped("folder", 0));
      mockPrismaVaultKey.count.mockImplementation(scoped("vaultKey", 0));
      mockPrismaPasswordShare.count.mockImplementation(scoped("passwordShare", 0));
      mockPrismaEmergencyGrant.count.mockImplementation(scoped("emergencyAccessGrant", 0));
    }

    it("refuses, deleting nothing, when personal vault rows are held under another tenant", async () => {
      // Left there by a realignment and reattachable. The unscoped reset deleted
      // them on the authority of a tenant that has none over them.
      holdOutside({ passwordEntry: 7 });

      await expect(executeVaultReset("user-1", AUDIT, { scopeTenantId: "tenant-a" })).rejects.toMatchObject({
        name: "VaultResetOutsideTenantError",
        outside: { passwordEntry: 7 },
      });
      expect(mockPrismaPasswordEntry.deleteMany).not.toHaveBeenCalled();
      expect(mockPrismaAttachment.deleteMany).not.toHaveBeenCalled();
      expect(mockPrismaUser.update).not.toHaveBeenCalled();
      expect(mockLogAuditInTx).not.toHaveBeenCalled();
    });

    it("names only the kinds actually held outside", async () => {
      holdOutside({ tag: 2, emergencyAccessGrant: 1 });

      await expect(executeVaultReset("user-1", AUDIT, { scopeTenantId: "tenant-a" })).rejects.toMatchObject({
        outside: { tag: 2, emergencyAccessGrant: 1 },
      });
    });

    it("resets when every personal vault row is under the authorizing tenant", async () => {
      // The allow side: without it a check that always refused would pass the
      // cells above.
      holdOutside({});

      const result = await executeVaultReset("user-1", AUDIT, { scopeTenantId: "tenant-a" });

      expect(result).toEqual({ deletedEntries: 10, deletedAttachments: 3 });
      expect(mockPrismaPasswordEntry.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
      expect(mockLogAuditInTx).toHaveBeenCalledWith(expect.anything(), "tenant-a", expect.anything());
    });

    it("asks after locking the user row, inside the deleting transaction", async () => {
      // A realignment updates the same users row, so the lock serializes it
      // against this check instead of letting it land between check and delete.
      holdOutside({});

      await executeVaultReset("user-1", AUDIT, { scopeTenantId: "tenant-a" });

      const lockOrder = mockQueryRaw.mock.invocationCallOrder[0];
      const scopedIndex = mockPrismaPasswordEntry.count.mock.calls.findIndex(
        ([args]) => (args as { where: { tenantId?: unknown } }).where.tenantId !== undefined,
      );
      expect(scopedIndex).toBeGreaterThanOrEqual(0);
      expect(mockPrismaPasswordEntry.count.mock.invocationCallOrder[scopedIndex]).toBeGreaterThan(lockOrder);
    });

    it("does not count team-side rows a guest legitimately holds under a team's tenant", async () => {
      // A row under exactly the authorizing tenant is inside (`not`), and an
      // attachment or share on a TEAM entry is not the user's vault. No count
      // mock exists for teamMemberKey, so asking about it would throw here.
      holdOutside({});

      await executeVaultReset("user-1", AUDIT, { scopeTenantId: "tenant-a" });

      expect(mockPrismaAttachment.count).toHaveBeenCalledWith({
        where: { createdById: "user-1", teamPasswordEntryId: null, tenantId: { not: "tenant-a" } },
      });
      expect(mockPrismaPasswordShare.count).toHaveBeenCalledWith({
        where: { createdById: "user-1", teamPasswordEntryId: null, tenantId: { not: "tenant-a" } },
      });
    });

    it("leaves the owner's own reset unscoped", async () => {
      // `/api/vault/reset`: the owner's authority covers all of their rows.
      holdOutside({ passwordEntry: 7 });

      await expect(executeVaultReset("user-1")).resolves.toEqual({
        deletedEntries: 10,
        deletedAttachments: 3,
      });
      expect(
        mockPrismaPasswordEntry.count.mock.calls.some(
          ([args]) => (args as { where: { tenantId?: unknown } }).where.tenantId !== undefined,
        ),
      ).toBe(false);
    });
  });
});
