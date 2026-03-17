import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaPasswordShare,
  mockPrismaShareAccessLog,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordShare: { findUnique: vi.fn() },
  mockPrismaShareAccessLog: { findMany: vi.fn() },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: mockPrismaPasswordShare,
    shareAccessLog: mockPrismaShareAccessLog,
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

const SHARE_ID = "share-abc123";
const now = new Date("2026-01-15T10:00:00Z");

const MOCK_LOG = {
  id: "log-1",
  ip: "1.2.3.4",
  userAgent: "Chrome/120",
  createdAt: now,
};

describe("GET /api/share-links/[id]/access-logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaPasswordShare.findUnique.mockResolvedValue({ createdById: "user-1" });
    mockPrismaShareAccessLog.findMany.mockResolvedValue([MOCK_LOG]);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/share-links/${SHARE_ID}/access-logs`),
      createParams({ id: SHARE_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when share link not found", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/share-links/${SHARE_ID}/access-logs`),
      createParams({ id: SHARE_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when share belongs to another user", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue({ createdById: "other-user" });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/share-links/${SHARE_ID}/access-logs`),
      createParams({ id: SHARE_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns access logs successfully", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/share-links/${SHARE_ID}/access-logs`),
      createParams({ id: SHARE_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(1);
    expect(json.items[0].id).toBe("log-1");
    expect(json.nextCursor).toBeNull();
  });

  it("returns 400 for invalid cursor", async () => {
    mockPrismaShareAccessLog.findMany.mockRejectedValue(new Error("Invalid cursor"));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/share-links/${SHARE_ID}/access-logs`, {
        searchParams: { cursor: "bad-cursor" },
      }),
      createParams({ id: SHARE_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("includes nextCursor when there are more pages", async () => {
    // Return limit+1 items (SHARE_ACCESS_LOG_LIMIT is typically 50)
    const logs = Array.from({ length: 51 }, (_, i) => ({ ...MOCK_LOG, id: `log-${i}` }));
    mockPrismaShareAccessLog.findMany.mockResolvedValue(logs);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/share-links/${SHARE_ID}/access-logs`),
      createParams({ id: SHARE_ID }),
    );
    const json = await res.json();
    expect(json.nextCursor).not.toBeNull();
  });
});
