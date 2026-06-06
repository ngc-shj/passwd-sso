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
vi.mock("@/lib/auth/access/team-auth", () => {
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  return { requireTeamPermission: mockRequireTeamPermission, TeamAuthError };
});
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mockTransaction } }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  logAuditBulkAsync: vi.fn(async (entries: unknown[]) => {
    for (const e of entries) await mockLogAudit(e);
  }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/tenant-context", () => ({ withTeamTenantRls: mockWithTeamTenantRls }));
vi.mock("@/lib/blob-store/cleanup", () => ({
  collectEntryAttachmentRefs: vi.fn(async () => []),
  deleteAttachmentBlobs: vi.fn(async () => {}),
}));

import { POST } from "@/app/api/teams/[teamId]/passwords/bulk-purge/route";
import { TeamAuthError } from "@/lib/auth/access/team-auth";

const TEAM_ID = "team-1";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("POST /api/teams/[teamId]/passwords/bulk-purge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ teamPasswordEntry: { findMany: mockFindMany, deleteMany: mockDeleteMany } }),
    );
    mockFindMany.mockResolvedValue([{ id: P1 }, { id: P2 }]);
    mockDeleteMany.mockResolvedValue({ count: 2 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/test", { body: { ids: [P1] } }), createParams({ teamId: TEAM_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking PASSWORD_DELETE permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await POST(createRequest("POST", "http://localhost:3000/api/test", { body: { ids: [P1] } }), createParams({ teamId: TEAM_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("permanently deletes selected trashed entries + writes audit logs", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/test", { body: { ids: [P1, P2] } }), createParams({ teamId: TEAM_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.deletedCount).toBe(2);

    expect(mockDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: TEAM_ID,
          id: { in: [P1, P2] },
          deletedAt: { not: null },
        }),
      }),
    );

    expect(mockLogAudit).toHaveBeenCalledTimes(3);
    expect(mockLogAudit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "ENTRY_BULK_PURGE",
        teamId: TEAM_ID,
        metadata: expect.objectContaining({ operation: "bulk-purge", deletedCount: 2 }),
      }),
    );
    expect(mockLogAudit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "ENTRY_PERMANENT_DELETE",
        teamId: TEAM_ID,
        targetId: P1,
        metadata: expect.objectContaining({ parentAction: "ENTRY_BULK_PURGE" }),
      }),
    );
  });

  it("re-throws non-TeamAuthError", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      POST(createRequest("POST", "http://localhost:3000/api/test", { body: { ids: [P1] } }), createParams({ teamId: TEAM_ID })),
    ).rejects.toThrow("unexpected");
  });
});
