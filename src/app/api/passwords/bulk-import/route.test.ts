import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaPasswordEntry,
  mockPrismaFolder,
  mockPrismaTag,
  mockPrismaUser,
  mockAuditCreate,
  mockWithUserTenantRls,
  mockRateLimiterCheck,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: {
    create: vi.fn(),
  },
  mockPrismaFolder: { findFirst: vi.fn() },
  mockPrismaTag: { count: vi.fn() },
  mockPrismaUser: { findUnique: vi.fn() },
  mockAuditCreate: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockRateLimiterCheck: vi.fn(),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    folder: mockPrismaFolder,
    tag: mockPrismaTag,
    user: mockPrismaUser,
    auditLog: { create: mockAuditCreate },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({}),
}));
vi.mock("@/lib/logger", () => {
  const noop = vi.fn();
  const child = { info: noop, warn: noop, error: noop };
  return {
    default: { info: noop, warn: noop, error: noop, child: vi.fn().mockReturnValue(child) },
    requestContext: { run: (_s: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
    getLogger: () => child,
  };
});

import { POST } from "./route";
import { AUDIT_ACTION } from "@/lib/constants";

const URL = "http://localhost:3000/api/passwords/bulk-import";

const makeEntry = (id: string) => ({
  id,
  encryptedBlob: { ciphertext: "blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
  encryptedOverview: { ciphertext: "over", iv: "c".repeat(24), authTag: "d".repeat(32) },
  keyVersion: 1,
  aadVersion: 1,
});

describe("POST /api/passwords/bulk-import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockPrismaFolder.findFirst.mockResolvedValue({ id: "folder-1" });
    mockPrismaTag.count.mockResolvedValue(0);
    mockAuditCreate.mockResolvedValue({});
    mockPrismaPasswordEntry.create.mockImplementation(({ data }: { data: { id?: string } }) =>
      Promise.resolve({ id: data.id ?? "generated-id" }),
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, {
      body: { entries: [makeEntry("id-1")] },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when actor user record is not found", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, {
      body: { entries: [makeEntry("550e8400-e29b-41d4-a716-000000000001")] },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await POST(createRequest("POST", URL, {
      body: { entries: [makeEntry("id-1")] },
    }));
    expect(res.status).toBe(429);
  });

  it("returns 400 when entries array is empty", async () => {
    const res = await POST(createRequest("POST", URL, {
      body: { entries: [] },
    }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when entries exceed max (51 entries)", async () => {
    const entries = Array.from({ length: 51 }, (_, i) =>
      makeEntry(`550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`),
    );
    const res = await POST(createRequest("POST", URL, { body: { entries } }));
    expect(res.status).toBe(400);
  });

  it("imports 3 entries successfully (201)", async () => {
    const entries = [
      makeEntry("550e8400-e29b-41d4-a716-000000000001"),
      makeEntry("550e8400-e29b-41d4-a716-000000000002"),
      makeEntry("550e8400-e29b-41d4-a716-000000000003"),
    ];

    const res = await POST(createRequest("POST", URL, { body: { entries } }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(3);
    expect(json.failed).toBe(0);
  });

  it("returns partial failure when one entry has invalid folderId", async () => {
    // first and third entries reference an existing folder, second references a non-existent one
    mockPrismaFolder.findFirst
      .mockResolvedValueOnce({ id: "550e8400-e29b-41d4-a716-aaaaaaaaaaaa" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "550e8400-e29b-41d4-a716-aaaaaaaaaaaa" });

    const entries = [
      { ...makeEntry("550e8400-e29b-41d4-a716-000000000001"), folderId: "550e8400-e29b-41d4-a716-aaaaaaaaaaaa" },
      { ...makeEntry("550e8400-e29b-41d4-a716-000000000002"), folderId: "550e8400-e29b-41d4-a716-bbbbbbbbbbbb" },
      { ...makeEntry("550e8400-e29b-41d4-a716-000000000003"), folderId: "550e8400-e29b-41d4-a716-aaaaaaaaaaaa" },
    ];

    const res = await POST(createRequest("POST", URL, { body: { entries } }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(2);
    expect(json.failed).toBe(1);
  });

  it("calls logAuditAsync with ENTRY_BULK_IMPORT action", async () => {
    const entries = [
      makeEntry("550e8400-e29b-41d4-a716-000000000001"),
      makeEntry("550e8400-e29b-41d4-a716-000000000002"),
    ];

    await POST(createRequest("POST", URL, { body: { entries } }));

    expect(mockLogAudit).toHaveBeenCalledTimes(3); // 1 parent + 2 per-entry
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.ENTRY_BULK_IMPORT,
        metadata: expect.objectContaining({
          bulk: true,
          requestedCount: 2,
          createdCount: 2,
          failedCount: 0,
        }),
      }),
    );
  });

  it("calls logAuditAsync with ENTRY_CREATE for each created entry", async () => {
    const entries = [
      makeEntry("550e8400-e29b-41d4-a716-000000000001"),
      makeEntry("550e8400-e29b-41d4-a716-000000000002"),
      makeEntry("550e8400-e29b-41d4-a716-000000000003"),
    ];

    await POST(createRequest("POST", URL, { body: { entries } }));

    // logAuditAsync called once per entry with ENTRY_CREATE
    expect(mockLogAudit).toHaveBeenCalledTimes(4); // 1 parent + 3 per-entry
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.ENTRY_CREATE,
        targetId: "550e8400-e29b-41d4-a716-000000000001",
        metadata: expect.objectContaining({
          source: "bulk-import",
          parentAction: AUDIT_ACTION.ENTRY_BULK_IMPORT,
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.ENTRY_CREATE,
        targetId: "550e8400-e29b-41d4-a716-000000000002",
        metadata: expect.objectContaining({
          source: "bulk-import",
          parentAction: AUDIT_ACTION.ENTRY_BULK_IMPORT,
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.ENTRY_CREATE,
        targetId: "550e8400-e29b-41d4-a716-000000000003",
        metadata: expect.objectContaining({
          source: "bulk-import",
          parentAction: AUDIT_ACTION.ENTRY_BULK_IMPORT,
        }),
      }),
    );
  });

  it("uses rate limiter key scoped to userId", async () => {
    await POST(createRequest("POST", URL, {
      body: { entries: [makeEntry("550e8400-e29b-41d4-a716-000000000001")] },
    }));

    expect(mockRateLimiterCheck).toHaveBeenCalledWith("rl:passwords_bulk_import:test-user-id");
  });

  it("includes sanitized filename in audit metadata when provided", async () => {
    await POST(createRequest("POST", URL, {
      body: {
        entries: [makeEntry("550e8400-e29b-41d4-a716-000000000001")],
        sourceFilename: "passwords.csv",
      },
    }));

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ filename: "passwords.csv" }),
      }),
    );
  });
});
