import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockAuditLogFindMany,
  mockPasswordEntryFindMany,
  mockUserFindMany,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockAuditLogFindMany: vi.fn(),
  mockPasswordEntryFindMany: vi.fn(),
  mockUserFindMany: vi.fn(),
  mockWithUserTenantRls: vi.fn(
    async (_userId: string, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: mockAuditLogFindMany },
    passwordEntry: { findMany: mockPasswordEntryFindMany },
    user: { findMany: mockUserFindMany },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { GET } from "./route";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

const BASE_URL = "http://localhost:3000/api/audit-logs";
const now = new Date("2026-03-01T12:00:00Z");

function makeLog(overrides: Record<string, unknown> = {}) {
  return {
    id: "log-1",
    action: AUDIT_ACTION.ENTRY_CREATE,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: "entry-1",
    metadata: null,
    ip: "127.0.0.1",
    userAgent: "test-agent",
    createdAt: now,
    scope: AUDIT_SCOPE.PERSONAL,
    userId: "user-1",
    user: { id: "user-1", name: "Alice", email: "alice@example.com", image: null },
    ...overrides,
  };
}

describe("GET /api/audit-logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockAuditLogFindMany.mockResolvedValue([]);
    mockPasswordEntryFindMany.mockResolvedValue([]);
    mockUserFindMany.mockResolvedValue([]);
  });

  // --- 401 unauthenticated ---

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("GET", BASE_URL));
    expect(res.status).toBe(401);
  });

  // --- Success: returns paginated audit logs with correct shape ---

  it("returns paginated logs with correct response shape", async () => {
    const log = makeLog();
    mockAuditLogFindMany.mockResolvedValue([log]);
    // Route does a separate user.findMany batch lookup (no longer uses include relation)
    mockUserFindMany.mockResolvedValue([
      { id: "user-1", name: "Alice", email: "alice@example.com", image: null },
    ]);

    const res = await GET(createRequest("GET", BASE_URL));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json).toHaveProperty("items");
    expect(json).toHaveProperty("nextCursor");
    expect(json).toHaveProperty("entryOverviews");
    expect(json).toHaveProperty("relatedUsers");

    const item = json.items[0];
    expect(item).toMatchObject({
      id: "log-1",
      action: AUDIT_ACTION.ENTRY_CREATE,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: "entry-1",
      metadata: null,
      ip: "127.0.0.1",
      userAgent: "test-agent",
      user: { id: "user-1", name: "Alice", email: "alice@example.com", image: null },
    });
  });

  it("returns nextCursor as null when no more pages", async () => {
    mockAuditLogFindMany.mockResolvedValue([makeLog()]);

    const res = await GET(createRequest("GET", BASE_URL, { searchParams: { limit: "10" } }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.nextCursor).toBeNull();
    expect(json.items).toHaveLength(1);
  });

  it("returns null user when log has no associated user", async () => {
    const log = makeLog({ user: null });
    mockAuditLogFindMany.mockResolvedValue([log]);

    const res = await GET(createRequest("GET", BASE_URL));
    const json = await res.json();

    expect(json.items[0].user).toBeNull();
  });

  // --- Pagination: cursor-based (nextCursor when more results) ---

  it("returns nextCursor when there are more results than limit", async () => {
    // limit=2, return 3 items → hasMore=true, nextCursor = id of last item in slice
    const logs = [
      makeLog({ id: "log-1" }),
      makeLog({ id: "log-2" }),
      makeLog({ id: "log-3" }),
    ];
    mockAuditLogFindMany.mockResolvedValue(logs);

    const res = await GET(
      createRequest("GET", BASE_URL, { searchParams: { limit: "2" } }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.items).toHaveLength(2);
    expect(json.nextCursor).toBe("log-2");
  });

  it("passes cursor to prisma query with skip: 1", async () => {
    mockAuditLogFindMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", BASE_URL, { searchParams: { cursor: "550e8400-e29b-41d4-a716-446655440000" } }),
    );

    expect(mockAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "550e8400-e29b-41d4-a716-446655440000" },
        skip: 1,
      }),
    );
  });

  // --- Date filter: from and to query params ---

  it("applies from date filter to prisma query", async () => {
    await GET(
      createRequest("GET", BASE_URL, { searchParams: { from: "2026-01-01T00:00:00Z" } }),
    );

    expect(mockAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ gte: new Date("2026-01-01T00:00:00Z") }),
        }),
      }),
    );
  });

  it("applies to date filter to prisma query", async () => {
    await GET(
      createRequest("GET", BASE_URL, { searchParams: { to: "2026-02-28T23:59:59Z" } }),
    );

    expect(mockAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ lte: new Date("2026-02-28T23:59:59Z") }),
        }),
      }),
    );
  });

  it("applies both from and to date filters", async () => {
    await GET(
      createRequest("GET", BASE_URL, {
        searchParams: {
          from: "2026-01-01T00:00:00Z",
          to: "2026-01-31T23:59:59Z",
        },
      }),
    );

    expect(mockAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date("2026-01-01T00:00:00Z"),
            lte: new Date("2026-01-31T23:59:59Z"),
          },
        }),
      }),
    );
  });

  // --- Action filter: actions query param (comma-separated) ---

  it("filters by a single valid action", async () => {
    await GET(
      createRequest("GET", BASE_URL, {
        searchParams: { actions: AUDIT_ACTION.ENTRY_CREATE },
      }),
    );

    expect(mockAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: { in: [AUDIT_ACTION.ENTRY_CREATE] },
        }),
      }),
    );
  });

  it("filters by multiple valid actions (comma-separated)", async () => {
    const actionsParam = `${AUDIT_ACTION.ENTRY_CREATE},${AUDIT_ACTION.ENTRY_UPDATE}`;
    await GET(
      createRequest("GET", BASE_URL, { searchParams: { actions: actionsParam } }),
    );

    expect(mockAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: { in: [AUDIT_ACTION.ENTRY_CREATE, AUDIT_ACTION.ENTRY_UPDATE] },
        }),
      }),
    );
  });

  // --- Invalid action filter → 400 ---

  it("returns 400 for invalid action in actions param", async () => {
    const res = await GET(
      createRequest("GET", BASE_URL, { searchParams: { actions: "INVALID_ACTION" } }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when any action in comma-separated list is invalid", async () => {
    const actionsParam = `${AUDIT_ACTION.ENTRY_CREATE},NOT_A_REAL_ACTION`;
    const res = await GET(
      createRequest("GET", BASE_URL, { searchParams: { actions: actionsParam } }),
    );
    expect(res.status).toBe(400);
  });

  // --- Invalid cursor → 400 ---

  it("returns 400 when prisma throws on invalid cursor", async () => {
    mockAuditLogFindMany.mockRejectedValue(new Error("Invalid cursor value"));

    const res = await GET(
      createRequest("GET", BASE_URL, { searchParams: { cursor: "00000000-0000-0000-0000-000000000000" } }),
    );
    expect(res.status).toBe(400);
  });

  // --- Empty results ---

  it("returns empty items and null nextCursor when no logs exist", async () => {
    mockAuditLogFindMany.mockResolvedValue([]);

    const res = await GET(createRequest("GET", BASE_URL));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.items).toHaveLength(0);
    expect(json.nextCursor).toBeNull();
    expect(json.entryOverviews).toEqual({});
    expect(json.relatedUsers).toEqual({});
  });

  // --- Entry overviews resolved for PasswordEntry targets ---

  it("resolves encryptedOverview for PasswordEntry target logs", async () => {
    const log = makeLog({ targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY, targetId: "00000000-0000-4000-a000-000000000abc" });
    mockAuditLogFindMany.mockResolvedValue([log]);
    mockPasswordEntryFindMany.mockResolvedValue([
      {
        id: "00000000-0000-4000-a000-000000000abc",
        encryptedOverview: "cipher",
        overviewIv: "iv-hex",
        overviewAuthTag: "tag-hex",
        aadVersion: 1,
      },
    ]);

    const res = await GET(createRequest("GET", BASE_URL));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.entryOverviews["00000000-0000-4000-a000-000000000abc"]).toEqual({
      ciphertext: "cipher",
      iv: "iv-hex",
      authTag: "tag-hex",
      aadVersion: 1,
    });
  });

  it("does not query passwordEntry when no PasswordEntry targets exist", async () => {
    const log = makeLog({ targetType: AUDIT_TARGET_TYPE.SESSION, targetId: "session-1" });
    mockAuditLogFindMany.mockResolvedValue([log]);

    await GET(createRequest("GET", BASE_URL));

    expect(mockPasswordEntryFindMany).not.toHaveBeenCalled();
  });

  // --- Related users resolved for Emergency Access logs ---

  it("resolves relatedUsers for emergency access logs", async () => {
    const log = makeLog({
      id: "log-ea",
      action: AUDIT_ACTION.EMERGENCY_VAULT_ACCESS,
      metadata: { ownerId: "owner-1", granteeId: "grantee-1" },
    });
    mockAuditLogFindMany.mockResolvedValue([log]);
    mockUserFindMany.mockResolvedValue([
      { id: "owner-1", name: "Owner", email: "owner@example.com", image: null },
      { id: "grantee-1", name: "Grantee", email: "grantee@example.com", image: null },
    ]);

    const res = await GET(createRequest("GET", BASE_URL));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.relatedUsers["owner-1"]).toMatchObject({ id: "owner-1", name: "Owner" });
    expect(json.relatedUsers["grantee-1"]).toMatchObject({ id: "grantee-1", name: "Grantee" });
  });

  it("queries users for all logs with non-sentinel userIds (not just emergency access)", async () => {
    // Route always batch-lookups user display info for any log with a non-sentinel userId
    mockAuditLogFindMany.mockResolvedValue([makeLog({ action: AUDIT_ACTION.ENTRY_CREATE })]);

    await GET(createRequest("GET", BASE_URL));

    // user.findMany IS called for the log's userId
    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["user-1"] } } }),
    );
  });
});
