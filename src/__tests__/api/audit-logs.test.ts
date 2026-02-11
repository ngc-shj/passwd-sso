import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SESSION } from "../helpers/mock-auth";
import { createRequest, parseResponse } from "../helpers/request-builder";

const { mockAuth, mockFindMany, mockEntryFindMany, mockUserFindMany } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockEntryFindMany: vi.fn().mockResolvedValue([]),
  mockUserFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: mockFindMany },
    passwordEntry: { findMany: mockEntryFindMany },
    user: { findMany: mockUserFindMany },
  },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));

import { GET } from "@/app/api/audit-logs/route";

describe("GET /api/audit-logs", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/audit-logs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns personal audit logs with pagination", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const now = new Date();
    const logs = Array.from({ length: 3 }, (_, i) => ({
      id: `log-${i}`,
      action: "ENTRY_CREATE",
      targetType: "PasswordEntry",
      targetId: `entry-${i}`,
      metadata: null,
      ip: "127.0.0.1",
      userAgent: "TestAgent",
      createdAt: now,
    }));

    mockFindMany.mockResolvedValue(logs);

    const req = createRequest("GET", "http://localhost/api/audit-logs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(3);
    expect(json.nextCursor).toBeNull();
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scope: "PERSONAL",
          OR: expect.any(Array),
        }),
        include: { user: { select: { id: true, name: true, email: true, image: true } } },
        orderBy: { createdAt: "desc" },
        take: 51, // default 50 + 1
      })
    );
  });

  it("returns nextCursor when more results exist", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    // Return limit+1 items to trigger pagination
    const logs = Array.from({ length: 4 }, (_, i) => ({
      id: `log-${i}`,
      action: "ENTRY_CREATE",
      targetType: null,
      targetId: null,
      metadata: null,
      ip: null,
      userAgent: null,
      createdAt: new Date(),
    }));

    mockFindMany.mockResolvedValue(logs);

    const req = createRequest(
      "GET",
      "http://localhost/api/audit-logs?limit=3"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(3);
    expect(json.nextCursor).toBe("log-2");
  });

  it("applies action filter", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/audit-logs?action=AUTH_LOGIN"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await GET(req as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: "AUTH_LOGIN",
        }),
      })
    );
  });

  it("applies multiple actions filter", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/audit-logs?actions=AUTH_LOGIN,ENTRY_CREATE"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await GET(req as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: { in: ["AUTH_LOGIN", "ENTRY_CREATE"] },
        }),
      })
    );
  });

  it("applies date range filter", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/audit-logs?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await GET(req as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: expect.any(Date),
            lte: expect.any(Date),
          },
        }),
      })
    );
  });

  it("ignores invalid action filter", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/audit-logs?action=INVALID_ACTION"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await GET(req as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scope: "PERSONAL",
        }),
      })
    );
  });

  it("returns 400 when actions contains invalid values", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest(
      "GET",
      "http://localhost/api/audit-logs?actions=AUTH_LOGIN,INVALID_ACTION"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details.actions).toContain("INVALID_ACTION");
  });

  it("clamps limit to max 100", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/audit-logs?limit=999"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await GET(req as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101, // max 100 + 1
      })
    );
  });

  it("passes cursor for pagination", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/audit-logs?cursor=abc123"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await GET(req as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "abc123" },
        skip: 1,
      })
    );
  });

  it("returns 400 when cursor causes Prisma error", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockRejectedValue(new Error("Record to return not found"));

    const req = createRequest(
      "GET",
      "http://localhost/api/audit-logs?cursor=invalid-cursor-id"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_CURSOR");
  });

  it("returns relatedUsers for emergency access logs", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const logs = [
      {
        id: "log-1",
        action: "EMERGENCY_VAULT_ACCESS",
        targetType: "EmergencyAccessGrant",
        targetId: "grant-1",
        metadata: { ownerId: "owner-1", granteeId: DEFAULT_SESSION.user.id },
        ip: "127.0.0.1",
        userAgent: "TestAgent",
        createdAt: new Date(),
      },
    ];

    mockFindMany.mockResolvedValue(logs);
    mockUserFindMany.mockResolvedValue([
      { id: "owner-1", name: "Owner", email: "owner@example.com", image: null },
      { id: DEFAULT_SESSION.user.id, name: "Viewer", email: "viewer@example.com", image: null },
    ]);

    const req = createRequest("GET", "http://localhost/api/audit-logs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(mockUserFindMany).toHaveBeenCalled();
    expect(json.relatedUsers["owner-1"]).toBeDefined();
    expect(json.relatedUsers[DEFAULT_SESSION.user.id]).toBeDefined();
  });
});
