import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaPasswordEntry,
  mockPrismaPasswordEntryHistory,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: { findUnique: vi.fn() },
  mockPrismaPasswordEntryHistory: {
    findUnique: vi.fn(),
  },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    passwordEntryHistory: mockPrismaPasswordEntryHistory,
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { GET } from "./route";

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

  it("returns 404 (A01-4) when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "other-user" });
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
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
