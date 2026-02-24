import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaUser, mockPrismaPasswordEntry, mockPrismaAttachment,
  mockPrismaPasswordShare, mockPrismaVaultKey, mockPrismaTag,
  mockPrismaEmergencyGrant, mockPrismaOrgMemberKey, mockPrismaOrgMember,
  mockPrismaTransaction, mockRateLimiter, mockLogAudit,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { update: vi.fn() },
  mockPrismaPasswordEntry: { count: vi.fn(), deleteMany: vi.fn() },
  mockPrismaAttachment: { count: vi.fn(), deleteMany: vi.fn() },
  mockPrismaPasswordShare: { deleteMany: vi.fn() },
  mockPrismaVaultKey: { deleteMany: vi.fn() },
  mockPrismaTag: { deleteMany: vi.fn() },
  mockPrismaEmergencyGrant: { updateMany: vi.fn() },
  mockPrismaOrgMemberKey: { deleteMany: vi.fn() },
  mockPrismaOrgMember: { updateMany: vi.fn() },
  mockPrismaTransaction: vi.fn(),
  mockRateLimiter: { check: vi.fn() },
  mockLogAudit: vi.fn(),
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
    emergencyAccessGrant: mockPrismaEmergencyGrant,
    orgMemberKey: mockPrismaOrgMemberKey,
    orgMember: mockPrismaOrgMember,
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
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
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
    mockRateLimiter.check.mockResolvedValue(true);
    mockPrismaPasswordEntry.count.mockResolvedValue(5);
    mockPrismaAttachment.count.mockResolvedValue(2);
    mockPrismaTransaction.mockResolvedValue([]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, {
      body: { confirmation: "DELETE MY VAULT" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiter.check.mockResolvedValue(false);
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

    // Transaction was called
    expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);

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

  it("includes ECDH cleanup, OrgMemberKey deletion, and keyDistributed reset in transaction", async () => {
    const res = await POST(createRequest("POST", URL, {
      body: { confirmation: "DELETE MY VAULT" },
    }));
    expect(res.status).toBe(200);

    // Transaction includes OrgMemberKey deleteMany and OrgMember updateMany
    const txArray = mockPrismaTransaction.mock.calls[0][0];

    // Verify OrgMemberKey.deleteMany was included
    expect(mockPrismaOrgMemberKey.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });

    // Verify OrgMember.updateMany was included (reset keyDistributed)
    expect(mockPrismaOrgMember.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { keyDistributed: false },
    });

    // Transaction should have 9 operations (original 7 + 2 new)
    expect(txArray).toHaveLength(9);
  });
});
