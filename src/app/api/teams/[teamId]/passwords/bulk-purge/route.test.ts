import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";
import type { logAuditAsync, logAuditBulkAsync } from "@/lib/audit/audit";

const {
  mockAuth,
  mockPrismaTransaction,
  mockRequireTeamPermission,
  TeamAuthError,
  mockWithTeamTenantRls,
  mockLogAudit,
  mockFindMany,
  mockDeleteMany,
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
    mockPrismaTransaction: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
    mockLogAudit: vi.fn<typeof logAuditAsync>(),
    // Hoisted so stale-session tests can assert deleteMany was NOT called.
    mockFindMany: vi.fn(),
    mockDeleteMany: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/auth/access/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  logAuditBulkAsync: vi.fn<typeof logAuditBulkAsync>(async (entries) => {
    for (const e of entries) await mockLogAudit(e);
  }),
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
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
// Irreversible bulk purge gates on requireRecentCurrentAuthMethod (step-up).
// Default: null (fresh session → allow). Stale-session tests override.
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: vi.fn().mockResolvedValue(null),
}));

import { NextResponse } from "next/server";
import { POST } from "./route";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";

const mockRequireRecent = vi.mocked(requireRecentCurrentAuthMethod);

const TEAM_ID = "team-123";
const ID_1 = "00000000-0000-4000-a000-000000000001";
const ID_2 = "00000000-0000-4000-a000-000000000002";

describe("POST /api/teams/[teamId]/passwords/bulk-purge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRecent.mockResolvedValue(null);
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue({ role: "OWNER" });
    mockFindMany.mockResolvedValue([{ id: ID_1 }, { id: ID_2 }]);
    mockDeleteMany.mockResolvedValue({ count: 2 });
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        teamPasswordEntry: {
          findMany: mockFindMany,
          deleteMany: mockDeleteMany,
        },
      };
      return fn(tx);
    });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/bulk-purge`, {
        body: { ids: [ID_1] },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when PASSWORD_DELETE permission is denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/bulk-purge`, {
        body: { ids: [ID_1] },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("rejects with 403 and does NOT delete when session is stale (step-up required)", async () => {
    mockRequireRecent.mockResolvedValueOnce(
      NextResponse.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/bulk-purge`, {
        body: { ids: [ID_1, ID_2] },
      }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(res.status).toBe(403);
    // Security-critical ordering: the purge must not run before step-up passes.
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("purges the supplied trashed ids when the session is fresh", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/bulk-purge`, {
        body: { ids: [ID_1, ID_2] },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deletedCount).toBe(2);
    expect(mockDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: TEAM_ID,
          deletedAt: { not: null },
        }),
      })
    );
  });
});
