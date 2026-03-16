import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockCreate, mockCreateMany, mockUserFindUnique, mockWithBypassRls, mockAuditLoggerInfo } =
  vi.hoisted(() => ({
    mockCreate: vi.fn(),
    mockCreateMany: vi.fn(),
    mockUserFindUnique: vi.fn(),
    mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
    mockAuditLoggerInfo: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: mockCreate,
      createMany: mockCreateMany,
    },
    user: {
      findUnique: mockUserFindUnique,
    },
    team: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/audit-logger", () => ({
  auditLogger: { info: mockAuditLoggerInfo },
  METADATA_BLOCKLIST: new Set<string>([
    "password",
    "passphrase",
    "secret",
    "secretKey",
    "encryptedBlob",
    "encryptedOverview",
    "encryptedData",
    "encryptedSecretKey",
    "encryptedTeamKey",
    "masterPasswordServerHash",
    "token",
    "tokenHash",
    "accessToken",
    "refreshToken",
    "idToken",
    "accountSalt",
    "passphraseVerifierHmac",
  ]),
}));

import { logAudit, logAuditBatch } from "./audit";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("logAuditBatch data equivalence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockCreate.mockResolvedValue({});
    mockCreateMany.mockResolvedValue({ count: 0 });
  });

  it("createMany data matches what individual logAudit.create calls would produce", async () => {
    logAuditBatch([
      {
        scope: "PERSONAL",
        action: "ENTRY_UPDATE",
        userId: "u1",
        targetType: "PASSWORD_ENTRY",
        targetId: "e1",
        metadata: { source: "bulk-archive" },
        ip: "1.2.3.4",
        userAgent: "Mozilla/5.0",
      },
      {
        scope: "PERSONAL",
        action: "ENTRY_UPDATE",
        userId: "u1",
        targetType: "PASSWORD_ENTRY",
        targetId: "e2",
        metadata: { source: "bulk-archive" },
        ip: "1.2.3.4",
        userAgent: "Mozilla/5.0",
      },
      {
        scope: "PERSONAL",
        action: "ENTRY_UPDATE",
        userId: "u1",
        targetType: "PASSWORD_ENTRY",
        targetId: "e3",
        metadata: { source: "bulk-archive" },
        ip: "1.2.3.4",
        userAgent: "Mozilla/5.0",
      },
    ]);

    await vi.waitFor(() => expect(mockCreateMany).toHaveBeenCalled());

    const createManyData = mockCreateMany.mock.calls[0][0].data;

    // Each entry must have the full set of fields matching logAudit's create contract
    for (const entry of createManyData) {
      expect(entry).toEqual(
        expect.objectContaining({
          scope: expect.any(String),
          action: expect.any(String),
          userId: expect.any(String),
          tenantId: expect.any(String), // must be resolved, not null
          teamId: null,
          targetType: expect.any(String),
          targetId: expect.any(String),
          metadata: expect.any(Object),
          ip: expect.any(String),
          userAgent: expect.any(String),
        }),
      );
    }

    // Exact count
    expect(createManyData).toHaveLength(3);

    // Per-entry data is distinct — not all identical
    expect(createManyData[0].targetId).toBe("e1");
    expect(createManyData[1].targetId).toBe("e2");
    expect(createManyData[2].targetId).toBe("e3");

    // Shared fields are correctly propagated
    expect(createManyData[0].userId).toBe("u1");
    expect(createManyData[0].tenantId).toBe("tenant-1");
    expect(createManyData[0].ip).toBe("1.2.3.4");
  });

  it("truncates metadata exceeding 10KB identically to logAudit", async () => {
    const bigMeta = { data: "x".repeat(11_000) };

    // logAuditBatch path
    logAuditBatch([
      {
        scope: "PERSONAL",
        action: "ENTRY_UPDATE",
        userId: "u1",
        targetType: "PASSWORD_ENTRY",
        targetId: "e1",
        metadata: bigMeta,
      },
    ]);

    await vi.waitFor(() => expect(mockCreateMany).toHaveBeenCalled());

    const batchEntry = mockCreateMany.mock.calls[0][0].data[0];
    expect(batchEntry.metadata).toEqual({
      _truncated: true,
      _originalSize: expect.any(Number),
    });
    expect(batchEntry.metadata._originalSize).toBeGreaterThan(10_240);

    // logAudit path (individual) must produce the same truncation shape
    vi.clearAllMocks();
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockCreate.mockResolvedValue({});

    logAudit({
      scope: "PERSONAL",
      action: "ENTRY_UPDATE",
      userId: "u1",
      targetType: "PASSWORD_ENTRY",
      targetId: "e1",
      metadata: bigMeta,
    });

    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalled());

    const singleEntry = mockCreate.mock.calls[0][0].data;
    expect(singleEntry.metadata).toEqual({
      _truncated: true,
      _originalSize: expect.any(Number),
    });

    // Both paths must produce the same _originalSize
    expect(batchEntry.metadata._originalSize).toBe(singleEntry.metadata._originalSize);
  });

  it("slices userAgent to 512 chars identically to logAudit", async () => {
    const longUA = "A".repeat(1000);

    // logAuditBatch path
    logAuditBatch([
      {
        scope: "PERSONAL",
        action: "ENTRY_UPDATE",
        userId: "u1",
        targetType: "PASSWORD_ENTRY",
        targetId: "e1",
        userAgent: longUA,
      },
    ]);

    await vi.waitFor(() => expect(mockCreateMany).toHaveBeenCalled());

    const batchUA = mockCreateMany.mock.calls[0][0].data[0].userAgent;
    expect(batchUA).toHaveLength(512);
    expect(batchUA).toBe("A".repeat(512));

    // logAudit path (individual) must produce the same truncation
    vi.clearAllMocks();
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockCreate.mockResolvedValue({});

    logAudit({
      scope: "PERSONAL",
      action: "ENTRY_UPDATE",
      userId: "u1",
      targetType: "PASSWORD_ENTRY",
      targetId: "e1",
      userAgent: longUA,
    });

    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalled());

    const singleUA = mockCreate.mock.calls[0][0].data.userAgent;
    expect(singleUA).toHaveLength(512);
    expect(singleUA).toBe(batchUA);
  });

  it("emits structured JSON per entry (not batched) via auditLogger", () => {
    logAuditBatch([
      {
        scope: "PERSONAL",
        action: "ENTRY_UPDATE",
        userId: "u1",
        targetType: "PASSWORD_ENTRY",
        targetId: "e1",
        metadata: { source: "bulk-archive" },
      },
      {
        scope: "PERSONAL",
        action: "ENTRY_UPDATE",
        userId: "u1",
        targetType: "PASSWORD_ENTRY",
        targetId: "e2",
        metadata: { source: "bulk-archive" },
      },
      {
        scope: "PERSONAL",
        action: "ENTRY_UPDATE",
        userId: "u1",
        targetType: "PASSWORD_ENTRY",
        targetId: "e3",
        metadata: { source: "bulk-archive" },
      },
    ]);

    // auditLogger.info is called synchronously, once per entry — not once for all
    expect(mockAuditLoggerInfo).toHaveBeenCalledTimes(3);

    // Each call carries a distinct targetId
    const calls = mockAuditLoggerInfo.mock.calls;
    expect(calls[0][0].audit.targetId).toBe("e1");
    expect(calls[1][0].audit.targetId).toBe("e2");
    expect(calls[2][0].audit.targetId).toBe("e3");

    // Message format matches logAudit: "audit.<action>"
    expect(calls[0][1]).toBe("audit.ENTRY_UPDATE");
  });
});
