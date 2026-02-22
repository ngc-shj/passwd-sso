import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaSession, mockRateLimiter, mockLogAudit } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockPrismaSession: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    mockRateLimiter: { check: vi.fn() },
    mockLogAudit: vi.fn(),
  }));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { session: mockPrismaSession },
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => mockRateLimiter,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET, DELETE } from "./route";

const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/sessions"),
    );
    expect(res.status).toBe(401);
  });

  it("returns sessions with isCurrent flag", async () => {
    mockPrismaSession.findMany.mockResolvedValue([
      {
        id: "s1",
        createdAt: now,
        lastActiveAt: now,
        ipAddress: "1.2.3.4",
        userAgent: "Mozilla/5.0",
        sessionToken: "current-token",
      },
      {
        id: "s2",
        createdAt: now,
        lastActiveAt: now,
        ipAddress: "5.6.7.8",
        userAgent: "Chrome/120",
        sessionToken: "other-token",
      },
    ]);

    const req = createRequest("GET", "http://localhost:3000/api/sessions", {
      headers: { Cookie: "authjs.session-token=current-token" },
    });
    const res = await GET(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toHaveLength(2);
    expect(json[0].isCurrent).toBe(true);
    expect(json[1].isCurrent).toBe(false);
    // sessionToken must not be exposed
    expect(json[0]).not.toHaveProperty("sessionToken");
  });

  it("returns empty array when no sessions", async () => {
    mockPrismaSession.findMany.mockResolvedValue([]);
    const req = createRequest("GET", "http://localhost:3000/api/sessions");
    const res = await GET(req);
    const json = await res.json();
    expect(json).toEqual([]);
  });
});

describe("DELETE /api/sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiter.check.mockResolvedValue(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/sessions"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiter.check.mockResolvedValue(false);
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/sessions"),
    );
    expect(res.status).toBe(429);
  });

  it("deletes all sessions except current and logs audit", async () => {
    mockPrismaSession.deleteMany.mockResolvedValue({ count: 3 });

    const req = createRequest("DELETE", "http://localhost:3000/api/sessions", {
      headers: { Cookie: "authjs.session-token=my-token" },
    });
    const res = await DELETE(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.revokedCount).toBe(3);

    expect(mockPrismaSession.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        sessionToken: { not: "my-token" },
      },
    });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SESSION_REVOKE_ALL",
        userId: "user-1",
        metadata: { revokedCount: 3 },
      }),
    );
  });
});
