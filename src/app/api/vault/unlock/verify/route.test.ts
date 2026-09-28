import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockCheckAuth,
  mockPrismaUser,
  mockPrismaExtensionTokenUpdate,
  mockWithUserTenantRls,
  mockWithBypassRls,
  mockCheckLockout,
  mockRateLimitCheck,
  mockCreateRateLimiter,
  mockLogAuditAsync,
} = vi.hoisted(() => {
  const mockRateLimitCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockCheckAuth: vi.fn(),
    mockPrismaUser: { findUnique: vi.fn() },
    mockPrismaExtensionTokenUpdate: vi.fn(),
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
    mockWithBypassRls: vi.fn(),
    mockCheckLockout: vi.fn(),
    mockRateLimitCheck,
    // Module-level `verifyLimiter = createRateLimiter(...)` runs at import
    // time (below) — the factory needs a working implementation from the
    // moment it is defined (vi.hoisted runs before the static import
    // evaluates the route module), or `verifyLimiter` is undefined for the
    // whole test run.
    mockCreateRateLimiter: vi.fn(() => ({ check: mockRateLimitCheck, clear: vi.fn() })),
    mockLogAuditAsync: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/auth/session/check-auth", () => ({ checkAuth: mockCheckAuth }));
vi.mock("@/lib/auth/policy/account-lockout", () => ({
  checkLockout: mockCheckLockout,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    extensionToken: { update: mockPrismaExtensionTokenUpdate },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
// Real module underneath so `getTenantRlsContext` resolves for audit.ts's
// load-time assertion; the opener override stays.
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: "1.2.3.4",
    userAgent: "test",
    acceptLanguage: null,
  }),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from "./route";

// Module-level `verifyLimiter = createRateLimiter(...)` runs at import time,
// above. Snapshot the recorded factory call now (module scope, before any
// test/beforeEach executes) — the global beforeEach's vi.clearAllMocks()
// would otherwise wipe mockCreateRateLimiter.mock.calls/.results before the
// first test runs.
const verifyLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const verifyLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimitCheck;
};

const AUTH_HASH = "a".repeat(64);
const SERVER_SALT = "b".repeat(64);
const SERVER_HASH = createHash("sha256").update(AUTH_HASH + SERVER_SALT).digest("hex");
const WRONG_AUTH_HASH = "c".repeat(64);

function makeUser() {
  return {
    vaultSetupAt: new Date("2024-01-01"),
    masterPasswordServerHash: SERVER_HASH,
    masterPasswordServerSalt: SERVER_SALT,
  };
}

function authOk(overrides?: Record<string, unknown>) {
  return {
    ok: true,
    auth: {
      type: "token",
      userId: "user-1",
      tenantId: "tenant-1",
      scopes: ["vault:unlock-data"],
      clientKind: "BROWSER_EXTENSION",
      tokenId: "token-1",
      familyId: "family-1",
      ...overrides,
    },
  };
}

function authSession() {
  return { ok: true, auth: { type: "session", userId: "user-1" } };
}

function authFail(status = 401, error = "UNAUTHORIZED") {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

function req(authHash: string) {
  return createRequest("POST", "http://localhost:3000/api/vault/unlock/verify", {
    body: { authHash },
  });
}

describe("POST /api/vault/unlock/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAuth.mockResolvedValue(authOk());
    mockCheckLockout.mockResolvedValue({ locked: false, lockedUntil: null });
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockPrismaUser.findUnique.mockResolvedValue(makeUser());
    mockPrismaExtensionTokenUpdate.mockResolvedValue({});
    mockWithBypassRls.mockImplementation(async (_p: unknown, fn: (tx: unknown) => unknown) =>
      fn({ extensionToken: { update: mockPrismaExtensionTokenUpdate } }),
    );
  });

  it("returns 401 when the auth type is session (no token row to record presence against)", async () => {
    mockCheckAuth.mockResolvedValue(authSession());

    const res = await POST(req(AUTH_HASH));

    expect(res.status).toBe(401);
    expect(mockPrismaExtensionTokenUpdate).not.toHaveBeenCalled();
  });

  it("returns whatever checkAuth's failure response is when unauthenticated", async () => {
    mockCheckAuth.mockResolvedValue(authFail());

    const res = await POST(req(AUTH_HASH));

    expect(res.status).toBe(401);
  });

  it("returns 403 for an IOS_AUTOFILL token", async () => {
    mockCheckAuth.mockResolvedValue(authOk({ clientKind: "IOS_AUTOFILL" }));

    const res = await POST(req(AUTH_HASH));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
    expect(mockPrismaExtensionTokenUpdate).not.toHaveBeenCalled();
  });

  it("returns 403 for a client kind outside the presence allowlist", async () => {
    mockCheckAuth.mockResolvedValue(authOk({ clientKind: "FUTURE_CLIENT_KIND" }));

    const res = await POST(req(AUTH_HASH));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
    expect(mockPrismaExtensionTokenUpdate).not.toHaveBeenCalled();
  });

  it("accepts an IOS_APP token", async () => {
    mockCheckAuth.mockResolvedValue(authOk({ clientKind: "IOS_APP" }));

    const res = await POST(req(AUTH_HASH));

    expect(res.status).toBe(200);
  });

  it("returns ACCOUNT_LOCKED without consuming the limiter or comparing the hash", async () => {
    const lockedUntil = new Date(Date.now() + 60_000);
    mockCheckLockout.mockResolvedValue({ locked: true, lockedUntil });

    const res = await POST(req(AUTH_HASH));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("ACCOUNT_LOCKED");
    expect(json.lockedUntil).toBe(lockedUntil.toISOString());
    expect(mockRateLimitCheck).not.toHaveBeenCalled();
    expect(mockPrismaUser.findUnique).not.toHaveBeenCalled();
    expect(mockPrismaExtensionTokenUpdate).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () => POST(req(AUTH_HASH)),
      limiter: verifyLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockPrismaExtensionTokenUpdate],
      limiterFactory: verifyLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("on success, records presence (lastPresenceAt) and does not touch expiresAt", async () => {
    const res = await POST(req(AUTH_HASH));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json).toEqual({ verified: true });
    expect(mockPrismaExtensionTokenUpdate).toHaveBeenCalledWith({
      where: { id: "token-1" },
      data: { lastPresenceAt: expect.any(Date) },
    });
    const updateArg = mockPrismaExtensionTokenUpdate.mock.calls[0]?.[0];
    expect(Object.keys(updateArg.data)).toEqual(["lastPresenceAt"]);
  });

  it("on mismatch, returns 422 AUTH_HASH_MISMATCH, leaves the token row untouched, and audits VAULT_UNLOCK_FAILED", async () => {
    const res = await POST(req(WRONG_AUTH_HASH));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(422);
    expect(json.error).toBe("AUTH_HASH_MISMATCH");
    expect(mockPrismaExtensionTokenUpdate).not.toHaveBeenCalled();
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VAULT_UNLOCK_FAILED",
        metadata: { source: "client_token", clientKind: "BROWSER_EXTENSION" },
      }),
    );
  });

  it("6th mismatch within the window on one family is rate-limited while a different family stays allowed", async () => {
    const counts: Record<string, number> = {};
    mockRateLimitCheck.mockImplementation(async (key: string) => {
      counts[key] = (counts[key] ?? 0) + 1;
      return { allowed: counts[key] <= 5 };
    });

    for (let i = 0; i < 5; i++) {
      const res = await POST(req(WRONG_AUTH_HASH));
      expect(res.status).toBe(422);
    }
    const sixthRes = await POST(req(WRONG_AUTH_HASH));
    expect(sixthRes.status).toBe(429);

    // A different family (different token) is unaffected.
    mockCheckAuth.mockResolvedValue(authOk({ familyId: "family-2", tokenId: "token-2" }));
    const otherFamilyRes = await POST(req(WRONG_AUTH_HASH));
    expect(otherFamilyRes.status).toBe(422);

    expect(mockRateLimitCheck).toHaveBeenCalledWith("rl:vault_unlock_verify:family-1");
    expect(mockRateLimitCheck).toHaveBeenCalledWith("rl:vault_unlock_verify:family-2");
  });
});
