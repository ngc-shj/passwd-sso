import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockFindMany,
  mockDeleteMany,
  mockTransaction,
  mockLogAudit,
  mockWithUserTenantRls,
  mockRequireRecentCurrentAuthMethod,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockDeleteMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockRequireRecentCurrentAuthMethod: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentCurrentAuthMethod,
}));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mockTransaction } }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  logAuditBulkAsync: vi.fn(async (entries: unknown[]) => {
    for (const e of entries) await mockLogAudit(e);
  }),
  personalAuditBase: vi.fn((_req, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/tenant-context", () => ({ withUserTenantRls: mockWithUserTenantRls }));
// Blob cleanup returns [] for the DB blob backend; mock to keep the test deterministic.
vi.mock("@/lib/blob-store/cleanup", () => ({
  collectEntryAttachmentRefs: vi.fn(async () => []),
  deleteAttachmentBlobs: vi.fn(async () => {}),
}));

import { POST } from "@/app/api/passwords/bulk-purge/route";

const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("POST /api/passwords/bulk-purge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(null);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ passwordEntry: { findMany: mockFindMany, deleteMany: mockDeleteMany } }),
    );
    mockFindMany.mockResolvedValue([{ id: P1 }, { id: P2 }]);
    mockDeleteMany.mockResolvedValue({ count: 2 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/test", { body: { ids: [P1] } }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("permanently deletes only the selected trashed entries", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/test", { body: { ids: [P1, P2] } }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deletedCount).toBe(2);

    // Scoped to the supplied ids AND only entries already in trash (deletedAt != null).
    expect(mockDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [P1, P2] },
          deletedAt: { not: null },
        }),
      }),
    );
  });

  it("writes an ENTRY_BULK_PURGE summary + per-entry ENTRY_PERMANENT_DELETE logs", async () => {
    await POST(createRequest("POST", "http://localhost:3000/api/test", { body: { ids: [P1, P2] } }));

    // 1 summary + 2 per-entry = 3
    expect(mockLogAudit).toHaveBeenCalledTimes(3);
    expect(mockLogAudit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "ENTRY_BULK_PURGE",
        metadata: expect.objectContaining({
          bulk: true,
          operation: "bulk-purge",
          deletedCount: 2,
          entryIds: [P1, P2],
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "ENTRY_PERMANENT_DELETE",
        targetId: P1,
        metadata: expect.objectContaining({
          source: "bulk-purge",
          parentAction: "ENTRY_BULK_PURGE",
        }),
      }),
    );
  });

  it("returns deletedCount=0 with only a summary log when nothing matches", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    mockDeleteMany.mockResolvedValueOnce({ count: 0 });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/test", { body: { ids: [P1] } }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.deletedCount).toBe(0);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty ids array (schema validation)", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/test", { body: { ids: [] } }));
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 403 and does not delete when step-up reauth is required (stale session)", async () => {
    mockRequireRecentCurrentAuthMethod.mockResolvedValueOnce(
      NextResponse.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const res = await POST(createRequest("POST", "http://localhost:3000/api/test", { body: { ids: [P1, P2] } }));
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});
