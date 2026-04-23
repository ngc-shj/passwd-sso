import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../../../__tests__/helpers/mock-auth";
import { createRequest, parseResponse } from "../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockAssertOrigin,
  mockAuditDeliveryTargetFindMany,
  mockAuditDeliveryTargetCount,
  mockAuditDeliveryTargetCreate,
  mockGetCurrentMasterKeyVersion,
  mockGetMasterKeyByVersion,
  mockEncryptServerData,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockAssertOrigin: vi.fn().mockReturnValue(null),
  mockAuditDeliveryTargetFindMany: vi.fn(),
  mockAuditDeliveryTargetCount: vi.fn(),
  mockAuditDeliveryTargetCreate: vi.fn(),
  mockGetCurrentMasterKeyVersion: vi.fn().mockReturnValue(1),
  mockGetMasterKeyByVersion: vi.fn(() => Buffer.alloc(32)),
  mockEncryptServerData: vi.fn().mockReturnValue({
    ciphertext: "encrypted-config",
    iv: "iv123456789012",
    authTag: "authtag1234567890123456789012",
  }),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/tenant-auth", () => {
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
    auditDeliveryTarget: {
      findMany: mockAuditDeliveryTargetFindMany,
      count: mockAuditDeliveryTargetCount,
      create: mockAuditDeliveryTargetCreate,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "127.0.0.1",
    userAgent: "test",
  }),
}));
vi.mock("@/lib/auth/session/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  getCurrentMasterKeyVersion: mockGetCurrentMasterKeyVersion,
  getMasterKeyByVersion: mockGetMasterKeyByVersion,
  encryptServerData: mockEncryptServerData,
}));

import { GET, POST } from "@/app/api/tenant/audit-delivery-targets/route";
import { TenantAuthError } from "@/lib/auth/access/tenant-auth";
import { AUDIT_ACTION } from "@/lib/constants";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };

const makeTargetSelectResult = (overrides: Record<string, unknown> = {}) => ({
  id: "adt-1",
  kind: "WEBHOOK",
  isActive: true,
  failCount: 0,
  lastError: null,
  lastDeliveredAt: null,
  createdAt: new Date(),
  ...overrides,
});

describe("GET /api/tenant/audit-delivery-targets", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/tenant/audit-delivery-targets");
    const res = await GET(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 when permission denied", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest("GET", "http://localhost/api/tenant/audit-delivery-targets");
    const res = await GET(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });

  it("returns list of targets without config fields", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetFindMany.mockResolvedValue([makeTargetSelectResult()]);

    const req = createRequest("GET", "http://localhost/api/tenant/audit-delivery-targets");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(Array.isArray(json.targets)).toBe(true);
    expect(json.targets).toHaveLength(1);
    expect(json.targets[0].id).toBe("adt-1");

    // Verify Prisma select omits config fields
    expect(mockAuditDeliveryTargetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({
          configEncrypted: expect.anything(),
          configIv: expect.anything(),
          configAuthTag: expect.anything(),
          masterKeyVersion: expect.anything(),
        }),
      }),
    );

    // Verify response does not expose config fields
    const target = json.targets[0];
    expect(target).not.toHaveProperty("configEncrypted");
    expect(target).not.toHaveProperty("configIv");
    expect(target).not.toHaveProperty("configAuthTag");
    expect(target).not.toHaveProperty("masterKeyVersion");
  });
});

