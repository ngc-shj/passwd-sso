import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireOrgPermission,
  mockEntryFindUnique,
  mockHistoryFindUnique,
  mockTransaction,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireOrgPermission: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockHistoryFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => {
  class OrgAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireOrgPermission: mockRequireOrgPermission,
    OrgAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgPasswordEntry: { findUnique: mockEntryFindUnique },
    orgPasswordEntryHistory: { findUnique: mockHistoryFindUnique },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));

import { POST } from "@/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/restore/route";
import { OrgAuthError } from "@/lib/team-auth";

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
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("FORBIDDEN", 403));
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when entry belongs to different org", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ id: "p1", orgId: "other-org" });
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 404 when history not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ id: "p1", orgId: "o1" });
    mockHistoryFindUnique.mockResolvedValue(null);
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("HISTORY_NOT_FOUND");
  });

  it("returns 404 when history belongs to different entry", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ id: "p1", orgId: "o1" });
    mockHistoryFindUnique.mockResolvedValue({ id: "h1", entryId: "other-entry" });
    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("restores history version successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({
      id: "p1",
      orgId: "o1",
      encryptedBlob: "cur",
      blobIv: "curIv",
      blobAuthTag: "curTag",
      aadVersion: 1,
      orgKeyVersion: 3,
    });
    mockHistoryFindUnique.mockResolvedValue({
      id: "h1",
      entryId: "p1",
      encryptedBlob: "old",
      blobIv: "oldIv",
      blobAuthTag: "oldTag",
      aadVersion: 0,
      orgKeyVersion: 2,
      changedAt: new Date("2025-01-01"),
    });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        orgPasswordEntryHistory: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn(),
        },
        orgPasswordEntry: { update: vi.fn() },
      });
    });

    const req = createRequest("POST");
    const res = await POST(req, createParams({ teamId: "o1", id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
  });
});
