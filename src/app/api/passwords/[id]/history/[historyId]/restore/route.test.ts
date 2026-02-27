import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaPasswordEntry, mockPrismaHistory, mockPrismaTransaction, mockLogAudit, mockWithUserTenantRls } =
  vi.hoisted(() => ({
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
  }));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    passwordEntryHistory: mockPrismaHistory,
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
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

  it("returns 403 when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({
      ...ownedEntry,
      userId: "other-user",
    });
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${ENTRY_ID}/history/${HISTORY_ID}/restore`),
      createParams({ id: ENTRY_ID, historyId: HISTORY_ID }),
    );
    expect(res.status).toBe(403);
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
    mockPrismaTransaction.mockResolvedValue(undefined);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${ENTRY_ID}/history/${HISTORY_ID}/restore`),
      createParams({ id: ENTRY_ID, historyId: HISTORY_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaTransaction).toHaveBeenCalled();
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
});
