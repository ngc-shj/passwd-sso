import { describe, it, expect, vi, beforeEach } from "vitest";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import type { AuditOutboxPayload } from "@/lib/audit/audit-outbox";

// ─── Shared mock handles ─────────────────────────────────────────────────────

const {
  mockAuditOutboxCreate,
  mockAuditOutboxCreateMany,
  mockQueryRaw,
  mockExecuteRaw,
  mockTransaction,
  mockProxiedTransaction,
} = vi.hoisted(() => {
  const mockAuditOutboxCreate = vi.fn().mockResolvedValue({});
  const mockAuditOutboxCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const mockQueryRaw = vi.fn();
  const mockExecuteRaw = vi.fn().mockResolvedValue(undefined);

  // tx object passed inside $transaction callback
  const txClient = {
    auditOutbox: { create: mockAuditOutboxCreate, createMany: mockAuditOutboxCreateMany },
    $queryRaw: mockQueryRaw,
    $executeRaw: mockExecuteRaw,
  };

  const mockTransaction = vi.fn(
    async (fn: (tx: typeof txClient) => Promise<unknown>) => fn(txClient),
  );

  // The PROXIED client's $transaction. Nothing in this module may reach it:
  // under an active RLS context the Proxy folds it into the caller's
  // transaction, which is the defect prismaBase exists to make unreachable.
  const mockProxiedTransaction = vi.fn(
    async (fn: (tx: typeof txClient) => Promise<unknown>) => fn(txClient),
  );

  return {
    mockAuditOutboxCreate,
    mockAuditOutboxCreateMany,
    mockQueryRaw,
    mockExecuteRaw,
    mockTransaction,
    mockProxiedTransaction,
  };
});

// Two distinct spies, deliberately. `mockTransaction` is prismaBase's — the one
// BOTH openers must use — and `mockProxiedTransaction` is the Proxy's, asserted
// untouched by each of them. A single shared spy would make the client choice
// unobservable, which is the whole property C1 buys.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockProxiedTransaction,
  },
  prismaBase: {
    $transaction: mockTransaction,
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  BYPASS_PURPOSE: { AUDIT_WRITE: "audit_write" },
}));

import { enqueueAuditInTx, enqueueAudit, enqueueAuditBulk } from "@/lib/audit/audit-outbox";

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
  auditOutbox: { create: mockAuditOutboxCreate, createMany: mockAuditOutboxCreateMany },
  $queryRaw: mockQueryRaw,
  $executeRaw: mockExecuteRaw,
};

// ─── enqueueAuditInTx ────────────────────────────────────────────────────────

/** A full row of readBypassState's four-column read; unset columns are null. */
type BypassStateRow = { bypass_rls: string | null; purpose: string | null; tenant_id: string | null; tables: string | null };
function bypassStateRow(row: Partial<BypassStateRow>): BypassStateRow {
  return { bypass_rls: null, purpose: null, tenant_id: null, tables: null, ...row };
}

describe("enqueueAuditInTx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an AuditOutbox row with correct tenantId and payload", async () => {
    // bypass_rls = 'on' → skip tenant_id check. No tenant-existence probe
    // (C4): the FK is what rejects an unknown tenantId now, at the create() call.
    mockQueryRaw.mockResolvedValueOnce([bypassStateRow({ bypass_rls: "on", tenant_id: "" })]); // ctx check

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
    mockQueryRaw.mockResolvedValueOnce([{ bypass_rls: "off", tenant_id: "tenant-1" }]); // tenant_id matches

    await expect(
      enqueueAuditInTx(TX_CLIENT as never, "tenant-1", SAMPLE_PAYLOAD),
    ).resolves.toBeUndefined();
    expect(mockAuditOutboxCreate).toHaveBeenCalledTimes(1);
  });

  it("propagates the audit_outbox FK violation when tenantId does not exist (C4 — no more probe)", async () => {
    mockQueryRaw.mockResolvedValueOnce([bypassStateRow({ bypass_rls: "on", tenant_id: "" })]); // ctx check passes
    const fkViolation = Object.assign(new Error("Foreign key constraint violated: audit_outbox_tenant_id_fkey"), {
      code: "P2003",
    });
    mockAuditOutboxCreate.mockRejectedValueOnce(fkViolation);

    await expect(
      enqueueAuditInTx(TX_CLIENT as never, "nonexistent-tenant", SAMPLE_PAYLOAD),
    ).rejects.toBe(fkViolation);
    // Only the ctx-check read — no tenant-existence SELECT EXISTS probe.
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
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

    mockQueryRaw.mockResolvedValueOnce([bypassStateRow({ bypass_rls: "on", tenant_id: "" })]);

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
    // Default: bypass_rls on. enqueueAudit's path (enqueueAuditInTx) no
    // longer probes tenant existence (C4), so this is the only queued read
    // most tests here need; enqueueAuditBulk still probes on its own (that
    // function's grant is fixed and names `tenants`), so its one test below
    // queues its own second value rather than relying on a leftover here —
    // an unconsumed once-value otherwise carries into the NEXT test's queue
    // and misaligns it.
    mockQueryRaw.mockResolvedValueOnce([bypassStateRow({ bypass_rls: "on", tenant_id: "" })]);
  });

  it("opens its transaction on the un-proxied client, never the Proxy", async () => {
    // I1.1. The Proxy folds $transaction into an active RLS context; the
    // un-proxied client cannot be folded. Which client the openers use is the
    // whole content of that invariant, and it is invisible to every static gate
    // in the tree — so it is pinned here and, against a real database, by a
    // txid_current() comparison in the integration suite.
    await enqueueAudit("tenant-1", SAMPLE_PAYLOAD);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockProxiedTransaction).not.toHaveBeenCalled();
  });

  it("enqueueAuditBulk opens on the un-proxied client too", async () => {
    // I1.1 is quantified over BOTH openers. Reverting only this one left the
    // whole unit suite green until this case existed — the singular pin says
    // nothing about it, and no static gate can tell the two clients apart.
    // enqueueAuditBulk keeps its own tenant-existence probe (unlike
    // enqueueAuditInTx, C4), so it needs this second queued read.
    mockQueryRaw.mockResolvedValueOnce([{ ok: true }]);
    await enqueueAuditBulk("tenant-1", [SAMPLE_PAYLOAD, SAMPLE_PAYLOAD]);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockProxiedTransaction).not.toHaveBeenCalled();
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
