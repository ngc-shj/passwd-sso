import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockCheckAuth,
  mockPrismaApiKey,
  mockPrismaUser,
  mockWithUserTenantRls,
  mockRateLimitCheck,
} = vi.hoisted(() => ({
  mockCheckAuth: vi.fn(),
  mockPrismaApiKey: {
    findMany: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
  },
  mockPrismaUser: { findUnique: vi.fn() },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/check-auth", () => ({
  checkAuth: mockCheckAuth,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn().mockReturnValue({ check: mockRateLimitCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiKey: mockPrismaApiKey,
    user: mockPrismaUser,
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  hashToken: (t: string) => `hashed_${t}`,
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/logger", () => {
  const noop = vi.fn();
  const child = { info: noop, warn: noop, error: noop };
  return {
    default: { info: noop, warn: noop, error: noop, child: vi.fn().mockReturnValue(child) },
    requestContext: { run: (_s: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
  };
});
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({}),
}));
vi.mock("@/lib/constants/api-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/constants/api-key")>();
  return { ...actual };
});

import { NextRequest } from "next/server";
import { GET, POST } from "./route";

function authFail(status = 401) {
  return {
    ok: false,
    response: NextResponse.json({ error: "UNAUTHORIZED" }, { status }),
  };
}

describe("GET /api/api-keys", () => {
  beforeEach(() => {
    mockCheckAuth.mockReset();
    mockPrismaApiKey.findMany.mockReset();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when unauthenticated", async () => {
    mockCheckAuth.mockResolvedValue(authFail());

    const res = await GET(createRequest("GET", "http://localhost:3000/api/api-keys"));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 401 when auth type is api_key", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: {
        type: "api_key",
        userId: "u1",
        tenantId: "t1",
        apiKeyId: "ak1",
        scopes: ["passwords:read"],
      },
    });

    const res = await GET(createRequest("GET", "http://localhost:3000/api/api-keys"));
    expect(res.status).toBe(401);
  });

  it("returns 401 for service_account auth type", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "service_account", serviceAccountId: "sa-1", tenantId: "t-1", tokenId: "tok-1", scopes: [] },
    });

    const res = await GET(createRequest("GET", "http://localhost:3000/api/api-keys"));
    expect(res.status).toBe(401);
  });

  it("returns key list for session auth", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockPrismaApiKey.findMany.mockResolvedValue([
      {
        id: "key-1",
        prefix: "api_XXXX",
        name: "Test Key",
        scope: "passwords:read,passwords:write",
        expiresAt: null,
        createdAt: new Date("2026-01-01"),
        revokedAt: null,
        lastUsedAt: null,
      },
    ]);

    const res = await GET(createRequest("GET", "http://localhost:3000/api/api-keys"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("key-1");
    expect(json[0].scopes).toEqual(["passwords:read", "passwords:write"]);
  });

  it("returns key list for extension token auth", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "token", userId: "u2", scopes: [] },
    });
    mockPrismaApiKey.findMany.mockResolvedValue([]);

    const res = await GET(createRequest("GET", "http://localhost:3000/api/api-keys"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("calls checkAuth with allowTokens and skipAccessRestriction", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockPrismaApiKey.findMany.mockResolvedValue([]);

    await GET(createRequest("GET", "http://localhost:3000/api/api-keys"));
    expect(mockCheckAuth).toHaveBeenCalledWith(
      expect.any(NextRequest),
      { allowTokens: true, skipAccessRestriction: true },
    );
  });
});

describe("POST /api/api-keys", () => {
  beforeEach(() => {
    mockCheckAuth.mockReset();
    mockPrismaApiKey.count.mockReset();
    mockPrismaApiKey.create.mockReset();
    mockPrismaUser.findUnique.mockReset();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when unauthenticated", async () => {
    mockCheckAuth.mockResolvedValue(authFail());

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/api-keys", {
        body: { name: "test", scope: ["passwords:read"] },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when auth type is api_key", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: {
        type: "api_key",
        userId: "u1",
        tenantId: "t1",
        apiKeyId: "ak1",
        scopes: ["passwords:read"],
      },
    });

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/api-keys", {
        body: { name: "test", scope: ["passwords:read"] },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("calls checkAuth with allowTokens and skipAccessRestriction", async () => {
    mockCheckAuth.mockResolvedValue(authFail());

    await POST(
      createRequest("POST", "http://localhost:3000/api/api-keys", {
        body: { name: "test", scope: ["passwords:read"] },
      }),
    );
    expect(mockCheckAuth).toHaveBeenCalledWith(
      expect.any(NextRequest),
      { allowTokens: true, skipAccessRestriction: true },
    );
  });

  it("returns 400 on malformed JSON", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });

    const req = new NextRequest("http://localhost:3000/api/api-keys", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when key limit is exceeded", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockPrismaApiKey.count.mockResolvedValue(10);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/api-keys", {
        body: { name: "Test", scope: ["passwords:read"], expiresAt: expiresAt.toISOString() },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("API_KEY_LIMIT_EXCEEDED");
  });

  it("returns 401 when user not found after auth", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockPrismaApiKey.count.mockResolvedValue(0);
    mockPrismaUser.findUnique.mockResolvedValue(null);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/api-keys", {
        body: { name: "Test", scope: ["passwords:read"], expiresAt: expiresAt.toISOString() },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/api-keys", {
        body: { name: "test", scope: ["passwords:read"] },
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("creates API key for session auth", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockPrismaApiKey.count.mockResolvedValue(0);
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "t1" });
    mockPrismaApiKey.create.mockResolvedValue({
      id: "new-key",
      prefix: "api_XXXX",
      name: "Test",
      scope: "passwords:read",
      expiresAt: new Date("2026-06-01"),
      createdAt: new Date("2026-01-01"),
    });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/api-keys", {
        body: { name: "Test", scope: ["passwords:read"], expiresAt: expiresAt.toISOString() },
      }),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe("new-key");
    expect(json.token).toMatch(/^api_/);
  });
});
