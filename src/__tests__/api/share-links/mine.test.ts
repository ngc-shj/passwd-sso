import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";
import { ENTRY_TYPE, TEAM_ROLE } from "@/lib/constants";

const { mockAuth, mockFindMany, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));
const { mockRequireTeamMember } = vi.hoisted(() => ({
  mockRequireTeamMember: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { findMany: mockFindMany },
  },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamMember: mockRequireTeamMember,
  TeamAuthError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { GET } from "@/app/api/share-links/mine/route";

function makeShare(overrides: Record<string, unknown> = {}) {
  return {
    id: "share-1",
    shareType: "ENTRY_SHARE",
    entryType: ENTRY_TYPE.LOGIN,
    sendName: null,
    sendFilename: null,
    sendSizeBytes: null,
    expiresAt: new Date(Date.now() + 86400_000), // +1 day
    maxViews: null,
    viewCount: 0,
    revokedAt: null,
    createdAt: new Date(),
    createdById: DEFAULT_SESSION.user.id,
    createdBy: { id: DEFAULT_SESSION.user.id, name: "Alice", email: "alice@example.com" },
    passwordEntryId: "pe-1",
    teamPasswordEntryId: null,
    passwordEntry: { id: "pe-1" },
    teamPasswordEntry: null,
    ...overrides,
  };
}

describe("GET /api/share-links/mine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireTeamMember.mockResolvedValue({ id: "member-1", role: TEAM_ROLE.ADMIN });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns share links for authenticated user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const share = makeShare();
    mockFindMany.mockResolvedValue([share]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.items[0].id).toBe("share-1");
    expect(json.items[0].isActive).toBe(true);
    expect(json.items[0].hasPersonalEntry).toBe(true);
    expect(json.items[0].teamName).toBeNull();
    expect(json.items[0].sharedBy).toBe("Alice");
    expect(json.items[0].canRevoke).toBe(true);
    expect(json.nextCursor).toBeNull();
  });

  it("computes isActive=false when revoked", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([
      makeShare({ revokedAt: new Date() }),
    ]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { json } = await parseResponse(res);

    expect(json.items[0].isActive).toBe(false);
  });

  it("computes isActive=false when expired", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([
      makeShare({ expiresAt: new Date(Date.now() - 1000) }),
    ]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { json } = await parseResponse(res);

    expect(json.items[0].isActive).toBe(false);
  });

  it("computes isActive=false when maxViews reached", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([
      makeShare({ maxViews: 5, viewCount: 5 }),
    ]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { json } = await parseResponse(res);

    expect(json.items[0].isActive).toBe(false);
  });

  it("includes teamName from team password entry relation", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([
      makeShare({
        passwordEntryId: null,
        teamPasswordEntryId: "ope-1",
        createdBy: { id: "user-2", name: "Bob", email: "bob@example.com" },
        passwordEntry: null,
        teamPasswordEntry: { id: "ope-1", team: { name: "Acme Corp" } },
      }),
    ]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { json } = await parseResponse(res);

    expect(json.items[0].teamName).toBe("Acme Corp");
    expect(json.items[0].hasPersonalEntry).toBe(false);
    expect(json.items[0].sharedBy).toBe("Bob");
    expect(json.items[0].canRevoke).toBe(false);
  });

  it("filters by status=active", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/mine?status=active"
    );
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
        }),
      })
    );
  });

  it("filters by status=expired", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/mine?status=expired"
    );
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revokedAt: null,
          expiresAt: { lte: expect.any(Date) },
        }),
      })
    );
  });

  it("filters by status=revoked", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/mine?status=revoked"
    );
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revokedAt: { not: null },
        }),
      })
    );
  });

  it("supports cursor-based pagination", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    // Return 31 items to trigger hasMore
    const shares = Array.from({ length: 31 }, (_, i) =>
      makeShare({ id: `share-${i}` })
    );
    mockFindMany.mockResolvedValue(shares);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/mine?cursor=share-prev"
    );
    const res = await GET(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(30);
    expect(json.nextCursor).toBe("share-29");
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "share-prev" },
        skip: 1,
        take: 31,
      })
    );
  });

  it("queries only authenticated user's shares (default: all types)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdById: DEFAULT_SESSION.user.id,
          teamPasswordEntryId: null,
        }),
      })
    );
    expect(mockRequireTeamMember).not.toHaveBeenCalled();
  });

  it("requires team membership and filters by team when team query is provided", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine?team=team-1");
    await GET(req as never);

    expect(mockRequireTeamMember).toHaveBeenCalledWith(DEFAULT_SESSION.user.id, "team-1");
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamPasswordEntry: { teamId: "team-1" },
        }),
      })
    );
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({
          createdById: DEFAULT_SESSION.user.id,
        }),
      })
    );
  });

  it("returns TeamAuthError status when team membership check fails", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const { TeamAuthError } = await import("@/lib/team-auth");
    mockRequireTeamMember.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));

    const req = createRequest("GET", "http://localhost/api/share-links/mine?team=team-1");
    const res = await GET(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("limits team scoped list to self-created links for VIEWER", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({ id: "member-1", role: TEAM_ROLE.VIEWER });
    mockFindMany.mockResolvedValue([]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine?team=team-1");
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamPasswordEntry: { teamId: "team-1" },
          createdById: DEFAULT_SESSION.user.id,
        }),
      })
    );
  });

  it("does not limit team scoped list to self-created links for MEMBER", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({ id: "member-1", role: TEAM_ROLE.MEMBER });
    mockFindMany.mockResolvedValue([]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine?team=team-1");
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamPasswordEntry: { teamId: "team-1" },
        }),
      })
    );
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({
          createdById: DEFAULT_SESSION.user.id,
        }),
      })
    );
  });

  it("does not limit team scoped list to self-created links for OWNER", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({ id: "member-1", role: TEAM_ROLE.OWNER });
    mockFindMany.mockResolvedValue([]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine?team=team-1");
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamPasswordEntry: { teamId: "team-1" },
        }),
      })
    );
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({
          createdById: DEFAULT_SESSION.user.id,
        }),
      })
    );
  });

  it("filters by shareType=entry for personal context", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/mine?shareType=entry"
    );
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdById: DEFAULT_SESSION.user.id,
          passwordEntryId: { not: null },
        }),
      })
    );
  });

  it("filters by shareType=send for personal context", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/mine?shareType=send"
    );
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdById: DEFAULT_SESSION.user.id,
          shareType: { in: ["TEXT", "FILE"] },
        }),
      })
    );
  });

  it("returns empty for shareType=send with team context", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/mine?team=team-1&shareType=send"
    );
    const res = await GET(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(0);
    expect(json.nextCursor).toBeNull();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("includes shareType, sendName, sendFilename, sendSizeBytes in response", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([
      makeShare({
        shareType: "TEXT",
        entryType: null,
        sendName: "My Text",
        passwordEntryId: null,
        passwordEntry: null,
      }),
    ]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items[0].shareType).toBe("TEXT");
    expect(json.items[0].sendName).toBe("My Text");
    expect(json.items[0].sendFilename).toBeNull();
    expect(json.items[0].sendSizeBytes).toBeNull();
  });
});
