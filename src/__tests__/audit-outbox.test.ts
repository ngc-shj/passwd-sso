import { describe, it, expect, vi, beforeEach } from "vitest";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import type { AuditOutboxPayload } from "@/lib/audit/audit-outbox";

// ─── Shared mock handles ─────────────────────────────────────────────────────

const {
  mockAuditOutboxCreate,
  mockQueryRaw,
  mockExecuteRaw,
  mockTransaction,
} = vi.hoisted(() => {
  const mockAuditOutboxCreate = vi.fn().mockResolvedValue({});
  const mockQueryRaw = vi.fn();
  const mockExecuteRaw = vi.fn().mockResolvedValue(undefined);

  // tx object passed inside $transaction callback
  const txClient = {
    auditOutbox: { create: mockAuditOutboxCreate },
    $queryRaw: mockQueryRaw,
    $executeRaw: mockExecuteRaw,
  };

  const mockTransaction = vi.fn(
    async (fn: (tx: typeof txClient) => Promise<unknown>) => fn(txClient),
  );

  return {
    mockAuditOutboxCreate,
    mockQueryRaw,
    mockExecuteRaw,
    mockTransaction,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockTransaction,
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  BYPASS_PURPOSE: { AUDIT_WRITE: "audit_write" },
}));

import { enqueueAuditInTx, enqueueAudit } from "@/lib/audit/audit-outbox";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SAMPLE_PAYLOAD: AuditOutboxPayload = {
  scope: AUDIT_SCOPE.PERSONAL,
  action: AUDIT_ACTION.AUTH_LOGIN,
  userId: "user-1",
  actorType: "HUMAN",
  serviceAccountId: null,
  teamId: null,
  targetType: null,
  targetId: null,
  metadata: null,
  ip: null,
  userAgent: null,
};

const TX_CLIENT = {
  auditOutbox: { create: mockAuditOutboxCreate },
  $queryRaw: mockQueryRaw,
  $executeRaw: mockExecuteRaw,
};

// ─── enqueueAuditInTx ────────────────────────────────────────────────────────

describe("enqueueAuditInTx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an AuditOutbox row with correct tenantId and payload", async () => {
    // bypass_rls = 'on' → skip tenant_id check
    mockQueryRaw
      .mockResolvedValueOnce([{ bypass_rls: "on", tenant_id: "" }]) // ctx check
      .mockResolvedValueOnce([{ ok: true }]); // tenant exists

    await enqueueAuditInTx(TX_CLIENT as never, "tenant-1", SAMPLE_PAYLOAD);

    expect(mockAuditOutboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        payload: expect.objectContaining({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.AUTH_LOGIN,
          userId: "user-1",
          actorType: "HUMAN",
        }),
      }),
    });
  });

  it("throws when bypass_rls is not 'on' and tenant_id does not match", async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { bypass_rls: "off", tenant_id: "different-tenant" },
    ]);

    await expect(
      enqueueAuditInTx(TX_CLIENT as never, "tenant-1", SAMPLE_PAYLOAD),
    ).rejects.toThrow(/bypass_rls/);
  });

  it("proceeds when bypass_rls is not 'on' but tenant_id matches", async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ bypass_rls: "off", tenant_id: "tenant-1" }]) // tenant_id matches
      .mockResolvedValueOnce([{ ok: true }]); // tenant exists

    await expect(
      enqueueAuditInTx(TX_CLIENT as never, "tenant-1", SAMPLE_PAYLOAD),
    ).resolves.toBeUndefined();
    expect(mockAuditOutboxCreate).toHaveBeenCalledTimes(1);
  });

  it("throws when tenantId does not exist in tenants table", async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ bypass_rls: "on", tenant_id: "" }]) // ctx check passes
      .mockResolvedValueOnce([{ ok: false }]); // tenant NOT found

    await expect(
      enqueueAuditInTx(TX_CLIENT as never, "nonexistent-tenant", SAMPLE_PAYLOAD),
    ).rejects.toThrow(/does not exist/);
  });

  it("passes full payload fields through to auditOutbox.create", async () => {
    const richPayload: AuditOutboxPayload = {
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: "user-2",
      actorType: "SERVICE_ACCOUNT",
      serviceAccountId: "sa-1",
      teamId: "team-1",
      targetType: "PASSWORD_ENTRY",
      targetId: "entry-1",
      metadata: { key: "value" },
      ip: "10.0.0.1",
      userAgent: "TestAgent/1.0",
    };

    mockQueryRaw
      .mockResolvedValueOnce([{ bypass_rls: "on", tenant_id: "" }])
      .mockResolvedValueOnce([{ ok: true }]);

    await enqueueAuditInTx(TX_CLIENT as never, "tenant-1", richPayload);

    expect(mockAuditOutboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        payload: expect.objectContaining({
          scope: AUDIT_SCOPE.TEAM,
          action: AUDIT_ACTION.ENTRY_CREATE,
          userId: "user-2",
          actorType: "SERVICE_ACCOUNT",
          serviceAccountId: "sa-1",
          teamId: "team-1",
          targetType: "PASSWORD_ENTRY",
          targetId: "entry-1",
          metadata: { key: "value" },
          ip: "10.0.0.1",
          userAgent: "TestAgent/1.0",
        }),
      }),
    });
  });
});

// ─── enqueueAudit ────────────────────────────────────────────────────────────

describe("enqueueAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults: bypass_rls on + tenant exists
    mockQueryRaw
      .mockResolvedValueOnce([{ bypass_rls: "on", tenant_id: "" }])
      .mockResolvedValueOnce([{ ok: true }]);
  });

  it("opens a transaction", async () => {
    await enqueueAudit("tenant-1", SAMPLE_PAYLOAD);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("sets app.bypass_rls GUC inside the transaction", async () => {
    await enqueueAudit("tenant-1", SAMPLE_PAYLOAD);

    // $executeRaw is called for each SET CONFIG
    expect(mockExecuteRaw).toHaveBeenCalled();
  });

  it("delegates to enqueueAuditInTx and creates the row", async () => {
    await enqueueAudit("tenant-1", SAMPLE_PAYLOAD);

    expect(mockAuditOutboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: "tenant-1" }),
      }),
    );
  });
});
