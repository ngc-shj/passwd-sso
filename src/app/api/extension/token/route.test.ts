import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockFindUnique,
  mockUpdate,
  mockWithBypassRls,
  mockEnforceAccessRestriction,
  mockLogAudit,
  mockExtractClientIp,
  mockRateLimiterCheck,
  mockCreateRateLimiter,
  mockWarn,
  mockVerifyDpop,
} = vi.hoisted(() => {
  const mockRateLimiterCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockFindUnique: vi.fn(),
    mockUpdate: vi.fn(),
    mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
    mockEnforceAccessRestriction: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
    mockLogAudit: vi.fn(),
    mockExtractClientIp: vi.fn(() => "1.2.3.4"),
    mockRateLimiterCheck,
    // createRateLimiter must be a RECORDING vi.fn (T4) — assertRedisFailClosed's
    // factory-attribution step reads mockCreateRateLimiter.mock.{calls,results}
    // to prove the limiter under test was constructed with the fail-closed
    // option enabled (the gate counts the literal option text, so this comment
    // deliberately avoids it).
    mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockRateLimiterCheck, clear: vi.fn() })),
    mockWarn: vi.fn(),
    mockVerifyDpop: vi.fn(),
  };
});

vi.mock("@/lib/auth/dpop/verify", () => ({
  verifyDpopProof: mockVerifyDpop,
  computeAth: vi.fn((t: string) => `ath-${t}`),
}));
vi.mock("@/lib/auth/dpop/jti-cache", () => ({
  getJtiCache: vi.fn(() => ({ has: vi.fn(() => false), add: vi.fn() })),
}));
vi.mock("@/lib/auth/dpop/htu-canonical", () => ({
  canonicalHtu: vi.fn(() => "https://localhost:3000/api/extension/token"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionToken: {
      findUnique: mockFindUnique,
      update: mockUpdate,
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ extensionTokenIdleTimeoutMinutes: 15 }),
    },
    // C13: active membership by default so token validation passes the deactivation check.
    tenantMember: {
      findUnique: vi.fn().mockResolvedValue({ deactivatedAt: null }),
    },
  },
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "a".repeat(64),
  hashToken: () => "h".repeat(64),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
}));
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: mockExtractClientIp,
  rateLimitKeyFromIp: (ip: string) => `ip:${ip}`,
}));
// checkIpRateLimit and checkRateLimitOrFail are NOT mocked (T1) — both run
// as production code so the real limiter.check() -> redisErrored -> 503
// mapping stays in the tested path. checkIpRateLimit itself just calls
// legacyDeprecatedLimiter.check(key), so this is limiter-layer control only.
vi.mock("@/lib/logger", () => ({
  default: { warn: mockWarn, error: vi.fn(), info: vi.fn() },
  getLogger: () => ({ warn: mockWarn, error: vi.fn(), info: vi.fn() }),
}));

import { POST, DELETE } from "./route";

// The module-level `legacyDeprecatedLimiter = createRateLimiter(...)` call
// in route.ts runs once at import time, above. The global `beforeEach` in
// src/__tests__/setup.ts calls `vi.clearAllMocks()` before the FIRST test
// runs, wiping `mockCreateRateLimiter.mock.calls`/`.results` recorded during
// that import. Snapshot them here (module scope, before any test/beforeEach
// executes) so `assertRedisFailClosed`'s factory-attribution check still has
// the original call/result to inspect after clearAllMocks runs.
const legacyDeprecatedLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const legacyDeprecatedLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimiterCheck;
};

// ─── POST ────────────────────────────────────────────────────

