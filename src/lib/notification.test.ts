import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrismaUser,
  mockPrismaNotification,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockPrismaUser: {
    findUnique: vi.fn(),
  },
  mockPrismaNotification: {
    create: vi.fn(),
  },
  mockWithBypassRls: vi.fn(
    async (_client: unknown, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    notification: mockPrismaNotification,
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

import { createNotification } from "./notification";

describe("createNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates notification with provided tenantId", async () => {
    mockPrismaNotification.create.mockResolvedValue({});

    createNotification({
      userId: "user-1",
      tenantId: "tenant-1",
      type: "SECURITY_ALERT" as never,
      title: "Test",
      body: "Body",
    });

    // Wait for the fire-and-forget async to resolve
    await vi.waitFor(() => {
      expect(mockPrismaNotification.create).toHaveBeenCalled();
    });

    expect(mockPrismaNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        tenantId: "tenant-1",
        type: "SECURITY_ALERT",
        title: "Test",
        body: "Body",
      }),
    });

    // Should not look up user when tenantId is provided
    expect(mockPrismaUser.findUnique).not.toHaveBeenCalled();
  });

  it("resolves tenantId from user when not provided", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "resolved-tenant" });
    mockPrismaNotification.create.mockResolvedValue({});

    createNotification({
      userId: "user-1",
      type: "NEW_DEVICE_LOGIN" as never,
      title: "New login",
      body: "From Chrome on macOS",
    });

    await vi.waitFor(() => {
      expect(mockPrismaNotification.create).toHaveBeenCalled();
    });

    expect(mockPrismaUser.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { tenantId: true },
    });

    expect(mockPrismaNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "resolved-tenant",
      }),
    });
  });

  it("skips creation when tenantId cannot be resolved", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null);

    createNotification({
      userId: "user-1",
      type: "SECURITY_ALERT" as never,
      title: "Test",
      body: "Body",
    });

    // Allow microtasks to settle
    await vi.waitFor(() => {
      expect(mockPrismaUser.findUnique).toHaveBeenCalled();
    });

    expect(mockPrismaNotification.create).not.toHaveBeenCalled();
  });

  it("truncates title to 200 characters", async () => {
    mockPrismaNotification.create.mockResolvedValue({});
    const longTitle = "A".repeat(300);

    createNotification({
      userId: "user-1",
      tenantId: "tenant-1",
      type: "SECURITY_ALERT" as never,
      title: longTitle,
      body: "Body",
    });

    await vi.waitFor(() => {
      expect(mockPrismaNotification.create).toHaveBeenCalled();
    });

    const callData = mockPrismaNotification.create.mock.calls[0][0].data;
    expect(callData.title).toHaveLength(200);
  });

  it("sanitizes metadata by removing blocklisted keys", async () => {
    mockPrismaNotification.create.mockResolvedValue({});

    createNotification({
      userId: "user-1",
      tenantId: "tenant-1",
      type: "SECURITY_ALERT" as never,
      title: "Test",
      body: "Body",
      metadata: {
        ip: "1.2.3.4",
        password: "secret", // should be stripped
        action: "LOGIN",
      },
    });

    await vi.waitFor(() => {
      expect(mockPrismaNotification.create).toHaveBeenCalled();
    });

    const callData = mockPrismaNotification.create.mock.calls[0][0].data;
    const meta = callData.metadata;
    expect(meta).toHaveProperty("ip");
    expect(meta).toHaveProperty("action");
    expect(meta).not.toHaveProperty("password");
  });

  it("never throws even when prisma fails", async () => {
    mockPrismaNotification.create.mockRejectedValue(new Error("DB error"));

    // Should not throw
    expect(() =>
      createNotification({
        userId: "user-1",
        tenantId: "tenant-1",
        type: "SECURITY_ALERT" as never,
        title: "Test",
        body: "Body",
      }),
    ).not.toThrow();

    // Allow the rejected promise to settle silently
    await vi.waitFor(() => {
      expect(true).toBe(true);
    });
  });
});
