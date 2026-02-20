import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";
import { ENTRY_TYPE } from "@/lib/constants";

const { mockAuth, mockAuthOrToken, mockPrismaPasswordEntry, mockPrismaHistory, mockPrismaTransaction, mockAuditCreate } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockAuthOrToken: vi.fn(),
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
  mockPrismaTransaction: vi.fn(),
  mockAuditCreate: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth-or-token", () => ({ authOrToken: mockAuthOrToken }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    passwordEntryHistory: mockPrismaHistory,
    auditLog: { create: mockAuditCreate },
    $transaction: mockPrismaTransaction,
  },
}));

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
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: "test-user-id" });
    mockAuditCreate.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthOrToken.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when scope insufficient", async () => {
    mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("accepts Bearer token auth", async () => {
    mockAuthOrToken.mockResolvedValue({ type: "token", userId: "test-user-id", scopes: ["passwords:read"] });
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

  it("returns 403 when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ ...ownedEntry, userId: "other-user" });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(403);
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
  const txMock = {
    passwordEntryHistory: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockAuditCreate.mockResolvedValue({});
    mockPrismaTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));
  });

  const updateBody = {
    encryptedBlob: { ciphertext: "new-blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
    encryptedOverview: { ciphertext: "new-over", iv: "c".repeat(24), authTag: "d".repeat(32) },
    keyVersion: 1,
  };

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ ...ownedEntry, userId: "other-user" });
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("updates password entry successfully", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "new-over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBe(PW_ID);
  });

  it("stores aadVersion when provided in update body", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(ownedEntry);
    mockPrismaPasswordEntry.update.mockResolvedValue({
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
    expect(mockPrismaPasswordEntry.update).toHaveBeenCalledWith(
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
    mockPrismaPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      encryptedOverview: "new-over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const updateBodyWithBlob = {
      encryptedBlob: { ciphertext: "new-blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
      encryptedOverview: { ciphertext: "new-over", iv: "c".repeat(24), authTag: "d".repeat(32) },
      keyVersion: 1,
    };

    await PUT(
      createRequest("PUT", `http://localhost:3000/api/passwords/${PW_ID}`, { body: updateBodyWithBlob }),
      createParams({ id: PW_ID }),
    );

    // Should have called $transaction to create history snapshot
    expect(mockPrismaTransaction).toHaveBeenCalled();
    expect(txMock.passwordEntryHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entryId: PW_ID,
        encryptedBlob: ownedEntry.encryptedBlob,
        blobIv: ownedEntry.blobIv,
        blobAuthTag: ownedEntry.blobAuthTag,
      }),
    });
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
});

describe("DELETE /api/passwords/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockAuditCreate.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
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

  it("returns 403 when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ ...ownedEntry, userId: "other-user" });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(403);
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
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_TRASH",
        }),
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
    expect(mockPrismaPasswordEntry.delete).toHaveBeenCalledWith({ where: { id: PW_ID } });
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_PERMANENT_DELETE",
        }),
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
});
