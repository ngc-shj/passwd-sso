import { describe, it, expect, vi, beforeEach } from "vitest";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockEntryFindUnique,
  mockHistoryFindUnique,
  mockTransaction,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockHistoryFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: { findUnique: mockEntryFindUnique },
    passwordEntryHistory: { findUnique: mockHistoryFindUnique },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { POST } from "@/app/api/passwords/[id]/history/[historyId]/restore/route";

type EntryRow = {
  encrypted_blob: string;
  blob_iv: string;
  blob_auth_tag: string;
  key_version: number;
  aad_version: number;
};

/**
 * Discriminate by SQL text: assertCurrentKeyVersion's `FROM users` guard
 * read must return a DIFFERENT row than the entry `FOR UPDATE` snapshot
 * read — a single blanket mock would vacuously satisfy both (test-F4).
 */
function mockTxQueryRaw(usersKeyVersion: number, entryRow: EntryRow | null) {
  return vi.fn().mockImplementation((tpl: TemplateStringsArray) => {
    const sql = tpl.join("?");
    if (/FROM users/i.test(sql)) {
      return Promise.resolve([{ key_version: usersKeyVersion }]);
    }
    return Promise.resolve(entryRow ? [entryRow] : []);
  });
}

describe("POST /api/passwords/[id]/history/[historyId]/restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("POST", "http://localhost/api/passwords/p1/history/h1/restore");
    const res = await POST(req, createParams({ id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue(null);
    const req = createRequest("POST", "http://localhost/api/passwords/p1/history/h1/restore");
    const res = await POST(req, createParams({ id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe(API_ERROR.NOT_FOUND);
  });

  it("returns 404 when entry belongs to another user (A01-4: no existence oracle)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ id: "p1", userId: "other-user" });
    const req = createRequest("POST", "http://localhost/api/passwords/p1/history/h1/restore");
    const res = await POST(req, createParams({ id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe(API_ERROR.NOT_FOUND);
  });

  it("returns 404 when history entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ id: "p1", userId: DEFAULT_SESSION.user.id });
    mockHistoryFindUnique.mockResolvedValue(null);
    const req = createRequest("POST", "http://localhost/api/passwords/p1/history/h1/restore");
    const res = await POST(req, createParams({ id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("HISTORY_NOT_FOUND");
  });

  it("returns 404 when history entry belongs to different entry", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ id: "p1", userId: DEFAULT_SESSION.user.id });
    mockHistoryFindUnique.mockResolvedValue({ id: "h1", entryId: "other-entry" });
    const req = createRequest("POST", "http://localhost/api/passwords/p1/history/h1/restore");
    const res = await POST(req, createParams({ id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("HISTORY_NOT_FOUND");
  });

  it("restores history version and returns success", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const entry = {
      id: "p1",
      userId: DEFAULT_SESSION.user.id,
      encryptedBlob: "current-blob",
      blobIv: "current-iv",
      blobAuthTag: "current-tag",
      keyVersion: 1,
      aadVersion: 0,
    };
    mockEntryFindUnique.mockResolvedValue(entry);
    mockHistoryFindUnique.mockResolvedValue({
      id: "h1",
      entryId: "p1",
      encryptedBlob: "old-blob",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      keyVersion: 1,
      aadVersion: 0,
      changedAt: new Date("2025-01-01"),
    });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return await fn({
        $queryRaw: mockTxQueryRaw(1, {
          encrypted_blob: "current-blob",
          blob_iv: "current-iv",
          blob_auth_tag: "current-tag",
          key_version: 1,
          aad_version: 0,
        }),
        passwordEntryHistory: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn(),
        },
        passwordEntry: { update: vi.fn() },
      });
    });

    const req = createRequest("POST", "http://localhost/api/passwords/p1/history/h1/restore");
    const res = await POST(req, createParams({ id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  // C5/func-F2: the snapshot must come from the in-tx FOR UPDATE read (the
  // "currently committed" blob), NOT the stale out-of-tx `entry` object read
  // before the transaction opened — closes the rotation-race window where the
  // two could diverge.
  it("creates history snapshot from the locked in-tx read, not the stale pre-tx entry read", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const staleEntry = {
      id: "p1",
      userId: DEFAULT_SESSION.user.id,
      tenantId: "tenant-1",
      // Intentionally distinct from the locked-read row below so the
      // assertion can detect a regression to reading from `entry`.
      encryptedBlob: "stale-pretx-blob",
      blobIv: "stale-pretx-iv",
      blobAuthTag: "stale-pretx-tag",
      keyVersion: 2,
      aadVersion: 1,
    };
    mockEntryFindUnique.mockResolvedValue(staleEntry);
    mockHistoryFindUnique.mockResolvedValue({
      id: "h1",
      entryId: "p1",
      encryptedBlob: "restored-blob",
      blobIv: "restored-iv",
      blobAuthTag: "restored-tag",
      keyVersion: 2,
      aadVersion: 1,
      changedAt: new Date("2025-01-01"),
    });

    const historyCreate = vi.fn().mockResolvedValue({});
    const entryUpdate = vi.fn().mockResolvedValue({});
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return await fn({
        $queryRaw: mockTxQueryRaw(2, {
          encrypted_blob: "locked-current-blob",
          blob_iv: "locked-current-iv",
          blob_auth_tag: "locked-current-tag",
          key_version: 2,
          aad_version: 1,
        }),
        passwordEntryHistory: {
          create: historyCreate,
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn(),
        },
        passwordEntry: { update: entryUpdate },
      });
    });

    const req = createRequest("POST", "http://localhost/api/passwords/p1/history/h1/restore");
    const res = await POST(req, createParams({ id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);

    // Snapshot must come from the locked in-tx read, not staleEntry.
    expect(historyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryId: "p1",
          encryptedBlob: "locked-current-blob",
          blobIv: "locked-current-iv",
          blobAuthTag: "locked-current-tag",
          keyVersion: 2,
          aadVersion: 1,
        }),
      }),
    );

    // The restored data (not the current data) must be written to the entry
    expect(entryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          encryptedBlob: "restored-blob",
          blobIv: "restored-iv",
          blobAuthTag: "restored-tag",
        }),
      }),
    );
  });

  it("returns 409 KEY_VERSION_MISMATCH when history.keyVersion is stale", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({
      id: "p1",
      userId: DEFAULT_SESSION.user.id,
      tenantId: "tenant-1",
    });
    mockHistoryFindUnique.mockResolvedValue({
      id: "h1",
      entryId: "p1",
      encryptedBlob: "restored-blob",
      blobIv: "restored-iv",
      blobAuthTag: "restored-tag",
      keyVersion: 1,
      aadVersion: 0,
      changedAt: new Date("2025-01-01"),
    });
    const entryUpdate = vi.fn();
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return await fn({
        // rotated past history.keyVersion (1)
        $queryRaw: mockTxQueryRaw(2, {
          encrypted_blob: "locked-blob",
          blob_iv: "locked-iv",
          blob_auth_tag: "locked-tag",
          key_version: 2,
          aad_version: 1,
        }),
        passwordEntryHistory: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn(),
        },
        passwordEntry: { update: entryUpdate },
      });
    });

    const req = createRequest("POST", "http://localhost/api/passwords/p1/history/h1/restore");
    const res = await POST(req, createParams({ id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("KEY_VERSION_MISMATCH");
    expect(entryUpdate).not.toHaveBeenCalled();
  });
});
