import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockFindMany,
  mockUpdateMany,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockWithUserTenantRls: vi.fn(
    async (_userId: string, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      findMany: mockFindMany,
      updateMany: mockUpdateMany,
    },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { GET, PATCH } from "@/app/api/notifications/route";

describe("GET /api/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/notifications");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns notifications with pagination", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const now = new Date();
    const items = Array.from({ length: 3 }, (_, i) => ({
      id: `n-${i}`,
      type: "SECURITY_ALERT",
      title: `Title ${i}`,
      body: `Body ${i}`,
      metadata: null,
      isRead: false,
      createdAt: now,
    }));
    mockFindMany.mockResolvedValue(items);

    const req = createRequest("GET", "http://localhost/api/notifications");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(3);
    expect(json.nextCursor).toBeNull();
  });

  it("returns nextCursor when more items exist", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    // limit defaults to 20, so 21 items triggers hasMore
    const items = Array.from({ length: 21 }, (_, i) => ({
      id: `n-${i}`,
      type: "SECURITY_ALERT",
      title: `Title ${i}`,
      body: `Body ${i}`,
      metadata: null,
      isRead: false,
      createdAt: new Date(),
    }));
    mockFindMany.mockResolvedValue(items);

    const req = createRequest("GET", "http://localhost/api/notifications");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(20);
    expect(json.nextCursor).toBe("n-19");
  });

  it("passes unreadOnly filter when specified", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest("GET", "http://localhost/api/notifications", {
      searchParams: { unreadOnly: "true" },
    });
    await GET(req);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: DEFAULT_SESSION.user.id,
          isRead: false,
        }),
      }),
    );
  });

  it("respects limit parameter (max 50)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest("GET", "http://localhost/api/notifications", {
      searchParams: { limit: "100" },
    });
    await GET(req);

    // limit is clamped to 50, so take = 51
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 51 }),
    );
  });

  it("passes cursor for pagination", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest("GET", "http://localhost/api/notifications", {
      searchParams: { cursor: "cursor-id" },
    });
    await GET(req);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "cursor-id" },
        skip: 1,
      }),
    );
  });

  it("returns 400 for invalid cursor", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockRejectedValue(new Error("Invalid cursor"));

    const req = createRequest("GET", "http://localhost/api/notifications", {
      searchParams: { cursor: "bad-cursor" },
    });
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_CURSOR");
  });
});

describe("PATCH /api/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("PATCH", "http://localhost/api/notifications");
    const res = await PATCH(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("marks all unread notifications as read", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockUpdateMany.mockResolvedValue({ count: 5 });

    const req = createRequest("PATCH", "http://localhost/api/notifications");
    const res = await PATCH(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.updatedCount).toBe(5);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { userId: DEFAULT_SESSION.user.id, isRead: false },
      data: { isRead: true },
    });
  });
});
