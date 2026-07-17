import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaPasswordEntry, mockPrismaHistory, mockPrismaTransaction, mockLogAudit, mockWithUserTenantRls, txMock } =
  vi.hoisted(() => {
    // curRow returned by the in-tx FOR UPDATE snapshot read — distinct from
    // ownedEntry so field-level assertions can detect a stale (out-of-tx) read.
    const curRow = {
      encrypted_blob: "cur-blob-cipher",
      blob_iv: "cur-blob-iv",
      blob_auth_tag: "cur-blob-tag",
      key_version: 1,
      aad_version: 0,
    };
    // Discriminate by SQL text: assertCurrentKeyVersion's `FROM users` guard
    // read must return a DIFFERENT row than the entry `FOR UPDATE` snapshot
    // read — a single blanket mock would vacuously satisfy both (test-F4).
    const defaultQueryRawImpl = (tpl: TemplateStringsArray) => {
      const sql = tpl.join("?");
      if (/FROM users/i.test(sql)) {
        return Promise.resolve([{ key_version: 1 }]);
      }
      return Promise.resolve([curRow]);
    };
    return {
      mockAuth: vi.fn(),
      mockPrismaPasswordEntry: {
        findUnique: vi.fn(),
      },
      mockPrismaHistory: {
        findUnique: vi.fn(),
      },
      mockPrismaTransaction: vi.fn(),
      mockLogAudit: vi.fn(),
      mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
      txMock: {
        $queryRaw: vi.fn().mockImplementation(defaultQueryRawImpl),
        passwordEntryHistory: {
          create: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        passwordEntry: {
          update: vi.fn().mockResolvedValue({}),
        },
      },
    };
  });

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    passwordEntryHistory: mockPrismaHistory,
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { POST } from "./route";

const ENTRY_ID = "entry-123";
const HISTORY_ID = "hist-456";
const now = new Date("2025-06-01T00:00:00Z");

const ownedEntry = {
  id: ENTRY_ID,
  userId: "user-1",
  encryptedBlob: "current-blob",
  blobIv: "current-iv",
  blobAuthTag: "current-tag",
  keyVersion: 1,
  aadVersion: 0,
};

const historyEntry = {
  id: HISTORY_ID,
  entryId: ENTRY_ID,
  encryptedBlob: "old-blob",
  blobIv: "old-iv",
  blobAuthTag: "old-tag",
  keyVersion: 1,
  aadVersion: 0,
  changedAt: now,
};

describe("POST /api/passwords/[id]/history/[historyId]/restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    txMock.$queryRaw.mockImplementation((tpl: TemplateStringsArray) => {
      const sql = tpl.join("?");
      if (/FROM users/i.test(sql)) {
        return Promise.resolve([{ key_version: 1 }]);
      }
      return Promise.resolve([{
        encrypted_blob: "cur-blob-cipher",
        blob_iv: "cur-blob-iv",
        blob_auth_tag: "cur-blob-tag",
        key_version: 1,
        aad_version: 0,
      }]);
    });
    txMock.passwordEntryHistory.create.mockResolvedValue({});
    txMock.passwordEntryHistory.findMany.mockResolvedValue([]);
    txMock.passwordEntryHistory.deleteMany.mockResolvedValue({ count: 0 });
    txMock.passwordEntry.update.mockResolvedValue({});
    mockPrismaTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${ENTRY_ID}/history/${HISTORY_ID}/restore`),
      createParams({ id: ENTRY_ID, historyId: HISTORY_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${ENTRY_ID}/history/${HISTORY_ID}/restore`),
      createParams({ id: ENTRY_ID, historyId: HISTORY_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({
      ...ownedEntry,
      userId: "other-user",
    });
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${ENTRY_ID}/history/${HISTORY_ID}/restore`),
      createParams({ id: ENTRY_ID, historyId: HISTORY_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when history entry not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaHistory.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${ENTRY_ID}/history/${HISTORY_ID}/restore`),
      createParams({ id: ENTRY_ID, historyId: HISTORY_ID }),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("HISTORY_NOT_FOUND");
  });

  it("returns 404 when history entry belongs to different entry", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaHistory.findUnique.mockResolvedValue({
      ...historyEntry,
      entryId: "different-entry",
    });
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${ENTRY_ID}/history/${HISTORY_ID}/restore`),
      createParams({ id: ENTRY_ID, historyId: HISTORY_ID }),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("HISTORY_NOT_FOUND");
  });

  it("restores history version successfully", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaHistory.findUnique.mockResolvedValue(historyEntry);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${ENTRY_ID}/history/${HISTORY_ID}/restore`),
      createParams({ id: ENTRY_ID, historyId: HISTORY_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaTransaction).toHaveBeenCalled();
    expect(txMock.passwordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          encryptedBlob: historyEntry.encryptedBlob,
          keyVersion: historyEntry.keyVersion,
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_HISTORY_RESTORE",
        targetId: ENTRY_ID,
        metadata: expect.objectContaining({
          historyId: HISTORY_ID,
        }),
      }),
    );
  });

  // Guard behavior added alongside the FOR UPDATE snapshot move: a stale
  // history.keyVersion (rotation raced the restore) must 409, not silently
  // restore a blob the current key can no longer decrypt.
  it("returns 409 KEY_VERSION_MISMATCH when history.keyVersion is stale", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaHistory.findUnique.mockResolvedValue({ ...historyEntry, keyVersion: 1 });
    txMock.$queryRaw.mockImplementation((tpl: TemplateStringsArray) => {
      const sql = tpl.join("?");
      if (/FROM users/i.test(sql)) {
        return Promise.resolve([{ key_version: 2 }]); // rotated past history.keyVersion
      }
      return Promise.resolve([{
        encrypted_blob: "cur-blob-cipher",
        blob_iv: "cur-blob-iv",
        blob_auth_tag: "cur-blob-tag",
        key_version: 2,
        aad_version: 0,
      }]);
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${ENTRY_ID}/history/${HISTORY_ID}/restore`),
      createParams({ id: ENTRY_ID, historyId: HISTORY_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("KEY_VERSION_MISMATCH");
    expect(txMock.passwordEntry.update).not.toHaveBeenCalled();
  });

  // F1-analogue: entry concurrently deleted between the early findUnique and
  // the in-tx FOR UPDATE lock.
  it("returns 404 when the entry FOR UPDATE read returns empty (concurrent delete)", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaHistory.findUnique.mockResolvedValue(historyEntry);
    txMock.$queryRaw.mockImplementation((tpl: TemplateStringsArray) => {
      const sql = tpl.join("?");
      if (/FROM users/i.test(sql)) {
        return Promise.resolve([{ key_version: 1 }]);
      }
      return Promise.resolve([]); // row gone by the time the lock fires
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${ENTRY_ID}/history/${HISTORY_ID}/restore`),
      createParams({ id: ENTRY_ID, historyId: HISTORY_ID }),
    );

    expect(res.status).toBe(404);
    expect(txMock.passwordEntry.update).not.toHaveBeenCalled();
  });
});
