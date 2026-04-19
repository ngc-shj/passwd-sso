import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../../../__tests__/helpers/mock-auth";
import { createRequest, parseResponse } from "../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockAuthOrToken,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockWithBypassRls,
  mockLogAudit,
  mockRateLimiterCheck,
  mockAccessRequestFindMany,
  mockAccessRequestCreate,
  mockServiceAccountFindUnique,
  mockDispatchTenantWebhook,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockAuthOrToken: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockAccessRequestFindMany: vi.fn(),
  mockAccessRequestCreate: vi.fn(),
  mockServiceAccountFindUnique: vi.fn(),
  mockDispatchTenantWebhook: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-auth", () => {
  class TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return {
    requireTenantPermission: mockRequireTenantPermission,
    TenantAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    accessRequest: {
      findMany: mockAccessRequestFindMany,
      create: mockAccessRequestCreate,
    },
    serviceAccount: {
      findUnique: mockServiceAccountFindUnique,
    },
  },
}));
vi.mock("@/lib/auth-or-token", () => ({
  authOrToken: mockAuthOrToken,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  resolveActorType: () => "HUMAN",
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchTenantWebhook: mockDispatchTenantWebhook,
}));

import { GET, POST } from "@/app/api/tenant/access-requests/route";
import { TenantAuthError } from "@/lib/tenant-auth";
import { MS_PER_HOUR } from "@/lib/constants/time";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };
const SA_ID = "00000000-0000-4000-a000-000000000001";

const makeAccessRequest = (overrides: Record<string, unknown> = {}) => ({
  id: "req-1",
  serviceAccountId: SA_ID,
  requestedScope: "passwords:read",
  justification: "Incident response",
  status: "PENDING",
  approvedById: null,
  approvedAt: null,
  grantedTokenId: null,
  grantedTokenTtlSec: null,
  expiresAt: new Date(Date.now() + MS_PER_HOUR),
  createdAt: new Date(),
  serviceAccount: { id: SA_ID, name: "ci-bot", description: null, isActive: true },
  approvedBy: null,
  ...overrides,
});

describe("GET /api/tenant/access-requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists access requests for tenant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindMany.mockResolvedValue([makeAccessRequest()]);

    const req = createRequest("GET", "http://localhost/api/tenant/access-requests");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("req-1");
  });

  it("filters by validated status enum", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindMany.mockResolvedValue([makeAccessRequest({ status: "APPROVED" })]);

    const req = createRequest("GET", "http://localhost/api/tenant/access-requests", {
      searchParams: { status: "APPROVED" },
    });
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(mockAccessRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
    expect(json[0].status).toBe("APPROVED");
  });

  it("ignores invalid status (does not crash)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindMany.mockResolvedValue([makeAccessRequest()]);

    const req = createRequest("GET", "http://localhost/api/tenant/access-requests", {
      searchParams: { status: "INVALID_STATUS" },
    });
    const res = await GET(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(200);
    // Invalid status should be silently ignored — where clause should not include status
    expect(mockAccessRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ status: "INVALID_STATUS" }),
      }),
    );
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/tenant/access-requests");
    const res = await GET(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });
});

