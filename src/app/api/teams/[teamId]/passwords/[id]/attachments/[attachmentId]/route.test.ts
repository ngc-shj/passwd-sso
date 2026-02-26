import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockPrismaOrgPasswordEntry,
  mockPrismaAttachment,
  MockTeamAuthError,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockPrismaOrgPasswordEntry: {
    findUnique: vi.fn(),
  },
  mockPrismaAttachment: {
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
  MockTeamAuthError: class MockTeamAuthError extends Error {
    status: number;
    constructor(message: string, status = 403) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError: MockTeamAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgPasswordEntry: mockPrismaOrgPasswordEntry,
    attachment: mockPrismaAttachment,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { GET, DELETE } from "./route";

function createParams(teamId: string, id: string, attachmentId: string) {
  return { params: Promise.resolve({ teamId: teamId, id, attachmentId }) };
}

function createRequest(method: string, url: string) {
  return new NextRequest(url, { method });
}

describe("GET /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({ orgId: "team-1" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest(
        "GET",
        "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1",
      ),
      createParams("team-1", "pw-1", "att-1"),
    );
    expect(res.status).toBe(401);
  });

  it("returns team auth error when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(
      new MockTeamAuthError("FORBIDDEN", 403),
    );
    const res = await GET(
      createRequest(
        "GET",
        "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1",
      ),
      createParams("team-1", "pw-1", "att-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when entry does not belong to org", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({ orgId: "other-team" });
    const res = await GET(
      createRequest(
        "GET",
        "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1",
      ),
      createParams("team-1", "pw-1", "att-1"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when attachment not found", async () => {
    mockPrismaAttachment.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest(
        "GET",
        "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1",
      ),
      createParams("team-1", "pw-1", "att-1"),
    );
    expect(res.status).toBe(404);
  });

  it("returns encrypted data as JSON for client-side decryption", async () => {
    mockPrismaAttachment.findUnique.mockResolvedValue({
      id: "att-1",
      filename: "doc.pdf",
      contentType: "application/pdf",
      sizeBytes: 4,
      encryptedData: Buffer.from([1, 2, 3]),
      iv: "a".repeat(24),
      authTag: "b".repeat(32),
      keyVersion: 1,
      aadVersion: 1,
    });

    const res = await GET(
      createRequest(
        "GET",
        "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1",
      ),
      createParams("team-1", "pw-1", "att-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBe("att-1");
    expect(json.filename).toBe("doc.pdf");
    expect(json.encryptedData).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(json.iv).toBe("a".repeat(24));
    expect(json.authTag).toBe("b".repeat(32));
    expect(json.keyVersion).toBe(1);
    expect(json.aadVersion).toBe(1);
  });
});

describe("DELETE /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({ orgId: "team-1" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest(
        "DELETE",
        "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1",
      ),
      createParams("team-1", "pw-1", "att-1"),
    );
    expect(res.status).toBe(401);
  });

  it("returns team auth error when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(
      new MockTeamAuthError("FORBIDDEN", 403),
    );
    const res = await DELETE(
      createRequest(
        "DELETE",
        "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1",
      ),
      createParams("team-1", "pw-1", "att-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when entry does not belong to org", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({ orgId: "other-team" });
    const res = await DELETE(
      createRequest(
        "DELETE",
        "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1",
      ),
      createParams("team-1", "pw-1", "att-1"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when attachment not found", async () => {
    mockPrismaAttachment.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest(
        "DELETE",
        "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1",
      ),
      createParams("team-1", "pw-1", "att-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toBe("ATTACHMENT_NOT_FOUND");
  });

  it("deletes attachment", async () => {
    mockPrismaAttachment.findUnique.mockResolvedValue({
      id: "att-1",
      filename: "doc.pdf",
      encryptedData: Buffer.from([1, 2, 3]),
    });
    mockPrismaAttachment.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest(
        "DELETE",
        "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1",
      ),
      createParams("team-1", "pw-1", "att-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });
});
