import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";
import { createHash } from "node:crypto";

const {
  mockAuth, mockEntryFindUnique, mockHistoryFindUnique, mockHistoryUpdate,
  mockWithUserTenantRls, mockLogAudit, mockRateLimiterCheck,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockHistoryFindUnique: vi.fn(),
  mockHistoryUpdate: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: { findUnique: mockEntryFindUnique },
    passwordEntryHistory: {
      findUnique: mockHistoryFindUnique,
      update: mockHistoryUpdate,
    },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));

import { GET, PATCH } from "@/app/api/passwords/[id]/history/[historyId]/route";

const VALID_IV = "a".repeat(24); // 12 bytes hex
const VALID_AUTH_TAG = "b".repeat(32); // 16 bytes hex
const OLD_BLOB = "old-encrypted-data";
const OLD_BLOB_HASH = createHash("sha256").update(OLD_BLOB).digest("hex");

const HISTORY_ENTRY = {
  id: "h1",
  entryId: "p1",
  encryptedBlob: OLD_BLOB,
  blobIv: VALID_IV,
  blobAuthTag: VALID_AUTH_TAG,
  keyVersion: 1,
  aadVersion: 0,
  changedAt: new Date("2025-01-15T10:00:00Z"),
};

describe("GET /api/passwords/[id]/history/[historyId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost/api/passwords/p1/history/h1");
    const res = await GET(req, createParams({ id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost/api/passwords/p1/history/h1");
    const res = await GET(req, createParams({ id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 403 when entry belongs to another user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: "other-user" });
    const req = createRequest("GET", "http://localhost/api/passwords/p1/history/h1");
    const res = await GET(req, createParams({ id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns individual history entry", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockHistoryFindUnique.mockResolvedValue(HISTORY_ENTRY);

    const req = createRequest("GET", "http://localhost/api/passwords/p1/history/h1");
    const res = await GET(req, createParams({ id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.id).toBe("h1");
    expect(json.encryptedBlob.ciphertext).toBe(OLD_BLOB);
    expect(json.keyVersion).toBe(1);
  });
});

describe("PATCH /api/passwords/[id]/history/[historyId]", () => {
  beforeEach(() => vi.clearAllMocks());

  function makePatchRequest(body: Record<string, unknown>) {
    return createRequest("PATCH", "http://localhost/api/passwords/p1/history/h1", { body });
  }

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PATCH(makePatchRequest({}), createParams({ id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRateLimiterCheck.mockResolvedValueOnce({ allowed: false });
    const res = await PATCH(makePatchRequest({}), createParams({ id: "p1", historyId: "h1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
  });

  it("returns 400 for missing fields", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const res = await PATCH(
      makePatchRequest({ encryptedBlob: "data" }),
      createParams({ id: "p1", historyId: "h1" }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 404 when history entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockHistoryFindUnique.mockResolvedValue(null);
    const res = await PATCH(
      makePatchRequest({
        encryptedBlob: "new-cipher",
        blobIv: VALID_IV,
        blobAuthTag: VALID_AUTH_TAG,
        keyVersion: 2,
        oldBlobHash: OLD_BLOB_HASH,
      }),
      createParams({ id: "p1", historyId: "h1" }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 400 for invalid IV format", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    const res = await PATCH(
      makePatchRequest({
        encryptedBlob: "new-cipher",
        blobIv: "short",
        blobAuthTag: VALID_AUTH_TAG,
        keyVersion: 2,
        oldBlobHash: OLD_BLOB_HASH,
      }),
      createParams({ id: "p1", historyId: "h1" }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 400 for key version downgrade", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockHistoryFindUnique.mockResolvedValue(HISTORY_ENTRY);

    const res = await PATCH(
      makePatchRequest({
        encryptedBlob: "new-cipher",
        blobIv: VALID_IV,
        blobAuthTag: VALID_AUTH_TAG,
        keyVersion: 1, // same as old
        oldBlobHash: OLD_BLOB_HASH,
      }),
      createParams({ id: "p1", historyId: "h1" }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("KEY_VERSION_NOT_NEWER");
  });

  it("returns 409 for blob hash mismatch", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockHistoryFindUnique.mockResolvedValue(HISTORY_ENTRY);

    const res = await PATCH(
      makePatchRequest({
        encryptedBlob: "new-cipher",
        blobIv: VALID_IV,
        blobAuthTag: VALID_AUTH_TAG,
        keyVersion: 2,
        oldBlobHash: "c".repeat(64),
      }),
      createParams({ id: "p1", historyId: "h1" }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("BLOB_HASH_MISMATCH");
  });

  it("successfully re-encrypts history entry", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockHistoryFindUnique.mockResolvedValue(HISTORY_ENTRY);
    mockHistoryUpdate.mockResolvedValue({});

    const res = await PATCH(
      makePatchRequest({
        encryptedBlob: "new-cipher",
        blobIv: VALID_IV,
        blobAuthTag: VALID_AUTH_TAG,
        keyVersion: 2,
        oldBlobHash: OLD_BLOB_HASH,
      }),
      createParams({ id: "p1", historyId: "h1" }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.success).toBe(true);

    expect(mockHistoryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "h1" },
        data: expect.objectContaining({
          encryptedBlob: "new-cipher",
          keyVersion: 2,
        }),
      }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_HISTORY_REENCRYPT",
        metadata: expect.objectContaining({
          oldKeyVersion: 1,
          newKeyVersion: 2,
        }),
      }),
    );
  });
});
