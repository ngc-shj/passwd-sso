import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

const {
  mockValidateApiKeyOnly,
  mockEnforceAccessRestriction,
  mockCheck,
  mockUserFindUnique,
  mockWithTenantRls,
} = vi.hoisted(() => ({
  mockValidateApiKeyOnly: vi.fn(),
  mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockUserFindUnique: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/api-key", () => ({ validateApiKeyOnly: mockValidateApiKeyOnly }));
vi.mock("@/lib/access-restriction", () => ({ enforceAccessRestriction: mockEnforceAccessRestriction }));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withTenantRls: mockWithTenantRls }));
vi.mock("@/lib/logger", () => {
  const noop = vi.fn();
  const child = { info: noop, warn: noop, error: noop };
  return {
    default: { info: noop, warn: noop, error: noop, child: vi.fn().mockReturnValue(child) },
    requestContext: { run: (_s: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
    getLogger: () => child,
  };
});

import { GET } from "./route";

const USER_ID = "user-1";
const TENANT_ID = "tenant-1";
const API_KEY_ID = "key-1";

const validApiKey = { userId: USER_ID, tenantId: TENANT_ID, apiKeyId: API_KEY_ID };

describe("GET /api/v1/vault/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockUserFindUnique.mockResolvedValue({
      encryptedSecretKey: "enc-key",
      keyVersion: 1,
    });
  });

  it("returns 401 when API key is missing or invalid", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_INVALID" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when API key scope is insufficient", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "SCOPE_INSUFFICIENT" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBeDefined();
  });

  it("returns 401 for revoked API key", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_REVOKED" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 401 for expired API key", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_EXPIRED" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 10_000 });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("10");
  });

  it("returns access restriction response when denied", async () => {
    const { NextResponse } = await import("next/server");
    mockEnforceAccessRestriction.mockResolvedValue(
      NextResponse.json({ error: "ACCESS_RESTRICTED" }, { status: 403 }),
    );
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    expect(res.status).toBe(403);
  });

  it("returns initialized=true when encryptedSecretKey is set", async () => {
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.initialized).toBe(true);
    expect(json.keyVersion).toBe(1);
  });

  it("returns initialized=false when encryptedSecretKey is null", async () => {
    mockUserFindUnique.mockResolvedValue({
      encryptedSecretKey: null,
      keyVersion: 0,
    });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.initialized).toBe(false);
    expect(json.keyVersion).toBe(0);
  });

  it("returns initialized=false and keyVersion=null when user not found", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    const res = await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.initialized).toBe(false);
    expect(json.keyVersion).toBeNull();
  });

  it("validates API key with VAULT_STATUS scope", async () => {
    await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    expect(mockValidateApiKeyOnly).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("vault:status"),
    );
  });

  it("uses tenant RLS when querying user", async () => {
    await GET(createRequest("GET", "http://localhost/api/v1/vault/status"));
    expect(mockWithTenantRls).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.any(Function),
    );
  });
});
