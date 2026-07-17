import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";
import { ENTRY_TYPE } from "@/lib/constants";
import { API_ERROR } from "@/lib/http/api-error-codes";

const { mockCheckAuth, mockPrismaPasswordEntry, mockPrismaHistory, mockPrismaUser, mockPrismaFolder, mockPrismaTag, mockPrismaTransaction, mockAuditCreate, mockLogAudit, mockWithUserTenantRls, mockWithBypassRls, mockRateLimiterCheck } = vi.hoisted(() => ({
  mockCheckAuth: vi.fn(),
  mockPrismaPasswordEntry: {
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  mockPrismaHistory: {
    create: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaFolder: { findFirst: vi.fn() },
  mockPrismaTag: { count: vi.fn() },
  mockPrismaTransaction: vi.fn(),
  mockAuditCreate: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockRateLimiterCheck: vi.fn(),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/auth/session/check-auth", () => ({ checkAuth: mockCheckAuth }));
// A01-3: permanent=true DELETE gates on requireRecentCurrentAuthMethod.
// Default: null (allow). Tests for the rejection path override.
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    passwordEntryHistory: mockPrismaHistory,
    user: mockPrismaUser,
    folder: mockPrismaFolder,
    tag: mockPrismaTag,
    auditLog: { create: mockAuditCreate },
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit/audit")>();
  return {
    ...actual,
    logAuditAsync: mockLogAudit,
  };
});
import { NextResponse } from "next/server";

import { GET, PUT, DELETE } from "./route";

const PW_ID = "pw-123";
const now = new Date("2025-01-01T00:00:00Z");

const ownedEntry = {
  id: PW_ID,
  userId: "test-user-id",
  encryptedBlob: "blob-cipher",
  blobIv: "blob-iv",
  blobAuthTag: "blob-tag",
  encryptedOverview: "overview-cipher",
  overviewIv: "overview-iv",
  overviewAuthTag: "overview-tag",
  keyVersion: 1,
  aadVersion: 0,
  entryType: ENTRY_TYPE.LOGIN,
  isFavorite: false,
  isArchived: false,
  requireReprompt: false,
  expiresAt: null as Date | null,
  tags: [{ id: "t1" }],
  createdAt: now,
  updatedAt: now,
};

describe("GET /api/passwords/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "session", userId: "test-user-id" } });
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockAuditCreate.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockCheckAuth.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 }) });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for service_account auth type", async () => {
    // checkAuth rejects service_account internally (no userId)
    mockCheckAuth.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 }),
    });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(429);
  });

  it("returns 403 when scope insufficient", async () => {
    mockCheckAuth.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "EXTENSION_TOKEN_SCOPE_INSUFFICIENT" }, { status: 403 }) });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("accepts Bearer token auth", async () => {
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "token", userId: "test-user-id", scopes: ["passwords:read"] } });
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`, {
        headers: { Authorization: `Bearer ${"a".repeat(64)}` },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 (A01-4) when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ ...ownedEntry, userId: "other-user" });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns password entry with encrypted data and entryType", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBe(PW_ID);
    expect(json.entryType).toBe(ENTRY_TYPE.LOGIN);
    expect(json.encryptedBlob).toEqual({
      ciphertext: "blob-cipher",
      iv: "blob-iv",
      authTag: "blob-tag",
    });
    expect(json.tagIds).toEqual(["t1"]);
  });

  it("returns SECURE_NOTE entryType", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({
      ...ownedEntry,
      entryType: "SECURE_NOTE",
    });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.entryType).toBe("SECURE_NOTE");
  });

  it("returns aadVersion in response", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ ...ownedEntry, aadVersion: 1 });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.aadVersion).toBe(1);
  });

  it("returns aadVersion=0 for legacy entries", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(json.aadVersion).toBe(0);
  });

  it("returns requireReprompt in response", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ ...ownedEntry, requireReprompt: true });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.requireReprompt).toBe(true);
  });

  it("returns expiresAt in response", async () => {
    const futureDate = new Date("2026-06-01T00:00:00Z");
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ ...ownedEntry, expiresAt: futureDate });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.expiresAt).toBe(futureDate.toISOString());
  });

  it("returns null expiresAt when not set", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.expiresAt).toBeNull();
  });

  it("returns PASSKEY entryType", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({
      ...ownedEntry,
      entryType: "PASSKEY",
    });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.entryType).toBe("PASSKEY");
  });
});

describe("PUT /api/passwords/[id]", () => {
  // cur row returned by $queryRaw FOR UPDATE — values are DISTINCT from ownedEntry
  // so field-level assertions can detect if the handler reads from `existing` instead.
  const curRow = {
    encrypted_blob: "cur-blob-cipher",
    blob_iv: "cur-blob-iv",
    blob_auth_tag: "cur-blob-tag",
    key_version: 2,
    aad_version: 3,
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

  const txMock = {
    $queryRaw: vi.fn().mockImplementation(defaultQueryRawImpl),
    passwordEntryHistory: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    passwordEntry: {
      update: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "session", userId: "test-user-id" } });
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockPrismaFolder.findFirst.mockResolvedValue({ id: "folder-1" });
    mockPrismaTag.count.mockResolvedValue(1);
    mockAuditCreate.mockResolvedValue({});
    txMock.$queryRaw.mockImplementation(defaultQueryRawImpl);
    txMock.passwordEntryHistory.create.mockResolvedValue({});
    txMock.passwordEntryHistory.findMany.mockResolvedValue([]);
    txMock.passwordEntryHistory.deleteMany.mockResolvedValue({ count: 0 });
    txMock.passwordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "new-over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      aadVersion: 0,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    mockPrismaTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));
  });

  const updateBody = {
    encryptedBlob: { ciphertext: "new-blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
    encryptedOverview: { ciphertext: "new-over", iv: "c".repeat(24), authTag: "d".repeat(32) },
    keyVersion: 1,
  };

  it("returns 401 when unauthenticated", async () => {
    mockCheckAuth.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 }) });
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(429);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 (A01-4) when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ ...ownedEntry, userId: "other-user" });
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("updates password entry successfully", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    // blob-changing path: result comes from txMock.passwordEntry.update (already configured in beforeEach)

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBe(PW_ID);
  });

  it("returns 403 when write scope is insufficient", async () => {
    mockCheckAuth.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "EXTENSION_TOKEN_SCOPE_INSUFFICIENT" }, { status: 403 }) });
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on malformed JSON", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost:3000/api/passwords/${PW_ID}`, {
      method: "PUT",
      body: "{",
      headers: { "content-type": "application/json" },
    });
    const res = await PUT(req, createParams({ id: PW_ID }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when folderId is invalid", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaFolder.findFirst.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { ...updateBody, folderId: "missing-folder" },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when tagIds are invalid", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaTag.count.mockResolvedValue(0);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { ...updateBody, tagIds: ["tag-1"] },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("C3: succeeds when tagIds contain duplicates but are all owned (count mock returns 1 for [t1,t1])", async () => {
    // tag.count returns distinct row count; t1 is owned once → count=1.
    // Before the fix, ownedCount(1) !== tagIds.length(2) → 400.
    // After the fix, ownedCount(1) !== uniqueTagIds.length(1) → success.
    const ownedTagId = "00000000-0000-4000-a000-000000000001";
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaTag.count.mockResolvedValue(1);
    // metadata-only path (no blob): update goes through mockPrismaPasswordEntry.update
    mockPrismaPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "overview-cipher",
      overviewIv: "overview-iv",
      overviewAuthTag: "overview-tag",
      keyVersion: 1,
      tags: [{ id: ownedTagId }],
      createdAt: now,
      updatedAt: now,
    });
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { tagIds: [ownedTagId, ownedTagId] },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(200);
  });

  it("C3: still rejects when tagIds reference an unowned tag", async () => {
    // t1 owned, t2-unowned → count=1 but uniqueTagIds.length=2 → 400
    const ownedTagId = "00000000-0000-4000-a000-000000000001";
    const unownedTagId = "00000000-0000-4000-a000-000000000002";
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaTag.count.mockResolvedValue(1);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { tagIds: [ownedTagId, unownedTagId] },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("stores aadVersion when provided in update body", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    // blob-changing path: update goes through txMock.passwordEntry.update
    txMock.passwordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "new-over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      aadVersion: 1,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { ...updateBody, aadVersion: 1 },
      }),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.aadVersion).toBe(1);
    expect(txMock.passwordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aadVersion: 1 }),
      }),
    );
  });

  it("updates requireReprompt flag", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "overview-cipher",
      overviewIv: "overview-iv",
      overviewAuthTag: "overview-tag",
      keyVersion: 1,
      requireReprompt: true,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { requireReprompt: true },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requireReprompt: true }),
      }),
    );
  });

  it("updates expiresAt with ISO string", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "overview-cipher",
      overviewIv: "overview-iv",
      overviewAuthTag: "overview-tag",
      keyVersion: 1,
      expiresAt: new Date("2026-06-01T00:00:00.000Z"),
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { expiresAt: "2026-06-01T00:00:00.000Z" },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt: new Date("2026-06-01T00:00:00.000Z") }),
      }),
    );
  });

  it("clears expiresAt with null", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ ...ownedEntry, expiresAt: new Date("2026-06-01") });
    mockPrismaPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "overview-cipher",
      overviewIv: "overview-iv",
      overviewAuthTag: "overview-tag",
      keyVersion: 1,
      expiresAt: null,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { expiresAt: null },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt: null }),
      }),
    );
  });

  it("updates favorite and archive flags", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "overview-cipher",
      overviewIv: "overview-iv",
      overviewAuthTag: "overview-tag",
      keyVersion: 1,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { isFavorite: true, isArchived: false },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isFavorite: true, isArchived: false }),
      }),
    );
  });

  it("creates history snapshot when encryptedBlob is updated", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);

    const updateBodyWithBlob = {
      encryptedBlob: { ciphertext: "new-blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
      encryptedOverview: { ciphertext: "new-over", iv: "c".repeat(24), authTag: "d".repeat(32) },
      keyVersion: 1,
    };

    await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBodyWithBlob }),
      createParams({ id: PW_ID }),
    );

    // $transaction and $queryRaw FOR UPDATE must be called
    expect(mockPrismaTransaction).toHaveBeenCalled();
    expect(txMock.$queryRaw).toHaveBeenCalled();
    // Snapshot fields must come from curRow (the FOR UPDATE result), NOT from ownedEntry
    expect(txMock.passwordEntryHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entryId: PW_ID,
        encryptedBlob: curRow.encrypted_blob,
        blobIv: curRow.blob_iv,
        blobAuthTag: curRow.blob_auth_tag,
        keyVersion: curRow.key_version,
        aadVersion: curRow.aad_version,
      }),
    });
  });

  it("trims history to the newest 20 snapshots", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    txMock.passwordEntryHistory.findMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({ id: `hist-${index}` })),
    );
    // blob-changing path: update goes through txMock.passwordEntry.update

    await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );

    expect(txMock.passwordEntryHistory.deleteMany).toHaveBeenCalledWith({
      where: { entryId: PW_ID, id: { in: ["hist-0"] } },
    });
  });

  it("updates tagIds with set semantics", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaTag.count.mockResolvedValue(2);
    const tagIds = ["00000000-0000-4000-a000-000000000001", "00000000-0000-4000-a000-000000000002"];
    // metadata-only path (no encryptedBlob): update goes through mockPrismaPasswordEntry.update
    mockPrismaPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "overview-cipher",
      overviewIv: "overview-iv",
      overviewAuthTag: "overview-tag",
      keyVersion: 1,
      tags: [{ id: tagIds[0] }, { id: tagIds[1] }],
      createdAt: now,
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { tagIds },
      }),
      createParams({ id: PW_ID }),
    );

    expect(res.status).toBe(200);
    expect(mockPrismaPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tags: { set: [{ id: tagIds[0] }, { id: tagIds[1] }] },
        }),
      }),
    );
  });

  it("does not create history snapshot when only metadata changes", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "overview-cipher",
      overviewIv: "overview-iv",
      overviewAuthTag: "overview-tag",
      keyVersion: 1,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { isFavorite: true },
      }),
      createParams({ id: PW_ID }),
    );

    // $transaction should NOT have been called since no blob change
    expect(mockPrismaTransaction).not.toHaveBeenCalled();
  });

  // C7: version metadata change without re-encryption
  it("rejects aadVersion change without encryptedBlob → 409 KEY_VERSION_WITHOUT_REENCRYPT", async () => {
    // ownedEntry has aadVersion=0; sending aadVersion=1 without blob should be rejected
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { aadVersion: 1 },
      }),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe(API_ERROR.KEY_VERSION_WITHOUT_REENCRYPT);
  });

  it("rejects keyVersion change without encryptedBlob → 409 KEY_VERSION_WITHOUT_REENCRYPT", async () => {
    // ownedEntry has keyVersion=1; sending keyVersion=2 without blob should be rejected
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { keyVersion: 2 },
      }),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe(API_ERROR.KEY_VERSION_WITHOUT_REENCRYPT);
  });

  it("allows same aadVersion without encryptedBlob → no error", async () => {
    // ownedEntry has aadVersion=0; sending aadVersion=0 is a no-op (same value)
    // NOTE: aadVersion schema has min(1), so we simulate an entry with aadVersion=1
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ ...ownedEntry, aadVersion: 1 });
    mockPrismaPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "overview-cipher",
      overviewIv: "overview-iv",
      overviewAuthTag: "overview-tag",
      keyVersion: 1,
      aadVersion: 1,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { aadVersion: 1 },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(200);
  });

  // C1: FOR UPDATE snapshot source and SQL text guard
  it("C1: $queryRaw is called before History.create on blob-changing PUT", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    const callOrder: string[] = [];
    txMock.$queryRaw.mockImplementation((tpl: TemplateStringsArray) => {
      const sql = tpl.join("?");
      if (/FROM users/i.test(sql)) {
        callOrder.push("$queryRaw:users");
        return Promise.resolve([{ key_version: 1 }]);
      }
      callOrder.push("$queryRaw:entries");
      return Promise.resolve([curRow]);
    });
    txMock.passwordEntryHistory.create.mockImplementation(() => {
      callOrder.push("historyCreate");
      return Promise.resolve({});
    });

    await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );

    // Both queryRaw reads (user guard, then entry FOR UPDATE) precede History.create.
    expect(callOrder.indexOf("$queryRaw:users")).toBeLessThan(callOrder.indexOf("$queryRaw:entries"));
    expect(callOrder.indexOf("$queryRaw:entries")).toBeLessThan(callOrder.indexOf("historyCreate"));
  });

  it("C1: FOR UPDATE SQL contains table name and required crypto columns", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);

    await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );

    expect(txMock.$queryRaw).toHaveBeenCalledTimes(2);
    // Two distinct queryRaw reads now fire: assertCurrentKeyVersion's `FROM
    // users` guard, then the entry FOR UPDATE snapshot — find the latter by
    // SQL text rather than assuming call index.
    const entryCall = txMock.$queryRaw.mock.calls.find(([tpl]) => {
      const sqlText = (tpl as TemplateStringsArray).join("?");
      return /FROM password_entries/i.test(sqlText);
    }) as [TemplateStringsArray, ...unknown[]] | undefined;
    expect(entryCall).toBeDefined();
    const sql = entryCall![0].join("?");
    expect(sql).toMatch(/FOR UPDATE/i);
    expect(sql).toMatch(/password_entries/i);
    expect(sql).toMatch(/encrypted_blob/i);
    expect(sql).toMatch(/blob_iv/i);
    expect(sql).toMatch(/blob_auth_tag/i);
    expect(sql).toMatch(/key_version/i);
    expect(sql).toMatch(/aad_version/i);
  });

  it("C1: all 5 crypto fields in History.create come from $queryRaw result, not from existing", async () => {
    // curRow values are intentionally distinct from ownedEntry values
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);

    await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );

    const histData = txMock.passwordEntryHistory.create.mock.calls[0][0].data;
    // Each field must equal curRow value (not ownedEntry value)
    expect(histData.encryptedBlob).toBe(curRow.encrypted_blob);
    expect(histData.blobIv).toBe(curRow.blob_iv);
    expect(histData.blobAuthTag).toBe(curRow.blob_auth_tag);
    expect(histData.keyVersion).toBe(curRow.key_version);
    expect(histData.aadVersion).toBe(curRow.aad_version);
    // Distinct-from-ownedEntry sanity check
    expect(histData.encryptedBlob).not.toBe(ownedEntry.encryptedBlob);
    expect(histData.blobIv).not.toBe(ownedEntry.blobIv);
    expect(histData.keyVersion).not.toBe(ownedEntry.keyVersion);
  });

  // F1: race — entry deleted between early read and FOR UPDATE lock
  it("F1: returns 404 when $queryRaw FOR UPDATE returns empty (concurrent delete)", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    // Only the entry FOR UPDATE read returns empty (row gone by the time the
    // lock fires) — the users guard read must still resolve normally so this
    // test isolates the entry-delete race, not a keyVersion mismatch.
    txMock.$queryRaw.mockImplementation((tpl: TemplateStringsArray) => {
      const sql = tpl.join("?");
      if (/FROM users/i.test(sql)) {
        return Promise.resolve([{ key_version: 1 }]);
      }
      return Promise.resolve([]);
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );

    expect(res.status).toBe(404);
    // update must NOT have been called — the handler must abort before writing
    expect(txMock.passwordEntry.update).not.toHaveBeenCalled();
  });

  it("C1: metadata-only PUT issues no $queryRaw and no History.create", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "overview-cipher",
      overviewIv: "overview-iv",
      overviewAuthTag: "overview-tag",
      keyVersion: 1,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, {
        body: { isFavorite: true },
      }),
      createParams({ id: PW_ID }),
    );

    expect(txMock.$queryRaw).not.toHaveBeenCalled();
    expect(txMock.passwordEntryHistory.create).not.toHaveBeenCalled();
    expect(mockPrismaTransaction).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/passwords/[id]", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "session", userId: "test-user-id" } });
    mockAuditCreate.mockResolvedValue({});
    // vi.clearAllMocks() wipes the factory default (mockResolvedValue(null)),
    // so re-establish "fresh step-up" here — no test then depends on leaked state.
    const { requireRecentCurrentAuthMethod } = await import(
      "@/lib/auth/session/recent-current-auth-method"
    );
    vi.mocked(requireRecentCurrentAuthMethod).mockResolvedValue(null);
  });

  it("returns 401 when unauthenticated", async () => {
    mockCheckAuth.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 }) });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 (A01-4) when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ ...ownedEntry, userId: "other-user" });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("soft deletes (moves to trash) by default", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntry.update.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { deletedAt: expect.any(Date) },
      }),
    );
    expect(mockPrismaPasswordEntry.delete).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_TRASH",
      })
    );
  });

  it("permanently deletes when permanent=true", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntry.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`, {
        searchParams: { permanent: "true" },
      }),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaPasswordEntry.delete).toHaveBeenCalledWith({ where: { id: PW_ID, userId: "test-user-id" } });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_PERMANENT_DELETE",
      })
    );
  });

  it("soft deletes PASSKEY entry", async () => {
    const passkeyEntry = { ...ownedEntry, entryType: "PASSKEY" };
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(passkeyEntry);
    mockPrismaPasswordEntry.update.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { deletedAt: expect.any(Date) },
      }),
    );
  });

  // ── C3: token soft-delete (extension passkey-replace) + permanent-delete guard ──

  const tokenAuth = (type: "token" | "api_key" | "mcp_token") => ({
    ok: true as const,
    auth: { type, userId: "test-user-id", scopes: ["passwords:write"] },
  });

  it("requests the PASSWORDS_WRITE scope (token soft-delete enabled)", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntry.update.mockResolvedValue({});
    await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    // The mock is arg-agnostic, so without this assertion the scope change is
    // vacuously untested.
    expect(mockCheckAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "passwords:write" }),
    );
  });

  it("soft-deletes for a passwords:write token (200, trashed, no hard delete)", async () => {
    mockCheckAuth.mockResolvedValue(tokenAuth("token"));
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntry.update.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deletedAt: expect.any(Date) } }),
    );
    expect(mockPrismaPasswordEntry.delete).not.toHaveBeenCalled();
  });

  it.each(["token", "api_key", "mcp_token"] as const)(
    "rejects permanent=true for a %s caller with 403 (no delete)",
    async (type) => {
      mockCheckAuth.mockResolvedValue(tokenAuth(type));
      mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);

      const res = await DELETE(
        createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`, {
          searchParams: { permanent: "true" },
        }),
        createParams({ id: PW_ID }),
      );
      const json = await res.json();
      expect(res.status).toBe(403);
      expect(json.error).toBe("FORBIDDEN");
      expect(mockPrismaPasswordEntry.delete).not.toHaveBeenCalled();
      expect(mockPrismaPasswordEntry.update).not.toHaveBeenCalled();
    },
  );

  it("token permanent=true short-circuits to 403 BEFORE step-up (ordering)", async () => {
    // Even if step-up would have produced its own response, the token guard
    // must win first → 403, not the step-up 401. Use a persistent (non-Once)
    // override so an un-consumed Once value cannot leak into a later test.
    const { requireRecentCurrentAuthMethod } = await import(
      "@/lib/auth/session/recent-current-auth-method"
    );
    vi.mocked(requireRecentCurrentAuthMethod).mockResolvedValue(
      NextResponse.json({ error: "STEP_UP" }, { status: 401 }),
    );
    mockCheckAuth.mockResolvedValue(tokenAuth("token"));
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`, {
        searchParams: { permanent: "true" },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(403);
    expect(requireRecentCurrentAuthMethod).not.toHaveBeenCalled();
    // No manual restore needed — beforeEach re-establishes the null default.
  });

  it("returns 404 for a token caller deleting another user's entry (oracle collapse)", async () => {
    mockCheckAuth.mockResolvedValue(tokenAuth("token"));
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ ...ownedEntry, userId: "other-user" });

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("session permanent=true still works with fresh step-up (unchanged)", async () => {
    const { requireRecentCurrentAuthMethod } = await import(
      "@/lib/auth/session/recent-current-auth-method"
    );
    vi.mocked(requireRecentCurrentAuthMethod).mockResolvedValue(null); // fresh
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "session", userId: "test-user-id" } });
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntry.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`, {
        searchParams: { permanent: "true" },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaPasswordEntry.delete).toHaveBeenCalled();
  });

  it("session permanent=true with stale step-up returns the step-up response", async () => {
    const { requireRecentCurrentAuthMethod } = await import(
      "@/lib/auth/session/recent-current-auth-method"
    );
    vi.mocked(requireRecentCurrentAuthMethod).mockResolvedValueOnce(
      NextResponse.json({ error: "STEP_UP_REQUIRED" }, { status: 401 }),
    );
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "session", userId: "test-user-id" } });
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`, {
        searchParams: { permanent: "true" },
      }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(401);
    expect(mockPrismaPasswordEntry.delete).not.toHaveBeenCalled();
  });
});
