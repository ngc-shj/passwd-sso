import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreate, mockFindUnique, mockWithBypassRls } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(
    async (_prisma: unknown, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: { create: mockCreate },
    user: { findUnique: mockFindUnique },
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

import { createNotification } from "@/lib/notification";
import { NOTIFICATION_TYPE } from "@/lib/constants";

describe("createNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation(
      async (_prisma: unknown, fn: () => unknown) => fn(),
    );
  });

  it("creates a notification with tenantId provided", async () => {
    mockCreate.mockResolvedValue({ id: "n-1" });

    createNotification({
      userId: "user-1",
      tenantId: "tenant-1",
      type: NOTIFICATION_TYPE.SECURITY_ALERT,
      title: "Alert",
      body: "Something happened",
    });

    // Fire-and-forget — give microtask a chance to settle
    await vi.waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          userId: "user-1",
          tenantId: "tenant-1",
          type: NOTIFICATION_TYPE.SECURITY_ALERT,
          title: "Alert",
          body: "Something happened",
          metadata: undefined,
        },
      });
    });
  });

  it("resolves tenantId from user when not provided", async () => {
    mockFindUnique.mockResolvedValue({ tenantId: "resolved-tenant" });
    mockCreate.mockResolvedValue({ id: "n-2" });

    createNotification({
      userId: "user-1",
      type: NOTIFICATION_TYPE.NEW_DEVICE_LOGIN,
      title: "New Device",
      body: "A new device logged in",
    });

    await vi.waitFor(() => {
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { id: "user-1" },
        select: { tenantId: true },
      });
      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: "resolved-tenant",
        }),
      });
    });
  });

  it("does not throw when creation fails (fire-and-forget)", () => {
    mockWithBypassRls.mockRejectedValue(new Error("DB error"));

    // Should not throw
    expect(() => {
      createNotification({
        userId: "user-1",
        tenantId: "tenant-1",
        type: NOTIFICATION_TYPE.SECURITY_ALERT,
        title: "Alert",
        body: "Something happened",
      });
    }).not.toThrow();
  });

  it("sanitizes metadata using blocklist", async () => {
    mockCreate.mockResolvedValue({ id: "n-3" });

    createNotification({
      userId: "user-1",
      tenantId: "tenant-1",
      type: NOTIFICATION_TYPE.SHARE_ACCESS,
      title: "Share",
      body: "Entry shared with you",
      metadata: {
        entryId: "e-1",
        encryptedBlob: "should-be-removed",
        encryptedOverview: "should-be-removed",
        safeField: "kept",
      },
    });

    await vi.waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            entryId: "e-1",
            safeField: "kept",
          }),
        }),
      });
      // Verify blocklisted fields are removed
      const callData = mockCreate.mock.calls[0][0].data;
      expect(callData.metadata).not.toHaveProperty("encryptedBlob");
      expect(callData.metadata).not.toHaveProperty("encryptedOverview");
    });
  });
});
