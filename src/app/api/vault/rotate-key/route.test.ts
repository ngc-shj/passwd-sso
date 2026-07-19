import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const { mockAuth, mockPrismaUser, mockTransaction, mockApplyVaultRotation, mockWithUserTenantRls, mockRateLimiterCheck, mockCreateRateLimiter, mockInvalidateUserSessions } = vi.hoisted(() => {
  const mockRateLimiterCheck = vi.fn();
  return {
    mockAuth: vi.fn(),
    mockPrismaUser: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    mockTransaction: vi.fn(),
    mockApplyVaultRotation: vi.fn(),
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
    mockRateLimiterCheck,
    // F: recording factory — assertRedisFailClosed's factory-attribution step
    // reads mockCreateRateLimiter.mock.{calls,results}.
    mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockRateLimiterCheck, clear: vi.fn() })),
    mockInvalidateUserSessions: vi.fn(),
  };
});

// Transaction mock (txMock) for advisory lock assertion
const txMock = {
  $executeRaw: vi.fn(),
};

// Default applyVaultRotation return value (happy path)
const defaultRotationEffects = {
  recoveryKeyInvalidated: false,
  emergencyGrantsCleared: 0,
  prfCredentialsCleared: 0,
  cekRewrapsAttempted: 0,
  cekRewrapsSucceeded: 0,
  cekRewrapsFailed: 0,
  legacyAttachmentsMigratedClientReported: 0,
  mode0Residual: 0 as const,
  cekRewrappedAttachmentIds: [],
  cekRewrappedAttachmentIdsOverflow: false,
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/vault/rotate-key-server", () => {
  class LegacyAttachmentsResidualError extends Error {
    constructor() {
      super("ATTACHMENT_MIGRATION_INCOMPLETE");
      this.name = "LegacyAttachmentsResidualError";
    }
  }
  class AttachmentCekManifestMismatchError extends Error {
    constructor() {
      super("ATTACHMENT_KEY_MANIFEST_MISMATCH");
      this.name = "AttachmentCekManifestMismatchError";
    }
  }
  class LegacyAttachmentInconsistentVersionError extends Error {
    constructor() {
      super("ATTACHMENT_INCONSISTENT_VERSION");
      this.name = "LegacyAttachmentInconsistentVersionError";
    }
  }
  class RotationPostConditionError extends Error {
    constructor() {
      super("ROTATION_POST_CONDITION_FAILED");
      this.name = "RotationPostConditionError";
    }
  }
  class Mode2InvariantViolationError extends Error {
    constructor() {
      super("MODE2_INVARIANT_VIOLATION");
      this.name = "Mode2InvariantViolationError";
    }
  }
  class RotationCasConflictError extends Error {
    constructor() {
      super("ROTATION_CAS_CONFLICT");
      this.name = "RotationCasConflictError";
    }
  }
  class AttachmentCekWrapAadVersionMismatchError extends Error {
    constructor() {
      super("ATTACHMENT_CEK_WRAP_AAD_VERSION_MISMATCH");
      this.name = "AttachmentCekWrapAadVersionMismatchError";
    }
  }
  return {
    applyVaultRotation: mockApplyVaultRotation,
    LegacyAttachmentsResidualError,
    AttachmentCekManifestMismatchError,
    LegacyAttachmentInconsistentVersionError,
    RotationPostConditionError,
    Mode2InvariantViolationError,
    RotationCasConflictError,
    AttachmentCekWrapAadVersionMismatchError,
  };
});
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
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

