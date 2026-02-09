import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import {
  createRequest,
  createParams,
  parseResponse,
} from "../../helpers/request-builder";

const { mockAuth, mockFindUnique, mockFindMany } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { findUnique: mockFindUnique },
    shareAccessLog: { findMany: mockFindMany },
  },
}));

import { GET } from "@/app/api/share-links/[id]/access-logs/route";

describe("GET /api/share-links/[id]/access-logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/s1/access-logs"
    );
    const res = await GET(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("Unauthorized");
  });

  it("returns 404 when share not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue(null);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/s1/access-logs"
    );
    const res = await GET(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("Not found");
  });

  it("returns 404 when share belongs to another user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({ createdById: "other-user" });

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/s1/access-logs"
    );
    const res = await GET(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("Not found");
  });

  it("returns access logs for own share link", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      createdById: DEFAULT_SESSION.user.id,
    });

    const mockLogs = [
      {
        id: "log1",
        ip: "203.0.113.1",
        userAgent: "Mozilla/5.0",
        createdAt: new Date("2025-01-01T10:00:00Z"),
      },
      {
        id: "log2",
        ip: "198.51.100.5",
        userAgent: "curl/7.68.0",
        createdAt: new Date("2025-01-01T09:00:00Z"),
      },
    ];
    mockFindMany.mockResolvedValue(mockLogs);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/s1/access-logs"
    );
    const res = await GET(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(2);
    expect(json.items[0].ip).toBe("203.0.113.1");
    expect(json.items[1].ip).toBe("198.51.100.5");
    expect(json.nextCursor).toBeNull();
  });

  it("supports cursor-based pagination", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      createdById: DEFAULT_SESSION.user.id,
    });

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/s1/access-logs?cursor=log50"
    );

    // Return 51 items to trigger hasMore
    const logs = Array.from({ length: 51 }, (_, i) => ({
      id: `log${i}`,
      ip: "1.2.3.4",
      userAgent: "Test",
      createdAt: new Date(),
    }));
    mockFindMany.mockResolvedValue(logs);

    const res = await GET(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(50);
    expect(json.nextCursor).toBe("log49");
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "log50" },
        skip: 1,
      })
    );
  });
});
