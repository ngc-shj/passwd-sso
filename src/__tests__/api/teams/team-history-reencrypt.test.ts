import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";
import { createHash } from "node:crypto";

const {
  mockAuth, mockRequireTeamMember, mockEntryFindUnique,
  mockHistoryFindUnique, mockHistoryUpdate,
  mockWithTeamTenantRls, mockLogAudit, mockRateLimiterCheck,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamMember: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockHistoryFindUnique: vi.fn(),
  mockHistoryUpdate: vi.fn(),
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/team-auth", () => {
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  return {
    requireTeamMember: mockRequireTeamMember,
    TeamAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: { findUnique: mockEntryFindUnique },
    teamPasswordEntryHistory: {
      findUnique: mockHistoryFindUnique,
      updateMany: mockHistoryUpdate,
    },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));

import { GET, PATCH } from "@/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/route";
import { TeamAuthError } from "@/lib/auth/team-auth";

const VALID_IV = "a".repeat(24);
const VALID_AUTH_TAG = "b".repeat(32);
const OLD_BLOB = "old-encrypted-data";
const OLD_BLOB_HASH = createHash("sha256").update(OLD_BLOB).digest("hex");

const HISTORY_ENTRY = {
  id: "h1",
  entryId: "p1",
  encryptedBlob: OLD_BLOB,
  blobIv: VALID_IV,
  blobAuthTag: VALID_AUTH_TAG,
  teamKeyVersion: 1,
  itemKeyVersion: null,
  aadVersion: 0,
  changedAt: new Date("2025-01-15T10:00:00Z"),
};

describe("GET /api/teams/[teamId]/passwords/[id]/history/[historyId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "t1", id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when not team member", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "t1", id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({});
    mockEntryFindUnique.mockResolvedValue(null);
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "t1", id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns individual team history entry", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({});
    mockEntryFindUnique.mockResolvedValue({ teamId: "t1", entryType: "LOGIN" });
    mockHistoryFindUnique.mockResolvedValue(HISTORY_ENTRY);

    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "t1", id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.id).toBe("h1");
    expect(json.encryptedBlob).toBe(OLD_BLOB);
    expect(json.teamKeyVersion).toBe(1);
  });
});

describe("PATCH /api/teams/[teamId]/passwords/[id]/history/[historyId]", () => {
  beforeEach(() => vi.clearAllMocks());

  function makePatchRequest(body: Record<string, unknown>) {
    return createRequest("PATCH", "http://localhost/api/teams/t1/passwords/p1/history/h1", { body });
  }

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PATCH(makePatchRequest({}), createParams({ teamId: "t1", id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRateLimiterCheck.mockResolvedValueOnce({ allowed: false });
    const res = await PATCH(makePatchRequest({}), createParams({ teamId: "t1", id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
  });

  it("returns 403 when not team member", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await PATCH(
      makePatchRequest({ encryptedBlob: "x", blobIv: VALID_IV, blobAuthTag: VALID_AUTH_TAG, teamKeyVersion: 2, oldBlobHash: "h" }),
      createParams({ teamId: "t1", id: "p1", historyId: "h1" }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 400 for missing fields", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({});
    const res = await PATCH(
      makePatchRequest({ encryptedBlob: "data" }),
      createParams({ teamId: "t1", id: "p1", historyId: "h1" }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 404 when history entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({});
    mockEntryFindUnique.mockResolvedValue({ teamId: "t1" });
    mockHistoryFindUnique.mockResolvedValue(null);
    const res = await PATCH(
      makePatchRequest({
        encryptedBlob: "new-cipher",
        blobIv: VALID_IV,
        blobAuthTag: VALID_AUTH_TAG,
        teamKeyVersion: 2,
        oldBlobHash: OLD_BLOB_HASH,
      }),
      createParams({ teamId: "t1", id: "p1", historyId: "h1" }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 400 for key version not newer", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({});
    mockEntryFindUnique.mockResolvedValue({ teamId: "t1" });
    mockHistoryFindUnique.mockResolvedValue(HISTORY_ENTRY);

    const res = await PATCH(
      makePatchRequest({
        encryptedBlob: "new-cipher",
        blobIv: VALID_IV,
        blobAuthTag: VALID_AUTH_TAG,
        teamKeyVersion: 1,
        oldBlobHash: OLD_BLOB_HASH,
      }),
      createParams({ teamId: "t1", id: "p1", historyId: "h1" }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("KEY_VERSION_NOT_NEWER");
  });

  it("returns 409 for blob hash mismatch", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({});
    mockEntryFindUnique.mockResolvedValue({ teamId: "t1" });
    mockHistoryFindUnique.mockResolvedValue(HISTORY_ENTRY);

    const res = await PATCH(
      makePatchRequest({
        encryptedBlob: "new-cipher",
        blobIv: VALID_IV,
        blobAuthTag: VALID_AUTH_TAG,
        teamKeyVersion: 2,
        oldBlobHash: "c".repeat(64),
      }),
      createParams({ teamId: "t1", id: "p1", historyId: "h1" }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("BLOB_HASH_MISMATCH");
  });

  it("successfully re-encrypts with teamKeyVersion upgrade", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({});
    mockEntryFindUnique.mockResolvedValue({ teamId: "t1" });
    mockHistoryFindUnique.mockResolvedValue(HISTORY_ENTRY);
    mockHistoryUpdate.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      makePatchRequest({
        encryptedBlob: "new-cipher",
        blobIv: VALID_IV,
        blobAuthTag: VALID_AUTH_TAG,
        teamKeyVersion: 2,
        oldBlobHash: OLD_BLOB_HASH,
      }),
      createParams({ teamId: "t1", id: "p1", historyId: "h1" }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.success).toBe(true);

    expect(mockHistoryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "h1", teamKeyVersion: 1 },
        data: expect.objectContaining({
          encryptedBlob: "new-cipher",
          teamKeyVersion: 2,
        }),
      }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_HISTORY_REENCRYPT",
        metadata: expect.objectContaining({
          oldTeamKeyVersion: 1,
          newTeamKeyVersion: 2,
        }),
      }),
    );
  });

  it("accepts dual key version upgrade (itemKeyVersion newer)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({});
    mockEntryFindUnique.mockResolvedValue({ teamId: "t1" });
    mockHistoryFindUnique.mockResolvedValue({ ...HISTORY_ENTRY, itemKeyVersion: 1 });
    mockHistoryUpdate.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      makePatchRequest({
        encryptedBlob: "new-cipher",
        blobIv: VALID_IV,
        blobAuthTag: VALID_AUTH_TAG,
        teamKeyVersion: 1, // same team key version
        itemKeyVersion: 2, // but newer item key version
        oldBlobHash: OLD_BLOB_HASH,
      }),
      createParams({ teamId: "t1", id: "p1", historyId: "h1" }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
  });
});
