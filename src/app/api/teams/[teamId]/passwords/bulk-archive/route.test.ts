import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamPasswordEntry, mockRequireTeamPermission, TeamAuthError, mockWithTeamTenantRls, mockLogAudit } = vi.hoisted(() => {
  class _TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockPrismaTeamPasswordEntry: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
    mockLogAudit: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { teamPasswordEntry: mockPrismaTeamPasswordEntry, auditLog: { create: vi.fn().mockResolvedValue({}) } },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
}));

import { POST } from "./route";
import { TEAM_ROLE, AUDIT_SCOPE } from "@/lib/constants";

const TEAM_ID = "team-123";
const BASE_URL = `http://localhost:3000/api/teams/${TEAM_ID}/passwords/bulk-archive`;

describe("POST /api/teams/[teamId]/passwords/bulk-archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    mockPrismaTeamPasswordEntry.updateMany.mockResolvedValue({ count: 2 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", BASE_URL, { body: { ids: ["p1"] } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns TeamAuthError status when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", BASE_URL, { body: { ids: ["p1"] } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("rethrows non-TeamAuthError", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      POST(
        createRequest("POST", BASE_URL, { body: { ids: ["p1"] } }),
        createParams({ teamId: TEAM_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new (await import("next/server")).NextRequest(BASE_URL, {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, createParams({ teamId: TEAM_ID }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty ids array", async () => {
    const res = await POST(
      createRequest("POST", BASE_URL, { body: { ids: [] } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when ids exceed max limit", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const res = await POST(
      createRequest("POST", BASE_URL, { body: { ids } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("archives matching entries and returns archived count", async () => {
    const res = await POST(
      createRequest("POST", BASE_URL, { body: { ids: ["p1", "p2", "p1"] } }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.operation).toBe("archive");
    expect(json.processedCount).toBe(2);
    expect(json.archivedCount).toBe(2);
    expect(mockPrismaTeamPasswordEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: TEAM_ID,
          id: { in: ["p1", "p2"] },
          deletedAt: null,
          isArchived: false,
        }),
        data: expect.objectContaining({
          isArchived: true,
        }),
      }),
    );
  });

  it("logs audit with scope=TEAM and teamId", async () => {
    await POST(
      createRequest("POST", BASE_URL, { body: { ids: ["p1", "p2"] } }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: AUDIT_SCOPE.TEAM,
        action: "ENTRY_BULK_ARCHIVE",
        teamId: TEAM_ID,
        userId: "test-user-id",
        metadata: expect.objectContaining({
          bulk: true,
          operation: "archive",
          requestedCount: 2,
          processedCount: 2,
          archivedCount: 2,
          entryIds: ["p1", "p2"],
        }),
      }),
    );

    // Per-entry audit logs
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: AUDIT_SCOPE.TEAM,
        action: "ENTRY_UPDATE",
        teamId: TEAM_ID,
        targetId: "p1",
        metadata: expect.objectContaining({
          source: "bulk-archive",
          parentAction: "ENTRY_BULK_ARCHIVE",
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: AUDIT_SCOPE.TEAM,
        action: "ENTRY_UPDATE",
        teamId: TEAM_ID,
        targetId: "p2",
        metadata: expect.objectContaining({
          source: "bulk-archive",
          parentAction: "ENTRY_BULK_ARCHIVE",
        }),
      }),
    );
  });

  it("unarchives matching entries with operation=unarchive", async () => {
    const res = await POST(
      createRequest("POST", BASE_URL, { body: { ids: ["p1", "p2"], operation: "unarchive" } }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.operation).toBe("unarchive");
    expect(json.unarchivedCount).toBe(2);
    expect(mockPrismaTeamPasswordEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isArchived: true,
        }),
        data: expect.objectContaining({
          isArchived: false,
        }),
      }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: AUDIT_SCOPE.TEAM,
        action: "ENTRY_BULK_UNARCHIVE",
        teamId: TEAM_ID,
        metadata: expect.objectContaining({
          operation: "unarchive",
          unarchivedCount: 2,
          archivedCount: 0,
        }),
      }),
    );
  });
});
