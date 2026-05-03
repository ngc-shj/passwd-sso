import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockCheckAuth, mockPrismaUser, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockCheckAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn() },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/auth/session/check-auth", () => ({ checkAuth: mockCheckAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: mockPrismaUser },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from "./route";

function authOk(userId = "test-user-id", type = "session") {
  const auth = type === "token"
    ? { type, userId, scopes: [] as string[] }
    : { type, userId };
  return { ok: true, auth };
}

function authFail(status = 401, error = "UNAUTHORIZED") {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

describe("GET /api/vault/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAuth.mockResolvedValue(authOk());
  });

  it("returns 401 when unauthenticated", async () => {
    mockCheckAuth.mockResolvedValue(authFail());
    const res = await GET(createRequest("GET", "http://localhost/api/vault/status"));
    expect(res.status).toBe(401);
  });

  it("returns 401 for service_account auth type", async () => {
    // checkAuth rejects service_account internally (no userId)
    mockCheckAuth.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 }),
    });
    const res = await GET(createRequest("GET", "http://localhost/api/vault/status"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when scope insufficient", async () => {
    mockCheckAuth.mockResolvedValue(
      authFail(403, "EXTENSION_TOKEN_SCOPE_INSUFFICIENT"),
    );
    const res = await GET(createRequest("GET", "http://localhost/api/vault/status"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when user not found", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null);
    const res = await GET(createRequest("GET", "http://localhost/api/vault/status"));
    expect(res.status).toBe(404);
  });

  it("returns setupRequired: true when vault not set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: null,
      accountSalt: null,
      keyVersion: 0,
      kdfType: 0,
      kdfIterations: 600_000,
      recoveryKeySetAt: null,
      recoveryKeyInvalidatedAt: null,
      tenant: {
        vaultAutoLockMinutes: null,
        tenantMinPasswordLength: 0,
        tenantRequireUppercase: false,
        tenantRequireLowercase: false,
        tenantRequireNumbers: false,
        tenantRequireSymbols: false,
        passwordMaxAgeDays: null,
        passwordExpiryWarningDays: 14,
      },
    });
    const res = await GET(createRequest("GET", "http://localhost/api/vault/status"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({
      setupRequired: true,
      accountSalt: null,
      keyVersion: 0,
      kdfType: 0,
      kdfIterations: 600_000,
      hasRecoveryKey: false,
      vaultAutoLockMinutes: null,
      tenantMinPasswordLength: 0,
      tenantRequireUppercase: false,
      tenantRequireLowercase: false,
      tenantRequireNumbers: false,
      tenantRequireSymbols: false,
      passwordMaxAgeDays: null,
      passwordExpiryWarningDays: 14,
    });
  });

  it("returns setupRequired: false when vault is set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "a".repeat(64),
      keyVersion: 1,
      kdfType: 0,
      kdfIterations: 600_000,
      recoveryKeySetAt: null,
      recoveryKeyInvalidatedAt: null,
      tenant: {
        vaultAutoLockMinutes: null,
        tenantMinPasswordLength: 0,
        tenantRequireUppercase: false,
        tenantRequireLowercase: false,
        tenantRequireNumbers: false,
        tenantRequireSymbols: false,
        passwordMaxAgeDays: null,
        passwordExpiryWarningDays: 14,
      },
    });
    const res = await GET(createRequest("GET", "http://localhost/api/vault/status"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.setupRequired).toBe(false);
    expect(json.accountSalt).toBe("a".repeat(64));
    expect(json.keyVersion).toBe(1);
    expect(json.kdfType).toBe(0);
    expect(json.kdfIterations).toBe(600_000);
    expect(json.hasRecoveryKey).toBe(false);
  });

  it("returns hasRecoveryKey: true when recovery key is set", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "a".repeat(64),
      keyVersion: 1,
      kdfType: 0,
      kdfIterations: 600_000,
      recoveryKeySetAt: new Date(),
      recoveryKeyInvalidatedAt: null,
      tenant: {
        vaultAutoLockMinutes: null,
        tenantMinPasswordLength: 0,
        tenantRequireUppercase: false,
        tenantRequireLowercase: false,
        tenantRequireNumbers: false,
        tenantRequireSymbols: false,
        passwordMaxAgeDays: null,
        passwordExpiryWarningDays: 14,
      },
    });
    const res = await GET(createRequest("GET", "http://localhost/api/vault/status"));
    const json = await res.json();
    expect(json.hasRecoveryKey).toBe(true);
  });

  it("works with Bearer token auth", async () => {
    mockCheckAuth.mockResolvedValue(authOk("token-user-id", "token"));
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "b".repeat(64),
      keyVersion: 1,
      kdfType: 0,
      kdfIterations: 600_000,
      recoveryKeySetAt: null,
      recoveryKeyInvalidatedAt: null,
      tenant: {
        vaultAutoLockMinutes: 30,
        tenantMinPasswordLength: 0,
        tenantRequireUppercase: false,
        tenantRequireLowercase: false,
        tenantRequireNumbers: false,
        tenantRequireSymbols: false,
        passwordMaxAgeDays: null,
        passwordExpiryWarningDays: 14,
      },
    });
    const res = await GET(createRequest("GET", "http://localhost/api/vault/status"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.accountSalt).toBe("b".repeat(64));
    expect(json.kdfType).toBe(0);
    expect(json.kdfIterations).toBe(600_000);
    expect(mockWithUserTenantRls).toHaveBeenCalledWith("token-user-id", expect.any(Function));
  });
});
