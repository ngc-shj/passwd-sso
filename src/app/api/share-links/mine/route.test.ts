import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTeamMember,
  mockPasswordShareFindMany,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamMember: vi.fn(),
  mockPasswordShareFindMany: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => ({
  requireTeamMember: mockRequireTeamMember,
  TeamAuthError: class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { findMany: mockPasswordShareFindMany },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/logger", () => {
  const noop = vi.fn();
  const child = { info: noop, warn: noop, error: noop };
  return {
    default: { info: noop, warn: noop, error: noop, child: vi.fn().mockReturnValue(child) },
    requestContext: { run: (_s: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
    getLogger: () => child,
  };
});

import { GET } from "./route";

const USER_ID = "user-1";
const now = new Date("2025-06-01T00:00:00Z");
const futureDate = new Date("2099-12-31T00:00:00Z");

function makeShare(overrides: Record<string, unknown> = {}) {
  return {
    id: "share-1",
    entryType: "LOGIN",
    shareType: "ENTRY",
    sendName: null,
    sendFilename: null,
    sendSizeBytes: null,
    expiresAt: futureDate,
    maxViews: null,
    viewCount: 0,
    revokedAt: null,
    createdAt: now,
    passwordEntryId: "pw-1",
    teamPasswordEntryId: null,
    createdBy: { id: USER_ID, name: "Test User", email: "test@example.com" },
    passwordEntry: { id: "pw-1" },
    teamPasswordEntry: null,
    ...overrides,
  };
}

describe("GET /api/share-links/mine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    mockPasswordShareFindMany.mockResolvedValue([makeShare()]);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("GET", "http://localhost/api/share-links/mine"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 400 when shareType param is invalid", async () => {
    const res = await GET(
      createRequest("GET", "http://localhost/api/share-links/mine", {
        searchParams: { shareType: "invalid" },
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns share links with correct shape in personal context", async () => {
    const res = await GET(createRequest("GET", "http://localhost/api/share-links/mine"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.items).toHaveLength(1);
    const item = json.items[0];
    expect(item.id).toBe("share-1");
    expect(item.shareType).toBe("ENTRY");
    expect(item.sharedBy).toBe("Test User");
    expect(item.canRevoke).toBe(true);
    expect(item.isActive).toBe(true);
    expect(item.hasPersonalEntry).toBe(true);
    expect(item.teamName).toBeNull();
  });

  it("returns nextCursor=null when results fit within limit", async () => {
    mockPasswordShareFindMany.mockResolvedValue([makeShare()]);
    const res = await GET(createRequest("GET", "http://localhost/api/share-links/mine"));
    const { json } = await parseResponse(res);
    expect(json.nextCursor).toBeNull();
  });

  it("returns nextCursor when there are more results", async () => {
    const shares = Array.from({ length: 31 }, (_, i) =>
      makeShare({ id: `share-${i}` }),
    );
    mockPasswordShareFindMany.mockResolvedValue(shares);
    const res = await GET(createRequest("GET", "http://localhost/api/share-links/mine"));
    const { json } = await parseResponse(res);
    expect(json.items).toHaveLength(30);
    expect(json.nextCursor).toBe("share-29");
  });

  it("filters by status=active — sets revokedAt: null and expiresAt: { gt: now }", async () => {
    mockPasswordShareFindMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/share-links/mine", {
        searchParams: { status: "active" },
      }),
    );
    const call = mockPasswordShareFindMany.mock.calls[0][0];
    expect(call.where.revokedAt).toBe(null);
    expect(call.where.expiresAt).toHaveProperty("gt");
  });

  it("filters by status=revoked — sets revokedAt: { not: null }", async () => {
    mockPasswordShareFindMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/share-links/mine", {
        searchParams: { status: "revoked" },
      }),
    );
    const call = mockPasswordShareFindMany.mock.calls[0][0];
    expect(call.where.revokedAt).toEqual({ not: null });
  });

  it("filters by status=expired", async () => {
    mockPasswordShareFindMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/share-links/mine", {
        searchParams: { status: "expired" },
      }),
    );
    const call = mockPasswordShareFindMany.mock.calls[0][0];
    expect(call.where.revokedAt).toBe(null);
    expect(call.where.expiresAt).toHaveProperty("lte");
  });

  it("personal context scopes by createdById", async () => {
    mockPasswordShareFindMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost/api/share-links/mine"));
    const call = mockPasswordShareFindMany.mock.calls[0][0];
    expect(call.where.createdById).toBe(USER_ID);
  });

  it("personal context with shareType=entry adds passwordEntryId: { not: null }", async () => {
    mockPasswordShareFindMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/share-links/mine", {
        searchParams: { shareType: "entry" },
      }),
    );
    const call = mockPasswordShareFindMany.mock.calls[0][0];
    expect(call.where.passwordEntryId).toEqual({ not: null });
  });

  it("personal context with shareType=send adds shareType filter", async () => {
    mockPasswordShareFindMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/share-links/mine", {
        searchParams: { shareType: "send" },
      }),
    );
    const call = mockPasswordShareFindMany.mock.calls[0][0];
    expect(call.where.shareType).toEqual({ in: ["TEXT", "FILE"] });
  });

  it("returns empty items list when no shares match", async () => {
    mockPasswordShareFindMany.mockResolvedValue([]);
    const res = await GET(createRequest("GET", "http://localhost/api/share-links/mine"));
    const { json } = await parseResponse(res);
    expect(json.items).toEqual([]);
    expect(json.nextCursor).toBeNull();
  });

  it("canRevoke=false when share was created by another user", async () => {
    mockPasswordShareFindMany.mockResolvedValue([
      makeShare({
        createdBy: { id: "other-user", name: "Other", email: "other@example.com" },
      }),
    ]);
    const res = await GET(createRequest("GET", "http://localhost/api/share-links/mine"));
    const { json } = await parseResponse(res);
    expect(json.items[0].canRevoke).toBe(false);
  });

  it("isActive=false when revokedAt is set", async () => {
    mockPasswordShareFindMany.mockResolvedValue([
      makeShare({ revokedAt: new Date("2025-01-01") }),
    ]);
    const res = await GET(createRequest("GET", "http://localhost/api/share-links/mine"));
    const { json } = await parseResponse(res);
    expect(json.items[0].isActive).toBe(false);
  });

  it("isActive=false when expiresAt is in the past", async () => {
    mockPasswordShareFindMany.mockResolvedValue([
      makeShare({ expiresAt: new Date("2000-01-01") }),
    ]);
    const res = await GET(createRequest("GET", "http://localhost/api/share-links/mine"));
    const { json } = await parseResponse(res);
    expect(json.items[0].isActive).toBe(false);
  });

  it("isActive=false when maxViews reached", async () => {
    mockPasswordShareFindMany.mockResolvedValue([
      makeShare({ maxViews: 5, viewCount: 5 }),
    ]);
    const res = await GET(createRequest("GET", "http://localhost/api/share-links/mine"));
    const { json } = await parseResponse(res);
    expect(json.items[0].isActive).toBe(false);
  });

  describe("team context", () => {
    const TEAM_ID = "team-1";

    it("returns empty list when shareType=send in team context", async () => {
      mockRequireTeamMember.mockResolvedValue({ role: "MEMBER" });
      const res = await GET(
        createRequest("GET", "http://localhost/api/share-links/mine", {
          searchParams: { team: TEAM_ID, shareType: "send" },
        }),
      );
      const { status, json } = await parseResponse(res);
      expect(status).toBe(200);
      expect(json.items).toEqual([]);
      expect(json.nextCursor).toBeNull();
    });

    it("scopes by team when team param is set", async () => {
      mockRequireTeamMember.mockResolvedValue({ role: "MEMBER" });
      mockPasswordShareFindMany.mockResolvedValue([]);
      await GET(
        createRequest("GET", "http://localhost/api/share-links/mine", {
          searchParams: { team: TEAM_ID },
        }),
      );
      const call = mockPasswordShareFindMany.mock.calls[0][0];
      expect(call.where.teamPasswordEntry).toEqual({ teamId: TEAM_ID });
    });

    it("VIEWER role restricts to own shares", async () => {
      mockRequireTeamMember.mockResolvedValue({ role: "VIEWER" });
      mockPasswordShareFindMany.mockResolvedValue([]);
      await GET(
        createRequest("GET", "http://localhost/api/share-links/mine", {
          searchParams: { team: TEAM_ID },
        }),
      );
      const call = mockPasswordShareFindMany.mock.calls[0][0];
      expect(call.where.createdById).toBe(USER_ID);
    });

    it("MEMBER role sees team-wide shares", async () => {
      mockRequireTeamMember.mockResolvedValue({ role: "MEMBER" });
      mockPasswordShareFindMany.mockResolvedValue([]);
      await GET(
        createRequest("GET", "http://localhost/api/share-links/mine", {
          searchParams: { team: TEAM_ID },
        }),
      );
      const call = mockPasswordShareFindMany.mock.calls[0][0];
      expect(call.where.createdById).toBeUndefined();
    });

    it("returns error when team membership check fails", async () => {
      const { TeamAuthError } = await import("@/lib/team-auth");
      mockRequireTeamMember.mockRejectedValue(new TeamAuthError("NOT_MEMBER", 403));
      const res = await GET(
        createRequest("GET", "http://localhost/api/share-links/mine", {
          searchParams: { team: TEAM_ID },
        }),
      );
      const { status } = await parseResponse(res);
      expect(status).toBe(403);
    });
  });
});
