import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const { mockAuth, mockCount, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCount: vi.fn(),
  mockWithUserTenantRls: vi.fn(
    async (_userId: string, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: { count: mockCount },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { GET } from "@/app/api/notifications/count/route";

describe("GET /api/notifications/count", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/notifications/count");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns unread count", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCount.mockResolvedValue(7);

    const req = createRequest("GET", "http://localhost/api/notifications/count");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.unreadCount).toBe(7);
    expect(mockCount).toHaveBeenCalledWith({
      where: { userId: DEFAULT_SESSION.user.id, isRead: false },
    });
  });

  it("returns 0 when no unread notifications", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCount.mockResolvedValue(0);

    const req = createRequest("GET", "http://localhost/api/notifications/count");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.unreadCount).toBe(0);
  });
});
