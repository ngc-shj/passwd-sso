import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const mockPasswordEntry = {
  findMany: vi.fn(),
  updateMany: vi.fn(),
};
const mockPasswordEntryHistory = {
  findMany: vi.fn(),
  updateMany: vi.fn(),
};
const mockAttachment = {
  findMany: vi.fn(),
  count: vi.fn(),
};
const mockWebAuthnCredential = {
  updateMany: vi.fn(),
};
const mockUserTx = {
  findUnique: vi.fn(),
  update: vi.fn(),
};

const { mockAuth, mockPrismaUser, mockPrismaVaultKey, mockTransaction, mockMarkStale, mockWithUserTenantRls, mockRateLimiterCheck, mockInvalidateUserSessions } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  mockPrismaVaultKey: {
    create: vi.fn(),
  },
  mockTransaction: vi.fn(),
  mockMarkStale: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockRateLimiterCheck: vi.fn(),
  mockInvalidateUserSessions: vi.fn(),
}));

// Transaction mock (txMock) for interactive transaction pattern
const txMock = {
  $executeRaw: vi.fn(),
  passwordEntry: mockPasswordEntry,
  passwordEntryHistory: mockPasswordEntryHistory,
  attachment: mockAttachment,
  webAuthnCredential: mockWebAuthnCredential,
  user: mockUserTx,
  vaultKey: { create: vi.fn() },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    vaultKey: mockPrismaVaultKey,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/emergency-access/emergency-access-server", () => ({
  markGrantsStaleForOwner: mockMarkStale,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/auth/session/user-session-invalidation", () => ({
  invalidateUserSessions: mockInvalidateUserSessions,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: vi.fn(() => ({})),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));

import { createHash } from "crypto";
import { POST } from "./route";

const serverSalt = "a".repeat(64);
const currentAuthHash = "b".repeat(64);
const serverHash = createHash("sha256")
  .update(currentAuthHash + serverSalt)
  .digest("hex");

const makeEncryptedField = () => ({
  ciphertext: "c".repeat(10),
  iv: "a".repeat(24),
  authTag: "b".repeat(32),
});

const validBody = {
  currentAuthHash,
  encryptedSecretKey: "new-encrypted-key",
  secretKeyIv: "c".repeat(24),
  secretKeyAuthTag: "d".repeat(32),
  accountSalt: "e".repeat(64),
  newAuthHash: "f".repeat(64),
  verificationArtifact: {
    ciphertext: "verify-cipher",
    iv: "a".repeat(24),
    authTag: "b".repeat(32),
  },
  entries: [],
  historyEntries: [],
  encryptedEcdhPrivateKey: "x".repeat(100),
  ecdhPrivateKeyIv: "a".repeat(24),
  ecdhPrivateKeyAuthTag: "b".repeat(32),
};

