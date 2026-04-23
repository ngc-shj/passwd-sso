import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

const {
  mockValidateApiKeyOnly,
  mockEnforceAccessRestriction,
  mockCheck,
  mockEntryFindMany,
  mockEntryCreate,
  mockFolderFindFirst,
  mockTagCount,
  mockLogAudit,
  mockWithTenantRls,
} = vi.hoisted(() => ({
  mockValidateApiKeyOnly: vi.fn(),
  mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockEntryFindMany: vi.fn(),
  mockEntryCreate: vi.fn(),
  mockFolderFindFirst: vi.fn(),
  mockTagCount: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/auth/api-key", () => ({ validateApiKeyOnly: mockValidateApiKeyOnly }));
vi.mock("@/lib/auth/access-restriction", () => ({ enforceAccessRestriction: mockEnforceAccessRestriction }));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: { findMany: mockEntryFindMany, create: mockEntryCreate },
    folder: { findFirst: mockFolderFindFirst },
    tag: { count: mockTagCount },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withTenantRls: mockWithTenantRls }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/logger", () => {
  const noop = vi.fn();
  const child = { info: noop, warn: noop, error: noop };
  return {
    default: { info: noop, warn: noop, error: noop, child: vi.fn().mockReturnValue(child) },
    requestContext: { run: (_s: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
    getLogger: () => child,
  };
});

import { GET, POST } from "./route";

const USER_ID = "user-1";
const TENANT_ID = "tenant-1";
const API_KEY_ID = "key-1";
const now = new Date("2025-01-01T00:00:00Z");

const validApiKey = { userId: USER_ID, tenantId: TENANT_ID, apiKeyId: API_KEY_ID };

const mockEntry = {
  id: "pw-1",
  encryptedOverview: "overview-cipher",
  overviewIv: "overview-iv",
  overviewAuthTag: "overview-tag",
  encryptedBlob: "blob-cipher",
  blobIv: "blob-iv",
  blobAuthTag: "blob-tag",
  keyVersion: 1,
  aadVersion: 0,
  entryType: "LOGIN",
  isFavorite: false,
  isArchived: false,
  requireReprompt: false,
  expiresAt: null as Date | null,
  folderId: null as string | null,
  tags: [{ id: "tag-1" }],
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

describe("GET /api/v1/passwords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockEntryFindMany.mockResolvedValue([mockEntry]);
  });

  it("returns 401 when API key is missing or invalid", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "INVALID" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/passwords"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when API key scope is insufficient", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "SCOPE_INSUFFICIENT" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/passwords"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBeDefined();
  });

  it("returns 401 for revoked API key", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_REVOKED" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/passwords"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 401 for expired API key", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_EXPIRED" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/passwords"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/passwords"));
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("returns access restriction response when denied", async () => {
    const { NextResponse } = await import("next/server");
    mockEnforceAccessRestriction.mockResolvedValue(
      NextResponse.json({ error: "ACCESS_RESTRICTED" }, { status: 403 }),
    );
    const res = await GET(createRequest("GET", "http://localhost/api/v1/passwords"));
    expect(res.status).toBe(403);
  });

  it("returns entries with encrypted overview shape", async () => {
    const res = await GET(createRequest("GET", "http://localhost/api/v1/passwords"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("pw-1");
    expect(json[0].encryptedOverview).toEqual({
      ciphertext: "overview-cipher",
      iv: "overview-iv",
      authTag: "overview-tag",
    });
    expect(json[0].tagIds).toEqual(["tag-1"]);
    expect(json[0].keyVersion).toBe(1);
    expect(json[0].aadVersion).toBe(0);
    expect(json[0].entryType).toBe("LOGIN");
  });

  it("does not include blob by default", async () => {
    const res = await GET(createRequest("GET", "http://localhost/api/v1/passwords"));
    const { json } = await parseResponse(res);
    expect(json[0].encryptedBlob).toBeUndefined();
  });

  it("includes blob when include=blob", async () => {
    const res = await GET(
      createRequest("GET", "http://localhost/api/v1/passwords", {
        searchParams: { include: "blob" },
      }),
    );
    const { json } = await parseResponse(res);
    expect(json[0].encryptedBlob).toEqual({
      ciphertext: "blob-cipher",
      iv: "blob-iv",
      authTag: "blob-tag",
    });
  });

  it("filters by entryType when type param is valid", async () => {
    mockEntryFindMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/v1/passwords", {
        searchParams: { type: "SECURE_NOTE" },
      }),
    );
    expect(mockEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entryType: "SECURE_NOTE" }),
      }),
    );
  });

  it("ignores invalid entryType query param", async () => {
    mockEntryFindMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/v1/passwords", {
        searchParams: { type: "INVALID_TYPE" },
      }),
    );
    const call = mockEntryFindMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("entryType");
  });

  it("filters trash entries when trash=true", async () => {
    mockEntryFindMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/v1/passwords", {
        searchParams: { trash: "true" },
      }),
    );
    expect(mockEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: { not: null } }),
      }),
    );
  });

  it("filters archived entries when archived=true", async () => {
    mockEntryFindMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/v1/passwords", {
        searchParams: { archived: "true" },
      }),
    );
    expect(mockEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isArchived: true }),
      }),
    );
  });

  it("filters favorites when favorites=true", async () => {
    mockEntryFindMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/v1/passwords", {
        searchParams: { favorites: "true" },
      }),
    );
    expect(mockEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isFavorite: true }),
      }),
    );
  });

  it("filters by tag when tag param is provided", async () => {
    mockEntryFindMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/v1/passwords", {
        searchParams: { tag: "tag-abc" },
      }),
    );
    expect(mockEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tags: { some: { id: "tag-abc" } } }),
      }),
    );
  });

  it("filters by folderId when folder param is provided", async () => {
    mockEntryFindMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/v1/passwords", {
        searchParams: { folder: "folder-abc" },
      }),
    );
    expect(mockEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ folderId: "folder-abc" }),
      }),
    );
  });

  it("returns empty array when no entries", async () => {
    mockEntryFindMany.mockResolvedValue([]);
    const res = await GET(createRequest("GET", "http://localhost/api/v1/passwords"));
    const { json } = await parseResponse(res);
    expect(json).toEqual([]);
  });

  it("validates API key with PASSWORDS_READ scope", async () => {
    await GET(createRequest("GET", "http://localhost/api/v1/passwords"));
    expect(mockValidateApiKeyOnly).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("passwords:read"),
    );
  });
});

