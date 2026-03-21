import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamPasswordEntry, mockPrismaTransaction, mockRequireTeamPermission, TeamAuthError, mockWithTeamTenantRls, mockLogAudit, mockLogAuditBatch } = vi.hoisted(() => {
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
    mockPrismaTransaction: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
    mockLogAudit: vi.fn(),
    mockLogAuditBatch: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: mockPrismaTeamPasswordEntry,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: mockPrismaTransaction,
  },
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
  logAuditBatch: mockLogAuditBatch,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
}));

import { POST } from "./route";
import { TEAM_ROLE, AUDIT_SCOPE } from "@/lib/constants";

const TEAM_ID = "team-123";
const BASE_URL = `http://localhost:3000/api/teams/${TEAM_ID}/passwords/bulk-trash`;

describe("POST /api/teams/[teamId]/passwords/bulk-trash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([{ id: "00000000-0000-4000-a000-000000000001" }, { id: "00000000-0000-4000-a000-000000000002" }]);
    mockPrismaTeamPasswordEntry.updateMany.mockResolvedValue({ count: 2 });
    // Default: $transaction invokes callback with a tx object that delegates to top-level mocks
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        teamPasswordEntry: {
          findMany: mockPrismaTeamPasswordEntry.findMany,
          updateMany: mockPrismaTeamPasswordEntry.updateMany,
        },
      })
    );
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
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-a000-${String(i + 1).padStart(12, "0")}`);
    const res = await POST(
      createRequest("POST", BASE_URL, { body: { ids } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("soft-deletes matching entries and returns moved count", async () => {
    const id1 = "00000000-0000-4000-a000-000000000001";
    const id2 = "00000000-0000-4000-a000-000000000002";
    const res = await POST(
      createRequest("POST", BASE_URL, { body: { ids: [id1, id2, id1] } }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.movedCount).toBe(2);
    expect(mockPrismaTeamPasswordEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: TEAM_ID,
          id: { in: [id1, id2] },
          deletedAt: null,
        }),
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("logs audit with scope=TEAM and teamId", async () => {
    const id1 = "00000000-0000-4000-a000-000000000001";
    const id2 = "00000000-0000-4000-a000-000000000002";
    await POST(
      createRequest("POST", BASE_URL, { body: { ids: [id1, id2] } }),
      createParams({ teamId: TEAM_ID }),
    );

    // Parent log via logAudit
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: AUDIT_SCOPE.TEAM,
        action: "ENTRY_BULK_TRASH",
        teamId: TEAM_ID,
        userId: "test-user-id",
        metadata: expect.objectContaining({
          bulk: true,
          requestedCount: 2,
          movedCount: 2,
          entryIds: [id1, id2],
        }),
      }),
    );

    // Per-entry logs batched via logAuditBatch
    expect(mockLogAuditBatch).toHaveBeenCalledTimes(1);
    expect(mockLogAuditBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          scope: AUDIT_SCOPE.TEAM,
          action: "ENTRY_TRASH",
          teamId: TEAM_ID,
          targetId: id1,
          metadata: expect.objectContaining({
            source: "bulk-trash",
            parentAction: "ENTRY_BULK_TRASH",
          }),
        }),
        expect.objectContaining({
          scope: AUDIT_SCOPE.TEAM,
          action: "ENTRY_TRASH",
          teamId: TEAM_ID,
          targetId: id2,
          metadata: expect.objectContaining({
            source: "bulk-trash",
            parentAction: "ENTRY_BULK_TRASH",
          }),
        }),
      ]),
    );
  });
});
