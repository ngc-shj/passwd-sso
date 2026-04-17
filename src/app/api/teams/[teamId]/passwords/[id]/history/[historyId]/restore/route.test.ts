import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockEntryFindUnique,
  mockHistoryFindUnique,
  mockTransaction,
  mockLogAudit,
  mockWithTeamTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockHistoryFindUnique: vi.fn(),
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
  return { requireTeamPermission: mockRequireTeamPermission, TeamAuthError };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: { findUnique: mockEntryFindUnique },
    teamPasswordEntryHistory: { findUnique: mockHistoryFindUnique },
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

import { POST } from "./route";
import { TeamAuthError } from "@/lib/team-auth";

const TEAM_ID = "team-1";
const ENTRY_ID = "entry-1";
const HISTORY_ID = "hist-1";

function makeParams() {
  return createParams({ teamId: TEAM_ID, id: ENTRY_ID, historyId: HISTORY_ID });
}

const baseEntry = {
  teamId: TEAM_ID,
  tenantId: "tenant-1",
  encryptedBlob: "cur",
  blobIv: "curIv",
  blobAuthTag: "curTag",
  aadVersion: 1,
  teamKeyVersion: 3,
};

const baseHistory = {
  id: HISTORY_ID,
  entryId: ENTRY_ID,
  encryptedBlob: "old",
  blobIv: "oldIv",
  blobAuthTag: "oldTag",
  aadVersion: 0,
  teamKeyVersion: 2,
  changedAt: new Date("2025-01-01"),
};

describe("POST /api/teams/[teamId]/passwords/[id]/history/[historyId]/restore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST"), makeParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking team permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await POST(createRequest("POST"), makeParams());
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await POST(createRequest("POST"), makeParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when entry belongs to different team", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ ...baseEntry, teamId: "other-team" });
    const res = await POST(createRequest("POST"), makeParams());
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 404 when history not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(baseEntry);
    mockHistoryFindUnique.mockResolvedValue(null);
    const res = await POST(createRequest("POST"), makeParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("HISTORY_NOT_FOUND");
  });

  it("returns 404 when history belongs to different entry", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(baseEntry);
    mockHistoryFindUnique.mockResolvedValue({ ...baseHistory, entryId: "other-entry" });
    const res = await POST(createRequest("POST"), makeParams());
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("restores history version: creates snapshot + updates entry in a transaction", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(baseEntry);
    mockHistoryFindUnique.mockResolvedValue(baseHistory);

    const txHistoryCreate = vi.fn();
    const txHistoryFindMany = vi.fn().mockResolvedValue([]);
    const txHistoryDeleteMany = vi.fn();
    const txEntryUpdate = vi.fn();

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        teamPasswordEntryHistory: {
          create: txHistoryCreate,
          findMany: txHistoryFindMany,
          deleteMany: txHistoryDeleteMany,
        },
        teamPasswordEntry: { update: txEntryUpdate },
      });
    });

    const res = await POST(createRequest("POST"), makeParams());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalled();
    expect(txHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryId: ENTRY_ID,
          encryptedBlob: baseEntry.encryptedBlob,
        }),
      }),
    );
    expect(txEntryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ENTRY_ID },
        data: expect.objectContaining({
          encryptedBlob: baseHistory.encryptedBlob,
          teamKeyVersion: baseHistory.teamKeyVersion,
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_HISTORY_RESTORE",
        targetId: ENTRY_ID,
        metadata: expect.objectContaining({ historyId: HISTORY_ID }),
      }),
    );
  });
});
