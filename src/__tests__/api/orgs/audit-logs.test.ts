import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const { mockAuth, mockFindMany, mockRequireOrgPermission, OrgAuthError } =
  vi.hoisted(() => {
    class OrgAuthError extends Error {
      status: number;
      constructor(message: string, status: number) {
        super(message);
        this.name = "OrgAuthError";
        this.status = status;
      }
    }
    return {
      mockAuth: vi.fn(),
      mockFindMany: vi.fn(),
      mockRequireOrgPermission: vi.fn(),
      OrgAuthError,
    };
  });

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: mockFindMany },
  },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError,
}));

import { GET } from "@/app/api/orgs/[orgId]/audit-logs/route";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE, ORG_ROLE } from "@/lib/constants";

const ORG_ID = "org-1";

describe("GET /api/orgs/[orgId]/audit-logs", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest(
      "GET",
      `http://localhost/api/orgs/${ORG_ID}/audit-logs`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any, createParams({ orgId: ORG_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when user lacks org:update permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockRejectedValue(
      new OrgAuthError("FORBIDDEN", 403)
    );

    const req = createRequest(
      "GET",
      `http://localhost/api/orgs/${ORG_ID}/audit-logs`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any, createParams({ orgId: ORG_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns org audit logs for ADMIN/OWNER", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.ADMIN });

    const now = new Date();
    const logs = [
      {
        id: "log-1",
        action: AUDIT_ACTION.ENTRY_CREATE,
        targetType: AUDIT_TARGET_TYPE.ORG_PASSWORD_ENTRY,
        targetId: "entry-1",
        metadata: null,
        ip: "10.0.0.1",
        userAgent: "Test",
        createdAt: now,
        user: { id: "user-1", name: "Alice", image: null },
      },
    ];

    mockFindMany.mockResolvedValue(logs);

    const req = createRequest(
      "GET",
      `http://localhost/api/orgs/${ORG_ID}/audit-logs`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any, createParams({ orgId: ORG_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.items[0].user).toEqual({
      id: "user-1",
      name: "Alice",
      image: null,
    });
    expect(json.nextCursor).toBeNull();

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orgId: ORG_ID,
          scope: AUDIT_SCOPE.ORG,
        },
        include: {
          user: { select: { id: true, name: true, image: true } },
        },
        orderBy: { createdAt: "desc" },
      })
    );
  });

  it("applies action filter", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.OWNER });
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      `http://localhost/api/orgs/${ORG_ID}/audit-logs?action=${AUDIT_ACTION.ORG_MEMBER_INVITE}`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await GET(req as any, createParams({ orgId: ORG_ID }));

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: AUDIT_ACTION.ORG_MEMBER_INVITE,
        }),
      })
    );
  });

  it("applies actions filter with multiple values", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.OWNER });
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      `http://localhost/api/orgs/${ORG_ID}/audit-logs?actions=${AUDIT_ACTION.ENTRY_CREATE},${AUDIT_ACTION.ENTRY_UPDATE}`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await GET(req as any, createParams({ orgId: ORG_ID }));

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: { in: [AUDIT_ACTION.ENTRY_CREATE, AUDIT_ACTION.ENTRY_UPDATE] },
        }),
      })
    );
  });

  it("returns 400 for invalid actions filter", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.OWNER });

    const req = createRequest(
      "GET",
      `http://localhost/api/orgs/${ORG_ID}/audit-logs?actions=${AUDIT_ACTION.ENTRY_CREATE},NOPE`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any, createParams({ orgId: ORG_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details).toEqual({ actions: ["NOPE"] });
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("applies date range filter", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.ADMIN });
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      `http://localhost/api/orgs/${ORG_ID}/audit-logs?from=2025-01-01T00:00:00Z&to=2025-06-30T23:59:59Z`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await GET(req as any, createParams({ orgId: ORG_ID }));

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

  it("supports cursor-based pagination", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.ADMIN });

    // Return limit+1 items to trigger hasMore
    const logs = Array.from({ length: 6 }, (_, i) => ({
      id: `log-${i}`,
      action: AUDIT_ACTION.ENTRY_UPDATE,
      targetType: null,
      targetId: null,
      metadata: null,
      ip: null,
      userAgent: null,
      createdAt: new Date(),
      user: { id: "user-1", name: "Alice", image: null },
    }));

    mockFindMany.mockResolvedValue(logs);

    const req = createRequest(
      "GET",
      `http://localhost/api/orgs/${ORG_ID}/audit-logs?limit=5`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any, createParams({ orgId: ORG_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(5);
    expect(json.nextCursor).toBe("log-4");
  });

  it("returns 400 for invalid cursor", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.ADMIN });
    mockFindMany.mockRejectedValue(new Error("Invalid cursor"));

    const req = createRequest(
      "GET",
      `http://localhost/api/orgs/${ORG_ID}/audit-logs?cursor=bad-cursor`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any, createParams({ orgId: ORG_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_CURSOR");
  });

  it("re-throws non-OrgAuthError", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockRejectedValue(new Error("Unexpected"));

    const req = createRequest(
      "GET",
      `http://localhost/api/orgs/${ORG_ID}/audit-logs`
    );

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      GET(req as any, createParams({ orgId: ORG_ID }))
    ).rejects.toThrow("Unexpected");
  });
});
