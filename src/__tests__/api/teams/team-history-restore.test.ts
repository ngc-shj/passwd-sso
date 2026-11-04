import { describe, it, expect, vi, beforeEach } from "vitest";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockEntryFindUnique,
  mockHistoryFindUnique,
  mockTransaction,
  mockWithTeamTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockHistoryFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", async (importOriginal) => {
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  const actual = await importOriginal<typeof import("@/lib/auth/access/team-auth")>();
  return {
    requireTeamPermission: mockRequireTeamPermission,
    hasTeamPermission: actual.hasTeamPermission,
    activeTeamRole: actual.activeTeamRole,
    TeamAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: { findUnique: mockEntryFindUnique },
    teamPasswordEntryHistory: { findUnique: mockHistoryFindUnique },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));

import { POST } from "@/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/restore/route";
import { TeamAuthError } from "@/lib/auth/access/team-auth";

describe("POST /api/teams/[teamId]/passwords/[id]/history/[historyId]/restore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe(API_ERROR.NOT_FOUND);
  });

  it("returns 404 when entry belongs to different team", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ id: "p1", teamId: "other-team" });
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 404 when history not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ id: "p1", teamId: "o1" });
    mockHistoryFindUnique.mockResolvedValue(null);
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("HISTORY_NOT_FOUND");
  });

  it("returns 404 when history belongs to different entry", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ id: "p1", teamId: "o1" });
    mockHistoryFindUnique.mockResolvedValue({ id: "h1", entryId: "other-entry" });
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  const OVERVIEW = { ciphertext: "restored-overview", iv: "a".repeat(24), authTag: "b".repeat(32) };

  function setupRestoreTx(holderKeys: { userId: string }[], actor: { role: string } | null = { role: "MEMBER" }) {
    const entryUpdate = vi.fn();
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
          const sql = strings.join("?");
          if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: "0", statement_timeout: "0" }];
          // The team row FOR SHARE (lockTeamKeyVersion).
          if (/FROM teams\b/.test(sql)) return [{ team_key_version: 3, tenant_id: "t1" }];
          // In-tx FOR UPDATE row lock (TOCTOU fix): the snapshot sources from
          // this locked row, not the outside-tx read.
          return [
            {
              encrypted_blob: "cur",
              blob_iv: "curIv",
              blob_auth_tag: "curTag",
              aad_version: 1,
              team_key_version: 3,
              item_key_version: 0,
              encrypted_item_key: null,
              item_key_iv: null,
              item_key_auth_tag: null,
              item_key_id: null,
              item_key_team_key_version: 3,
              item_key_version_high_water: 0,
            },
          ];
        }),
        $executeRaw: vi.fn(),
        teamPasswordEntryHistory: {
          // The restore source, re-read under the entry lock.
          findUnique: vi.fn().mockResolvedValue({
            id: "h1",
            entryId: "p1",
            encryptedBlob: "old",
            blobIv: "oldIv",
            blobAuthTag: "oldTag",
            aadVersion: 0,
            teamKeyVersion: 2,
            itemKeyVersion: 0,
            encryptedItemKey: null,
            itemKeyIv: null,
            itemKeyAuthTag: null,
            itemKeyId: null,
            changedAt: new Date("2025-01-01"),
          }),
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn(),
        },
        teamMemberKey: { findMany: vi.fn().mockResolvedValue(holderKeys) },
        teamMember: {
          findMany: vi.fn().mockResolvedValue(holderKeys.map(({ userId }) => ({ userId, role: "ADMIN" }))),
          // The actor's membership, re-read under the team lock.
          findFirst: vi.fn().mockResolvedValue(actor),
        },
        teamPasswordEntry: { update: entryUpdate },
      }),
    );
    return entryUpdate;
  }

  function preChecksPass() {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ id: "p1", teamId: "o1", tenantId: "t1" });
    mockHistoryFindUnique.mockResolvedValue({ entryId: "p1" });
  }

  it("restores history version successfully", async () => {
    preChecksPass();
    const entryUpdate = setupRestoreTx([{ userId: "u-holder" }]);

    const req = createRequest("POST", undefined, { body: { encryptedOverview: OVERVIEW } });
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(entryUpdate.mock.calls[0][0].data).toMatchObject({
      encryptedBlob: "old",
      encryptedOverview: OVERVIEW.ciphertext,
      itemKeyId: null,
      itemKeyTeamKeyVersion: 0,
    });
  });

  it("refuses a version no active member holds the key for (409 HISTORY_KEY_UNAVAILABLE)", async () => {
    preChecksPass();
    const entryUpdate = setupRestoreTx([]);

    const req = createRequest("POST", undefined, { body: { encryptedOverview: OVERVIEW } });
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe(API_ERROR.HISTORY_KEY_UNAVAILABLE);
    expect(entryUpdate).not.toHaveBeenCalled();
  });

  it("refuses with 403 ACTOR_NOT_PERMITTED when the actor's membership is gone under the team lock", async () => {
    preChecksPass();
    const entryUpdate = setupRestoreTx([{ userId: "u-holder" }], null);

    const req = createRequest("POST", undefined, { body: { encryptedOverview: OVERVIEW } });
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe(API_ERROR.ACTOR_NOT_PERMITTED);
    expect(entryUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 when the re-encrypted overview is missing", async () => {
    preChecksPass();
    const entryUpdate = setupRestoreTx([{ userId: "u-holder" }]);

    const res = await POST(createRequest("POST"), createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(entryUpdate).not.toHaveBeenCalled();
  });
});
