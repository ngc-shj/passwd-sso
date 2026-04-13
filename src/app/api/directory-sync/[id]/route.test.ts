import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockTenantMemberFindFirst,
  mockConfigFindFirst,
  mockConfigUpdate,
  mockConfigDelete,
  mockWithUserTenantRls,
  mockLogAudit,
  mockEncryptCredentials,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockTenantMemberFindFirst: vi.fn(),
  mockConfigFindFirst: vi.fn(),
  mockConfigUpdate: vi.fn(),
  mockConfigDelete: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockEncryptCredentials: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: { findFirst: mockTenantMemberFindFirst },
    directorySyncConfig: {
      findFirst: mockConfigFindFirst,
      update: mockConfigUpdate,
      delete: mockConfigDelete,
    },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
}));
vi.mock("@/lib/directory-sync/credentials", () => ({
  encryptCredentials: mockEncryptCredentials,
}));

import { GET, PUT, DELETE } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost/api/directory-sync/config-1";

const MEMBER = { tenantId: "tenant-1" };

const BASE_CONFIG = {
  id: "config-1",
  provider: "AZURE_AD",
  displayName: "My Azure AD",
  enabled: true,
  syncIntervalMinutes: 60,
  status: "IDLE",
  lastSyncAt: null,
  lastSyncError: null,
  lastSyncStats: null,
  nextSyncAt: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const CTX = createParams({ id: "config-1" });

// ── GET ───────────────────────────────────────────────────────

describe("GET /api/directory-sync/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(MEMBER);
    mockConfigFindFirst.mockResolvedValue(BASE_CONFIG);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req, CTX));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when user is not ADMIN/OWNER", async () => {
    mockTenantMemberFindFirst.mockResolvedValue(null);

    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req, CTX));

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when config does not exist", async () => {
    mockConfigFindFirst.mockResolvedValue(null);

    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req, CTX));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns the config on success", async () => {
    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req, CTX));

    expect(status).toBe(200);
    expect(json.id).toBe("config-1");
    expect(json.provider).toBe("AZURE_AD");
    expect(json.displayName).toBe("My Azure AD");
    expect(json.enabled).toBe(true);
    expect(json.syncIntervalMinutes).toBe(60);
  });

  it("queries config filtered by tenantId", async () => {
    const req = createRequest("GET", ROUTE_URL);
    await GET(req, CTX);

    expect(mockConfigFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "config-1", tenantId: "tenant-1" },
      }),
    );
  });
});

// ── PUT ───────────────────────────────────────────────────────

describe("PUT /api/directory-sync/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    // resolveAdminAndConfig calls tenantMember + configFindFirst
    mockTenantMemberFindFirst.mockResolvedValue(MEMBER);
    mockConfigFindFirst.mockResolvedValue(BASE_CONFIG);
    mockConfigUpdate.mockResolvedValue(BASE_CONFIG);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("PUT", ROUTE_URL, { body: { displayName: "Updated" } });
    const { status, json } = await parseResponse(await PUT(req, CTX));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when user is not ADMIN/OWNER", async () => {
    // resolveAdminAndConfig returns null → second tenantMember check also returns null
    mockTenantMemberFindFirst.mockResolvedValue(null);

    const req = createRequest("PUT", ROUTE_URL, { body: { displayName: "Updated" } });
    const { status, json } = await parseResponse(await PUT(req, CTX));

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when config does not belong to tenant", async () => {
    // First call (resolveAdminAndConfig member check) succeeds, config check fails
    // Second call (explicit member check in error path) succeeds
    mockTenantMemberFindFirst
      .mockResolvedValueOnce(MEMBER)   // resolveAdminAndConfig – member
      .mockResolvedValueOnce(MEMBER);  // NOT_FOUND fallback check
    mockConfigFindFirst.mockResolvedValue(null);

    const req = createRequest("PUT", ROUTE_URL, { body: { displayName: "Updated" } });
    const { status, json } = await parseResponse(await PUT(req, CTX));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 400 for invalid body (syncIntervalMinutes out of range)", async () => {
    const req = createRequest("PUT", ROUTE_URL, {
      body: { syncIntervalMinutes: 0 },
    });
    const { status, json } = await parseResponse(await PUT(req, CTX));

    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it("returns 400 for invalid body (displayName empty string)", async () => {
    const req = createRequest("PUT", ROUTE_URL, { body: { displayName: "" } });
    const { status, json } = await parseResponse(await PUT(req, CTX));

    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it("updates displayName and returns updated config", async () => {
    const updated = { ...BASE_CONFIG, displayName: "Updated Name" };
    mockConfigUpdate.mockResolvedValue(updated);

    const req = createRequest("PUT", ROUTE_URL, { body: { displayName: "Updated Name" } });
    const { status, json } = await parseResponse(await PUT(req, CTX));

    expect(status).toBe(200);
    expect(json.displayName).toBe("Updated Name");
    expect(mockConfigUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ displayName: "Updated Name" }),
      }),
    );
  });

  it("re-encrypts credentials when provided", async () => {
    mockEncryptCredentials.mockReturnValue({
      ciphertext: "enc-data",
      iv: "iv-hex",
      authTag: "auth-tag-hex",
    });

    const credentials = { clientId: "abc", clientSecret: "secret" };
    const req = createRequest("PUT", ROUTE_URL, { body: { credentials } });
    const { status } = await parseResponse(await PUT(req, CTX));

    expect(status).toBe(200);
    expect(mockEncryptCredentials).toHaveBeenCalledWith(
      JSON.stringify(credentials),
      "config-1",
      "tenant-1",
    );
    expect(mockConfigUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          encryptedCredentials: "enc-data",
          credentialsIv: "iv-hex",
          credentialsAuthTag: "auth-tag-hex",
        }),
      }),
    );
  });

  it("calls logAudit after successful update", async () => {
    const req = createRequest("PUT", ROUTE_URL, { body: { enabled: false } });
    await PUT(req, CTX);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DIRECTORY_SYNC_CONFIG_UPDATE",
        tenantId: "tenant-1",
        targetId: "config-1",
      }),
    );
  });
});

// ── DELETE ────────────────────────────────────────────────────

describe("DELETE /api/directory-sync/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(MEMBER);
    mockConfigFindFirst.mockResolvedValue(BASE_CONFIG);
    mockConfigDelete.mockResolvedValue(BASE_CONFIG);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when user is not ADMIN/OWNER", async () => {
    mockTenantMemberFindFirst.mockResolvedValue(null);

    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when config does not belong to tenant", async () => {
    mockTenantMemberFindFirst
      .mockResolvedValueOnce(MEMBER)  // resolveAdminAndConfig – member
      .mockResolvedValueOnce(MEMBER); // NOT_FOUND fallback check
    mockConfigFindFirst.mockResolvedValue(null);

    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("deletes the config and returns success", async () => {
    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockConfigDelete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "config-1" } }),
    );
  });

  it("calls logAudit after successful delete", async () => {
    const req = createRequest("DELETE", ROUTE_URL);
    await DELETE(req, CTX);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DIRECTORY_SYNC_CONFIG_DELETE",
        tenantId: "tenant-1",
        targetId: "config-1",
        metadata: expect.objectContaining({
          provider: "AZURE_AD",
          displayName: "My Azure AD",
        }),
      }),
    );
  });
});
