import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaUser, mockPrismaPasswordEntry, mockPrismaAttachment,
  mockPrismaPasswordShare, mockPrismaVaultKey, mockPrismaTag, mockPrismaFolder,
  mockPrismaEmergencyGrant, mockPrismaTeamMemberKey, mockPrismaTeamMember,
  mockPrismaTransaction, mockRateLimiter, mockLogAudit, mockExecuteVaultReset,
  mockInvalidateUserSessions,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
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
  mockRateLimiter: { check: vi.fn() },
  mockLogAudit: vi.fn(),
  mockExecuteVaultReset: vi.fn(),
  mockInvalidateUserSessions: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
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
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => mockRateLimiter,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: "127.0.0.1",
    userAgent: "test",
    acceptLanguage: null,
  }),
}));
vi.mock("@/lib/vault/vault-reset", () => ({
  executeVaultReset: mockExecuteVaultReset,
}));
vi.mock("@/lib/auth/session/user-session-invalidation", () => ({
  invalidateUserSessions: mockInvalidateUserSessions,
}));
// executeVaultReset uses withBypassRls (not withUserTenantRls)
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: vi.fn((_prisma: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from "./route";
import { VAULT_CONFIRMATION_PHRASE } from "@/lib/constants/vault";

const URL = "http://localhost/api/vault/reset";

describe("POST /api/vault/reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiter.check.mockResolvedValue({ allowed: true });
    mockPrismaPasswordEntry.count.mockResolvedValue(5);
    mockPrismaAttachment.count.mockResolvedValue(2);
    mockPrismaTransaction.mockResolvedValue([]);
    mockExecuteVaultReset.mockResolvedValue({ deletedEntries: 5, deletedAttachments: 2 });
    mockInvalidateUserSessions.mockResolvedValue({
      sessions: 0,
      extensionTokens: 0,
      apiKeys: 0,
      mcpAccessTokens: 0,
      mcpRefreshTokens: 0,
      delegationSessions: 0,
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, {
      body: { confirmation: VAULT_CONFIRMATION_PHRASE.DELETE_VAULT },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiter.check.mockResolvedValue({ allowed: false });
    const res = await POST(createRequest("POST", URL, {
      body: { confirmation: VAULT_CONFIRMATION_PHRASE.DELETE_VAULT },
    }));
    expect(res.status).toBe(429);
  });

  it("returns 400 on wrong confirmation text", async () => {
    const res = await POST(createRequest("POST", URL, {
      body: { confirmation: "wrong text" },
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VAULT_RESET_CONFIRMATION_MISMATCH");
  });

  it("deletes all vault data and logs audit on success", async () => {
    const res = await POST(createRequest("POST", URL, {
      body: { confirmation: VAULT_CONFIRMATION_PHRASE.DELETE_VAULT },
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // executeVaultReset was called
    expect(mockExecuteVaultReset).toHaveBeenCalledWith("user-1");

    // Audit log includes invalidation counts (zero by default in this test)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VAULT_RESET_EXECUTED",
        userId: "user-1",
        metadata: {
          deletedEntries: 5,
          deletedAttachments: 2,
          invalidatedSessions: 0,
          invalidatedExtensionTokens: 0,
          invalidatedApiKeys: 0,
          invalidatedMcpAccessTokens: 0,
          invalidatedMcpRefreshTokens: 0,
          invalidatedDelegationSessions: 0,
        },
      }),
    );
  });

  it("invalidates all user sessions/tokens across tenants after vault reset", async () => {
    mockInvalidateUserSessions.mockResolvedValue({
      sessions: 3,
      extensionTokens: 2,
      apiKeys: 1,
      mcpAccessTokens: 4,
      mcpRefreshTokens: 5,
      delegationSessions: 6,
    });

    const res = await POST(createRequest("POST", URL, {
      body: { confirmation: VAULT_CONFIRMATION_PHRASE.DELETE_VAULT },
    }));
    expect(res.status).toBe(200);

    // Sessions/tokens invalidated across all tenants (mirrors admin-reset).
    expect(mockInvalidateUserSessions).toHaveBeenCalledOnce();
    expect(mockInvalidateUserSessions).toHaveBeenCalledWith("user-1", {
      allTenants: true,
      reason: "self_vault_reset",
    });

    // Counts propagated to audit metadata.
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VAULT_RESET_EXECUTED",
        metadata: expect.objectContaining({
          invalidatedSessions: 3,
          invalidatedExtensionTokens: 2,
          invalidatedApiKeys: 1,
          invalidatedMcpAccessTokens: 4,
          invalidatedMcpRefreshTokens: 5,
          invalidatedDelegationSessions: 6,
        }),
      }),
    );
  });

  it("returns 400 on missing confirmation field", async () => {
    const res = await POST(createRequest("POST", URL, {
      body: {},
    }));
    expect(res.status).toBe(400);
  });

  it("returns 500 when executeVaultReset throws", async () => {
    mockExecuteVaultReset.mockRejectedValue(new Error("DB failure"));
    await expect(
      POST(createRequest("POST", URL, { body: { confirmation: VAULT_CONFIRMATION_PHRASE.DELETE_VAULT } })),
    ).rejects.toThrow("DB failure");
    expect(mockLogAudit).not.toHaveBeenCalled();
    // No invalidation when the wipe itself failed — DB rows still exist.
    expect(mockInvalidateUserSessions).not.toHaveBeenCalled();
  });

  it("delegates full vault wipe to executeVaultReset with correct userId", async () => {
    const res = await POST(createRequest("POST", URL, {
      body: { confirmation: VAULT_CONFIRMATION_PHRASE.DELETE_VAULT },
    }));
    expect(res.status).toBe(200);

    expect(mockExecuteVaultReset).toHaveBeenCalledOnce();
    expect(mockExecuteVaultReset).toHaveBeenCalledWith("user-1");
  });
});
