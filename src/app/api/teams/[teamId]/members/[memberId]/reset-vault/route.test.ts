import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth, mockLogAudit, mockCreateNotification, mockSendEmail,
  mockAdminLimiter, mockTargetLimiter,
  mockRequireTeamPermission, mockIsRoleAbove,
  mockTeamMemberFindFirst, mockAdminVaultResetCount, mockAdminVaultResetCreate,
  mockTeamFindUnique,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockLogAudit: vi.fn(),
  mockCreateNotification: vi.fn(),
  mockSendEmail: vi.fn(),
  mockAdminLimiter: { check: vi.fn() },
  mockTargetLimiter: { check: vi.fn() },
  mockRequireTeamPermission: vi.fn(),
  mockIsRoleAbove: vi.fn(),
  mockTeamMemberFindFirst: vi.fn(),
  mockAdminVaultResetCount: vi.fn(),
  mockAdminVaultResetCreate: vi.fn(),
  mockTeamFindUnique: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamMember: { findFirst: mockTeamMemberFindFirst },
    adminVaultReset: { count: mockAdminVaultResetCount, create: mockAdminVaultResetCreate },
    team: { findUnique: mockTeamFindUnique },
  },
}));
vi.mock("@/lib/csrf", () => ({
  assertOrigin: vi.fn(() => null),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn()
    .mockReturnValueOnce(mockAdminLimiter)
    .mockReturnValueOnce(mockTargetLimiter),
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
}));
vi.mock("@/lib/notification", () => ({
  createNotification: mockCreateNotification,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
}));
vi.mock("@/lib/email/templates/admin-vault-reset", () => ({
  adminVaultResetEmail: vi.fn(() => ({
    subject: "Reset",
    html: "<p>Reset</p>",
    text: "Reset",
  })),
}));
vi.mock("@/lib/locale", () => ({
  resolveUserLocale: vi.fn(() => "en"),
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  isRoleAbove: mockIsRoleAbove,
  TeamAuthError: class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: vi.fn((_teamId: string, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from "./route";
import { TeamAuthError } from "@/lib/team-auth";

const URL = "http://localhost/api/teams/team-1/members/member-1/reset-vault";
const makeParams = () => createParams({ teamId: "team-1", memberId: "member-1" });

const TARGET_MEMBER = {
  id: "member-1",
  userId: "target-user-1",
  role: "MEMBER",
  teamId: "team-1",
  user: { id: "target-user-1", email: "target@test.com", name: "Target", locale: "en" },
};

describe("POST /api/teams/[teamId]/members/[memberId]/reset-vault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_URL = "http://localhost:3000";
    mockAuth.mockResolvedValue({ user: { id: "admin-1", name: "Admin", email: "admin@test.com" } });
    mockRequireTeamPermission.mockResolvedValue({ role: "ADMIN" });
    mockIsRoleAbove.mockReturnValue(true);
    mockTeamMemberFindFirst.mockResolvedValue(TARGET_MEMBER);
    mockAdminLimiter.check.mockResolvedValue(true);
    mockTargetLimiter.check.mockResolvedValue(true);
    mockAdminVaultResetCount.mockResolvedValue(0);
    mockAdminVaultResetCreate.mockResolvedValue({});
    mockTeamFindUnique.mockResolvedValue({ name: "Test Team", tenantId: "tenant-1" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await POST(createRequest("POST", URL), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 404 when target member not found", async () => {
    mockTeamMemberFindFirst.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 403 when trying to reset own vault", async () => {
    mockTeamMemberFindFirst.mockResolvedValue({
      ...TARGET_MEMBER,
      userId: "admin-1",
    });
    const res = await POST(createRequest("POST", URL), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 403 when actor role is not above target (ADMIN→ADMIN)", async () => {
    mockIsRoleAbove.mockReturnValue(false);
    const res = await POST(createRequest("POST", URL), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 429 when admin rate limit exceeded", async () => {
    mockAdminLimiter.check.mockResolvedValue(false);
    const res = await POST(createRequest("POST", URL), makeParams());
    expect(res.status).toBe(429);
  });

  it("returns 429 when target rate limit exceeded", async () => {
    mockTargetLimiter.check.mockResolvedValue(false);
    const res = await POST(createRequest("POST", URL), makeParams());
    expect(res.status).toBe(429);
  });

  it("returns 429 when pending reset count exceeds limit", async () => {
    mockAdminVaultResetCount.mockResolvedValue(3);
    const res = await POST(createRequest("POST", URL), makeParams());
    expect(res.status).toBe(429);
  });

  it("creates reset record, notification, audit log, and email on success", async () => {
    const res = await POST(createRequest("POST", URL), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // Reset record created
    expect(mockAdminVaultResetCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "tenant-1",
          teamId: "team-1",
          targetUserId: "target-user-1",
          initiatedById: "admin-1",
        }),
      }),
    );

    // Audit log
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_VAULT_RESET_INITIATE",
        userId: "admin-1",
        teamId: "team-1",
        targetId: "target-user-1",
      }),
    );

    // Notification
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "target-user-1",
        type: "ADMIN_VAULT_RESET",
      }),
    );

    // Email
    expect(mockSendEmail).toHaveBeenCalled();
  });

  it("OWNER can reset ADMIN vault (role hierarchy respected)", async () => {
    mockRequireTeamPermission.mockResolvedValue({ role: "OWNER" });
    mockTeamMemberFindFirst.mockResolvedValue({
      ...TARGET_MEMBER,
      role: "ADMIN",
    });
    mockIsRoleAbove.mockReturnValue(true);
    const res = await POST(createRequest("POST", URL), makeParams());
    expect(res.status).toBe(200);
  });

  it("admin and target rate limiters work independently", async () => {
    // Admin exceeds limit but target is fine
    mockAdminLimiter.check.mockResolvedValue(false);
    mockTargetLimiter.check.mockResolvedValue(true);
    let res = await POST(createRequest("POST", URL), makeParams());
    expect(res.status).toBe(429);

    // Reset — target exceeds limit but admin is fine
    mockAdminLimiter.check.mockResolvedValue(true);
    mockTargetLimiter.check.mockResolvedValue(false);
    res = await POST(createRequest("POST", URL), makeParams());
    expect(res.status).toBe(429);
  });
});
