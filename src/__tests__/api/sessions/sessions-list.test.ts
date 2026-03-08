import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth, mockSessionFindUnique, mockSessionFindMany,
  mockUserFindUnique, mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockSessionFindUnique: vi.fn(),
  mockSessionFindMany: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: {
      findUnique: mockSessionFindUnique,
      findMany: mockSessionFindMany,
    },
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: vi.fn().mockResolvedValue({ allowed: true }) }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));

import { GET } from "@/app/api/sessions/route";

const NOW = new Date("2025-06-01T12:00:00Z");

describe("GET /api/sessions — sessionCount and maxConcurrentSessions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost/api/sessions");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("includes sessionCount and maxConcurrentSessions in response", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockSessionFindUnique.mockResolvedValue(null); // no current session match
    mockSessionFindMany.mockResolvedValue([
      {
        id: "s1",
        createdAt: NOW,
        lastActiveAt: NOW,
        ipAddress: "127.0.0.1",
        userAgent: "test",
      },
      {
        id: "s2",
        createdAt: NOW,
        lastActiveAt: NOW,
        ipAddress: "10.0.0.1",
        userAgent: "other",
      },
    ]);
    mockUserFindUnique.mockResolvedValue({ tenant: { maxConcurrentSessions: 5 } });

    const req = createRequest("GET", "http://localhost/api/sessions");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.sessionCount).toBe(2);
    expect(json.maxConcurrentSessions).toBe(5);
    expect(json.sessions).toHaveLength(2);
  });

  it("returns null maxConcurrentSessions when no tenant limit", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockSessionFindUnique.mockResolvedValue(null);
    mockSessionFindMany.mockResolvedValue([]);
    mockUserFindUnique.mockResolvedValue({ tenant: null });

    const req = createRequest("GET", "http://localhost/api/sessions");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.sessionCount).toBe(0);
    expect(json.maxConcurrentSessions).toBeNull();
  });
});
