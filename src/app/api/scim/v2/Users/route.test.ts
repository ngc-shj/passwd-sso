import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockLogAudit,
  mockTenantMember,
  mockUser,
  mockScimExternalMapping,
  mockTransaction,
  mockWithTenantRls,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockTenantMember: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  mockUser: { findUnique: vi.fn(), create: vi.fn() },
  mockScimExternalMapping: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  mockTransaction: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/scim-token", () => ({ validateScimToken: mockValidateScimToken }));
vi.mock("@/lib/scim/rate-limit", () => ({ checkScimRateLimit: mockCheckScimRateLimit }));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: mockTenantMember,
    user: mockUser,
    scimExternalMapping: mockScimExternalMapping,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/tenant-rls", () => ({ withTenantRls: mockWithTenantRls }));

import { GET, POST } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", teamId: "team-1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
};

function makeReq(options: { searchParams?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL("http://localhost/api/scim/v2/Users");
  if (options.searchParams) {
    for (const [k, v] of Object.entries(options.searchParams)) {
      url.searchParams.set(k, v);
    }
  }
  const init: RequestInit = { method: options.body ? "POST" : "GET" };
  if (options.body) {
    init.body = JSON.stringify(options.body);
    init.headers = { "content-type": "application/json" };
  }
  return new NextRequest(url.toString(), init as ConstructorParameters<typeof NextRequest>[1]);
}

describe("GET /api/scim/v2/Users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns tenant users", async () => {
    mockTenantMember.findMany.mockResolvedValue([
      {
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "test@example.com", name: "Test" },
      },
    ]);
    mockTenantMember.count.mockResolvedValue(1);
    mockScimExternalMapping.findMany.mockResolvedValue([]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0].userName).toBe("test@example.com");
    expect(body.Resources[0].active).toBe(true);
  });

  it("filters by externalId", async () => {
    mockScimExternalMapping.findFirst.mockResolvedValue({ internalId: "user-1" });
    mockTenantMember.findMany.mockResolvedValue([
      {
        userId: "user-1",
        deactivatedAt: null,
        user: { id: "user-1", email: "ext@example.com", name: "Ext" },
      },
    ]);
    mockTenantMember.count.mockResolvedValue(1);
    mockScimExternalMapping.findMany.mockResolvedValue([{ internalId: "user-1", externalId: "ext-1" }]);

    const res = await GET(makeReq({ searchParams: { filter: 'externalId eq "ext-1"' } }));
    expect(res.status).toBe(200);
    expect(mockScimExternalMapping.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        externalId: "ext-1",
        resourceType: "User",
      },
    });
  });
});

describe("POST /api/scim/v2/Users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("creates tenant member", async () => {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "new-user", email: "new@example.com", name: "New" }),
        },
        tenantMember: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "tm1", deactivatedAt: null }),
        },
        scimExternalMapping: {
          findFirst: vi.fn().mockResolvedValue(null),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          create: vi.fn().mockResolvedValue({}),
        },
      };
      return fn(tx);
    });

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "new@example.com",
          name: { formatted: "New" },
          externalId: "ext-1",
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "SCIM_USER_CREATE" }));
  });

  it("returns 409 when user already exists in tenant", async () => {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1", email: "dup@example.com" }) },
        tenantMember: { findUnique: vi.fn().mockResolvedValue({ id: "tm1" }) },
      };
      return fn(tx);
    });

    const res = await POST(
      makeReq({
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "dup@example.com",
        },
      }),
    );

    expect(res.status).toBe(409);
  });
});
