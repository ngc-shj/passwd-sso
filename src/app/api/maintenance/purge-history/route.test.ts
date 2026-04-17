import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";

const ADMIN_TOKEN = randomBytes(32).toString("hex");

const {
  mockDeleteMany,
  mockCount,
  mockTenantMemberFindFirst,
  mockCheck,
  mockLogAudit,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockDeleteMany: vi.fn(),
  mockCount: vi.fn(),
  mockTenantMemberFindFirst: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAudit: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntryHistory: { deleteMany: mockDeleteMany, count: mockCount },
    tenantMember: { findFirst: mockTenantMemberFindFirst },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "10.0.0.1", userAgent: "Test" }),
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

// Set up env before importing route
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

import { POST } from "./route";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { MS_PER_DAY } from "@/lib/constants/time";

function createRequest(
  body: unknown,
  token?: string,
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "10.0.0.1",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return new NextRequest("http://localhost/api/maintenance/purge-history", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/maintenance/purge-history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    setEnv({ ADMIN_API_TOKEN: ADMIN_TOKEN });
  });

  afterEach(() => {
    restoreEnv();
  });

  // ─── Auth ──────────────────────────────────────────────────

  it("returns 401 without authorization header", async () => {
    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440001" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid (non-hex) token", async () => {
    const req = createRequest(
      { operatorId: "660e8400-e29b-41d4-a716-446655440001" },
      "not-a-hex-token-at-all-should-fail!!",
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when ADMIN_API_TOKEN is not set", async () => {
    setEnv({ ADMIN_API_TOKEN: undefined });
    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440001" }, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  // ─── Rate Limit ────────────────────────────────────────────

  it("returns 429 when rate limited", async () => {
    mockCheck.mockResolvedValue({ allowed: false });
    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440001" }, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(429);
  });

  // ─── Body Validation ──────────────────────────────────────

  it("returns 400 when operatorId is missing", async () => {
    const req = createRequest({}, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when operatorId does not match an active admin", async () => {
    mockTenantMemberFindFirst.mockResolvedValue(null);
    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440099" }, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("operatorId");
  });

  it("returns 400 when operatorId exists but has MEMBER role", async () => {
    // findFirst with role filter returns null for MEMBER
    mockTenantMemberFindFirst.mockResolvedValue(null);
    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440002" }, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);

    // Verify the query filters by admin roles
    const where = mockTenantMemberFindFirst.mock.calls[0][0].where;
    expect(where.role).toEqual({ in: ["OWNER", "ADMIN"] });
  });

  it("returns 400 when operatorId is deactivated admin", async () => {
    // findFirst with deactivatedAt: null filter returns null for deactivated
    mockTenantMemberFindFirst.mockResolvedValue(null);
    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440003" }, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);

    // Verify the query filters out deactivated members
    const where = mockTenantMemberFindFirst.mock.calls[0][0].where;
    expect(where.deactivatedAt).toBeNull();
  });

  // ─── Purge Success ────────────────────────────────────────

  it("purges history entries and returns count", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockDeleteMany.mockResolvedValue({ count: 42 });

    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440010" }, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(42);
  });

  it("does not filter by userId (system-wide purge)", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440010" }, ADMIN_TOKEN);
    await POST(req);

    const where = mockDeleteMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("entry");
    expect(where).toHaveProperty("changedAt");
  });

  it("uses default retentionDays of 90", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440010" }, ADMIN_TOKEN);
    await POST(req);

    const cutoff = mockDeleteMany.mock.calls[0][0].where.changedAt.lt as Date;
    const expectedMs = 90 * MS_PER_DAY;
    const expectedDate = new Date(Date.now() - expectedMs);
    expect(Math.abs(cutoff.getTime() - expectedDate.getTime())).toBeLessThan(5000);
  });

  it("respects custom retentionDays parameter", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockDeleteMany.mockResolvedValue({ count: 10 });

    const req = createRequest(
      { operatorId: "660e8400-e29b-41d4-a716-446655440010", retentionDays: 30 },
      ADMIN_TOKEN,
    );
    await POST(req);

    const cutoff = mockDeleteMany.mock.calls[0][0].where.changedAt.lt as Date;
    const expectedMs = 30 * MS_PER_DAY;
    const expectedDate = new Date(Date.now() - expectedMs);
    expect(Math.abs(cutoff.getTime() - expectedDate.getTime())).toBeLessThan(5000);
  });

  // ─── Dry Run ──────────────────────────────────────────────

  it("returns matched count without deleting when dryRun is true", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockCount.mockResolvedValue(15);

    const req = createRequest(
      { operatorId: "660e8400-e29b-41d4-a716-446655440010", dryRun: true },
      ADMIN_TOKEN,
    );
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(0);
    expect(body.matched).toBe(15);
    expect(body.dryRun).toBe(true);

    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockCount).toHaveBeenCalled();

    // Verify count uses the same cutoff date as deleteMany would
    const cutoff = mockCount.mock.calls[0][0].where.changedAt.lt as Date;
    const expectedMs = 90 * MS_PER_DAY;
    const expectedDate = new Date(Date.now() - expectedMs);
    expect(Math.abs(cutoff.getTime() - expectedDate.getTime())).toBeLessThan(5000);
  });

  // ─── Auth Order ───────────────────────────────────────────

  it("checks rate limit after auth (429 only for authenticated requests)", async () => {
    mockCheck.mockResolvedValue({ allowed: false });
    // Unauthenticated request should get 401, not 429
    const unauthReq = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440010" });
    const unauthRes = await POST(unauthReq);
    expect(unauthRes.status).toBe(401);

    // Authenticated request should get 429
    const authReq = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440010" }, ADMIN_TOKEN);
    const authRes = await POST(authReq);
    expect(authRes.status).toBe(429);
  });

  // ─── Audit ────────────────────────────────────────────────

  it("logs audit with scope TENANT on successful purge", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockDeleteMany.mockResolvedValue({ count: 5 });

    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440010" }, ADMIN_TOKEN);
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "HISTORY_PURGE",
        userId: SYSTEM_ACTOR_ID,
        actorType: "SYSTEM",
        tenantId: "tenant-1",
        metadata: expect.objectContaining({
          operatorId: "660e8400-e29b-41d4-a716-446655440010",
          purgedCount: 5,
          retentionDays: 90,
          systemWide: true,
        }),
      }),
    );
  });

  it("does not log audit on dryRun", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockCount.mockResolvedValue(3);

    const req = createRequest(
      { operatorId: "660e8400-e29b-41d4-a716-446655440010", dryRun: true },
      ADMIN_TOKEN,
    );
    await POST(req);

    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
