import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaNotification, mockWithUserTenantRls } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockPrismaNotification: {
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    mockWithUserTenantRls: vi.fn(
      async (_userId: string, fn: () => unknown) => fn(),
    ),
  }));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { notification: mockPrismaNotification },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PATCH, DELETE } from "./route";

const now = new Date("2026-03-01T00:00:00Z");

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: "n1",
    userId: "user-1",
    tenantId: "tenant-1",
    type: "SECURITY_ALERT",
    title: "Test notification",
    body: "Test body",
    metadata: null,
    isRead: false,
    createdAt: now,
    ...overrides,
  };
}

describe("PATCH /api/notifications/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PATCH(
      createRequest("PATCH", "http://localhost:3000/api/notifications/n1"),
      createParams({ id: "n1" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when notification not found", async () => {
    mockPrismaNotification.findFirst.mockResolvedValue(null);
    const res = await PATCH(
      createRequest("PATCH", "http://localhost:3000/api/notifications/n1"),
      createParams({ id: "n1" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when notification belongs to another user (filtered by userId)", async () => {
    // findFirst with userId filter returns null for another user's notification
    mockPrismaNotification.findFirst.mockResolvedValue(null);
    const res = await PATCH(
      createRequest("PATCH", "http://localhost:3000/api/notifications/n1"),
      createParams({ id: "n1" }),
    );
    expect(res.status).toBe(404);
  });

  it("marks notification as read", async () => {
    mockPrismaNotification.findFirst.mockResolvedValue(makeNotification());
    mockPrismaNotification.update.mockResolvedValue(
      makeNotification({ isRead: true }),
    );

    const res = await PATCH(
      createRequest("PATCH", "http://localhost:3000/api/notifications/n1"),
      createParams({ id: "n1" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.id).toBe("n1");
    expect(json.isRead).toBe(true);

    expect(mockPrismaNotification.update).toHaveBeenCalledWith({
      where: { id: "n1" },
      data: { isRead: true },
    });
  });
});

describe("DELETE /api/notifications/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/notifications/n1"),
      createParams({ id: "n1" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when notification not found", async () => {
    mockPrismaNotification.findFirst.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/notifications/n1"),
      createParams({ id: "n1" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when notification belongs to another user (filtered by userId)", async () => {
    mockPrismaNotification.findFirst.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/notifications/n1"),
      createParams({ id: "n1" }),
    );
    expect(res.status).toBe(404);
  });

  it("deletes the notification", async () => {
    mockPrismaNotification.findFirst.mockResolvedValue(makeNotification());
    mockPrismaNotification.delete.mockResolvedValue(makeNotification());

    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/notifications/n1"),
      createParams({ id: "n1" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);

    expect(mockPrismaNotification.delete).toHaveBeenCalledWith({
      where: { id: "n1" },
    });
  });
});