describe("POST /api/extension/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractClientIp.mockReturnValue("1.2.3.4");
    legacyDeprecatedLimiter.check.mockResolvedValue({ allowed: true });
    mockLogAudit.mockResolvedValue(undefined);
  });

  it("returns 410 with no session cookie + Cache-Control: no-store", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/extension/token"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(410);
    expect(json.error).toBe(API_ERROR.EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 410 even with valid session cookie", async () => {
    const req = createRequest("POST", "http://localhost/api/extension/token", {
      headers: { Cookie: `authjs.session-token=fake-session-token` },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(410);
    expect(json.error).toBe(API_ERROR.EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED);
  });

  it("emits ANONYMOUS_ACTOR_ID audit row with EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED + ip/userAgent", async () => {
    const req = createRequest("POST", "http://localhost/api/extension/token", {
      headers: { "User-Agent": "test-agent/1.0" },
    });
    await POST(req);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED,
        userId: ANONYMOUS_ACTOR_ID,
        actorType: ACTOR_TYPE.ANONYMOUS,
        ip: "1.2.3.4",
        userAgent: "test-agent/1.0",
      }),
    );
  });

  it("response includes Deprecation: true header", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/extension/token"));
    expect(res.headers.get("Deprecation")).toBe("true");
  });

  it("returns 429 when IP rate limit exceeded", async () => {
    // Drives the real checkIpRateLimit -> legacyDeprecatedLimiter.check ->
    // checkRateLimitOrFail chain (T1: no more rate-limit-audit stub); the
    // limiter-layer mock is the only arrangement needed.
    legacyDeprecatedLimiter.check.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });

    const res = await POST(createRequest("POST", "http://localhost/api/extension/token"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
    // Critical invariant: rate-limit blocks before audit emission, capping
    // audit-row write rate at the limiter's threshold per IP.
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    // assertRedisFailClosed asserts the production checkRateLimitOrFail
    // mapping + no-mutation contract.
    await assertRedisFailClosed({
      invoke: () => POST(createRequest("POST", "http://localhost/api/extension/token")),
      limiter: legacyDeprecatedLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockUpdate],
      limiterFactory: legacyDeprecatedLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });
});

// ─── DELETE ──────────────────────────────────────────────────

const VALID_CNF_JKT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb";

describe("DELETE /api/extension/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyDpop.mockResolvedValue({ ok: true, claims: {}, jkt: VALID_CNF_JKT });
  });

  it("revokes a token successfully via Bearer", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: DEFAULT_SESSION.user.id,
      scope: "passwords:read,vault:unlock-data",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
      cnfJkt: VALID_CNF_JKT,
      familyId: "fam-1",
      familyCreatedAt: new Date(),
      clientKind: "BROWSER_EXTENSION",
    });
    mockUpdate.mockResolvedValue({});

    const req = createRequest("DELETE", "http://localhost/api/extension/token", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
  });

  it("returns 404 for non-existent token", async () => {
    mockFindUnique.mockResolvedValue(null);

    const req = createRequest("DELETE", "http://localhost/api/extension/token", {
      headers: { Authorization: `Bearer ${"b".repeat(64)}` },
    });
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("EXTENSION_TOKEN_INVALID");
  });

  it("returns 400 for already revoked token", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: DEFAULT_SESSION.user.id,
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: new Date("2025-01-01"),
    });

    const req = createRequest("DELETE", "http://localhost/api/extension/token", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("EXTENSION_TOKEN_REVOKED");
  });

  it("returns 400 for expired token", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: DEFAULT_SESSION.user.id,
      scope: "passwords:read",
      expiresAt: new Date("2020-01-01"),
      revokedAt: null,
    });

    const req = createRequest("DELETE", "http://localhost/api/extension/token", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("EXTENSION_TOKEN_EXPIRED");
  });

  it("returns 404 when no Bearer header", async () => {
    const req = createRequest("DELETE", "http://localhost/api/extension/token");
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("EXTENSION_TOKEN_INVALID");
  });

  it("returns 403 when client IP is outside the tenant access restriction", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: DEFAULT_SESSION.user.id,
      scope: "passwords:read,vault:unlock-data",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
      cnfJkt: VALID_CNF_JKT,
      familyId: "fam-1",
      familyCreatedAt: new Date(),
      clientKind: "BROWSER_EXTENSION",
    });
    const denied = new Response(
      JSON.stringify({ error: "ACCESS_DENIED" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
    mockEnforceAccessRestriction.mockResolvedValueOnce(denied);

    const req = createRequest("DELETE", "http://localhost/api/extension/token", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const res = await DELETE(req);

    expect(res.status).toBe(403);
    // validateExtensionToken internally updates lastUsedAt on every successful
    // validation; that call is expected. What must NOT happen under IP denial
    // is the revoke write (`revokedAt: <date>`).
    for (const call of mockUpdate.mock.calls) {
      expect(call[0].data).not.toHaveProperty("revokedAt");
    }
  });
});
