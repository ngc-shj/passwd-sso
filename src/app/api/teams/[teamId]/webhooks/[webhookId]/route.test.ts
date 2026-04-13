import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamWebhook, mockRequireTeamPermission, TeamAuthError, mockWithTeamTenantRls, mockLogAudit, mockExtractRequestMeta } = vi.hoisted(() => {
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
    mockPrismaTeamWebhook: {
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
    mockLogAudit: vi.fn(),
    mockExtractRequestMeta: vi.fn(() => ({ ip: null, userAgent: null })),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { teamWebhook: mockPrismaTeamWebhook },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: mockExtractRequestMeta,
}));

import { DELETE } from "./route";

const TEAM_ID = "team-123";
const WEBHOOK_ID = "webhook-456";

describe("DELETE /api/teams/[teamId]/webhooks/[webhookId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: "OWNER" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/webhooks/${WEBHOOK_ID}`),
      createParams({ teamId: TEAM_ID, webhookId: WEBHOOK_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns TeamAuthError status when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/webhooks/${WEBHOOK_ID}`),
      createParams({ teamId: TEAM_ID, webhookId: WEBHOOK_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("returns 404 when webhook not found", async () => {
    mockPrismaTeamWebhook.findFirst.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/webhooks/${WEBHOOK_ID}`),
      createParams({ teamId: TEAM_ID, webhookId: WEBHOOK_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("deletes webhook successfully", async () => {
    mockPrismaTeamWebhook.findFirst.mockResolvedValue({ id: WEBHOOK_ID, url: "https://example.com/hook" });
    mockPrismaTeamWebhook.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/webhooks/${WEBHOOK_ID}`),
      createParams({ teamId: TEAM_ID, webhookId: WEBHOOK_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaTeamWebhook.delete).toHaveBeenCalledWith({ where: { id: WEBHOOK_ID, teamId: TEAM_ID } });
  });

  it("logs audit event on successful delete", async () => {
    mockPrismaTeamWebhook.findFirst.mockResolvedValue({ id: WEBHOOK_ID, url: "https://example.com/hook" });
    mockPrismaTeamWebhook.delete.mockResolvedValue({});

    await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/webhooks/${WEBHOOK_ID}`),
      createParams({ teamId: TEAM_ID, webhookId: WEBHOOK_ID }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBHOOK_DELETE",
        teamId: TEAM_ID,
        metadata: { webhookId: WEBHOOK_ID, url: "https://example.com/hook" },
      }),
    );
  });
});
