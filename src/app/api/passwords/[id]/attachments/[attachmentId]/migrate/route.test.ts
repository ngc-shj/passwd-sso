import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { clearMigrateLimitForUser } from "@/__tests__/helpers/rate-limiters";
import { ATTACHMENT_MIGRATE_PAYLOAD_MAX } from "@/lib/validations/common";

const { mockAuth, mockPrismaTransaction, mockApplyAttachmentMigration, mockWithUserTenantRls, mockLogAuditAsync } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockApplyAttachmentMigration: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockLogAuditAsync: vi.fn(),
}));

// Tx mock with advisory lock + user.findUnique (called inside the lock)
const txMock = {
  $executeRaw: vi.fn(),
  user: { findUnique: vi.fn() },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/vault/rotate-key-server", () => {
  class LegacyAttachmentInconsistentVersionError extends Error {
    constructor() {
      super("ATTACHMENT_INCONSISTENT_VERSION");
      this.name = "LegacyAttachmentInconsistentVersionError";
    }
  }
  class LegacyMigrationNotApplicableError extends Error {
    constructor() {
      super("LEGACY_MIGRATION_NOT_APPLICABLE");
      this.name = "LegacyMigrationNotApplicableError";
    }
  }
  class LegacyBodyHashMismatchError extends Error {
    constructor() {
      super("LEGACY_INTEGRITY_MISMATCH");
      this.name = "LegacyBodyHashMismatchError";
    }
  }
  return {
    applyAttachmentMigration: mockApplyAttachmentMigration,
    LegacyAttachmentInconsistentVersionError,
    LegacyMigrationNotApplicableError,
    LegacyBodyHashMismatchError,
  };
});
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  extractRequestMeta: () => ({ ip: "127.0.0.1" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock("@/lib/security/rate-limiters", () => ({
  migrateLimiter: {
    check: vi.fn().mockResolvedValue({ allowed: true }),
    clear: vi.fn(),
  },
}));

import { PUT } from "./route";

function createParams(id: string, attachmentId: string) {
  return { params: Promise.resolve({ id, attachmentId }) };
}

// A valid migrate request body
const validMigrateBody = {
  oldEncryptedDataHash: "a".repeat(64),
  encryptedData: "c".repeat(100), // base64
  iv: "b".repeat(24),
  authTag: "c".repeat(32),
  cekEncrypted: "Y2Vr", // base64 of "cek"
  cekIv: "d".repeat(24),
  cekAuthTag: "e".repeat(32),
  cekKeyVersion: 1,
  cekWrapAadVersion: 1,
};

describe("PUT /api/passwords/[id]/attachments/[attachmentId]/migrate", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaTransaction.mockImplementation(async (fn: (tx: typeof txMock) => unknown) => fn(txMock));
    txMock.$executeRaw.mockResolvedValue(undefined);
    txMock.user.findUnique.mockResolvedValue({ tenantId: "tenant-1", keyVersion: 1 });
    mockApplyAttachmentMigration.mockResolvedValue({ encryptionMode: 2, fromKeyVersion: 1 });
    mockLogAuditAsync.mockResolvedValue(undefined);
    // Clear rate limit state between tests
    await clearMigrateLimitForUser("user-1");
  });

  // I5.7: session-only auth

  it("rejects unauthenticated request → 401", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: validMigrateBody,
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(401);
  });

  // Field validation

  it("rejects request missing oldEncryptedDataHash → 400", async () => {
    const { oldEncryptedDataHash: _, ...bodyWithout } = validMigrateBody;
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: bodyWithout,
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(400);
  });

  it("rejects request missing cekEncrypted → 400", async () => {
    const { cekEncrypted: _, ...bodyWithout } = validMigrateBody;
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: bodyWithout,
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(400);
  });

  // RT7/F3: cekWrapAadVersion is pinned to exactly CURRENT_CEK_WRAP_AAD_VERSION
  // (currently 1) — a floor-only check would let a bad value lie dormant
  // until the next rotation, where applyVaultRotation's own defense-in-depth
  // check throws and leaves the vault stuck. Reverting the
  // `cekWrapAadVersion !== CURRENT_CEK_WRAP_AAD_VERSION` guard would let this
  // request through to applyAttachmentMigration instead of rejecting at 400.
  it("RT7/F3: rejects migrate with cekWrapAadVersion=2 (exceeds current format) → 400, no write", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: { ...validMigrateBody, cekWrapAadVersion: 2 },
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(400);
    expect(mockApplyAttachmentMigration).not.toHaveBeenCalled();
  });

  // Error mapping

  it("rejects when row is mode-2 (already migrated) → 409 LEGACY_MIGRATION_NOT_APPLICABLE", async () => {
    const { LegacyMigrationNotApplicableError } = await import("@/lib/vault/rotate-key-server");
    mockApplyAttachmentMigration.mockRejectedValue(new LegacyMigrationNotApplicableError());

    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: validMigrateBody,
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("LEGACY_MIGRATION_NOT_APPLICABLE");
    // S11: no extra payload fields
    expect(Object.keys(json)).toEqual(["error"]);
  });

  it("rejects when stored body hash mismatches → 409 LEGACY_INTEGRITY_MISMATCH", async () => {
    const { LegacyBodyHashMismatchError } = await import("@/lib/vault/rotate-key-server");
    mockApplyAttachmentMigration.mockRejectedValue(new LegacyBodyHashMismatchError());

    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: validMigrateBody,
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("LEGACY_INTEGRITY_MISMATCH");
    expect(Object.keys(json)).toEqual(["error"]);
  });

  it("rejects when cekKeyVersion !== user.keyVersion → 409 ATTACHMENT_INCONSISTENT_VERSION", async () => {
    // Server's keyVersion is 1 (set in beforeEach via tx.user.findUnique mock),
    // but request sends 2. The check now lives inside the advisory-locked tx.
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: { ...validMigrateBody, cekKeyVersion: 2 },
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("ATTACHMENT_INCONSISTENT_VERSION");
    // applyAttachmentMigration must NOT run when the version mismatch is
    // detected — the lock-protected check short-circuits before the helper.
    expect(mockApplyAttachmentMigration).not.toHaveBeenCalled();
  });

  it("rejects when user record vanishes inside tx → 404", async () => {
    txMock.user.findUnique.mockResolvedValueOnce(null);
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: validMigrateBody,
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(404);
    expect(mockApplyAttachmentMigration).not.toHaveBeenCalled();
  });

  // Payload-size guard (Fix #4)

  it("rejects oversized Content-Length header → 413 PAYLOAD_TOO_LARGE", async () => {
    const req = new NextRequest(
      "http://localhost/api/passwords/entry-1/attachments/att-1/migrate",
      {
        method: "PUT",
        headers: { "content-length": String(ATTACHMENT_MIGRATE_PAYLOAD_MAX + 1) },
      },
    );
    const res = await PUT(req, createParams("entry-1", "att-1"));
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects oversized encryptedData base64 string → 400 FILE_TOO_LARGE", async () => {
    // Roughly 16MB of base64 chars — well above the cap, well below the
    // Content-Length cap so Content-Length pre-check passes.
    const huge = "A".repeat(16 * 1024 * 1024);
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: { ...validMigrateBody, encryptedData: huge },
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FILE_TOO_LARGE");
  });

  it("rejects oversized cekEncrypted base64 string → 400", async () => {
    const longCek = "A".repeat(257);
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: { ...validMigrateBody, cekEncrypted: longCek },
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(400);
  });

  it("rejects malformed base64 in cekEncrypted (base64url chars) → 400 VALIDATION_ERROR", async () => {
    // base64url uses `-` / `_`; standard base64 must reject them.
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: { ...validMigrateBody, cekEncrypted: "Y2V-" },
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockApplyAttachmentMigration).not.toHaveBeenCalled();
  });

  it("rejects malformed base64 in encryptedData (length not mod 4) → 400 VALIDATION_ERROR", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: { ...validMigrateBody, encryptedData: "abc" },
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockApplyAttachmentMigration).not.toHaveBeenCalled();
  });

  it("rejects base64 with padding `=` placed mid-string → 400 VALIDATION_ERROR", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: { ...validMigrateBody, cekEncrypted: "Y2=r" },
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockApplyAttachmentMigration).not.toHaveBeenCalled();
  });

  it("rejects empty `cekEncrypted` (regex no longer matches empty) → 400 VALIDATION_ERROR", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: { ...validMigrateBody, cekEncrypted: "" },
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(400);
    expect(mockApplyAttachmentMigration).not.toHaveBeenCalled();
  });

  it("rejects CR/LF embedded in cekEncrypted → 400 VALIDATION_ERROR (copy-paste regression)", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: { ...validMigrateBody, cekEncrypted: "Y2V\nr" },
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockApplyAttachmentMigration).not.toHaveBeenCalled();
  });

  it("rejects cross-user attempt (findFirst returns null) → 404 (not 403 to avoid enumeration)", async () => {
    mockApplyAttachmentMigration.mockRejectedValue(Object.assign(new Error("NOT_FOUND"), {}));

    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: validMigrateBody,
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(404);
  });

  it("rejects team-scope attachment via personal migrate route → 404", async () => {
    // applyAttachmentMigration scopes to personal entries only (teamPasswordEntryId: null)
    // Cross-team attachment returns NOT_FOUND (not 403 — avoid enumeration)
    mockApplyAttachmentMigration.mockRejectedValue(new Error("NOT_FOUND"));

    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/team-entry-1/attachments/att-team/migrate", {
        body: validMigrateBody,
      }),
      createParams("team-entry-1", "att-team"),
    );
    expect(res.status).toBe(404);
  });

  // Audit

  it("successful migrate emits ATTACHMENT_LEGACY_MIGRATION audit event", async () => {
    mockApplyAttachmentMigration.mockResolvedValue({ encryptionMode: 2, fromKeyVersion: 1 });

    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: validMigrateBody,
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(200);
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ATTACHMENT_LEGACY_MIGRATION",
        targetType: "Attachment",
        targetId: "att-1",
      }),
    );
  });
});
