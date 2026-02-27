import { describe, it, expect, vi, beforeEach } from "vitest";
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
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { POST } from "@/app/api/passwords/[id]/history/[historyId]/restore/route";

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
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 403 when entry belongs to another user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ id: "p1", userId: "other-user" });
    const req = createRequest("POST", "http://localhost/api/passwords/p1/history/h1/restore");
    const res = await POST(req, createParams({ id: "p1", historyId: "h1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
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
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
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
});
