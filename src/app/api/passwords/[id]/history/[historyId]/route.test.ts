import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";
import { createHash } from "node:crypto";

const {
  mockAuth,
  mockPrismaPasswordEntry,
  mockPrismaPasswordEntryHistory,
  mockLogAudit,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: { findUnique: vi.fn() },
  mockPrismaPasswordEntryHistory: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  mockLogAudit: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    passwordEntryHistory: mockPrismaPasswordEntryHistory,
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: () => Promise.resolve({ allowed: true }) }),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { GET, PATCH } from "./route";

const USER_ID = "user-1";
const ENTRY_ID = "entry-456";
const HISTORY_ID = "hist-789";

function makeUrl() {
  return `http://localhost:3000/api/passwords/${ENTRY_ID}/history/${HISTORY_ID}`;
}

function makeParams() {
  return createParams({ id: ENTRY_ID, historyId: HISTORY_ID });
}

const ownedEntry = { userId: USER_ID };

const historyRecord = {
  id: HISTORY_ID,
  entryId: ENTRY_ID,
  encryptedBlob: "encrypted-blob-data",
  blobIv: "aabbccddee001122334455",
  blobAuthTag: "aabbccddee00112233445566778899aa",
  keyVersion: 1,
  aadVersion: 1,
  changedAt: new Date("2025-01-01T00:00:00Z"),
};

// Valid PATCH body — all hex fields match the schema lengths
const BLOB_IV = "a".repeat(24);        // 12 bytes = 24 hex chars
const BLOB_AUTH_TAG = "b".repeat(32);  // 16 bytes = 32 hex chars
const OLD_BLOB = "old-encrypted-blob";
const OLD_BLOB_HASH = createHash("sha256").update(OLD_BLOB).digest("hex"); // 32 bytes = 64 hex chars

const validPatchBody = {
  encryptedBlob: "new-encrypted-blob",
  blobIv: BLOB_IV,
  blobAuthTag: BLOB_AUTH_TAG,
  keyVersion: 2,
  oldBlobHash: OLD_BLOB_HASH,
};

describe("GET /api/passwords/[id]/history/[historyId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    // Default: both entry and history found via Promise.all
    mockWithUserTenantRls.mockImplementation(async (_userId: string, fn: () => unknown) => fn());
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntryHistory.findUnique.mockResolvedValue(historyRecord);
  });

  it("returns history record on success (entry + history fetched via Promise.all)", async () => {
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBe(HISTORY_ID);
    expect(json.entryId).toBe(ENTRY_ID);
    expect(json.encryptedBlob).toEqual({
      ciphertext: historyRecord.encryptedBlob,
      iv: historyRecord.blobIv,
      authTag: historyRecord.blobAuthTag,
    });
    expect(json.keyVersion).toBe(historyRecord.keyVersion);
    expect(json.aadVersion).toBe(historyRecord.aadVersion);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 403 when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "other-user" });
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 404 when history not found", async () => {
    mockPrismaPasswordEntryHistory.findUnique.mockResolvedValue(null);
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toBe("HISTORY_NOT_FOUND");
  });

  it("returns 404 when history entryId does not match", async () => {
    mockPrismaPasswordEntryHistory.findUnique.mockResolvedValue({
      ...historyRecord,
      entryId: "different-entry",
    });
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toBe("HISTORY_NOT_FOUND");
  });
});

describe("PATCH /api/passwords/[id]/history/[historyId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    mockWithUserTenantRls.mockImplementation(async (_userId: string, fn: () => unknown) => fn());
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntryHistory.findUnique.mockResolvedValue({
      ...historyRecord,
      encryptedBlob: OLD_BLOB,
      keyVersion: 1,
    });
    mockPrismaPasswordEntryHistory.updateMany.mockResolvedValue({ count: 1 });
  });

  it("re-encrypts history record on success", async () => {
    const res = await PATCH(
      createRequest("PATCH", makeUrl(), { body: validPatchBody }),
      makeParams(),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaPasswordEntryHistory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: HISTORY_ID, keyVersion: 1 },
        data: expect.objectContaining({
          encryptedBlob: validPatchBody.encryptedBlob,
          keyVersion: 2,
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_HISTORY_REENCRYPT",
        targetId: ENTRY_ID,
        metadata: expect.objectContaining({
          historyId: HISTORY_ID,
          oldKeyVersion: 1,
          newKeyVersion: 2,
        }),
      }),
    );
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await PATCH(
      createRequest("PATCH", makeUrl(), { body: validPatchBody }),
      makeParams(),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when history not found", async () => {
    mockPrismaPasswordEntryHistory.findUnique.mockResolvedValue(null);
    const res = await PATCH(
      createRequest("PATCH", makeUrl(), { body: validPatchBody }),
      makeParams(),
    );
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toBe("HISTORY_NOT_FOUND");
  });

  it("returns 400 when key version is not newer", async () => {
    const res = await PATCH(
      createRequest("PATCH", makeUrl(), {
        body: { ...validPatchBody, keyVersion: 1 }, // same as current keyVersion: 1
      }),
      makeParams(),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("KEY_VERSION_NOT_NEWER");
  });

  it("returns 409 when old blob hash does not match", async () => {
    const res = await PATCH(
      createRequest("PATCH", makeUrl(), {
        body: { ...validPatchBody, oldBlobHash: "a".repeat(64) }, // wrong hash
      }),
      makeParams(),
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("BLOB_HASH_MISMATCH");
  });

  it("returns 409 when optimistic lock fails (concurrent update)", async () => {
    mockPrismaPasswordEntryHistory.updateMany.mockResolvedValue({ count: 0 });
    const res = await PATCH(
      createRequest("PATCH", makeUrl(), { body: validPatchBody }),
      makeParams(),
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("BLOB_HASH_MISMATCH");
  });
});
