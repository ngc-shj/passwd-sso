import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockCheck, mockCreateNotification, mockLogAudit, mockSendEmail, mockWithUserTenantRls, mockRequireTeamMember, MockTeamAuthError } = vi.hoisted(() => {
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
    mockCheck: vi.fn(),
    mockCreateNotification: vi.fn(),
    mockLogAudit: vi.fn(),
    mockSendEmail: vi.fn(),
    mockWithUserTenantRls: vi.fn(),
    mockRequireTeamMember: vi.fn(),
    MockTeamAuthError: _TeamAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({
    check: mockCheck,
    clear: vi.fn(),
  })),
}));
vi.mock("@/lib/csrf", () => ({
  assertOrigin: vi.fn(() => null),
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "127.0.0.1", userAgent: "test" }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "127.0.0.1", userAgent: "test" }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: "test" }),
}));
vi.mock("@/lib/notification", () => ({
  createNotification: mockCreateNotification,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
}));
vi.mock("@/lib/email/templates/watchtower-alert", () => ({
  watchtowerAlertEmail: vi.fn(() => ({
    subject: "Test subject",
    html: "<p>Test</p>",
    text: "Test",
  })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamMember: mockRequireTeamMember,
  TeamAuthError: MockTeamAuthError,
}));
vi.mock("@/lib/locale", () => ({ resolveUserLocale: vi.fn(() => "en") }));
vi.mock("@/lib/url-helpers", () => ({ serverAppUrl: vi.fn(() => "http://localhost") }));
vi.mock("@/lib/notification-messages", () => ({
  notificationTitle: vi.fn(() => "Alert"),
  notificationBody: vi.fn(() => "Body"),
}));

import { POST } from "./route";

describe("POST /api/watchtower/alert", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: userId } });
    mockCheck.mockResolvedValue({ allowed: true });
    mockRequireTeamMember.mockResolvedValue({ role: "MEMBER" });
    mockWithUserTenantRls.mockImplementation((_id: string, fn: () => unknown) => fn());
  });

  function makeRequest(body: unknown) {
    return createRequest("POST", "http://localhost:3000/api/watchtower/alert", {
      body,
    });
  }

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(makeRequest({ newBreachCount: 3 }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid body (missing newBreachCount)", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid body (negative count)", async () => {
    const res = await POST(makeRequest({ newBreachCount: -1 }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid body (count exceeds max)", async () => {
    const res = await POST(makeRequest({ newBreachCount: 10001 }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid body (float)", async () => {
    const res = await POST(makeRequest({ newBreachCount: 1.5 }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 429 when rate limited", async () => {
    mockCheck.mockResolvedValue({ allowed: false });
    const res = await POST(makeRequest({ newBreachCount: 3 }));
    expect(res.status).toBe(429);
  });

  it("creates notification and audit log on success", async () => {
    mockWithUserTenantRls.mockResolvedValue({ email: "user@example.com", locale: "en" });
    const res = await POST(makeRequest({ newBreachCount: 3 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        type: "WATCHTOWER_ALERT",
        metadata: { breachCount: 3 },
      }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WATCHTOWER_ALERT_SENT",
        userId,
        metadata: { newBreachCount: 3 },
      }),
    );
  });

  it("sends email when user has email", async () => {
    mockWithUserTenantRls.mockResolvedValue({ email: "user@example.com", locale: "en" });
    await POST(makeRequest({ newBreachCount: 2 }));
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
      }),
    );
  });

  it("does not send email when user has no email", async () => {
    mockWithUserTenantRls.mockResolvedValue({ email: null, locale: "en" });
    await POST(makeRequest({ newBreachCount: 2 }));
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("uses correct rate limit key", async () => {
    await POST(makeRequest({ newBreachCount: 1 }));
    expect(mockCheck).toHaveBeenCalledWith(`rl:watchtower:alert:${userId}`);
  });

  it("returns 404 when user is not a team member", async () => {
    mockRequireTeamMember.mockRejectedValue(new MockTeamAuthError("NOT_FOUND", 404));
    const res = await POST(makeRequest({ newBreachCount: 1, teamId: "team-abc" }));
    expect(res.status).toBe(404);
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("uses team rate limit key when teamId is provided", async () => {
    mockWithUserTenantRls.mockResolvedValue({ email: null, locale: "en" });
    const res = await POST(makeRequest({ newBreachCount: 1, teamId: "team-abc" }));
    expect(res.status).toBe(200);
    expect(mockCheck).toHaveBeenCalledWith(`rl:watchtower:alert:team:team-abc:${userId}`);
  });

  it("logs audit with TEAM scope when teamId is provided", async () => {
    mockWithUserTenantRls.mockResolvedValue({ email: null, locale: "en" });
    const res = await POST(makeRequest({ newBreachCount: 5, teamId: "team-abc" }));
    expect(res.status).toBe(200);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TEAM",
        action: "WATCHTOWER_ALERT_SENT",
        userId,
        teamId: "team-abc",
        metadata: { newBreachCount: 5, teamId: "team-abc" },
      }),
    );
  });

  it("logs audit with PERSONAL scope when no teamId", async () => {
    mockWithUserTenantRls.mockResolvedValue({ email: null, locale: "en" });
    const res = await POST(makeRequest({ newBreachCount: 2 }));
    expect(res.status).toBe(200);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "PERSONAL",
        action: "WATCHTOWER_ALERT_SENT",
        userId,
        metadata: { newBreachCount: 2 },
      }),
    );
  });
});
