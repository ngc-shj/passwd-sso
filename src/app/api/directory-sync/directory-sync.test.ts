import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockTenantMemberFindFirst,
  mockConfigFindMany,
  mockConfigFindFirst,
  mockTransaction,
  mockWithUserTenantRls,
  mockLogAudit,
  mockEncryptCredentials,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockTenantMemberFindFirst: vi.fn(),
  mockConfigFindMany: vi.fn(),
  mockConfigFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockEncryptCredentials: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: {
      findFirst: mockTenantMemberFindFirst,
    },
    directorySyncConfig: {
      findMany: mockConfigFindMany,
      findFirst: mockConfigFindFirst,
    },
    $transaction: mockTransaction,
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

import { GET, POST } from "@/app/api/directory-sync/route";

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

describe("GET /api/directory-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/directory-sync");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when user is not ADMIN/OWNER", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/directory-sync");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns list of configs for the tenant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(MEMBER);
    mockConfigFindMany.mockResolvedValue([BASE_CONFIG]);

    const req = createRequest("GET", "http://localhost/api/directory-sync");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("config-1");
    expect(json[0].provider).toBe("AZURE_AD");
  });
});

describe("POST /api/directory-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/directory-sync", {
      body: { provider: "AZURE_AD", displayName: "Test", credentials: {} },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when user is not ADMIN/OWNER", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/directory-sync", {
      body: { provider: "AZURE_AD", displayName: "Test", credentials: {} },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 400 for invalid body (missing provider)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(MEMBER);

    const req = createRequest("POST", "http://localhost/api/directory-sync", {
      body: { displayName: "Test", credentials: {} },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid body (missing displayName)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(MEMBER);

    const req = createRequest("POST", "http://localhost/api/directory-sync", {
      body: { provider: "AZURE_AD", credentials: {} },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid body (unknown provider)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(MEMBER);

    const req = createRequest("POST", "http://localhost/api/directory-sync", {
      body: { provider: "UNKNOWN_PROVIDER", displayName: "Test", credentials: {} },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 409 when duplicate provider config exists", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(MEMBER);
    mockConfigFindFirst.mockResolvedValue({ id: "existing-config" });

    const req = createRequest("POST", "http://localhost/api/directory-sync", {
      body: { provider: "AZURE_AD", displayName: "Test", credentials: {} },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("CONFLICT");
  });

  it("creates config successfully and returns 201", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(MEMBER);
    mockConfigFindFirst.mockResolvedValue(null);
    mockEncryptCredentials.mockReturnValue({
      ciphertext: "encrypted-data",
      iv: "iv-hex",
      authTag: "auth-tag-hex",
    });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        directorySyncConfig: {
          create: vi.fn().mockResolvedValue({ ...BASE_CONFIG, id: "new-config-1" }),
          update: vi.fn().mockResolvedValue({ ...BASE_CONFIG, id: "new-config-1" }),
        },
      };
      return fn(tx);
    });

    const req = createRequest("POST", "http://localhost/api/directory-sync", {
      body: {
        provider: "AZURE_AD",
        displayName: "My Azure AD",
        credentials: { clientId: "abc", clientSecret: "secret", tenantId: "aad-tenant" },
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.id).toBe("new-config-1");
    expect(json.provider).toBe("AZURE_AD");
  });

  it("calls encryptCredentials with the config ID and tenant ID", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(MEMBER);
    mockConfigFindFirst.mockResolvedValue(null);
    mockEncryptCredentials.mockReturnValue({
      ciphertext: "encrypted-data",
      iv: "iv-hex",
      authTag: "auth-tag-hex",
    });

    const createdRow = { ...BASE_CONFIG, id: "new-config-1" };
    const txCreate = vi.fn().mockResolvedValue(createdRow);
    const txUpdate = vi.fn().mockResolvedValue(createdRow);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        directorySyncConfig: { create: txCreate, update: txUpdate },
      };
      return fn(tx);
    });

    const credentials = { clientId: "abc", clientSecret: "secret" };
    const req = createRequest("POST", "http://localhost/api/directory-sync", {
      body: {
        provider: "AZURE_AD",
        displayName: "My Azure AD",
        credentials,
      },
    });
    await POST(req);

    expect(mockEncryptCredentials).toHaveBeenCalledWith(
      JSON.stringify(credentials),
      "new-config-1",
      "tenant-1",
    );
  });

  it("calls logAuditAsync after successful creation", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(MEMBER);
    mockConfigFindFirst.mockResolvedValue(null);
    mockEncryptCredentials.mockReturnValue({
      ciphertext: "encrypted-data",
      iv: "iv-hex",
      authTag: "auth-tag-hex",
    });

    const createdRow = { ...BASE_CONFIG, id: "new-config-1" };
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        directorySyncConfig: {
          create: vi.fn().mockResolvedValue(createdRow),
          update: vi.fn().mockResolvedValue(createdRow),
        },
      };
      return fn(tx);
    });

    const req = createRequest("POST", "http://localhost/api/directory-sync", {
      body: {
        provider: "AZURE_AD",
        displayName: "My Azure AD",
        credentials: {},
      },
    });
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DIRECTORY_SYNC_CONFIG_CREATE",
        tenantId: "tenant-1",
        targetId: "new-config-1",
        metadata: expect.objectContaining({
          provider: "AZURE_AD",
          displayName: "My Azure AD",
        }),
      }),
    );
  });
});
