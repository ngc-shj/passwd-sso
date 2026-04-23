import { describe, it, expect, vi, beforeEach } from "vitest";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit";
import { ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";

const {
  mockEnqueueAudit,
  mockDeadLetterWarn,
  mockUserFindUnique,
  mockTeamFindUnique,
  mockAuditLogCreate,
} = vi.hoisted(() => ({
  mockEnqueueAudit: vi.fn().mockResolvedValue(undefined),
  mockDeadLetterWarn: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockTeamFindUnique: vi.fn(),
  mockAuditLogCreate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit/audit-outbox", () => ({
  enqueueAudit: mockEnqueueAudit,
  enqueueAuditInTx: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    team: { findUnique: mockTeamFindUnique },
    user: { findUnique: mockUserFindUnique },
    auditLog: { create: mockAuditLogCreate },
  },
}));

const mockAuditInfo = vi.hoisted(() => vi.fn());

vi.mock("@/lib/audit/audit-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit/audit-logger")>();
  return {
    ...actual,
    auditLogger: { info: mockAuditInfo, enabled: true },
    deadLetterLogger: { warn: mockDeadLetterWarn },
  };
});

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: (_prisma: unknown, fn: () => unknown, _purpose: unknown) => fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { logAuditAsync } from "@/lib/audit/audit";

describe("logAuditAsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueueAudit.mockResolvedValue(undefined);
  });

  it("enqueues to outbox with explicit tenantId", async () => {
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "00000000-0000-4000-8000-000000000001",
      tenantId: "tenant-1",
    });

    expect(mockEnqueueAudit).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.AUTH_LOGIN,
        userId: "00000000-0000-4000-8000-000000000001",
        actorType: "HUMAN",
      }),
    );
  });

  it("enqueues ANONYMOUS actor via outbox when userId is ANONYMOUS_ACTOR_ID", async () => {
    await logAuditAsync({
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION.SHARE_ACCESS_VERIFY_SUCCESS,
      userId: ANONYMOUS_ACTOR_ID,
      actorType: "ANONYMOUS",
      tenantId: "tenant-1",
    });

    // ANONYMOUS actor MUST flow through outbox, not direct write
    expect(mockEnqueueAudit).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({
        userId: ANONYMOUS_ACTOR_ID,
        actorType: "ANONYMOUS",
        action: AUDIT_ACTION.SHARE_ACCESS_VERIFY_SUCCESS,
      }),
    );
    // Direct write must NOT be called
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
  });

  it("accepts explicit actorType for sentinel userId (no coercion)", async () => {
    await logAuditAsync({
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
      userId: ANONYMOUS_ACTOR_ID,
      actorType: "ANONYMOUS",
      tenantId: "tenant-1",
    });

    // actorType must remain ANONYMOUS — no coercion to another type
    expect(mockEnqueueAudit).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({
        userId: ANONYMOUS_ACTOR_ID,
        actorType: "ANONYMOUS",
      }),
    );
  });

  it("dead-letters sentinel userId when tenantId is absent AND user lookup fails", async () => {
    // Sentinel IDs are not in the users table, so resolveTenantId returns null
    mockUserFindUnique.mockResolvedValue(null);

    await logAuditAsync({
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
      userId: ANONYMOUS_ACTOR_ID,
      actorType: "ANONYMOUS",
      // tenantId intentionally omitted
    });

    expect(mockAuditLogCreate).not.toHaveBeenCalled();
    expect(mockEnqueueAudit).not.toHaveBeenCalled();
    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "tenant_not_found" }),
      "audit.dead_letter",
    );
  });

  it("resolves tenantId from userId when not provided", async () => {
    mockUserFindUnique.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000042",
      tenantId: "tenant-from-user",
    });

    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: "00000000-0000-4000-8000-000000000042",
    });

    expect(mockUserFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "00000000-0000-4000-8000-000000000042" },
      }),
    );
    expect(mockEnqueueAudit).toHaveBeenCalledWith(
      "tenant-from-user",
      expect.objectContaining({ userId: "00000000-0000-4000-8000-000000000042" }),
    );
  });

  it("resolves tenantId from teamId when provided", async () => {
    mockTeamFindUnique.mockResolvedValue({
      id: "team-99",
      tenantId: "tenant-from-team",
    });

    await logAuditAsync({
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: "00000000-0000-4000-8000-000000000001",
      teamId: "team-99",
    });

    expect(mockTeamFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "team-99" } }),
    );
    expect(mockEnqueueAudit).toHaveBeenCalledWith(
      "tenant-from-team",
      expect.objectContaining({ teamId: "team-99" }),
    );
  });

  it("dead-letters entry when tenantId cannot be resolved", async () => {
    mockUserFindUnique.mockResolvedValue(null);

    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "00000000-0000-4000-8000-0000000000ff",
    });

    expect(mockEnqueueAudit).not.toHaveBeenCalled();
    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "tenant_not_found" }),
      "audit.dead_letter",
    );
  });

  it("dead-letters UUID userId when user lookup returns null (tenant_not_found)", async () => {
    // UUID userId that doesn't exist in DB — resolveTenantId returns null
    mockUserFindUnique.mockResolvedValue(null);

    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "00000000-0000-4000-8000-00000000ffff",
    });

    expect(mockEnqueueAudit).not.toHaveBeenCalled();
    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "tenant_not_found" }),
      "audit.dead_letter",
    );
  });

  it("catches enqueueAudit rejection and logs to dead letter (never throws)", async () => {
    mockUserFindUnique.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      tenantId: "tenant-1",
    });
    mockEnqueueAudit.mockRejectedValueOnce(new Error("outbox write failed"));

    // logAuditAsync must never throw — errors go to deadLetterLogger
    await expect(
      logAuditAsync({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.AUTH_LOGIN,
        userId: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toBeUndefined();

    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "logAuditAsync_failed",
        error: expect.stringContaining("outbox write failed"),
      }),
      "audit.dead_letter",
    );
  });

  it("emits structured JSON to auditLogger before outbox write", async () => {
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "00000000-0000-4000-8000-000000000001",
      tenantId: "tenant-1",
    });

    expect(mockAuditInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.AUTH_LOGIN,
          tenantId: "tenant-1",
        }),
      }),
      "audit.AUTH_LOGIN",
    );
  });

  it("dead letter output does not contain raw metadata", async () => {
    mockUserFindUnique.mockResolvedValue(null);

    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "00000000-0000-4000-8000-0000000000ff",
      metadata: { password: "secret", token: "bearer-xyz" },
    });

    const deadLetterCall = mockDeadLetterWarn.mock.calls[0][0];
    expect(deadLetterCall).not.toHaveProperty("auditEntry");
    expect(deadLetterCall).not.toHaveProperty("metadata");
    expect(deadLetterCall).toHaveProperty("reason", "tenant_not_found");
  });
});
