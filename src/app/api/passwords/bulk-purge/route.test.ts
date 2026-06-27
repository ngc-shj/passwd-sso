import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockFindMany, mockDeleteMany, mockTransaction, mockLogAudit, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockDeleteMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  logAuditBulkAsync: vi.fn(async (entries: unknown[]) => {
    for (const e of entries) await mockLogAudit(e);
  }),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
// Irreversible bulk purge gates on requireRecentCurrentAuthMethod (step-up).
// Default: null (fresh session → allow). Stale-session tests override.
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: vi.fn().mockResolvedValue(null),
}));

import { POST } from "./route";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";

const mockRequireRecent = vi.mocked(requireRecentCurrentAuthMethod);

const URL = "http://localhost:3000/api/passwords/bulk-purge";
const ID_1 = "00000000-0000-4000-a000-000000000001";
const ID_2 = "00000000-0000-4000-a000-000000000002";

describe("POST /api/passwords/bulk-purge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRecent.mockResolvedValue(null);
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        passwordEntry: {
          findMany: mockFindMany,
          deleteMany: mockDeleteMany,
        },
      })
    );
    mockFindMany.mockResolvedValue([{ id: ID_1 }, { id: ID_2 }]);
    mockDeleteMany.mockResolvedValue({ count: 2 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, { body: { ids: [ID_1] } }));
    expect(res.status).toBe(401);
  });

  it("rejects with 403 and does NOT delete when session is stale (step-up required)", async () => {
    mockRequireRecent.mockResolvedValueOnce(
      NextResponse.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const res = await POST(createRequest("POST", URL, { body: { ids: [ID_1, ID_2] } }));

    expect(res.status).toBe(403);
    // Security-critical ordering: the purge must not run before step-up passes.
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("purges the supplied trashed ids when the session is fresh", async () => {
    const res = await POST(createRequest("POST", URL, { body: { ids: [ID_1, ID_2] } }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deletedCount).toBe(2);
    expect(mockDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: [ID_1, ID_2] },
          deletedAt: { not: null },
        }),
      })
    );
  });

  it("only targets trashed entries (deletedAt != null) in the scoped lookup", async () => {
    await POST(createRequest("POST", URL, { body: { ids: [ID_1, ID_2] } }));

    // The eligibility lookup must filter on deletedAt != null so live entries
    // can never be hard-deleted via this endpoint.
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: [ID_1, ID_2] },
          deletedAt: { not: null },
        }),
      })
    );
  });
});
