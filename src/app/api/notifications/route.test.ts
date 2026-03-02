import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaNotification, mockWithUserTenantRls } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockPrismaNotification: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
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
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { GET, PATCH } from "./route";

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

describe("GET /api/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/notifications"),
    );
    expect(res.status).toBe(401);
  });

  it("returns paginated notifications", async () => {
    const items = [
      makeNotification({ id: "n1" }),
      makeNotification({ id: "n2" }),
      makeNotification({ id: "n3" }),
    ];
    mockPrismaNotification.findMany.mockResolvedValue(items);

    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/notifications", {
        searchParams: { limit: "2" },
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    // 3 items returned but limit=2, so hasMore=true
    expect(json.items).toHaveLength(2);
    expect(json.nextCursor).toBe("n2");
  });

  it("returns all items when no more pages", async () => {
    const items = [makeNotification({ id: "n1" })];
    mockPrismaNotification.findMany.mockResolvedValue(items);

    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/notifications"),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.nextCursor).toBeNull();
  });

  it("filters by unreadOnly", async () => {
    mockPrismaNotification.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", "http://localhost:3000/api/notifications", {
        searchParams: { unreadOnly: "true" },
      }),
    );

    expect(mockPrismaNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isRead: false }),
      }),
    );
  });

  it("passes cursor to prisma query", async () => {
    mockPrismaNotification.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", "http://localhost:3000/api/notifications", {
        searchParams: { cursor: "cursor-id" },
      }),
    );

    expect(mockPrismaNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "cursor-id" },
        skip: 1,
      }),
    );
  });

  it("returns 400 for invalid cursor", async () => {
    mockPrismaNotification.findMany.mockRejectedValue(
      new Error("Invalid cursor"),
    );

    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/notifications", {
        searchParams: { cursor: "bad-cursor" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("clamps limit to max 50", async () => {
    mockPrismaNotification.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", "http://localhost:3000/api/notifications", {
        searchParams: { limit: "200" },
      }),
    );

    expect(mockPrismaNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 51, // 50 + 1
      }),
    );
  });

  it("does not expose userId or tenantId in response", async () => {
    mockPrismaNotification.findMany.mockResolvedValue([
      makeNotification(),
    ]);

    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/notifications"),
    );
    const json = await res.json();

    expect(json.items[0]).not.toHaveProperty("userId");
    expect(json.items[0]).not.toHaveProperty("tenantId");
  });
});

describe("PATCH /api/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PATCH(
      createRequest("PATCH", "http://localhost:3000/api/notifications"),
    );
    expect(res.status).toBe(401);
  });

  it("marks all unread notifications as read", async () => {
    mockPrismaNotification.updateMany.mockResolvedValue({ count: 5 });

    const res = await PATCH(
      createRequest("PATCH", "http://localhost:3000/api/notifications"),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.updatedCount).toBe(5);

    expect(mockPrismaNotification.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", isRead: false },
      data: { isRead: true },
    });
  });
});