describe("POST /api/tenant/audit-delivery-targets", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: { kind: "WEBHOOK", url: "https://example.com/hook", secret: "s3cr3t" },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 when permission denied", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: { kind: "WEBHOOK", url: "https://example.com/hook", secret: "s3cr3t" },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });

  it("blocks request when CSRF fails", async () => {
    mockAssertOrigin.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "INVALID_ORIGIN" }), { status: 403 }),
    );

    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: { kind: "WEBHOOK", url: "https://example.com/hook", secret: "s3cr3t" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("returns 400 when kind is DB (internal only, not allowed)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: { kind: "DB" },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("returns 400 when kind is INVALID", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: { kind: "INVALID" },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("returns 400 when required config fields missing (SIEM_HEC without token)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: { kind: "SIEM_HEC", url: "https://example.com/hec" },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("returns 400 when URL fails SSRF validation (localhost)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: { kind: "WEBHOOK", url: "https://localhost/hook", secret: "s3cr3t" },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("returns 400 when URL fails SSRF validation (HTTP, not HTTPS)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: { kind: "WEBHOOK", url: "http://example.com/hook", secret: "s3cr3t" },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("returns 400 when count limit reached (10)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetCount.mockResolvedValue(10);

    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: { kind: "WEBHOOK", url: "https://example.com/hook", secret: "s3cr3t" },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.details).toBeDefined();
  });

  it("returns 201 on success with target but no config", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetCount.mockResolvedValue(0);
    const created = {
      id: "adt-new",
      tenantId: "tenant-1",
      kind: "WEBHOOK",
      isActive: true,
      createdAt: new Date(),
      configEncrypted: "encrypted-config",
      configIv: "iv123456789012",
      configAuthTag: "authtag1234567890123456789012",
      masterKeyVersion: 1,
      failCount: 0,
      lastError: null,
      lastDeliveredAt: null,
    };
    mockAuditDeliveryTargetCreate.mockResolvedValue(created);

    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: { kind: "WEBHOOK", url: "https://example.com/hook", secret: "s3cr3t" },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.target.id).toBe("adt-new");
    expect(json.target.kind).toBe("WEBHOOK");
    expect(json.target.isActive).toBe(true);
    expect(json.target).not.toHaveProperty("configEncrypted");
    expect(json.target).not.toHaveProperty("configIv");
    expect(json.target).not.toHaveProperty("configAuthTag");
    expect(json.target).not.toHaveProperty("masterKeyVersion");
    expect(json).not.toHaveProperty("secret");
  });

  it("calls logAuditAsync with AUDIT_DELIVERY_TARGET_CREATE", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetCount.mockResolvedValue(0);
    mockAuditDeliveryTargetCreate.mockResolvedValue({
      id: "adt-new",
      tenantId: "tenant-1",
      kind: "WEBHOOK",
      isActive: true,
      createdAt: new Date(),
      configEncrypted: "enc",
      configIv: "iv",
      configAuthTag: "tag",
      masterKeyVersion: 1,
      failCount: 0,
      lastError: null,
      lastDeliveredAt: null,
    });

    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: { kind: "WEBHOOK", url: "https://example.com/hook", secret: "s3cr3t" },
      headers: { origin: "http://localhost" },
    });
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.AUDIT_DELIVERY_TARGET_CREATE,
        tenantId: "tenant-1",
        scope: "TENANT",
      }),
    );
  });

  it("calls encryptServerData with JSON.stringify of config", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetCount.mockResolvedValue(0);
    mockAuditDeliveryTargetCreate.mockResolvedValue({
      id: "adt-new",
      tenantId: "tenant-1",
      kind: "WEBHOOK",
      isActive: true,
      createdAt: new Date(),
      configEncrypted: "enc",
      configIv: "iv",
      configAuthTag: "tag",
      masterKeyVersion: 1,
      failCount: 0,
      lastError: null,
      lastDeliveredAt: null,
    });

    const payload = { kind: "WEBHOOK", url: "https://example.com/hook", secret: "s3cr3t" };
    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: payload,
      headers: { origin: "http://localhost" },
    });
    await POST(req);

    // Config blob should NOT include kind (stripped before encryption)
    const callArg = mockEncryptServerData.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(callArg);
    expect(parsed).toEqual({ url: "https://example.com/hook", secret: "s3cr3t" });
    // AAD buffer is the 3rd argument
    expect(mockEncryptServerData).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.any(Buffer),
    );
  });

  it("creates S3_OBJECT target successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetCount.mockResolvedValue(0);
    mockAuditDeliveryTargetCreate.mockResolvedValue({
      id: "adt-s3",
      tenantId: "tenant-1",
      kind: "S3_OBJECT",
      isActive: true,
      createdAt: new Date(),
      configEncrypted: "enc",
      configIv: "iv",
      configAuthTag: "tag",
      masterKeyVersion: 1,
      failCount: 0,
      lastError: null,
      lastDeliveredAt: null,
    });

    const req = createRequest("POST", "http://localhost/api/tenant/audit-delivery-targets", {
      body: {
        kind: "S3_OBJECT",
        endpoint: "https://s3.us-east-1.amazonaws.com/my-audit-bucket",
        region: "us-east-1",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      headers: { origin: "http://localhost" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.target.kind).toBe("S3_OBJECT");
  });
});
