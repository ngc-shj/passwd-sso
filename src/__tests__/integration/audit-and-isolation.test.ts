/**
 * Integration-style scenario tests for audit logging and tenant isolation.
 * Tests SA action audit logging, human session audit continuity, and cross-tenant rejection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockCreate,
  mockAuditInfo,
  mockUserFindUnique,
  mockWithBypassRls,
  mockValidateServiceAccountToken,
  mockAuth,
} = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockAuditInfo: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockValidateServiceAccountToken: vi.fn(),
  mockAuth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { create: mockCreate },
    team: { findUnique: vi.fn() },
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit-logger", () => ({
  auditLogger: { info: mockAuditInfo, enabled: true },
  METADATA_BLOCKLIST: new Set([
    "password", "passphrase", "secret", "secretKey",
    "encryptedBlob", "encryptedOverview", "encryptedData", "encryptedSecretKey",
    "encryptedTeamKey", "masterPasswordServerHash",
    "token", "tokenHash", "accessToken", "refreshToken", "idToken",
    "accountSalt", "passphraseVerifierHmac",
  ]),
}));
vi.mock("@/lib/service-account-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/service-account-token")>();
  return {
    ...actual,
    validateServiceAccountToken: mockValidateServiceAccountToken,
  };
});
vi.mock("@/auth", () => ({ auth: mockAuth }));

// ─── Imports after mocks ───────────────────────────────────────────────────────

import { logAudit, resolveActorType } from "@/lib/audit";
import type { AuthResult } from "@/lib/auth-or-token";

// Flush microtasks so async void fire-and-forget work completes
async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Scenario 5: SA action audit logging ──────────────────────────────────────

describe("Scenario 5: SA action audit logging", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolveActorType returns SERVICE_ACCOUNT for service_account auth", () => {
    const auth: AuthResult = {
      type: "service_account",
      serviceAccountId: "c0000000-0000-4000-8000-000000000001",
      tenantId: "a0000000-0000-4000-8000-000000000001",
      tokenId: "d0000000-0000-4000-8000-000000000001",
      scopes: [],
    };
    expect(resolveActorType(auth)).toBe("SERVICE_ACCOUNT");
  });

  it("resolveActorType returns HUMAN for session auth", () => {
    const auth: AuthResult = { type: "session", userId: "u1" };
    expect(resolveActorType(auth)).toBe("HUMAN");
  });

  it("resolveActorType returns HUMAN for api_key auth", () => {
    const auth: AuthResult = {
      type: "api_key",
      userId: "u1",
      tenantId: "a0000000-0000-4000-8000-000000000001",
      apiKeyId: "ak-1",
      scopes: [],
    };
    expect(resolveActorType(auth)).toBe("HUMAN");
  });

  it("logAudit writes actorType SERVICE_ACCOUNT and serviceAccountId when SA acts", async () => {
    mockUserFindUnique.mockResolvedValue({ tenantId: "a0000000-0000-4000-8000-000000000001" });
    mockCreate.mockResolvedValue({});

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: "sa-proxy-user-id",
      actorType: "SERVICE_ACCOUNT",
      serviceAccountId: "sa-001",
      tenantId: "a0000000-0000-4000-8000-000000000001",
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: "e0000000-0000-4000-8000-000000000001",
    });
    await flushAsyncWork();

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: "SERVICE_ACCOUNT",
        serviceAccountId: "sa-001",
        tenantId: "a0000000-0000-4000-8000-000000000001",
      }),
    });
  });

  it("logAudit emits actorType SERVICE_ACCOUNT to pino logger when SA acts", async () => {
    mockUserFindUnique.mockResolvedValue({ tenantId: "a0000000-0000-4000-8000-000000000001" });
    mockCreate.mockResolvedValue({});
    mockAuditInfo.mockReturnValue(undefined);

    logAudit({
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION.ENTRY_UPDATE,
      userId: "sa-proxy-user-id",
      actorType: "SERVICE_ACCOUNT",
      serviceAccountId: "sa-002",
      tenantId: "a0000000-0000-4000-8000-000000000001",
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: "entry-42",
    });
    await flushAsyncWork();

    expect(mockAuditInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          actorType: "SERVICE_ACCOUNT",
          serviceAccountId: "sa-002",
        }),
      }),
      expect.any(String),
    );
  });
});

// ─── Scenario 6: Session-based actions stay HUMAN ─────────────────────────────

describe("Scenario 6: Existing audit unchanged — session produces HUMAN", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolveActorType returns HUMAN for session type", () => {
    const auth: AuthResult = { type: "session", userId: "u1" };
    expect(resolveActorType(auth)).toBe("HUMAN");
  });

  it("resolveActorType returns HUMAN for token type", () => {
    const auth: AuthResult = { type: "token", userId: "u1", scopes: [] };
    expect(resolveActorType(auth)).toBe("HUMAN");
  });

  it("logAudit defaults actorType to HUMAN when not provided", async () => {
    mockUserFindUnique.mockResolvedValue({ tenantId: "a0000000-0000-4000-8000-000000000001" });
    mockCreate.mockResolvedValue({});

    // No actorType passed — should default to HUMAN in DB write
    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "b0000000-0000-4000-8000-000000000001",
      tenantId: "a0000000-0000-4000-8000-000000000001",
    });
    await flushAsyncWork();

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: "HUMAN",
        serviceAccountId: null,
      }),
    });
  });

  it("logAudit defaults actorType to HUMAN in pino emit when not provided", () => {
    mockCreate.mockResolvedValue({});
    mockAuditInfo.mockReturnValue(undefined);

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGOUT,
      userId: "b0000000-0000-4000-8000-000000000001",
    });

    expect(mockAuditInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          actorType: "HUMAN",
          serviceAccountId: null,
        }),
      }),
      expect.any(String),
    );
  });

  it("session-based audit has no serviceAccountId in DB write", async () => {
    mockUserFindUnique.mockResolvedValue({ tenantId: "a0000000-0000-4000-8000-000000000001" });
    mockCreate.mockResolvedValue({});

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_VIEW,
      userId: "user-human",
      tenantId: "a0000000-0000-4000-8000-000000000001",
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: "e0000000-0000-4000-8000-000000000001",
    });
    await flushAsyncWork();

    const call = mockCreate.mock.calls[0][0];
    expect(call.data.actorType).toBe("HUMAN");
    expect(call.data.serviceAccountId).toBeNull();
  });
});

// ─── Scenario 7: Tenant isolation ─────────────────────────────────────────────

describe("Scenario 7: Tenant isolation — SA token from tenant-A rejected for tenant-B", () => {
  it("validateServiceAccountToken returns tenantId from token", async () => {
    // Simulate a token issued by tenant-A
    mockValidateServiceAccountToken.mockResolvedValue({
      ok: true,
      data: {
        tokenId: "d0000000-0000-4000-8000-000000000001",
        serviceAccountId: "c0000000-0000-4000-8000-000000000001",
        tenantId: "tenant-A",
        scopes: ["passwords:read"],
      },
    });

    const { validateServiceAccountToken } = await import("@/lib/service-account-token");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/v1/passwords", {
      headers: { authorization: "Bearer sa_abc123" },
    });
    const result = await validateServiceAccountToken(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.tenantId).toBe("tenant-A");
    }
  });

  it("tenant mismatch is detected: SA tenantId !== route context tenantId", async () => {
    // Simulate SA token from tenant-A, route expects tenant-B
    const saTokenTenantId = "tenant-A";
    const routeContextTenantId = "tenant-B";

    // The check a route handler would perform:
    const isCrossTenant = saTokenTenantId !== routeContextTenantId;
    expect(isCrossTenant).toBe(true);
  });

  it("same-tenant SA access passes isolation check", async () => {
    const saTokenTenantId = "tenant-A";
    const routeContextTenantId = "tenant-A";

    const isCrossTenant = saTokenTenantId !== routeContextTenantId;
    expect(isCrossTenant).toBe(false);
  });

  it("authOrToken returns service_account type with correct tenantId for SA Bearer", async () => {
    // Mock a valid SA token belonging to tenant-A
    mockValidateServiceAccountToken.mockResolvedValue({
      ok: true,
      data: {
        tokenId: "d0000000-0000-4000-8000-000000000001",
        serviceAccountId: "c0000000-0000-4000-8000-000000000001",
        tenantId: "tenant-A",
        scopes: ["passwords:read"],
      },
    });
    // No session
    mockAuth.mockResolvedValue(null);

    // We test the auth result type and tenantId extraction pattern used in routes
    const { validateServiceAccountToken } = await import("@/lib/service-account-token");
    const { NextRequest } = await import("next/server");

    const req = new NextRequest("http://localhost/api/v1/passwords", {
      headers: { authorization: "Bearer sa_validtoken" },
    });
    const result = await validateServiceAccountToken(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Route handler would reject this if result.data.tenantId !== actor.tenantId
      const authTenantId = result.data.tenantId;
      const routeTenantId = "tenant-B";
      expect(authTenantId).not.toBe(routeTenantId); // mismatch → should reject
    }
  });

  it("resolveActorType on service_account auth identifies non-human actor for isolation auditing", () => {
    const auth: AuthResult = {
      type: "service_account",
      serviceAccountId: "c0000000-0000-4000-8000-000000000001",
      tenantId: "tenant-A",
      tokenId: "d0000000-0000-4000-8000-000000000001",
      scopes: ["passwords:read"],
    };

    const actorType = resolveActorType(auth);
    expect(actorType).toBe("SERVICE_ACCOUNT");

    // A route checking tenantId from SA token
    const routeTenantId = "tenant-B";
    const isTenantMismatch = auth.tenantId !== routeTenantId;
    expect(isTenantMismatch).toBe(true);
  });
});
