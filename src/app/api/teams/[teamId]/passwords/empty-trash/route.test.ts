import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaTransaction,
  mockRequireTeamPermission,
  TeamAuthError,
  mockWithTeamTenantRls,
  mockLogAudit,
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
    mockLogAudit: vi.fn(),
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
  logAuditBulkAsync: vi.fn(async (entries: unknown[]) => {
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

import { POST } from "./route";

const TEAM_ID = "team-123";

describe("POST /api/teams/[teamId]/passwords/empty-trash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue({ role: "OWNER" });
    // Default: transaction returns 2 deleted entries
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        teamPasswordEntry: {
          findMany: vi.fn().mockResolvedValue([{ id: "entry-1" }, { id: "entry-2" }]),
          deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        },
      };
      return fn(tx);
    });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/empty-trash`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/empty-trash`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows unexpected permission errors", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("boom"));
    await expect(
      POST(
        createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/empty-trash`),
        createParams({ teamId: TEAM_ID }),
      ),
    ).rejects.toThrow("boom");
  });

  it("permanently deletes all trashed entries and returns count", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/empty-trash`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.deletedCount).toBe(2);
  });

  it("returns 0 deletedCount when trash is already empty", async () => {
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        teamPasswordEntry: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };
      return fn(tx);
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/empty-trash`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deletedCount).toBe(0);
  });

  it("logs ENTRY_EMPTY_TRASH audit event", async () => {
    await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/empty-trash`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_EMPTY_TRASH",
        teamId: TEAM_ID,
      }),
    );
  });

  it("logs ENTRY_PERMANENT_DELETE for each deleted entry", async () => {
    await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/empty-trash`),
      createParams({ teamId: TEAM_ID }),
    );
    const permanentDeleteCalls = mockLogAudit.mock.calls.filter(
      ([call]: [{ action: string }]) => call.action === "ENTRY_PERMANENT_DELETE",
    );
    expect(permanentDeleteCalls).toHaveLength(2);
  });
});
