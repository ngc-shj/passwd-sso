import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";

const {
  mockValidateApiKeyOnly,
  mockEnforceAccessRestriction,
  mockCheck,
  mockEntryFindUnique,
  mockEntryUpdate,
  mockEntryDelete,
  mockHistoryCreate,
  mockHistoryFindMany,
  mockHistoryDeleteMany,
  mockFolderFindFirst,
  mockTagCount,
  mockTransaction,
  mockLogAudit,
  mockWithTenantRls,
} = vi.hoisted(() => ({
  mockValidateApiKeyOnly: vi.fn(),
  mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockEntryFindUnique: vi.fn(),
  mockEntryUpdate: vi.fn(),
  mockEntryDelete: vi.fn(),
  mockHistoryCreate: vi.fn(),
  mockHistoryFindMany: vi.fn().mockResolvedValue([]),
  mockHistoryDeleteMany: vi.fn(),
  mockFolderFindFirst: vi.fn(),
  mockTagCount: vi.fn(),
  mockTransaction: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/api-key", () => ({ validateApiKeyOnly: mockValidateApiKeyOnly }));
vi.mock("@/lib/access-restriction", () => ({ enforceAccessRestriction: mockEnforceAccessRestriction }));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: { findUnique: mockEntryFindUnique, update: mockEntryUpdate, delete: mockEntryDelete },
    passwordEntryHistory: {
      create: mockHistoryCreate,
      findMany: mockHistoryFindMany,
      deleteMany: mockHistoryDeleteMany,
    },
    folder: { findFirst: mockFolderFindFirst },
    tag: { count: mockTagCount },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withTenantRls: mockWithTenantRls }));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));

import { GET, PUT, DELETE } from "./route";

const PW_ID = "pw-123";
const USER_ID = "user-1";
const TENANT_ID = "tenant-1";
const API_KEY_ID = "key-1";
const now = new Date("2025-01-01T00:00:00Z");

const validApiKey = { userId: USER_ID, tenantId: TENANT_ID, apiKeyId: API_KEY_ID };

const ownedEntry = {
  id: PW_ID,
  userId: USER_ID,
  tenantId: TENANT_ID,
  encryptedBlob: "blob-cipher",
  blobIv: "blob-iv",
  blobAuthTag: "blob-tag",
  encryptedOverview: "overview-cipher",
  overviewIv: "overview-iv",
  overviewAuthTag: "overview-tag",
  keyVersion: 1,
  aadVersion: 0,
  entryType: "LOGIN",
  isFavorite: false,
  isArchived: false,
  requireReprompt: false,
  expiresAt: null as Date | null,
  folderId: null as string | null,
  tags: [{ id: "tag-1" }],
  createdAt: now,
  updatedAt: now,
};

