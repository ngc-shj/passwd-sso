import { describe, it, expect, vi, beforeEach } from "vitest";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit";

const {
  mockEnqueueAudit,
  mockDeadLetterWarn,
  mockUserFindUnique,
  mockTeamFindUnique,
} = vi.hoisted(() => ({
  mockEnqueueAudit: vi.fn().mockResolvedValue(undefined),
  mockDeadLetterWarn: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockTeamFindUnique: vi.fn(),
}));

vi.mock("@/lib/audit-outbox", () => ({
  enqueueAudit: mockEnqueueAudit,
  enqueueAuditInTx: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    team: { findUnique: mockTeamFindUnique },
    user: { findUnique: mockUserFindUnique },
    auditLog: { create: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock("@/lib/audit-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit-logger")>();
  return {
    ...actual,
    auditLogger: { info: vi.fn(), enabled: false },
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

import { logAuditAsync } from "@/lib/audit";

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

  it("dead-letters non-UUID userId without tenantId", async () => {
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "anonymous",
    });

    expect(mockEnqueueAudit).not.toHaveBeenCalled();
    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "non_uuid_userId_no_tenantId" }),
      "audit.dead_letter",
    );
  });

  it("propagates enqueueAudit rejection without throwing", async () => {
    mockUserFindUnique.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      tenantId: "tenant-1",
    });
    mockEnqueueAudit.mockRejectedValueOnce(new Error("outbox write failed"));

    // logAuditAsync should propagate the rejection (caller decides how to handle)
    await expect(
      logAuditAsync({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.AUTH_LOGIN,
        userId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("outbox write failed");
  });
});
