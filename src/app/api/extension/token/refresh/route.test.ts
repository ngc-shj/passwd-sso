import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockValidateExtensionToken,
  mockRevokeExtensionTokenFamily,
  mockCheck,
  mockSessionFindFirst,
  mockTenantFindUnique,
  mockExtTokenUpdateMany,
  mockExtTokenCreate,
  mockTransaction,
  mockWithUserTenantRls,
  mockWithBypassRls,
  mockEnforceAccessRestriction,
} = vi.hoisted(() => ({
  mockValidateExtensionToken: vi.fn(),
  mockRevokeExtensionTokenFamily: vi.fn().mockResolvedValue({ rowsRevoked: 0 }),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockSessionFindFirst: vi.fn(),
  mockTenantFindUnique: vi.fn().mockResolvedValue({
    extensionTokenIdleTimeoutMinutes: 10080,
    extensionTokenAbsoluteTimeoutMinutes: 43200,
  }),
  mockExtTokenUpdateMany: vi.fn(),
  mockExtTokenCreate: vi.fn(),
  mockTransaction: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (_p: unknown, fn: () => unknown) => fn()),
  mockEnforceAccessRestriction: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
}));

vi.mock("@/lib/auth/extension-token", () => ({
  validateExtensionToken: mockValidateExtensionToken,
  revokeExtensionTokenFamily: mockRevokeExtensionTokenFamily,
}));

vi.mock("@/lib/auth/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: { findFirst: mockSessionFindFirst },
    tenant: { findUnique: mockTenantFindUnique },
    extensionToken: {
      updateMany: mockExtTokenUpdateMany,
      create: mockExtTokenCreate,
    },
    $transaction: mockTransaction,
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/crypto-server", () => ({
  generateShareToken: () => "new-token-plaintext",
  hashToken: () => "new-token-hash",
}));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { POST } from "./route";

// ─── Helpers ─────────────────────────────────────────────────

function validTokenResult(overrides?: Record<string, unknown>) {
  return {
    ok: true,
    data: {
      tokenId: "old-tok-id",
      userId: "user-1",
      tenantId: "tenant-1",
      scopes: ["passwords:read", "vault:unlock-data"],
      expiresAt: new Date("2030-01-01"),
      familyId: "fam-1",
      familyCreatedAt: new Date(),
      ...overrides,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("POST /api/extension/token/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtTokenUpdateMany.mockResolvedValue({ count: 1 });
    mockExtTokenCreate.mockResolvedValue({
      expiresAt: new Date("2030-01-01"),
      scope: "passwords:read,vault:unlock-data",
    });
    // Interactive transaction: pass tx object with same mocks to the callback
    mockTransaction.mockImplementation(
      async (cb: (tx: unknown) => unknown) =>
        cb({
          extensionToken: {
            updateMany: mockExtTokenUpdateMany,
            create: mockExtTokenCreate,
          },
        }),
    );
  });

  it("returns 401 when no Bearer token", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_INVALID",
    });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh");
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("EXTENSION_TOKEN_INVALID");
  });

  it("returns 401 when token is expired", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_EXPIRED",
    });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer expired-token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("EXTENSION_TOKEN_EXPIRED");
  });

  it("returns 401 when token is revoked", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_REVOKED",
    });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer revoked-token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("EXTENSION_TOKEN_REVOKED");
  });

  it("returns 429 when rate limited", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    mockCheck.mockResolvedValueOnce({ allowed: false });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 401 when Auth.js session has expired", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    mockSessionFindFirst.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when client IP is outside the tenant access restriction", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });
    const denied = new Response(
      JSON.stringify({ error: "ACCESS_DENIED" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
    mockEnforceAccessRestriction.mockResolvedValueOnce(denied);

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
    // Must not rotate token when IP is denied
    expect(mockExtTokenCreate).not.toHaveBeenCalled();
    expect(mockEnforceAccessRestriction).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "tenant-1",
    );
  });

  it("refreshes token successfully", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.token).toBe("new-token-plaintext");
    expect(json.expiresAt).toBeDefined();
    expect(json.scope).toEqual(["passwords:read", "vault:unlock-data"]);
  });

  it("revokes old token and creates new in transaction", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    await POST(req);

    expect(mockTransaction).toHaveBeenCalled();
    expect(mockExtTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "old-tok-id", revokedAt: null }),
      }),
    );
    expect(mockExtTokenCreate).toHaveBeenCalled();
  });

  it("inherits scopes from old token", async () => {
    mockValidateExtensionToken.mockResolvedValue(
      validTokenResult({ scopes: ["passwords:read"] }),
    );
    mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });
    mockExtTokenCreate.mockResolvedValue({
      expiresAt: new Date("2030-01-01"),
      scope: "passwords:read",
    });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);
    const { json } = await parseResponse(res);

    expect(json.scope).toEqual(["passwords:read"]);
  });

  it("returns 401 on concurrent refresh (optimistic lock)", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });
    // updateMany returns count: 0 — already revoked by concurrent request
    mockExtTokenUpdateMany.mockResolvedValue({ count: 0 });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("EXTENSION_TOKEN_REVOKED");
    // Must NOT create a new token when old one was already revoked
    expect(mockExtTokenCreate).not.toHaveBeenCalled();
  });
});
