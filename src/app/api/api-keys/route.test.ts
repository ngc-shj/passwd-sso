import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockCheckAuth,
  mockPrismaApiKey,
  mockPrismaUser,
  mockExecuteRaw,
  mockWithUserTenantRls,
  mockRateLimitCheck,
  mockRequireRecentSession,
} = vi.hoisted(() => ({
  mockCheckAuth: vi.fn(),
  mockPrismaApiKey: {
    findMany: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
  },
  mockPrismaUser: { findUnique: vi.fn() },
  mockExecuteRaw: vi.fn().mockResolvedValue(1),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth/session/check-auth", () => ({
  checkAuth: mockCheckAuth,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn().mockReturnValue({ check: mockRateLimitCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiKey: mockPrismaApiKey,
    user: mockPrismaUser,
    // The cap-check + create now run under an advisory lock inside one
    // withUserTenantRls tx (TOCTOU fix); the route calls prisma.$executeRaw
    // for the lock before count/create.
    $executeRaw: mockExecuteRaw,
  },
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: (t: string) => `hashed_${t}`,
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/logger", () => {
  const noop = vi.fn();
  const child = { info: noop, warn: noop, error: noop };
  return {
    default: { info: noop, warn: noop, error: noop, child: vi.fn().mockReturnValue(child) },
    requestContext: { run: (_s: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
  };
});
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: () => ({}),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/constants/auth/api-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/constants/auth/api-key")>();
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

// Asserts the per-user advisory lock ($executeRaw with
// pg_advisory_xact_lock) was acquired. Mutation-kill: deleting the lock line
// from the production count-then-create path leaves $executeRaw uncalled with
// that SQL, so this fails.
function expectAdvisoryLockAcquired(mock: ReturnType<typeof vi.fn>) {
  expect(
    mock.mock.calls.some((c) => String(c[0]).includes("pg_advisory_xact_lock")),
  ).toBe(true);
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

  it("returns 401 for non-session auth types (token/api_key/mcp/service_account)", async () => {
    // checkAuth(req) is session-only after C2; all non-session auth types fail at the gate
    mockCheckAuth.mockResolvedValue(authFail());

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

  it("calls checkAuth in session-only mode (no allowTokens option)", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockPrismaApiKey.findMany.mockResolvedValue([]);

    await GET(createRequest("GET", "http://localhost:3000/api/api-keys"));
    expect(mockCheckAuth).toHaveBeenCalledWith(expect.any(NextRequest));
  });
});

describe("POST /api/api-keys", () => {
  beforeEach(() => {
    mockCheckAuth.mockReset();
    mockPrismaApiKey.count.mockReset();
    mockPrismaApiKey.create.mockReset();
    mockPrismaUser.findUnique.mockReset();
    mockExecuteRaw.mockClear();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockRequireRecentSession.mockResolvedValue(null);
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

  it("returns 401 for non-session auth types (token/api_key/mcp/service_account)", async () => {
    // checkAuth(req) is session-only after C2; all non-session auth types fail at the gate
    mockCheckAuth.mockResolvedValue(authFail());

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/api-keys", {
        body: { name: "test", scope: ["passwords:read"] },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("calls checkAuth in session-only mode (no allowTokens option)", async () => {
    mockCheckAuth.mockResolvedValue(authFail());

    await POST(
      createRequest("POST", "http://localhost:3000/api/api-keys", {
        body: { name: "test", scope: ["passwords:read"] },
      }),
    );
    expect(mockCheckAuth).toHaveBeenCalledWith(expect.any(NextRequest));
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

  it("returns 403 when session step-up is required for session auth", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/api-keys", {
        body: { name: "test", scope: ["passwords:read"] },
      }),
    );

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockPrismaApiKey.create).not.toHaveBeenCalled();
  });

  it("calls requireRecentCurrentAuthMethod unconditionally on session auth", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockPrismaApiKey.count.mockResolvedValue(0);
    mockPrismaApiKey.create.mockResolvedValue({
      id: "new-key",
      prefix: "api_XXXX",
      name: "Test",
      scope: "passwords:read",
      expiresAt: new Date("2026-06-01"),
      createdAt: new Date("2026-01-01"),
    });

    await POST(
      createRequest("POST", "http://localhost:3000/api/api-keys", {
        body: { name: "Test", scope: ["passwords:read"] },
      }),
    );

    expect(mockRequireRecentSession).toHaveBeenCalledTimes(1);
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
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // The count-then-create runs under a per-user advisory lock (TOCTOU fix).
    expectAdvisoryLockAcquired(mockExecuteRaw);
  });
});
