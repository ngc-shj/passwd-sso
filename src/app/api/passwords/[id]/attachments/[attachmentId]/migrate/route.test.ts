import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { clearMigrateLimitForUser } from "@/__tests__/helpers/rate-limiters";
import { ATTACHMENT_BODY_BASE64_MAX, ATTACHMENT_MIGRATE_PAYLOAD_MAX } from "@/lib/validations/common";

const {
  mockAuth,
  mockPrisma,
  mockApplyAttachmentMigration,
  mockWithUserTenantRls,
  mockLogAuditAsync,
  mockGetObject,
  mockPutObject,
  mockDeleteObject,
  mockDeleteBlobs,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  // Inside withUserTenantRls, `prisma` resolves to the opener's transaction: the lock
  // and the user read go through it directly. The pre-transaction snapshot read
  // (attachment.findFirst) runs in its own tenant context.
  mockPrisma: { $executeRaw: vi.fn(), user: { findUnique: vi.fn() }, attachment: { findFirst: vi.fn() } },
  mockApplyAttachmentMigration: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockLogAuditAsync: vi.fn(),
  mockGetObject: vi.fn(),
  mockPutObject: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockDeleteBlobs: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
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
  class AttachmentMigrationCasError extends Error {
    constructor() {
      super("MIGRATE_CAS_FAILED");
      this.name = "AttachmentMigrationCasError";
    }
  }
  return {
    applyAttachmentMigration: mockApplyAttachmentMigration,
    AttachmentMigrationCasError,
    LegacyAttachmentInconsistentVersionError,
    LegacyMigrationNotApplicableError,
    LegacyBodyHashMismatchError,
  };
});
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => ({
    backend: "s3",
    getObject: mockGetObject,
    putObject: mockPutObject,
    deleteObject: mockDeleteObject,
  }),
}));
vi.mock("@/lib/blob-store/cleanup", () => ({
  deleteAttachmentBlobs: mockDeleteBlobs,
}));
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
import { BlobRefInvalidError } from "@/lib/blob-store/object-ref";

