import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSession,
  mockExtensionToken,
  mockApiKey,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockSession: { deleteMany: vi.fn() },
  mockExtensionToken: { updateMany: vi.fn() },
  mockApiKey: { updateMany: vi.fn() },
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: mockSession,
    extensionToken: mockExtensionToken,
    apiKey: mockApiKey,
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

import { invalidateUserSessions } from "./user-session-invalidation";

describe("invalidateUserSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.deleteMany.mockResolvedValue({ count: 2 });
    mockExtensionToken.updateMany.mockResolvedValue({ count: 1 });
    mockApiKey.updateMany.mockResolvedValue({ count: 3 });
  });

  it("deletes sessions, revokes extension tokens and API keys", async () => {
    const result = await invalidateUserSessions("user-1");

    expect(mockSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(mockExtensionToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockApiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(result).toEqual({ sessions: 2, extensionTokens: 1, apiKeys: 3 });
  });

  it("uses withBypassRls", async () => {
    await invalidateUserSessions("user-1");
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
  });

  it("filters by userId only when no tenantId provided", async () => {
    await invalidateUserSessions("user-1");

    expect(mockSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("filters by tenantId when provided", async () => {
    await invalidateUserSessions("user-1", { tenantId: "tenant-1" });

    expect(mockSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: "tenant-1" },
    });
    expect(mockExtensionToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockApiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