describe("POST /api/tenant/access-requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates access request with validated scope array", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({
      id: SA_ID,
      tenantId: "tenant-1",
      isActive: true,
    });
    const created = {
      id: "req-new",
      serviceAccountId: SA_ID,
      requestedScope: "passwords:read",
      justification: "Incident response",
      status: "PENDING",
      expiresAt: new Date(Date.now() + MS_PER_HOUR),
      createdAt: new Date(),
    };
    mockAccessRequestCreate.mockResolvedValue(created);

    const req = createRequest("POST", "http://localhost/api/tenant/access-requests", {
      body: {
        serviceAccountId: SA_ID,
        requestedScope: ["passwords:read"],
        justification: "Incident response",
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.id).toBe("req-new");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ACCESS_REQUEST_CREATE",
        tenantId: "tenant-1",
      }),
    );
  });

  it("rejects invalid scope values not in SA_TOKEN_SCOPES", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest("POST", "http://localhost/api/tenant/access-requests", {
      body: {
        serviceAccountId: SA_ID,
        requestedScope: ["vault:unlock"],
      },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("returns 404 for non-existent service account", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/tenant/access-requests", {
      body: {
        serviceAccountId: SA_ID,
        requestedScope: ["passwords:read"],
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("SA_NOT_FOUND");
  });

  it("returns 404 for inactive service account", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({
      id: SA_ID,
      tenantId: "tenant-1",
      isActive: false,
    });

    const req = createRequest("POST", "http://localhost/api/tenant/access-requests", {
      body: {
        serviceAccountId: SA_ID,
        requestedScope: ["passwords:read"],
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("SA_NOT_FOUND");
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuthOrToken.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/tenant/access-requests", {
      body: {
        serviceAccountId: SA_ID,
        requestedScope: ["passwords:read"],
      },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 for insufficient permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest("POST", "http://localhost/api/tenant/access-requests", {
      body: {
        serviceAccountId: SA_ID,
        requestedScope: ["passwords:read"],
      },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });

  it("creates access request via SA token with access-request:create scope", async () => {
    mockAuthOrToken.mockResolvedValue({
      type: "service_account",
      serviceAccountId: SA_ID,
      tenantId: "tenant-1",
      tokenId: "tok-1",
      scopes: ["access-request:create"],
    });
    mockServiceAccountFindUnique.mockResolvedValue({
      isActive: true,
      createdById: DEFAULT_SESSION.user.id,
    });
    const created = {
      id: "req-sa-1",
      serviceAccountId: SA_ID,
      requestedScope: "passwords:read",
      justification: "Automated request",
      status: "PENDING",
      expiresAt: new Date(Date.now() + MS_PER_HOUR),
      createdAt: new Date(),
    };
    mockAccessRequestCreate.mockResolvedValue(created);

    const req = createRequest("POST", "http://localhost/api/tenant/access-requests", {
      body: {
        serviceAccountId: SA_ID,
        requestedScope: ["passwords:read"],
        justification: "Automated request",
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.id).toBe("req-sa-1");
  });

  it("returns 403 when SA token lacks access-request:create scope", async () => {
    mockAuthOrToken.mockResolvedValue({
      type: "service_account",
      serviceAccountId: SA_ID,
      tenantId: "tenant-1",
      tokenId: "tok-2",
      scopes: ["passwords:read"],
    });

    const req = createRequest("POST", "http://localhost/api/tenant/access-requests", {
      body: {
        requestedScope: ["passwords:read"],
      },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });

  it("SA self-service infers serviceAccountId from token (no serviceAccountId in body)", async () => {
    mockAuthOrToken.mockResolvedValue({
      type: "service_account",
      serviceAccountId: SA_ID,
      tenantId: "tenant-1",
      tokenId: "tok-3",
      scopes: ["access-request:create"],
    });
    mockServiceAccountFindUnique.mockResolvedValue({
      isActive: true,
      createdById: DEFAULT_SESSION.user.id,
    });
    const created = {
      id: "req-sa-infer",
      serviceAccountId: SA_ID,
      requestedScope: "passwords:read",
      justification: null,
      status: "PENDING",
      expiresAt: new Date(Date.now() + MS_PER_HOUR),
      createdAt: new Date(),
    };
    mockAccessRequestCreate.mockResolvedValue(created);

    // Body does NOT include serviceAccountId — SA path infers it from token
    const req = createRequest("POST", "http://localhost/api/tenant/access-requests", {
      body: {
        requestedScope: ["passwords:read"],
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.serviceAccountId).toBe(SA_ID);
    expect(mockAccessRequestCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ serviceAccountId: SA_ID }),
      }),
    );
  });
});
