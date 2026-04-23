import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../../../../../../__tests__/helpers/mock-auth";
import {
  createRequest,
  parseResponse,
  createParams,
} from "../../../../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockServiceAccountFindUnique,
  mockServiceAccountTokenFindUnique,
  mockServiceAccountTokenUpdate,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockServiceAccountFindUnique: vi.fn(),
  mockServiceAccountTokenFindUnique: vi.fn(),
  mockServiceAccountTokenUpdate: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/tenant-auth", () => {
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
    serviceAccount: {
      findUnique: mockServiceAccountFindUnique,
    },
    serviceAccountToken: {
      findUnique: mockServiceAccountTokenFindUnique,
      update: mockServiceAccountTokenUpdate,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));

import { DELETE } from "@/app/api/tenant/service-accounts/[id]/tokens/[tokenId]/route";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };
const SA_ID = "sa-00000001";
const TOKEN_ID = "tok-00000001";

const makeToken = (overrides: Record<string, unknown> = {}) => ({
  id: TOKEN_ID,
  serviceAccountId: SA_ID,
  tenantId: "tenant-1",
  revokedAt: null,
  ...overrides,
});

describe("DELETE /api/tenant/service-accounts/[id]/tokens/[tokenId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("revokes a token successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({ id: SA_ID, tenantId: "tenant-1" });
    mockServiceAccountTokenFindUnique.mockResolvedValue(makeToken());
    mockServiceAccountTokenUpdate.mockResolvedValue({ id: TOKEN_ID, revokedAt: new Date() });

    const req = createRequest(
      "DELETE",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens/${TOKEN_ID}`,
    );
    const res = await DELETE(req, createParams({ id: SA_ID, tokenId: TOKEN_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SERVICE_ACCOUNT_TOKEN_REVOKE",
        tenantId: "tenant-1",
        targetId: TOKEN_ID,
      }),
    );
  });

  it("returns 404 when token not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({ id: SA_ID, tenantId: "tenant-1" });
    mockServiceAccountTokenFindUnique.mockResolvedValue(null);

    const req = createRequest(
      "DELETE",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens/${TOKEN_ID}`,
    );
    const res = await DELETE(req, createParams({ id: SA_ID, tokenId: TOKEN_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 404 when service account not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue(null);

    const req = createRequest(
      "DELETE",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens/${TOKEN_ID}`,
    );
    const res = await DELETE(req, createParams({ id: SA_ID, tokenId: TOKEN_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 409 when token is already revoked", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({ id: SA_ID, tenantId: "tenant-1" });
    mockServiceAccountTokenFindUnique.mockResolvedValue(
      makeToken({ revokedAt: new Date("2025-01-01") }),
    );

    const req = createRequest(
      "DELETE",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens/${TOKEN_ID}`,
    );
    const res = await DELETE(req, createParams({ id: SA_ID, tokenId: TOKEN_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("SA_TOKEN_ALREADY_REVOKED");
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest(
      "DELETE",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens/${TOKEN_ID}`,
    );
    const res = await DELETE(req, createParams({ id: SA_ID, tokenId: TOKEN_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });
});