// Module-level `rotateLimiter = createRateLimiter(...)` runs at import time,
// above. Snapshot the recorded factory call now (module scope, before any
// test/beforeEach executes) — the global beforeEach's vi.clearAllMocks()
// would otherwise wipe mockCreateRateLimiter.mock.calls/.results before the
// first test runs.
const rotateLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const rotateLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimiterCheck;
};

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
  attachmentCekRewraps: [],
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
      accountSalt: "e".repeat(64),
    });
    // Interactive transaction mock: execute the callback with txMock
    mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => unknown) => fn(txMock));
    // applyVaultRotation returns the RotationEffects object on success
    mockApplyVaultRotation.mockResolvedValue(defaultRotationEffects);
    txMock.$executeRaw.mockResolvedValue(undefined);
    mockInvalidateUserSessions.mockResolvedValue({
      sessions: 0,
      extensionTokens: 0,
      apiKeys: 0,
      mcpAccessTokens: 0,
      mcpRefreshTokens: 0,
      delegationSessions: 0,
      cacheTombstoneFailures: 0,
    });
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

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () =>
        POST(createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })),
      limiter: rotateLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockApplyVaultRotation, mockInvalidateUserSessions],
      limiterFactory: rotateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
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
    expect(mockApplyVaultRotation).toHaveBeenCalledWith(
      txMock,
      "user-1",
      "tenant-1",
      1,
      2,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ entries: [], historyEntries: [] }),
      expect.any(Date),
      "e".repeat(64),
    );
    // Verify ALL user-bound auth artifacts are revoked after key rotation
    expect(mockInvalidateUserSessions).toHaveBeenCalledWith("user-1", {
      tenantId: "tenant-1",
      reason: "KEY_ROTATION",
    });
  });

  it("rotates key with entries and history", async () => {
    const entryId = "660e8400-e29b-41d4-a716-446655440020";
    const historyId = "660e8400-e29b-41d4-a716-446655440021";

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
    expect(mockApplyVaultRotation).toHaveBeenCalledWith(
      txMock,
      "user-1",
      "tenant-1",
      1,
      2,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        entries: expect.arrayContaining([expect.objectContaining({ id: entryId })]),
        historyEntries: expect.arrayContaining([expect.objectContaining({ id: historyId })]),
      }),
      expect.any(Date),
      "e".repeat(64),
    );
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

  it("increments keyVersion from current value", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      vaultSetupAt: new Date(),
      masterPasswordServerHash: serverHash,
      masterPasswordServerSalt: serverSalt,
      keyVersion: 5,
      accountSalt: "e".repeat(64),
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    const json = await res.json();
    expect(json.keyVersion).toBe(6);
    expect(mockApplyVaultRotation).toHaveBeenCalledWith(
      txMock,
      "user-1",
      "tenant-1",
      5,
      6,
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      expect.any(Date),
      "e".repeat(64),
    );
  });

  it("runs key rotation within withUserTenantRls scope", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    // Two calls: (1) user.findUnique, (2) the rotation transaction
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

  // ── New Phase B error-mapping tests ──────────────────────────────────

  it("rejects rotation when mode-0 residue exists → 409 ATTACHMENT_MIGRATION_INCOMPLETE", async () => {
    const { LegacyAttachmentsResidualError } = await import("@/lib/vault/rotate-key-server");
    mockApplyVaultRotation.mockRejectedValue(new LegacyAttachmentsResidualError());

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("ATTACHMENT_MIGRATION_INCOMPLETE");
    // No extra payload fields per S11
    expect(Object.keys(json)).toEqual(["error"]);
  });

  it("rejects rotation when manifest references non-existent mode-2 id → 409 ATTACHMENT_KEY_MANIFEST_MISMATCH", async () => {
    const { AttachmentCekManifestMismatchError } = await import("@/lib/vault/rotate-key-server");
    mockApplyVaultRotation.mockRejectedValue(new AttachmentCekManifestMismatchError());

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("ATTACHMENT_KEY_MANIFEST_MISMATCH");
    expect(Object.keys(json)).toEqual(["error"]);
  });

  it("rejects rotation when row's cekKeyVersion does not match user's keyVersion → 409 ATTACHMENT_INCONSISTENT_VERSION", async () => {
    const { LegacyAttachmentInconsistentVersionError } = await import("@/lib/vault/rotate-key-server");
    mockApplyVaultRotation.mockRejectedValue(new LegacyAttachmentInconsistentVersionError());

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("ATTACHMENT_INCONSISTENT_VERSION");
    expect(Object.keys(json)).toEqual(["error"]);
  });

  it("rejects rotation when a mode-2 row violates the cek_* NOT-NULL invariant → 500 INTERNAL_ERROR", async () => {
    const { Mode2InvariantViolationError } = await import("@/lib/vault/rotate-key-server");
    mockApplyVaultRotation.mockRejectedValue(new Mode2InvariantViolationError());

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody }),
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("INTERNAL_ERROR");
  });

  it("rejects attachmentCekRewraps[].cekEncrypted with non-base64 characters → 400 VALIDATION_ERROR", async () => {
    // base64url chars (`-` / `_`) are not valid standard base64.
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", {
        body: {
          ...validBody,
          attachmentCekRewraps: [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              cekEncrypted: "Y2V-",
              cekIv: "a".repeat(24),
              cekAuthTag: "b".repeat(32),
              cekKeyVersion: 2,
              cekWrapAadVersion: 1,
            },
          ],
        },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    // applyVaultRotation must NOT be invoked — Zod parse rejects first.
    expect(mockApplyVaultRotation).not.toHaveBeenCalled();
  });

  it("accepts non-empty attachmentCekRewraps with valid base64 (regex happy-path) → 200", async () => {
    // Locks in that the new `.regex(BASE64_RE)` does NOT reject canonical
    // standard base64 — without this, a regex regression that rejects ALL
    // base64 would still let every other rotation test pass (validBody has
    // an empty rewraps array).
    mockApplyVaultRotation.mockResolvedValue({
      ...defaultRotationEffects,
      cekRewrapsAttempted: 1,
      cekRewrapsSucceeded: 1,
    });
    const rewrap = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      cekEncrypted: "Y2Vr", // base64 of "cek"
      cekIv: "a".repeat(24),
      cekAuthTag: "b".repeat(32),
      cekKeyVersion: 2,
      cekWrapAadVersion: 1,
    };
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", {
        body: { ...validBody, attachmentCekRewraps: [rewrap] },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockApplyVaultRotation).toHaveBeenCalledWith(
      expect.anything(), // tx
      "user-1",
      "tenant-1",
      1, // oldKeyVersion
      2, // newKeyVersion
      expect.any(String), // newServerHash
      expect.any(String), // newServerSalt
      expect.objectContaining({
        attachmentCekRewraps: [expect.objectContaining({ cekEncrypted: "Y2Vr" })],
      }),
      expect.any(Date), // oldVaultSetupAt
      "e".repeat(64), // oldAccountSalt
    );
  });

  it("rotation succeeds with empty attachmentCekRewraps when no mode-2 attachments exist", async () => {
    mockApplyVaultRotation.mockResolvedValue({
      ...defaultRotationEffects,
      cekRewrapsAttempted: 0,
      mode0Residual: 0 as const,
    });
    const mockLogAudit = vi.mocked((await import("@/lib/audit/audit")).logAuditAsync);

    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody }),
    );
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          cekRewrapsAttempted: 0,
          mode0Residual: 0,
        }),
      }),
    );
  });

  it("rotation drops acknowledgeAttachmentDataLoss from request schema (unknown field stripped or rejected)", async () => {
    // Submit a body with the old Phase A field — the schema should either strip it (Zod default)
    // or reject it (if .strict() is used). Either way, a 200 is expected for a valid otherwise-valid body.
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", {
        body: { ...validBody, acknowledgeAttachmentDataLoss: true },
      }),
    );
    // Zod strips unknown fields by default — so the request succeeds with 200
    // (if .strict() were used, the field would cause 400; this test documents the actual behavior)
    expect([200, 400]).toContain(res.status);
    if (res.status === 400) {
      const json = await res.json();
      expect(["INVALID_REQUEST", "VALIDATION_ERROR"]).toContain(json.error);
    } else {
      expect(res.status).toBe(200);
    }
  });

  // ── Recovery wrapping clear (#433 / A.1+S5) ──────────────────────────

  it("audits recoveryKeyInvalidated: true when applyVaultRotation reports it", async () => {
    mockApplyVaultRotation.mockResolvedValue({
      ...defaultRotationEffects,
      recoveryKeyInvalidated: true,
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

  it("audits recoveryKeyInvalidated: false when applyVaultRotation reports no recovery key", async () => {
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
