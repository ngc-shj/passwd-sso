import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockFindMany,
  mockDeleteMany,
  mockTransaction,
  mockLogAudit,
  mockWithTeamTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockFindMany: vi.fn(),
  mockDeleteMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => {
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  return {
    requireTeamPermission: mockRequireTeamPermission,
    TeamAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));

import { POST } from "@/app/api/teams/[teamId]/passwords/empty-trash/route";
import { TeamAuthError } from "@/lib/team-auth";

const TEAM_ID = "team-1";

describe("POST /api/teams/[teamId]/passwords/empty-trash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        teamPasswordEntry: {
          findMany: mockFindMany,
          deleteMany: mockDeleteMany,
        },
      })
    );
    mockFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    mockDeleteMany.mockResolvedValue({ count: 2 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: TEAM_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking PASSWORD_DELETE permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: TEAM_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("re-throws non-TeamAuthError", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    const req = createRequest("POST");
    await expect(
      POST(req, createParams({ teamId: TEAM_ID }))
    ).rejects.toThrow("unexpected");
  });

  it("empties trash and writes summary + per-entry audit logs", async () => {
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: TEAM_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deletedCount).toBe(2);

    expect(mockDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: TEAM_ID,
          id: { in: ["p1", "p2"] },
          deletedAt: { not: null },
        }),
      })
    );

    // findMany + deleteMany run inside a single withTeamTenantRls + $transaction
    expect(mockWithTeamTenantRls).toHaveBeenCalledTimes(1);
    expect(mockTransaction).toHaveBeenCalledTimes(1);

    // Summary log + 2 per-entry logs = 3 calls
    expect(mockLogAudit).toHaveBeenCalledTimes(3);
    expect(mockLogAudit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "ENTRY_EMPTY_TRASH",
        teamId: TEAM_ID,
        metadata: expect.objectContaining({
          operation: "empty-trash",
          deletedCount: 2,
          entryIds: ["p1", "p2"],
        }),
      })
    );
    expect(mockLogAudit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "ENTRY_PERMANENT_DELETE",
        teamId: TEAM_ID,
        targetId: "p1",
        metadata: expect.objectContaining({
          source: "empty-trash",
          parentAction: "ENTRY_EMPTY_TRASH",
        }),
      })
    );
  });

  it("returns deletedCount=0 when trash is empty", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    mockDeleteMany.mockResolvedValueOnce({ count: 0 });

    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: TEAM_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deletedCount).toBe(0);
    // Only summary log, no per-entry logs
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_EMPTY_TRASH",
        metadata: expect.objectContaining({
          deletedCount: 0,
          entryIds: [],
        }),
      })
    );
  });

  it("propagates db errors", async () => {
    mockTransaction.mockRejectedValueOnce(new Error("db down"));
    const req = createRequest("POST");
    await expect(
      POST(req, createParams({ teamId: TEAM_ID }))
    ).rejects.toThrow("db down");
  });
});
