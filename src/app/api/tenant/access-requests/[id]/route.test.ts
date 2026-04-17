import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../../../../__tests__/helpers/mock-auth";
import {
  createRequest,
  parseResponse,
  createParams,
} from "../../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockAccessRequestFindUnique,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockAccessRequestFindUnique: vi.fn(),
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
      findUnique: mockAccessRequestFindUnique,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));

import { GET } from "@/app/api/tenant/access-requests/[id]/route";
import { TenantAuthError } from "@/lib/tenant-auth";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };
const REQUEST_ID = "req-00000001";
const SA_ID = "00000000-0000-4000-a000-000000000001";

const makeAccessRequest = (overrides: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  tenantId: "tenant-1",
  serviceAccountId: SA_ID,
  requestedScope: "passwords:read",
  justification: "Incident response",
  status: "PENDING",
  approvedById: null,
  approvedAt: null,
  grantedTokenId: null,
  grantedTokenTtlSec: null,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  createdAt: new Date(),
  serviceAccount: { id: SA_ID, name: "ci-bot", description: null, isActive: true },
  approvedBy: null,
  ...overrides,
});

describe("GET /api/tenant/access-requests/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a single access request with relations", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());

    const req = createRequest(
      "GET",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}`,
    );
    const res = await GET(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.id).toBe(REQUEST_ID);
    expect(json.serviceAccountId).toBe(SA_ID);
    expect(json.status).toBe("PENDING");
    expect(json.serviceAccount).toBeDefined();
    expect(json.serviceAccount.name).toBe("ci-bot");
    expect(json.approvedBy).toBeNull();
  });

  it("returns 404 when access request does not exist", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(null);

    const req = createRequest(
      "GET",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}`,
    );
    const res = await GET(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 404 when request belongs to a different tenant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(
      makeAccessRequest({ tenantId: "other-tenant" }),
    );

    const req = createRequest(
      "GET",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}`,
    );
    const res = await GET(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest(
      "GET",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}`,
    );
    const res = await GET(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 for insufficient permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest(
      "GET",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}`,
    );
    const res = await GET(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });
});