describe("POST /api/vault/rotate-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaUser.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      vaultSetupAt: new Date(),
      masterPasswordServerHash: serverHash,
      masterPasswordServerSalt: serverSalt,
      keyVersion: 1,
    });
    // Interactive transaction mock: execute the callback with txMock
    mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => unknown) => fn(txMock));
    // By default, DB has no entries/history/attachments (matches empty arrays in validBody)
    mockPasswordEntry.findMany.mockResolvedValue([]);
    mockPasswordEntryHistory.findMany.mockResolvedValue([]);
    mockAttachment.findMany.mockResolvedValue([]);
    mockAttachment.count.mockResolvedValue(0);
    mockPasswordEntry.updateMany.mockResolvedValue({ count: 1 });
    mockPasswordEntryHistory.updateMany.mockResolvedValue({ count: 1 });
    // tx.user.findUnique reads recoveryEncryptedSecretKey to compute
    // recoveryKeyInvalidated audit flag.
    mockUserTx.findUnique.mockResolvedValue({ recoveryEncryptedSecretKey: null });
    mockUserTx.update.mockResolvedValue({});
    mockWebAuthnCredential.updateMany.mockResolvedValue({ count: 0 });
    mockMarkStale.mockResolvedValue(0);
    mockInvalidateUserSessions.mockResolvedValue({
      sessions: 0,
      extensionTokens: 0,
      apiKeys: 0,
      mcpAccessTokens: 0,
      mcpRefreshTokens: 0,
      delegationSessions: 0,
      cacheTombstoneFailures: 0,
    });
    txMock.$executeRaw.mockResolvedValue(undefined);
    txMock.user.update.mockResolvedValue({});
    txMock.vaultKey.create.mockResolvedValue({});
    mockMarkStale.mockResolvedValue(0);
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false });
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    expect(res.status).toBe(429);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when vault not set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 for wrong current passphrase", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", {
        body: { ...validBody, currentAuthHash: "0".repeat(64) },
      })
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("INVALID_PASSPHRASE");
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/vault/rotate-key", {
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
      createRequest("POST", "http://localhost/api/vault/rotate-key", {
        body: { currentAuthHash: "short" },
      })
    );
    expect(res.status).toBe(400);
  });

  it("rotates key successfully with empty vault", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.keyVersion).toBe(2);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(txMock.$executeRaw).toHaveBeenCalled();
    expect(txMock.vaultKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        tenantId: "tenant-1",
        version: 2,
      }),
    });
    // Verify ALL user-bound auth artifacts are revoked after key rotation
    // (Session/ExtensionToken/ApiKey/McpAccessToken/McpRefreshToken/DelegationSession).
    // Replaces the prior single revokeAllDelegationSessions call which left
    // MCP tokens valid against the freshly-rotated vault — see plan #433 / S-N2.
    expect(mockInvalidateUserSessions).toHaveBeenCalledWith("user-1", {
      tenantId: "tenant-1",
      reason: "KEY_ROTATION",
    });
  });

  it("rotates key with entries and history (UUID v4 IDs — legacy label kept for context)", async () => {
    const entryId = "660e8400-e29b-41d4-a716-446655440020";
    const historyId = "660e8400-e29b-41d4-a716-446655440021";
    mockPasswordEntry.findMany.mockResolvedValue([{ id: entryId }]);
    mockPasswordEntryHistory.findMany.mockResolvedValue([{ id: historyId }]);

    const bodyWithEntries = {
      ...validBody,
      entries: [{
        id: entryId,
        encryptedBlob: makeEncryptedField(),
        encryptedOverview: makeEncryptedField(),
        aadVersion: 1,
      }],
      historyEntries: [{
        id: historyId,
        encryptedBlob: makeEncryptedField(),
        aadVersion: 1,
      }],
    };

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: bodyWithEntries })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.keyVersion).toBe(2);
    expect(mockPasswordEntry.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPasswordEntryHistory.updateMany).toHaveBeenCalledTimes(1);
  });

  it("rotates key with entries and history (UUID v4 IDs)", async () => {
    const entryId = "550e8400-e29b-41d4-a716-446655440000";
    const historyId = "550e8400-e29b-41d4-a716-446655440001";
    mockPasswordEntry.findMany.mockResolvedValue([{ id: entryId }]);
    mockPasswordEntryHistory.findMany.mockResolvedValue([{ id: historyId }]);

    const bodyWithEntries = {
      ...validBody,
      entries: [{
        id: entryId,
        encryptedBlob: makeEncryptedField(),
        encryptedOverview: makeEncryptedField(),
        aadVersion: 1,
      }],
      historyEntries: [{
        id: historyId,
        encryptedBlob: makeEncryptedField(),
        aadVersion: 1,
      }],
    };

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: bodyWithEntries })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.keyVersion).toBe(2);
    expect(mockPasswordEntry.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPasswordEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: entryId }),
      })
    );
    expect(mockPasswordEntryHistory.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPasswordEntryHistory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: historyId }),
      })
    );
  });

  it("returns 400 on entry count mismatch", async () => {
    // DB has 1 entry but client sends 0
    mockPasswordEntry.findMany.mockResolvedValue([{ id: "660e8400-e29b-41d4-a716-446655440030" }]);

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on history count mismatch", async () => {
    const entryId = "660e8400-e29b-41d4-a716-446655440020";
    // DB has 1 history entry but client sends 0
    mockPasswordEntry.findMany.mockResolvedValue([{ id: entryId }]);
    mockPasswordEntryHistory.findMany.mockResolvedValue([{ id: "660e8400-e29b-41d4-a716-446655440021" }]);

    const bodyWithEntry = {
      ...validBody,
      entries: [{
        id: entryId,
        encryptedBlob: makeEncryptedField(),
        encryptedOverview: makeEncryptedField(),
        aadVersion: 1,
      }],
      historyEntries: [], // client sends 0 but DB has 1
    };

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: bodyWithEntry })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when submitted entry IDs do not match DB entry IDs", async () => {
    const dbId = "660e8400-e29b-41d4-a716-446655440040";
    const wrongId = "660e8400-e29b-41d4-a716-446655440041";
    mockPasswordEntry.findMany.mockResolvedValue([{ id: dbId }]);

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", {
        body: {
          ...validBody,
          entries: [{
            id: wrongId,
            encryptedBlob: makeEncryptedField(),
            encryptedOverview: makeEncryptedField(),
            aadVersion: 1,
          }],
        },
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when entries exceed max limit", async () => {
    const tooManyEntries = Array.from({ length: 5001 }, (_, i) => ({
      id: `660e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`,
      encryptedBlob: makeEncryptedField(),
      encryptedOverview: makeEncryptedField(),
      aadVersion: 1,
    }));

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", {
        body: { ...validBody, entries: tooManyEntries },
      })
    );
    expect(res.status).toBe(400);
  });

  it("acquires advisory lock in transaction", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    expect(txMock.$executeRaw).toHaveBeenCalled();
  });

  it("updates ECDH private key fields", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    expect(txMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({
        encryptedEcdhPrivateKey: validBody.encryptedEcdhPrivateKey,
        ecdhPrivateKeyIv: validBody.ecdhPrivateKeyIv,
        ecdhPrivateKeyAuthTag: validBody.ecdhPrivateKeyAuthTag,
      }),
    });
  });

  it("calls markGrantsStaleForOwner with new keyVersion AND tx client (in-tx atomic)", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    // After #433 the call is inside the rotation tx and receives the tx client
    // as a third argument, so atomicity is preserved with the rest of the rotation.
    expect(mockMarkStale).toHaveBeenCalledWith("user-1", 2, txMock);
  });

  it("aborts rotation when markGrantsStaleForOwner throws inside tx (#433 / F10 atomicity trade-off)", async () => {
    mockMarkStale.mockRejectedValue(new Error("DB error"));
    // Behavior change vs prior best-effort post-tx: an EA-table failure now
    // bubbles up (handled by the Next.js framework as a 500 in production)
    // because the rotation rolls back atomically. The route does not
    // try/catch unknown errors — only ENTRY_COUNT_MISMATCH, HISTORY_COUNT_MISMATCH,
    // and AttachmentAckRequiredError are translated to structured responses.
    await expect(
      POST(
        createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
      )
    ).rejects.toThrow("DB error");
  });

  it("increments keyVersion from current value", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      vaultSetupAt: new Date(),
      masterPasswordServerHash: serverHash,
      masterPasswordServerSalt: serverSalt,
      keyVersion: 5,
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    const json = await res.json();
    expect(json.keyVersion).toBe(6);
    expect(mockMarkStale).toHaveBeenCalledWith("user-1", 6, txMock);
  });

  it("runs key rotation entirely within withUserTenantRls scope", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    // After #433: 2 calls. (1) Prisma.user.findUnique to fetch outer user,
    // (2) the rotation transaction. The EA stale call is now INSIDE the tx
    // (not a separate withUserTenantRls scope as it was pre-#433).
    expect(mockWithUserTenantRls).toHaveBeenCalledTimes(2);
    expect(mockWithUserTenantRls).toHaveBeenNthCalledWith(1, "user-1", expect.any(Function));
    expect(mockWithUserTenantRls).toHaveBeenNthCalledWith(2, "user-1", expect.any(Function));
  });

  it("truncates error details when >10 validation issues", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: {} }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details.errors[0]).toMatch(/Validation failed with \d+ errors/);
    expect(json.details).not.toHaveProperty("properties");
  });

  // ── Attachment data-loss safeguard (#433 / A.4) ──────────────────────

  it("rejects (422) when personal attachments exist and ack flag is missing", async () => {
    mockAttachment.count.mockResolvedValue(2);
    mockAttachment.findMany.mockResolvedValue([{ id: "att-1" }, { id: "att-2" }]);

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody }),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED");
    expect(json.attachmentsAffected).toBe(2);
    // The dialog reads this count — silent re-encryption-without-acknowledge
    // is a critical regression vector (#433 post-impl review T1).
    expect(mockMarkStale).not.toHaveBeenCalled();
  });

  it("succeeds with 200 when attachments exist and ack flag is true", async () => {
    mockAttachment.count.mockResolvedValue(1);
    mockAttachment.findMany.mockResolvedValue([{ id: "att-1" }]);
    const mockLogAudit = vi.mocked((await import("@/lib/audit/audit")).logAuditAsync);

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", {
        body: { ...validBody, acknowledgeAttachmentDataLoss: true },
      }),
    );
    expect(res.status).toBe(200);
    // Audit captures the affected manifest + ack flag for forensic traceability.
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VAULT_KEY_ROTATION",
        metadata: expect.objectContaining({
          attachmentsAffected: 1,
          attachmentDataLossAcknowledged: true,
          affectedAttachmentIds: ["att-1"],
          affectedAttachmentIdsOverflow: false,
        }),
      }),
    );
  });

  // ── Recovery wrapping clear (#433 / A.1+S5) ──────────────────────────

  it("audits recoveryKeyInvalidated: true when user had a recovery key set pre-rotation", async () => {
    mockUserTx.findUnique.mockResolvedValue({
      recoveryEncryptedSecretKey: "old-wrapping-ciphertext",
    });
    const mockLogAudit = vi.mocked((await import("@/lib/audit/audit")).logAuditAsync);

    await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ recoveryKeyInvalidated: true }),
      }),
    );
  });

  it("audits recoveryKeyInvalidated: false when user had no recovery key", async () => {
    // mockUserTx.findUnique default returns recoveryEncryptedSecretKey: null
    const mockLogAudit = vi.mocked((await import("@/lib/audit/audit")).logAuditAsync);

    await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ recoveryKeyInvalidated: false }),
      }),
    );
  });

  // ── invalidateUserSessions audit shape (#433 / S-N2) ─────────────────

  it("audit metadata captures all 7 invalidation count fields", async () => {
    mockInvalidateUserSessions.mockResolvedValue({
      sessions: 2,
      extensionTokens: 1,
      apiKeys: 0,
      mcpAccessTokens: 3,
      mcpRefreshTokens: 3,
      delegationSessions: 0,
      cacheTombstoneFailures: 0,
    });
    const mockLogAudit = vi.mocked((await import("@/lib/audit/audit")).logAuditAsync);

    await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          invalidatedSessions: 2,
          invalidatedExtensionTokens: 1,
          invalidatedApiKeys: 0,
          invalidatedMcpAccessTokens: 3,
          invalidatedMcpRefreshTokens: 3,
          invalidatedDelegationSessions: 0,
          cacheTombstoneFailures: 0,
        }),
      }),
    );
  });
});
