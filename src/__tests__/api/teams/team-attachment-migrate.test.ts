import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createParams, createRequest, parseResponse } from "../../helpers/request-builder";

// Gate refusals of the team attachment migrate route: everything that answers
// before a blob is written or a lock is taken. The in-transaction refusals are
// pinned in the route's own route.test.ts and, against a real DB, in
// team-attachment-rekey.integration.test.ts.

const {
  mockAuth,
  mockRequireTeamPermission,
  mockRequireRecentSession,
  mockRateLimitCheck,
  mockEntryFindUnique,
  mockAttachmentFindUnique,
  mockPutObject,
  mockWithTeamTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockRequireRecentSession: vi.fn(),
  mockRateLimitCheck: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockAttachmentFindUnique: vi.fn(),
  mockPutObject: vi.fn(),
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
  return {
    requireTeamPermission: mockRequireTeamPermission,
    activeTeamRole: vi.fn(),
    hasTeamPermission: vi.fn(),
    TeamAuthError,
  };
});
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/security/rate-limiters", () => ({
  teamAttachmentMigrateLimiter: { check: mockRateLimitCheck, clear: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: { findUnique: mockEntryFindUnique },
    attachment: { findUnique: mockAttachmentFindUnique },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => ({ backend: "db", putObject: mockPutObject }),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: vi.fn(),
  teamAuditBase: vi.fn(),
}));

import { PUT } from "@/app/api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/migrate/route";
import { TeamAuthError } from "@/lib/auth/access/team-auth";

const MIGRATE_URL = "http://localhost/api/teams/t1/passwords/e1/attachments/a1/migrate";
const BODY = {
  itemKeyId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  cekKeyVersion: 1,
  snapshot: { iv: "1".repeat(24), authTag: "2".repeat(32) },
  clientHash: "3".repeat(64),
  encryptedData: "AAAA",
  iv: "4".repeat(24),
  authTag: "5".repeat(32),
  cekEncrypted: "AAAA",
  cekIv: "6".repeat(24),
  cekAuthTag: "7".repeat(32),
  cekWrapAadVersion: 1,
  filename: "doc.pdf",
  contentType: "application/pdf",
  sizeBytes: 3,
  aadVersion: 1,
};

async function migrate() {
  const res = await PUT(createRequest("PUT", MIGRATE_URL, { body: BODY }), createParams({ teamId: "t1", id: "e1", attachmentId: "a1" }));
  return parseResponse(res);
}

describe("PUT /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/migrate — gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockRequireRecentSession.mockResolvedValue(null);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockEntryFindUnique.mockResolvedValue({ teamId: "t1" });
    mockAttachmentFindUnique.mockResolvedValue(null);
  });

  it("returns 401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    const { status } = await migrate();
    expect(status).toBe(401);
  });

  it("returns 403 for a member without TEAM_UPDATE", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const { status, json } = await migrate();
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns the step-up refusal for a stale session", async () => {
    mockRequireRecentSession.mockResolvedValue(
      new Response(JSON.stringify({ error: "SESSION_STEP_UP_REQUIRED" }), { status: 403 }),
    );
    const { status, json } = await migrate();
    expect(status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
  });

  it("returns 429 keyed per (team, user)", async () => {
    mockRateLimitCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const { status } = await migrate();
    expect(status).toBe(429);
    expect(mockRateLimitCheck).toHaveBeenCalledWith(`rl:team_attachment_migrate:t1:${DEFAULT_SESSION.user.id}`);
  });

  it("returns 404 for an entry id of another team", async () => {
    mockEntryFindUnique.mockResolvedValue({ teamId: "t2" });
    const { status } = await migrate();
    expect(status).toBe(404);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("returns 404 for an entry id of another tenant (invisible under RLS)", async () => {
    mockEntryFindUnique.mockResolvedValue(null);
    const { status } = await migrate();
    expect(status).toBe(404);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("returns 404 for an attachment id of another entry", async () => {
    const { status, json } = await migrate();
    expect(status).toBe(404);
    expect(json.error).toBe("ATTACHMENT_NOT_FOUND");
    expect(mockAttachmentFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "a1", teamPasswordEntryId: "e1" } }),
    );
    expect(mockPutObject).not.toHaveBeenCalled();
  });
});
