import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockAuditLogCreate,
  mockRequireTeamPermission,
  TeamAuthError,
  mockWithTeamTenantRls,
  mockRateLimiterCheck,
  mockLogAudit,
  mockCreateTeamPassword,
  TeamPasswordServiceError,
} = vi.hoisted(() => {
  class _TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }

  class _TeamPasswordServiceError extends Error {
    code: string;
    statusHint: number;
    constructor(code: string, statusHint: number) {
      super(code);
      this.name = "TeamPasswordServiceError";
      this.code = code;
      this.statusHint = statusHint;
    }
  }

  return {
    mockAuth: vi.fn(),
    mockAuditLogCreate: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
    mockRateLimiterCheck: vi.fn(),
    mockLogAudit: vi.fn(),
    mockCreateTeamPassword: vi.fn(),
    TeamPasswordServiceError: _TeamPasswordServiceError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { create: mockAuditLogCreate },
  },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({}),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/services/team-password-service", () => ({
  createTeamPassword: mockCreateTeamPassword,
  TeamPasswordServiceError,
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

import { POST } from "./route";
import { AUDIT_ACTION, TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-123";
const URL = `http://localhost:3000/api/teams/${TEAM_ID}/passwords/bulk-import`;

const makeEntry = (id: string) => ({
  id,
  encryptedBlob: { ciphertext: "blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
  encryptedOverview: { ciphertext: "over", iv: "c".repeat(24), authTag: "d".repeat(32) },
  aadVersion: 1,
  teamKeyVersion: 1,
  itemKeyVersion: 0,
  entryType: "LOGIN",
});

describe("POST /api/teams/[teamId]/passwords/bulk-import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.MEMBER });
    mockAuditLogCreate.mockResolvedValue({});
    mockCreateTeamPassword.mockImplementation((_teamId: string, input: { id: string }) =>
      Promise.resolve({ id: input.id, entryType: "LOGIN", tags: [], createdAt: new Date() }),
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", URL, { body: { entries: [makeEntry("660e8400-e29b-41d4-a716-000000000001")] } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when user lacks team permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await POST(
      createRequest("POST", URL, { body: { entries: [makeEntry("660e8400-e29b-41d4-a716-000000000001")] } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-TeamAuthError", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      POST(
        createRequest("POST", URL, { body: { entries: [makeEntry("660e8400-e29b-41d4-a716-000000000001")] } }),
        createParams({ teamId: TEAM_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 2000 });
    const res = await POST(
      createRequest("POST", URL, { body: { entries: [makeEntry("660e8400-e29b-41d4-a716-000000000001")] } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(429);
  });

  it("rate limiter key includes teamId and userId", async () => {
    await POST(
      createRequest("POST", URL, { body: { entries: [makeEntry("660e8400-e29b-41d4-a716-000000000001")] } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockRateLimiterCheck).toHaveBeenCalledWith(
      `rl:team_bulk_import:${TEAM_ID}:test-user-id`,
    );
  });

  it("returns 400 when entries array is empty", async () => {
    const res = await POST(
      createRequest("POST", URL, { body: { entries: [] } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("imports team entries successfully (201)", async () => {
    const entries = [
      makeEntry("660e8400-e29b-41d4-a716-000000000001"),
      makeEntry("660e8400-e29b-41d4-a716-000000000002"),
      makeEntry("660e8400-e29b-41d4-a716-000000000003"),
    ];

    const res = await POST(
      createRequest("POST", URL, { body: { entries } }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(3);
    expect(json.failed).toBe(0);
  });

  it("handles partial failure when service throws a generic error", async () => {
    mockCreateTeamPassword
      .mockResolvedValueOnce({ id: "660e8400-e29b-41d4-a716-000000000001", entryType: "LOGIN", tags: [], createdAt: new Date() })
      .mockRejectedValueOnce(new Error("DB timeout"));

    const entries = [
      makeEntry("660e8400-e29b-41d4-a716-000000000001"),
      makeEntry("660e8400-e29b-41d4-a716-000000000002"),
    ];

    const res = await POST(
      createRequest("POST", URL, { body: { entries } }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(1);
    expect(json.failed).toBe(1);
  });

  it("handles partial failure when service throws TeamPasswordServiceError", async () => {
    mockCreateTeamPassword
      .mockResolvedValueOnce({ id: "660e8400-e29b-41d4-a716-000000000001", entryType: "LOGIN", tags: [], createdAt: new Date() })
      .mockRejectedValueOnce(new TeamPasswordServiceError("TEAM_KEY_VERSION_MISMATCH", 409))
      .mockResolvedValueOnce({ id: "660e8400-e29b-41d4-a716-000000000003", entryType: "LOGIN", tags: [], createdAt: new Date() });

    const entries = [
      makeEntry("660e8400-e29b-41d4-a716-000000000001"),
      makeEntry("660e8400-e29b-41d4-a716-000000000002"),
      makeEntry("660e8400-e29b-41d4-a716-000000000003"),
    ];

    const res = await POST(
      createRequest("POST", URL, { body: { entries } }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(2);
    expect(json.failed).toBe(1);
  });

  it("calls logAuditAsync with ENTRY_BULK_IMPORT and TEAM scope", async () => {
    const entries = [
      makeEntry("660e8400-e29b-41d4-a716-000000000001"),
      makeEntry("660e8400-e29b-41d4-a716-000000000002"),
    ];

    await POST(
      createRequest("POST", URL, { body: { entries } }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(mockLogAudit).toHaveBeenCalledTimes(3); // 1 parent + 2 per-entry
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.ENTRY_BULK_IMPORT,
        teamId: TEAM_ID,
        metadata: expect.objectContaining({
          bulk: true,
          requestedCount: 2,
          createdCount: 2,
          failedCount: 0,
        }),
      }),
    );
  });

  it("calls logAuditAsync with ENTRY_CREATE for each created team entry", async () => {
    const entries = [
      makeEntry("660e8400-e29b-41d4-a716-000000000001"),
      makeEntry("660e8400-e29b-41d4-a716-000000000002"),
    ];

    await POST(
      createRequest("POST", URL, { body: { entries } }),
      createParams({ teamId: TEAM_ID }),
    );

    // logAuditAsync called once per entry with ENTRY_CREATE
    expect(mockLogAudit).toHaveBeenCalledTimes(3); // 1 parent + 2 per-entry
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.ENTRY_CREATE,
        targetId: "660e8400-e29b-41d4-a716-000000000001",
        teamId: TEAM_ID,
        metadata: expect.objectContaining({
          source: "bulk-import",
          parentAction: AUDIT_ACTION.ENTRY_BULK_IMPORT,
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.ENTRY_CREATE,
        targetId: "660e8400-e29b-41d4-a716-000000000002",
        teamId: TEAM_ID,
        metadata: expect.objectContaining({
          source: "bulk-import",
          parentAction: AUDIT_ACTION.ENTRY_BULK_IMPORT,
        }),
      }),
    );
  });
});
