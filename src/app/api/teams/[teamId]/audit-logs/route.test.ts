import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaAuditLog,
  mockPrismaTeamPasswordEntry,
  mockRequireTeamPermission,
  TeamAuthError,
  mockWithTeamTenantRls,
} = vi.hoisted(() => {
  class _TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockPrismaAuditLog: { findMany: vi.fn() },
    mockPrismaTeamPasswordEntry: { findMany: vi.fn() },
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: mockPrismaAuditLog,
    teamPasswordEntry: mockPrismaTeamPasswordEntry,
  },
}));
vi.mock("@/lib/auth/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { GET } from "./route";

const TEAM_ID = "team-123";

const MOCK_LOG = {
  id: "log-1",
  action: "ENTRY_CREATE",
  targetType: null,
  targetId: null,
  metadata: null,
  ip: "1.2.3.4",
  userAgent: "Chrome/120",
  createdAt: new Date("2026-01-15T10:00:00Z"),
  user: { id: "user-1", name: "Test User", email: "test@example.com", image: null },
};

describe("GET /api/teams/[teamId]/audit-logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue({ role: "OWNER" });
    mockPrismaAuditLog.findMany.mockResolvedValue([MOCK_LOG]);
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([]);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows unexpected permission errors", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("boom"));
    await expect(
      GET(
        createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs`),
        createParams({ teamId: TEAM_ID }),
      ),
    ).rejects.toThrow("boom");
  });

  it("returns audit logs successfully", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(1);
    expect(json.items[0].id).toBe("log-1");
    expect(json.items[0].action).toBe("ENTRY_CREATE");
    expect(json.nextCursor).toBeNull();
    expect(json.entryOverviews).toEqual({});
  });

  it("returns 400 for invalid action filter", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs`, {
        searchParams: { actions: "ENTRY_CREATE,NOT_REAL_ACTION" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid cursor", async () => {
    mockPrismaAuditLog.findMany.mockRejectedValue(new Error("Invalid cursor"));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs`, {
        searchParams: { cursor: "bad-cursor" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("includes nextCursor when there are more pages", async () => {
    // Return limit+1 items to trigger pagination
    const logs = Array.from({ length: 51 }, (_, i) => ({ ...MOCK_LOG, id: `log-${i}` }));
    mockPrismaAuditLog.findMany.mockResolvedValue(logs);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(json.nextCursor).not.toBeNull();
    expect(json.items).toHaveLength(50);
  });

  it("includes entryOverviews for TEAM_PASSWORD_ENTRY targets with item keys", async () => {
    const logWithTarget = {
      ...MOCK_LOG,
      id: "log-entry",
      targetType: "TeamPasswordEntry",
      targetId: "00000000-0000-4000-a000-000000000001",
    };
    mockPrismaAuditLog.findMany.mockResolvedValue([logWithTarget]);
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([
      {
        id: "00000000-0000-4000-a000-000000000001",
        encryptedOverview: "enc",
        overviewIv: "iv",
        overviewAuthTag: "tag",
        aadVersion: 1,
        teamKeyVersion: 1,
        encryptedItemKey: "itemkey",
        itemKeyIv: "itemiv",
        itemKeyAuthTag: "itemtag",
        itemKeyVersion: 1,
      },
    ]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(json.entryOverviews).toHaveProperty("00000000-0000-4000-a000-000000000001");
    expect(json.entryOverviews["00000000-0000-4000-a000-000000000001"].encryptedOverview).toBe("enc");
  });
});