describe("POST /api/v1/passwords", () => {
    // aadVersion defaults to 1 in the schema, so id is required
  const validBody = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    encryptedBlob: { ciphertext: "blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
    encryptedOverview: { ciphertext: "over", iv: "c".repeat(24), authTag: "d".repeat(32) },
    keyVersion: 1,
  };

  const createdEntry = {
    id: "new-pw",
    encryptedOverview: "over",
    overviewIv: "c".repeat(24),
    overviewAuthTag: "d".repeat(32),
    keyVersion: 1,
    aadVersion: 0,
    entryType: "LOGIN",
    requireReprompt: false,
    expiresAt: null,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockFolderFindFirst.mockResolvedValue({ id: "folder-1" });
    mockTagCount.mockResolvedValue(1);
    mockEntryCreate.mockResolvedValue(createdEntry);
  });

  it("returns 401 when API key is missing or invalid", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "INVALID" });
    const res = await POST(
      createRequest("POST", "http://localhost/api/v1/passwords", { body: validBody }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when API key scope is insufficient", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "SCOPE_INSUFFICIENT" });
    const res = await POST(
      createRequest("POST", "http://localhost/api/v1/passwords", { body: validBody }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBeDefined();
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 60_000 });
    const res = await POST(
      createRequest("POST", "http://localhost/api/v1/passwords", { body: validBody }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("returns 400 on invalid body (missing required fields)", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/v1/passwords", {
        body: { encryptedBlob: "not-an-object" },
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 400 when folderId is invalid", async () => {
    mockFolderFindFirst.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/v1/passwords", {
        body: { ...validBody, folderId: "missing-folder" },
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 400 when tagIds contain unowned tags", async () => {
    mockTagCount.mockResolvedValue(0);
    const res = await POST(
      createRequest("POST", "http://localhost/api/v1/passwords", {
        body: { ...validBody, tagIds: ["foreign-tag"] },
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("creates entry and returns 201 with correct shape", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/v1/passwords", { body: validBody }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(201);
    expect(json.id).toBe("new-pw");
    expect(json.encryptedOverview).toEqual({
      ciphertext: "over",
      iv: "c".repeat(24),
      authTag: "d".repeat(32),
    });
    expect(json.keyVersion).toBe(1);
    expect(json.tagIds).toEqual([]);
    expect(json.entryType).toBe("LOGIN");
  });

  it("creates entry with client-generated id", async () => {
    const clientId = "550e8400-e29b-41d4-a716-446655440000";
    mockEntryCreate.mockResolvedValue({ ...createdEntry, id: clientId });
    await POST(
      createRequest("POST", "http://localhost/api/v1/passwords", {
        body: { ...validBody, id: clientId },
      }),
    );
    expect(mockEntryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ id: clientId }),
      }),
    );
  });

  it("logs ENTRY_CREATE audit event after creation", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/v1/passwords", { body: validBody }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ENTRY_CREATE", targetId: "new-pw" }),
    );
  });

  it("validates API key with PASSWORDS_WRITE scope", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/v1/passwords", { body: validBody }),
    );
    expect(mockValidateApiKeyOnly).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("passwords:write"),
    );
  });

  it("does not include encryptedBlob in 201 response", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/v1/passwords", { body: validBody }),
    );
    const { json } = await parseResponse(res);
    expect(json).not.toHaveProperty("encryptedBlob");
  });
});