describe("GET /api/v1/passwords/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
  });

  it("returns 401 when API key is missing or invalid", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "INVALID" });
    const res = await GET(
      createRequest("GET", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBeDefined();
  });

  it("returns 403 when API key scope is insufficient", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "SCOPE_INSUFFICIENT" });
    const res = await GET(
      createRequest("GET", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when entry belongs to another user", async () => {
    mockEntryFindUnique.mockResolvedValue({ ...ownedEntry, userId: "other-user" });
    const res = await GET(
      createRequest("GET", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns entry with correct shape including select fields", async () => {
    mockEntryFindUnique.mockResolvedValue(ownedEntry);
    const res = await GET(
      createRequest("GET", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.id).toBe(PW_ID);
    expect(json.encryptedBlob).toEqual({
      ciphertext: "blob-cipher",
      iv: "blob-iv",
      authTag: "blob-tag",
    });
    expect(json.encryptedOverview).toEqual({
      ciphertext: "overview-cipher",
      iv: "overview-iv",
      authTag: "overview-tag",
    });
    expect(json.tagIds).toEqual(["tag-1"]);
    expect(json.keyVersion).toBe(1);
    expect(json.aadVersion).toBe(0);
  });
});

describe("PUT /api/v1/passwords/[id]", () => {
  const txMock = {
    passwordEntryHistory: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    passwordEntry: {
      update: vi.fn(),
    },
  };

  const updateBody = {
    encryptedBlob: { ciphertext: "new-blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
    encryptedOverview: { ciphertext: "new-over", iv: "c".repeat(24), authTag: "d".repeat(32) },
    keyVersion: 2,
  };

  const updatedEntry = {
    id: PW_ID,
    encryptedOverview: "new-over",
    overviewIv: "c".repeat(24),
    overviewAuthTag: "d".repeat(32),
    keyVersion: 2,
    aadVersion: 0,
    entryType: "LOGIN",
    requireReprompt: false,
    expiresAt: null,
    tags: [],
    createdAt: now,
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockEntryFindUnique.mockResolvedValue(ownedEntry);
    txMock.passwordEntryHistory.create.mockResolvedValue({});
    txMock.passwordEntryHistory.findMany.mockResolvedValue([]);
    txMock.passwordEntryHistory.deleteMany.mockResolvedValue({ count: 0 });
    txMock.passwordEntry.update.mockResolvedValue(updatedEntry);
    mockTransaction.mockImplementation(
      async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
    );
  });

  it("returns 401 when API key is missing or invalid", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "INVALID" });
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("updates entry and creates history snapshot in a single transaction", async () => {
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.id).toBe(PW_ID);
    expect(json.keyVersion).toBe(2);

    // History snapshot created inside transaction
    expect(mockTransaction).toHaveBeenCalled();
    expect(txMock.passwordEntryHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryId: PW_ID,
          encryptedBlob: ownedEntry.encryptedBlob,
          blobIv: ownedEntry.blobIv,
          blobAuthTag: ownedEntry.blobAuthTag,
        }),
      }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ENTRY_UPDATE", targetId: PW_ID }),
    );
  });

  it("trims history to newest 20 when over limit", async () => {
    txMock.passwordEntryHistory.findMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({ id: `hist-${i}` })),
    );

    await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );

    expect(txMock.passwordEntryHistory.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["hist-0"] } },
    });
  });

  it("does not create history snapshot when only metadata changes (no encryptedBlob)", async () => {
    txMock.passwordEntry.update.mockResolvedValue({ ...updatedEntry, isFavorite: true });

    await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: { isFavorite: true },
      }),
      createParams({ id: PW_ID }),
    );

    // Transaction is always used for atomicity, but history.create is skipped when no blob changes
    expect(mockTransaction).toHaveBeenCalled();
    expect(txMock.passwordEntryHistory.create).not.toHaveBeenCalled();
  });

  it("returns response without breaking when select clause omits some fields", async () => {
    // The updated entry from the transaction uses include: { tags: { select: { id: true } } }
    // so tags is present and the response shape should be valid
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toHaveProperty("tagIds");
    expect(json).toHaveProperty("encryptedOverview");
  });
});

describe("DELETE /api/v1/passwords/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockEntryFindUnique.mockResolvedValue({ userId: USER_ID });
  });

  it("returns 401 when API key is missing or invalid", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "INVALID" });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when entry belongs to another user", async () => {
    mockEntryFindUnique.mockResolvedValue({ userId: "other-user" });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("soft deletes (trash) by default", async () => {
    mockEntryUpdate.mockResolvedValue({});
    const res = await DELETE(
      createRequest("DELETE", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockEntryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deletedAt: expect.any(Date) } }),
    );
    expect(mockEntryDelete).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ENTRY_TRASH" }),
    );
  });

  it("permanently deletes when ?permanent=true", async () => {
    mockEntryDelete.mockResolvedValue({});
    const res = await DELETE(
      createRequest("DELETE", `http://localhost/api/v1/passwords/${PW_ID}`, {
        searchParams: { permanent: "true" },
      }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockEntryDelete).toHaveBeenCalledWith({ where: { id: PW_ID } });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ENTRY_PERMANENT_DELETE" }),
    );
  });
});
