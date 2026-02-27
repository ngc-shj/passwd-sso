import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaSession, mockRateLimiter, mockLogAudit, mockWithUserTenantRls } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockPrismaSession: {
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    },
    mockRateLimiter: { check: vi.fn() },
    mockLogAudit: vi.fn(),
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
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
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { DELETE } from "./route";

describe("DELETE /api/sessions/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiter.check.mockResolvedValue(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/sessions/s1"),
      createParams({ id: "s1" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiter.check.mockResolvedValue(false);
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/sessions/s1"),
      createParams({ id: "s1" }),
    );
    expect(res.status).toBe(429);
  });

  it("returns 401 when session cookie is missing", async () => {
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/sessions/s1"),
      createParams({ id: "s1" }),
    );
    expect(res.status).toBe(401);
    expect(mockPrismaSession.findFirst).not.toHaveBeenCalled();
    expect(mockPrismaSession.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 400 when trying to revoke current session", async () => {
    mockPrismaSession.findFirst.mockResolvedValue({
      sessionToken: "current-token",
    });

    const req = createRequest(
      "DELETE",
      "http://localhost:3000/api/sessions/s1",
      { headers: { Cookie: "authjs.session-token=current-token" } },
    );
    const res = await DELETE(req, createParams({ id: "s1" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("CANNOT_REVOKE_CURRENT_SESSION");
  });

  it("returns 404 when session not found (userId mismatch)", async () => {
    mockPrismaSession.findFirst.mockResolvedValue(null);
    mockPrismaSession.deleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest(
      "DELETE",
      "http://localhost:3000/api/sessions/s1",
      { headers: { Cookie: "authjs.session-token=my-token" } },
    );
    const res = await DELETE(req, createParams({ id: "s1" }));

    expect(res.status).toBe(404);
  });

  it("deletes session and logs audit", async () => {
    mockPrismaSession.findFirst.mockResolvedValue({
      sessionToken: "other-token",
    });
    mockPrismaSession.deleteMany.mockResolvedValue({ count: 1 });

    const req = createRequest(
      "DELETE",
      "http://localhost:3000/api/sessions/s1",
      { headers: { Cookie: "authjs.session-token=my-token" } },
    );
    const res = await DELETE(req, createParams({ id: "s1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);

    expect(mockPrismaSession.deleteMany).toHaveBeenCalledWith({
      where: { id: "s1", userId: "user-1" },
    });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SESSION_REVOKE",
        userId: "user-1",
        targetId: "s1",
      }),
    );
  });
});
