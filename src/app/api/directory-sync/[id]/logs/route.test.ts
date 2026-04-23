import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockRequireTenantPermission,
  mockConfigFindFirst,
  mockLogFindMany,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockConfigFindFirst: vi.fn(),
  mockLogFindMany: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    directorySyncConfig: { findFirst: mockConfigFindFirst },
    directorySyncLog: { findMany: mockLogFindMany },
  },
}));
vi.mock("@/lib/auth/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));

import { GET } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost/api/directory-sync/config-1/logs";

const MEMBER = { tenantId: "tenant-1" };
const CONFIG = { id: "config-1" };

const makeLogs = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `log-${i + 1}`,
    status: "SUCCESS",
    startedAt: new Date(`2024-01-0${i + 1}`),
    completedAt: new Date(`2024-01-0${i + 1}`),
    dryRun: false,
    usersCreated: i,
    usersUpdated: 0,
    usersDeactivated: 0,
    groupsUpdated: 0,
    errorMessage: null,
  }));

const CTX = createParams({ id: "config-1" });

// ── Tests ─────────────────────────────────────────────────────

describe("GET /api/directory-sync/[id]/logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(MEMBER);
    mockConfigFindFirst.mockResolvedValue(CONFIG);
    mockLogFindMany.mockResolvedValue(makeLogs(3));
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req, CTX));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when user is not ADMIN/OWNER", async () => {
    const err = Object.assign(new Error("FORBIDDEN"), { name: "TenantAuthError", status: 403 });
    mockRequireTenantPermission.mockRejectedValue(err);

    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req, CTX));

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when config does not exist", async () => {
    mockConfigFindFirst.mockResolvedValue(null);

    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req, CTX));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns logs with hasMore=false when count is under limit", async () => {
    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req, CTX));

    expect(status).toBe(200);
    expect(json.items).toHaveLength(3);
    expect(json.hasMore).toBe(false);
    expect(json.nextCursor).toBeUndefined();
  });

  it("returns hasMore=true and nextCursor when more pages exist", async () => {
    // limit default is 20; returning 21 items signals hasMore
    mockLogFindMany.mockResolvedValue(makeLogs(21));

    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req, CTX));

    expect(status).toBe(200);
    expect(json.items).toHaveLength(20);
    expect(json.hasMore).toBe(true);
    expect(json.nextCursor).toBe("log-20");
  });

  it("respects custom limit query param", async () => {
    mockLogFindMany.mockResolvedValue(makeLogs(5));

    const req = createRequest("GET", ROUTE_URL, { searchParams: { limit: "5" } });
    const { status, json } = await parseResponse(await GET(req, CTX));

    expect(status).toBe(200);
    expect(mockLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 6 }), // limit + 1
    );
    expect(json.items).toHaveLength(5);
  });

  it("caps limit at 100", async () => {
    const req = createRequest("GET", ROUTE_URL, { searchParams: { limit: "999" } });
    await GET(req, CTX);

    expect(mockLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 101 }), // 100 + 1
    );
  });

  it("uses cursor for keyset pagination", async () => {
    const req = createRequest("GET", ROUTE_URL, { searchParams: { cursor: "550e8400-e29b-41d4-a716-446655440000" } });
    await GET(req, CTX);

    expect(mockLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "550e8400-e29b-41d4-a716-446655440000" },
        skip: 1,
      }),
    );
  });

  it("queries logs filtered by configId and tenantId", async () => {
    const req = createRequest("GET", ROUTE_URL);
    await GET(req, CTX);

    expect(mockLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { configId: "config-1", tenantId: "tenant-1" },
      }),
    );
  });

  it("returns empty items when no logs exist", async () => {
    mockLogFindMany.mockResolvedValue([]);

    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req, CTX));

    expect(status).toBe(200);
    expect(json.items).toHaveLength(0);
    expect(json.hasMore).toBe(false);
  });
});
