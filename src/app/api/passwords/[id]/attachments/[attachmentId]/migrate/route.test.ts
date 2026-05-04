import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { clearMigrateLimitForUser } from "@/__tests__/helpers/rate-limiters";

const { mockAuth, mockPrismaUser, mockPrismaTransaction, mockApplyAttachmentMigration, mockWithUserTenantRls, mockLogAuditAsync } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaTransaction: vi.fn(),
  mockApplyAttachmentMigration: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockLogAuditAsync: vi.fn(),
}));

// Tx mock with advisory lock stub
const txMock = { $executeRaw: vi.fn() };

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/vault/rotate-key-server", () => {
  class LegacyMigrationNotApplicableError extends Error {
    constructor() {
      super("LEGACY_MIGRATION_NOT_APPLICABLE");
      this.name = "LegacyMigrationNotApplicableError";
    }
  }
  class LegacyBodyHashMismatchError extends Error {
    constructor() {
      super("LEGACY_BODY_HASH_MISMATCH");
      this.name = "LegacyBodyHashMismatchError";
    }
  }
  return {
    applyAttachmentMigration: mockApplyAttachmentMigration,
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
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1", keyVersion: 1 });
    mockPrismaTransaction.mockImplementation(async (fn: (tx: typeof txMock) => unknown) => fn(txMock));
    txMock.$executeRaw.mockResolvedValue(undefined);
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

  it("rejects when stored body hash mismatches → 409 LEGACY_BODY_HASH_MISMATCH", async () => {
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
    expect(json.error).toBe("LEGACY_BODY_HASH_MISMATCH");
    expect(Object.keys(json)).toEqual(["error"]);
  });

  it("rejects when cekKeyVersion !== user.keyVersion → 400", async () => {
    // Server's keyVersion is 1, but request sends 2
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/passwords/entry-1/attachments/att-1/migrate", {
        body: { ...validMigrateBody, cekKeyVersion: 2 },
      }),
      createParams("entry-1", "att-1"),
    );
    expect(res.status).toBe(400);
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