// The row as read before the transaction: on S3 the column holds a ref.
const STORED_REF = Buffer.from('{"key":"personal/entry-1/att-1.bin"}');
const STORED_BODY = Buffer.from("stored-ciphertext");
const NEW_REF = Buffer.from('{"key":"new"}');
const SNAPSHOT_ROW = { encryptedData: STORED_REF, iv: "f".repeat(24), authTag: "0".repeat(32), encryptionMode: 0 };

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
    mockWithUserTenantRls.mockImplementation(async (_userId: string, fn: () => unknown) => fn());
    mockPrisma.$executeRaw.mockResolvedValue(undefined);
    mockPrisma.user.findUnique.mockResolvedValue({ tenantId: "tenant-1", keyVersion: 1 });
    mockApplyAttachmentMigration.mockResolvedValue({ encryptionMode: 2, fromKeyVersion: 1, oldStored: STORED_REF });
    mockLogAuditAsync.mockResolvedValue(undefined);
    mockPrisma.attachment.findFirst.mockResolvedValue(SNAPSHOT_ROW);
    mockGetObject.mockResolvedValue(STORED_BODY);
    mockPutObject.mockResolvedValue(NEW_REF);
    mockDeleteObject.mockResolvedValue(undefined);
    mockDeleteBlobs.mockResolvedValue(undefined);
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
    // Server's keyVersion is 1 (set in beforeEach via the prisma.user.findUnique mock),
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
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: validMigrateBody,
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(404);
    expect(mockApplyAttachmentMigration).not.toHaveBeenCalled();
  });

  it("takes the advisory lock, then reads the user, both inside the tenant context", async () => {
    // Round 10: the read moved out of a nested `prisma.$transaction` callback into
    // withUserTenantRls's own, which the proxy runs on the same transaction.
    const order: string[] = [];
    let inside = false;
    mockWithUserTenantRls.mockImplementation(async (_userId: string, fn: () => unknown) => {
      inside = true;
      try {
        return await fn();
      } finally {
        inside = false;
      }
    });
    mockPrisma.$executeRaw.mockImplementation(async () => {
      order.push(`lock:${inside}`);
    });
    mockPrisma.user.findUnique.mockImplementation(async () => {
      order.push(`read:${inside}`);
      return { tenantId: "tenant-1", keyVersion: 1 };
    });

    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: validMigrateBody,
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(200);
    expect(order).toEqual(["lock:true", "read:true"]);
    expect(mockApplyAttachmentMigration).toHaveBeenCalledWith(mockPrisma, expect.objectContaining({ tenantId: "tenant-1" }));
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

  it("checks a well-formed encryptedData near ATTACHMENT_BODY_BASE64_MAX (no regex stack overflow) and reaches the lookup → 404 when absent", async () => {
    mockPrisma.attachment.findFirst.mockResolvedValue(null);
    const large = "A".repeat(ATTACHMENT_BODY_BASE64_MAX - (ATTACHMENT_BODY_BASE64_MAX % 4));
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: { ...validMigrateBody, encryptedData: large },
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(404);
    expect(mockPrisma.attachment.findFirst).toHaveBeenCalled();
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
    mockApplyAttachmentMigration.mockResolvedValue({ encryptionMode: 2, fromKeyVersion: 1, oldStored: STORED_REF });

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

  // Blob store (plan C4 personal migrate fix): the hash covers the stored
  // ciphertext read through the blob store, the new body goes to a fresh
  // object, and the transaction applies only to the row that was read.

  const put = () =>
    PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: validMigrateBody,
      }),
      createParams("entry-1", "att-1"),
    );

  it("reads the snapshot row scoped to the user's entry, and the body through the blob store", async () => {
    const res = await put();
    expect(res.status).toBe(200);
    expect(mockPrisma.attachment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "att-1",
          passwordEntryId: "entry-1",
          passwordEntry: { userId: "user-1" },
          teamPasswordEntryId: null,
        },
      }),
    );
    expect(mockGetObject).toHaveBeenCalledWith(STORED_REF, { attachmentId: "att-1", entryId: "entry-1" });
    expect(mockApplyAttachmentMigration).toHaveBeenCalledWith(
      mockPrisma,
      expect.objectContaining({
        snapshot: { stored: STORED_REF, body: STORED_BODY, iv: SNAPSHOT_ROW.iv, authTag: SNAPSHOT_ROW.authTag },
        newStored: NEW_REF,
      }),
    );
  });

  it("writes the new body to a fresh generation key before the transaction", async () => {
    await put();
    expect(mockPutObject).toHaveBeenCalledWith(
      Buffer.from(validMigrateBody.encryptedData, "base64"),
      { attachmentId: "att-1", entryId: "entry-1", generation: expect.stringMatching(/^[0-9a-f]{32}$/) },
    );
    expect(mockPutObject.mock.invocationCallOrder[0]).toBeLessThan(
      mockApplyAttachmentMigration.mock.invocationCallOrder[0],
    );
  });

  it("deletes the old object after commit and keeps the new one", async () => {
    await put();
    expect(mockDeleteBlobs).toHaveBeenCalledWith([
      { stored: STORED_REF, context: { attachmentId: "att-1", entryId: "entry-1" } },
    ]);
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("returns 404 without writing when the snapshot row is not the user's", async () => {
    mockPrisma.attachment.findFirst.mockResolvedValue(null);
    const res = await put();
    expect(res.status).toBe(404);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("returns 409 LEGACY_MIGRATION_NOT_APPLICABLE without writing when the row is already mode 2", async () => {
    mockPrisma.attachment.findFirst.mockResolvedValue({ ...SNAPSHOT_ROW, encryptionMode: 2 });
    const res = await put();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("LEGACY_MIGRATION_NOT_APPLICABLE");
    expect(mockGetObject).not.toHaveBeenCalled();
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("returns 409 BLOB_REF_INVALID without writing when the stored ref is not the row's", async () => {
    mockGetObject.mockRejectedValue(new BlobRefInvalidError());
    const res = await put();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("BLOB_REF_INVALID");
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it.each([
    ["LegacyBodyHashMismatchError", "LEGACY_INTEGRITY_MISMATCH"],
    ["AttachmentMigrationCasError", "MIGRATE_CAS_FAILED"],
    ["LegacyMigrationNotApplicableError", "LEGACY_MIGRATION_NOT_APPLICABLE"],
  ] as const)("deletes the new object when the transaction refuses with %s → %s", async (errorName, code) => {
    const mod = await import("@/lib/vault/rotate-key-server");
    const ErrorClass = mod[errorName] as unknown as new () => Error;
    mockApplyAttachmentMigration.mockRejectedValue(new ErrorClass());
    const res = await put();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(code);
    expect(mockDeleteObject).toHaveBeenCalledWith(NEW_REF, expect.objectContaining({ attachmentId: "att-1" }));
    expect(mockDeleteBlobs).not.toHaveBeenCalled();
  });

  it("deletes the new object and rethrows on an unexpected failure", async () => {
    mockApplyAttachmentMigration.mockRejectedValue(new Error("db down"));
    await expect(put()).rejects.toThrow("db down");
    expect(mockDeleteObject).toHaveBeenCalledWith(NEW_REF, expect.anything());
  });
});
