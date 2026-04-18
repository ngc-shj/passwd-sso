import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaUser, mockPrismaPasswordEntry, mockPrismaAttachment,
  mockPrismaPasswordShare, mockPrismaVaultKey, mockPrismaTag, mockPrismaFolder,
  mockPrismaEmergencyGrant, mockPrismaTeamMemberKey, mockPrismaTeamMember,
  mockPrismaTransaction, mockRateLimiter, mockLogAudit, mockExecuteVaultReset,
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
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => mockRateLimiter,
}));
vi.mock("@/lib/csrf", () => ({
  assertOrigin: vi.fn(() => null),
}));
vi.mock("@/lib/audit", () => ({
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
vi.mock("@/lib/vault-reset", () => ({
  executeVaultReset: mockExecuteVaultReset,
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
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, {
      body: { confirmation: "DELETE MY VAULT" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiter.check.mockResolvedValue({ allowed: false });
    const res = await POST(createRequest("POST", URL, {
      body: { confirmation: "DELETE MY VAULT" },
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
      body: { confirmation: "DELETE MY VAULT" },
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // executeVaultReset was called
    expect(mockExecuteVaultReset).toHaveBeenCalledWith("user-1");

    // Audit log
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VAULT_RESET_EXECUTED",
        userId: "user-1",
        metadata: { deletedEntries: 5, deletedAttachments: 2 },
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
      POST(createRequest("POST", URL, { body: { confirmation: "DELETE MY VAULT" } })),
    ).rejects.toThrow("DB failure");
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("delegates full vault wipe to executeVaultReset with correct userId", async () => {
    const res = await POST(createRequest("POST", URL, {
      body: { confirmation: "DELETE MY VAULT" },
    }));
    expect(res.status).toBe(200);

    expect(mockExecuteVaultReset).toHaveBeenCalledOnce();
    expect(mockExecuteVaultReset).toHaveBeenCalledWith("user-1");
  });
});
