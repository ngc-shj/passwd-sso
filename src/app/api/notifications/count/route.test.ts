import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPrismaNotification, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaNotification: { count: vi.fn() },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
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

import { GET } from "./route";

describe("GET /api/notifications/count", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaNotification.count.mockResolvedValue(5);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await (GET as () => Promise<Response>)();
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns unread count", async () => {
    const res = await (GET as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.unreadCount).toBe(5);
    expect(mockPrismaNotification.count).toHaveBeenCalledWith({
      where: { userId: "user-1", isRead: false },
    });
  });

  it("returns 0 when there are no unread notifications", async () => {
    mockPrismaNotification.count.mockResolvedValue(0);
    const res = await (GET as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.unreadCount).toBe(0);
  });
});
