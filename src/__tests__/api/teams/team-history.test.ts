import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const { mockAuth, mockRequireOrgMember, mockEntryFindUnique, mockHistoryFindMany } = vi.hoisted(
  () => ({
    mockAuth: vi.fn(),
    mockRequireOrgMember: vi.fn(),
    mockEntryFindUnique: vi.fn(),
    mockHistoryFindMany: vi.fn(),
  })
);

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
    requireOrgMember: mockRequireOrgMember,
    OrgAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgPasswordEntry: { findUnique: mockEntryFindUnique },
    orgPasswordEntryHistory: { findMany: mockHistoryFindMany },
  },
}));

import { GET } from "@/app/api/teams/[teamId]/passwords/[id]/history/route";
import { OrgAuthError } from "@/lib/team-auth";

describe("GET /api/teams/[teamId]/passwords/[id]/history", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "o1", id: "p1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when not org member", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgMember.mockRejectedValue(new OrgAuthError("FORBIDDEN", 403));
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "o1", id: "p1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgMember.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "o1", id: "p1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when entry belongs to different org", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgMember.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ orgId: "other-org" });
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "o1", id: "p1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns history entries with user info", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgMember.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ orgId: "o1" });
    const changedAt = new Date("2025-06-01");
    mockHistoryFindMany.mockResolvedValue([
      {
        id: "h1",
        entryId: "p1",
        encryptedBlob: "cipher",
        blobIv: "iv",
        blobAuthTag: "tag",
        aadVersion: 1,
        orgKeyVersion: 2,
        changedAt,
        changedBy: { id: "u1", name: "Admin", email: "admin@test.com" },
      },
    ]);

    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "o1", id: "p1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].encryptedBlob).toEqual({ ciphertext: "cipher", iv: "iv", authTag: "tag" });
    expect(json[0].orgKeyVersion).toBe(2);
    expect(json[0].changedBy.name).toBe("Admin");
  });
});
