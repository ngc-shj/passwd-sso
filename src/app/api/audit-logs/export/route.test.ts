import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockRequireTeamPermission, TeamAuthError, mockLogAudit } = vi.hoisted(() => {
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
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockLogAudit: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));

import { POST } from "./route";
import { AUDIT_ACTION, AUDIT_SCOPE, TEAM_PERMISSION, TEAM_ROLE } from "@/lib/constants";

const URL = "http://localhost:3000/api/audit-logs/export";

describe("POST /api/audit-logs/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.MEMBER });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", URL, { body: { entryCount: 5, format: "csv" } })
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new (await import("next/server")).NextRequest(URL, {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for invalid body", async () => {
    const res = await POST(
      createRequest("POST", URL, { body: { entryCount: -1, format: "xml" } })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_BODY");
  });

  it("logs personal export when no teamId", async () => {
    const res = await POST(
      createRequest("POST", URL, { body: { entryCount: 10, format: "csv" } })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.ENTRY_EXPORT,
        userId: "user-1",
        metadata: { entryCount: 10, format: "csv" },
      })
    );
    expect(mockRequireTeamPermission).not.toHaveBeenCalled();
  });

  it("logs filename when provided", async () => {
    const res = await POST(
      createRequest("POST", URL, {
        body: {
          entryCount: 2,
          format: "json",
          filename: "passwd-sso-export-20260214.json",
          encrypted: true,
          includeTeams: true,
        },
      })
    );
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          entryCount: 2,
          format: "json",
          filename: "passwd-sso-export-20260214.json",
          encrypted: true,
          includeTeams: true,
        },
      })
    );
  });

  it("logs team export when teamId is provided and user is member", async () => {
    const res = await POST(
      createRequest("POST", URL, {
        body: { teamId: "team-1", entryCount: 3, format: "json" },
      })
    );
    expect(res.status).toBe(200);
    expect(mockRequireTeamPermission).toHaveBeenCalledWith(
      "user-1",
      "team-1",
      TEAM_PERMISSION.TEAM_UPDATE
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: AUDIT_SCOPE.TEAM,
        teamId: "team-1",
      })
    );
  });

  it("returns 403 when user lacks team:update permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await POST(
      createRequest("POST", URL, {
        body: { teamId: "team-1", entryCount: 1, format: "csv" },
      })
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 404 when teamId is specified but user is not a member", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("NOT_FOUND", 404));
    const res = await POST(
      createRequest("POST", URL, {
        body: { teamId: "team-other", entryCount: 1, format: "csv" },
      })
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_FOUND");
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

});
