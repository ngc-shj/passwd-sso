import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createParams } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockEntryFindUnique,
  mockAttachmentFindUnique,
  mockAttachmentDelete,
  mockGetObject,
  mockDeleteObject,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockAttachmentFindUnique: vi.fn(),
  mockAttachmentDelete: vi.fn(),
  mockGetObject: vi.fn(),
  mockDeleteObject: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => {
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { requireTeamPermission: mockRequireTeamPermission, TeamAuthError };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: { findUnique: mockEntryFindUnique },
    attachment: {
      findUnique: mockAttachmentFindUnique,
      delete: mockAttachmentDelete,
    },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => ({
    getObject: mockGetObject,
    deleteObject: mockDeleteObject,
  }),
}));

import { NextRequest } from "next/server";
import { GET, DELETE } from "@/app/api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/route";
import { TeamAuthError } from "@/lib/team-auth";

function makeParams(teamId: string, id: string, attachmentId: string) {
  return createParams({ teamId: teamId, id, attachmentId });
}

function createGetRequest() {
  return new NextRequest(
    "http://localhost/api/teams/o1/passwords/e1/attachments/a1",
    { method: "GET" },
  );
}

function createDeleteRequest() {
  return new NextRequest(
    "http://localhost/api/teams/o1/passwords/e1/attachments/a1",
    { method: "DELETE" },
  );
}

const TEAM_ENTRY = { teamId: "o1" };

const ATTACHMENT = {
  id: "a1",
  filename: "test.pdf",
  contentType: "application/pdf",
  sizeBytes: 100,
  iv: "a".repeat(24),
  authTag: "b".repeat(32),
  encryptedData: Buffer.from("encrypted-data"),
  keyVersion: 1,
  aadVersion: 1,
};

describe("GET /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry belongs to different team", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: "other-team" });
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when attachment not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentFindUnique.mockResolvedValue(null);
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns encrypted data as JSON for client-side decryption", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentFindUnique.mockResolvedValue(ATTACHMENT);
    mockGetObject.mockResolvedValue(Buffer.from("encrypted-data"));

    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.id).toBe("a1");
    expect(json.filename).toBe("test.pdf");
    expect(json.contentType).toBe("application/pdf");
    expect(json.sizeBytes).toBe(100);
    expect(json.encryptedData).toBe(Buffer.from("encrypted-data").toString("base64"));
    expect(json.iv).toBe("a".repeat(24));
    expect(json.authTag).toBe("b".repeat(32));
    expect(json.keyVersion).toBe(1);
    expect(json.aadVersion).toBe(1);
  });
});

describe("DELETE /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry belongs to different team", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: "other-team" });
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when attachment not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: "o1" });
    mockAttachmentFindUnique.mockResolvedValue(null);
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("deletes attachment successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: "o1" });
    mockAttachmentFindUnique.mockResolvedValue({
      id: "a1",
      filename: "test.pdf",
      encryptedData: Buffer.from("blob-key"),
    });
    mockDeleteObject.mockResolvedValue(undefined);
    mockAttachmentDelete.mockResolvedValue({});

    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockAttachmentDelete).toHaveBeenCalledWith({ where: { id: "a1" } });
  });
});
