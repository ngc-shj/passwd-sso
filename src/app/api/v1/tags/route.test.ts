import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

const {
  mockValidateApiKeyOnly,
  mockEnforceAccessRestriction,
  mockCheck,
  mockTagFindMany,
  mockWithTenantRls,
} = vi.hoisted(() => ({
  mockValidateApiKeyOnly: vi.fn(),
  mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockTagFindMany: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/auth/api-key", () => ({ validateApiKeyOnly: mockValidateApiKeyOnly }));
vi.mock("@/lib/auth/access-restriction", () => ({ enforceAccessRestriction: mockEnforceAccessRestriction }));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tag: { findMany: mockTagFindMany },
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

const mockTags = [
  { id: "t1", name: "Alpha", color: "#ff0000", parentId: null, _count: { passwords: 5 } },
  { id: "t2", name: "Beta", color: null, parentId: "t1", _count: { passwords: 0 } },
];

describe("GET /api/v1/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockTagFindMany.mockResolvedValue(mockTags);
  });

  it("returns 401 when API key is missing or invalid", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_INVALID" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when API key scope is insufficient", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "SCOPE_INSUFFICIENT" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBeDefined();
  });

  it("returns 401 for revoked API key", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_REVOKED" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 401 for expired API key", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "API_KEY_EXPIRED" });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 45_000 });
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("45");
  });

  it("returns access restriction response when denied", async () => {
    const { NextResponse } = await import("next/server");
    mockEnforceAccessRestriction.mockResolvedValue(
      NextResponse.json({ error: "ACCESS_RESTRICTED" }, { status: 403 }),
    );
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    expect(res.status).toBe(403);
  });

  it("returns tags with correct shape", async () => {
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toEqual([
      { id: "t1", name: "Alpha", color: "#ff0000", parentId: null, passwordCount: 5 },
      { id: "t2", name: "Beta", color: null, parentId: "t1", passwordCount: 0 },
    ]);
  });

  it("returns empty array when no tags", async () => {
    mockTagFindMany.mockResolvedValue([]);
    const res = await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toEqual([]);
  });

  it("passes ACTIVE_ENTRY_WHERE filter in count query", async () => {
    await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    expect(mockTagFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          _count: expect.objectContaining({
            select: expect.objectContaining({
              passwords: expect.objectContaining({
                where: expect.objectContaining({ deletedAt: null, isArchived: false }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("validates API key with TAGS_READ scope", async () => {
    await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    expect(mockValidateApiKeyOnly).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("tags:read"),
    );
  });

  it("orders results by name ascending", async () => {
    await GET(createRequest("GET", "http://localhost/api/v1/tags"));
    expect(mockTagFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { name: "asc" },
      }),
    );
  });
});
