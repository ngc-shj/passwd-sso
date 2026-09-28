import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";
import { REFRESH_REPLAY_GRACE_MS } from "@/lib/auth/tokens/mobile-token";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockValidateExtensionToken,
  mockRevokeExtensionTokenFamily,
  mockCheck,
  mockCreateRateLimiter,
  mockTenantFindUnique,
  mockExtTokenUpdateMany,
  mockExtTokenCreate,
  mockExtTokenAggregate,
  mockExtTokenFindUnique,
  mockTransaction,
  mockWithUserTenantRls,
  mockWithBypassRls,
  mockEnforceAccessRestriction,
  mockDerivePasskeyState,
  mockRecordPasskeyAuditEmit,
  mockLogAuditAsync,
} = vi.hoisted(() => {
  const mockCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
  mockValidateExtensionToken: vi.fn(),
  mockRevokeExtensionTokenFamily: vi.fn().mockResolvedValue({ rowsRevoked: 0 }),
  mockCheck,
  // T4: recording factory — assertRedisFailClosed's factory-attribution step
  // reads mockCreateRateLimiter.mock.{calls,results}.
  mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockCheck, clear: vi.fn() })),
  // Returns null for idle timeout to exercise the production fallback to
  // EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT — keeps the fixture decoupled from any
  // future change to the constant. Existing tests only assert
  // `expiresAt` is defined, not its specific value.
  mockTenantFindUnique: vi.fn().mockResolvedValue({
    extensionTokenIdleTimeoutMinutes: null,
    extensionTokenAbsoluteTimeoutMinutes: 43200,
  }),
  mockExtTokenUpdateMany: vi.fn(),
  mockExtTokenCreate: vi.fn(),
  // C4: getFamilyPresenceAt reads this. Default: no row has ever recorded
  // presence, so the helper falls back to familyCreatedAt (fresh in
  // validTokenResult() — never presence-expired unless a test overrides it).
  mockExtTokenAggregate: vi.fn().mockResolvedValue({ _max: { lastPresenceAt: null } }),
  // C5 replay detection reads the presented (revoked) row directly. Default:
  // not found — the generic "token is revoked" tests don't model a row, so
  // detectRefreshReplay is a no-op for them.
  mockExtTokenFindUnique: vi.fn().mockResolvedValue(null),
  mockTransaction: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p)),
  mockEnforceAccessRestriction: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
  // C8 passkey enforcement mocks
  mockDerivePasskeyState: vi.fn().mockResolvedValue({
    requirePasskey: false,
    hasPasskey: false,
    requirePasskeyEnabledAt: null,
    passkeyGracePeriodDays: null,
  }),
  mockRecordPasskeyAuditEmit: vi.fn().mockReturnValue(true),
  mockLogAuditAsync: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/auth/tokens/extension-token", () => ({
  validateExtensionToken: mockValidateExtensionToken,
  revokeExtensionTokenFamily: mockRevokeExtensionTokenFamily,
  EXTENSION_TOKEN_REVOKE_REASON: {
    FAMILY_EXPIRED: "family_expired",
    PRESENCE_EXPIRED: "presence_expired",
    REPLAY_DETECTED: "replay_detected",
    SIGN_OUT_EVERYWHERE: "sign_out_everywhere",
    PASSKEY_REAUTH: "passkey_reauth",
    USER_DELETE: "user_delete",
  },
}));

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: mockTenantFindUnique },
    extensionToken: {
      updateMany: mockExtTokenUpdateMany,
      create: mockExtTokenCreate,
      aggregate: mockExtTokenAggregate,
      findUnique: mockExtTokenFindUnique,
    },
    $transaction: mockTransaction,
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "new-token-plaintext",
  hashToken: () => "new-token-hash",
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

vi.mock("@/lib/auth/policy/passkey-enforcement", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  derivePasskeyState: mockDerivePasskeyState,
  recordPasskeyAuditEmit: mockRecordPasskeyAuditEmit,
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
  // Used by emitRateLimitFailClosed (rate-limit-audit.ts) on the redisErrored
  // path — required so the fail-closed test's void async audit emission
  // doesn't throw inside the mock module.
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "1.2.3.4",
    userAgent: "test",
    acceptLanguage: null,
  }),
}));

import { POST } from "./route";

// The module-level `refreshLimiter = createRateLimiter(...)` call in
// route.ts runs once at import time, above. The global `beforeEach` in
// src/__tests__/setup.ts calls `vi.clearAllMocks()` before the FIRST test
// runs, wiping `mockCreateRateLimiter.mock.calls`/`.results` recorded during
// that import. Snapshot them here (module scope, before any test/beforeEach
// executes) so `assertRedisFailClosed`'s factory-attribution check still has
// the original call/result to inspect after clearAllMocks runs.
const refreshLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const refreshLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockCheck;
};

// ─── Helpers ─────────────────────────────────────────────────

function validTokenResult(overrides?: Record<string, unknown>) {
  return {
    ok: true,
    data: {
      tokenId: "old-tok-id",
      userId: "user-1",
      tenantId: "tenant-1",
      scopes: ["passwords:read", "vault:unlock-data"],
      expiresAt: new Date("2030-01-01"),
      familyId: "fam-1",
      familyCreatedAt: new Date(),
      cnfJkt: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb",
      ...overrides,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("POST /api/extension/token/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockExtTokenUpdateMany.mockResolvedValue({ count: 1 });
    mockExtTokenCreate.mockResolvedValue({
      expiresAt: new Date("2030-01-01"),
      scope: "passwords:read,vault:unlock-data",
      cnfJkt: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb",
    });
    mockExtTokenAggregate.mockResolvedValue({ _max: { lastPresenceAt: null } });
    mockExtTokenFindUnique.mockResolvedValue(null);
    // Interactive transaction: pass tx object with same mocks to the callback
    mockTransaction.mockImplementation(
      async (cb: (tx: unknown) => unknown) =>
        cb({
          extensionToken: {
            updateMany: mockExtTokenUpdateMany,
            create: mockExtTokenCreate,
          },
        }),
    );
    // Default: passkey enforcement OFF → allows rotation
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
    mockRecordPasskeyAuditEmit.mockReturnValue(true);
    mockLogAuditAsync.mockResolvedValue(undefined);
  });

  it("returns 401 when no Bearer token", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_INVALID",
    });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh");
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("EXTENSION_TOKEN_INVALID");
  });

  it("returns 401 when token is expired", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_EXPIRED",
    });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer expired-token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("EXTENSION_TOKEN_EXPIRED");
  });

  it("returns 401 when token is revoked", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_REVOKED",
    });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer revoked-token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("EXTENSION_TOKEN_REVOKED");
  });

  it("returns 429 when rate limited", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    mockCheck.mockResolvedValueOnce({ allowed: false });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());

    await assertRedisFailClosed({
      invoke: () =>
        POST(
          createRequest("POST", "http://localhost/api/extension/token/refresh", {
            headers: { Authorization: "Bearer valid-token" },
          }),
        ),
      limiter: refreshLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockExtTokenUpdateMany, mockExtTokenCreate],
      limiterFactory: refreshLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  // FR1 / C5: the extension token refresh path no longer depends on an
  // Auth.js web session at all — the token row's own tenantId + family
  // presence bound its lifetime. This replaces the old "returns 401 when
  // Auth.js session has expired" test, which asserted the opposite.
  it("refresh succeeds without a session", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(200);
    expect(mockExtTokenCreate).toHaveBeenCalled();
  });

  it("returns 403 when client IP is outside the tenant access restriction", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    const denied = new Response(
      JSON.stringify({ error: "ACCESS_DENIED" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
    mockEnforceAccessRestriction.mockResolvedValueOnce(denied);

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
    // Must not rotate token when IP is denied
    expect(mockExtTokenCreate).not.toHaveBeenCalled();
    expect(mockEnforceAccessRestriction).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "tenant-1",
    );
  });

  it("refreshes token successfully", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(json.token).toBe("new-token-plaintext");
    expect(json.expiresAt).toBeDefined();
    expect(json.scope).toEqual(["passwords:read", "vault:unlock-data"]);
  });

  // Regression (null-tenant fail-open class): tenantId is FK-backed, so a
  // null tenant ROW is data corruption. Defaulting the TTL to the ceiling
  // could refresh a token to a longer TTL than a tenant that had tightened
  // it. Must FAIL CLOSED (throw → no rotation).
  // Mutation check: restore `tenant?.… ?? DEFAULT` (no null-row throw) and this
  // refresh succeeds instead of throwing — the test fails.
  it("fails closed (throws) when the tenant row is missing", async () => {
    mockValidateExtensionToken.mockResolvedValue(
      validTokenResult({ tenantId: "tenant-gone" }),
    );
    mockTenantFindUnique.mockResolvedValueOnce(null);

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    await expect(POST(req)).rejects.toThrow(/tenant-gone not found/);
    expect(mockExtTokenCreate).not.toHaveBeenCalled();
  });

  it("revokes old token and creates new in transaction", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    await POST(req);

    expect(mockTransaction).toHaveBeenCalled();
    expect(mockExtTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "old-tok-id", revokedAt: null }),
      }),
    );
    expect(mockExtTokenCreate).toHaveBeenCalled();
  });

  it("inherits scopes from old token", async () => {
    mockValidateExtensionToken.mockResolvedValue(
      validTokenResult({ scopes: ["passwords:read"] }),
    );
    mockExtTokenCreate.mockResolvedValue({
      expiresAt: new Date("2030-01-01"),
      scope: "passwords:read",
      cnfJkt: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb",
    });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);
    const { json } = await parseResponse(res);

    expect(json.scope).toEqual(["passwords:read"]);
  });

  it("returns 401 on concurrent refresh (optimistic lock)", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    // updateMany returns count: 0 — already revoked by concurrent request
    mockExtTokenUpdateMany.mockResolvedValue({ count: 0 });

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("EXTENSION_TOKEN_REVOKED");
    // Must NOT create a new token when old one was already revoked
    expect(mockExtTokenCreate).not.toHaveBeenCalled();
  });

  // ─── C4: presence gate ────────────────────────────────────────

  describe("C4: presence gate", () => {
    it("revokes the family and refuses refresh when presence + idle <= now", async () => {
      const staleFamilyCreatedAt = new Date(Date.now() - 20 * 60_000); // 20 min ago
      mockValidateExtensionToken.mockResolvedValue(
        validTokenResult({ familyCreatedAt: staleFamilyCreatedAt }),
      );
      // Tight idle policy (10 min); no row has ever recorded presence, so
      // getFamilyPresenceAt falls back to the (stale) familyCreatedAt.
      mockTenantFindUnique.mockResolvedValueOnce({
        extensionTokenIdleTimeoutMinutes: 10,
        extensionTokenAbsoluteTimeoutMinutes: 43200,
      });
      mockExtTokenAggregate.mockResolvedValueOnce({ _max: { lastPresenceAt: null } });

      const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
        headers: { Authorization: "Bearer valid-token" },
      });
      const res = await POST(req);
      const { status, json } = await parseResponse(res);

      expect(status).toBe(401);
      expect(json.error).toBe("EXTENSION_TOKEN_SESSION_EXPIRED");
      expect(mockRevokeExtensionTokenFamily).toHaveBeenCalledWith(
        expect.objectContaining({ familyId: "fam-1", reason: "presence_expired" }),
      );
      expect(mockExtTokenCreate).not.toHaveBeenCalled();
    });

    it("rotates when presence is within the idle window", async () => {
      const recentPresence = new Date(Date.now() - 60_000); // 1 min ago
      mockValidateExtensionToken.mockResolvedValue(validTokenResult());
      mockTenantFindUnique.mockResolvedValueOnce({
        extensionTokenIdleTimeoutMinutes: 10,
        extensionTokenAbsoluteTimeoutMinutes: 43200,
      });
      mockExtTokenAggregate.mockResolvedValueOnce({ _max: { lastPresenceAt: recentPresence } });

      const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
        headers: { Authorization: "Bearer valid-token" },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockExtTokenCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lastPresenceAt: recentPresence }),
        }),
      );
    });
  });

  // ─── Replay attack flow ──────────────────────────────────────
  // Simulates the full refresh-then-replay sequence: a legitimate refresh
  // rotates the token, the old plaintext leaks (e.g. via XSS or a sniffed
  // cache), and an attacker presents the rotated token expecting to refresh
  // it. The validation layer must reject the rotated token and the route
  // must NOT mint a new one.

  describe("replay of a rotated token", () => {
    it("first refresh succeeds, then replay of the original token is rejected with REVOKED", async () => {
      // Step 1: legitimate refresh succeeds (token A1 → A2).
      mockValidateExtensionToken.mockResolvedValueOnce(validTokenResult());
      const firstReq = createRequest(
        "POST",
        "http://localhost/api/extension/token/refresh",
        { headers: { Authorization: "Bearer A1-plaintext" } },
      );
      const firstRes = await POST(firstReq);
      const firstParsed = await parseResponse(firstRes);
      expect(firstParsed.status).toBe(200);
      expect(mockExtTokenUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockExtTokenCreate).toHaveBeenCalledTimes(1);

      // Step 2: replay the old plaintext (A1). validateExtensionToken now
      // observes revokedAt != null and short-circuits with REVOKED. No row
      // is modeled for the C5 replay lookup (mockExtTokenFindUnique default
      // null), so detectRefreshReplay is a no-op here — this test covers the
      // validation-layer short-circuit, not the C5 replay-detection lookup
      // itself (see the "C5: replay detection" describe block below).
      mockValidateExtensionToken.mockResolvedValueOnce({
        ok: false,
        error: "EXTENSION_TOKEN_REVOKED",
      });
      const replayReq = createRequest(
        "POST",
        "http://localhost/api/extension/token/refresh",
        { headers: { Authorization: "Bearer A1-plaintext" } },
      );
      const replayRes = await POST(replayReq);
      const replayParsed = await parseResponse(replayRes);
      expect(replayParsed.status).toBe(401);
      expect(replayParsed.json.error).toBe("EXTENSION_TOKEN_REVOKED");

      // The replay must NOT mint a new token — only the legitimate refresh did.
      expect(mockExtTokenCreate).toHaveBeenCalledTimes(1);
      expect(mockExtTokenUpdateMany).toHaveBeenCalledTimes(1);
    });

    it("replay does not extend the family absolute timer", async () => {
      // Replay arriving AFTER the family's absolute timeout would normally
      // race with the family-expired branch. Even so, the replayed token is
      // already revoked and validateExtensionToken short-circuits before the
      // family-expired check fires. No row is modeled for the C5 replay
      // lookup here, so the family-expired audit path is NOT reachable via
      // this short-circuit either.
      mockValidateExtensionToken.mockResolvedValue({
        ok: false,
        error: "EXTENSION_TOKEN_REVOKED",
      });

      const req = createRequest(
        "POST",
        "http://localhost/api/extension/token/refresh",
        { headers: { Authorization: "Bearer rotated-A1" } },
      );
      const res = await POST(req);
      const parsed = await parseResponse(res);

      expect(parsed.status).toBe(401);
      expect(parsed.json.error).toBe("EXTENSION_TOKEN_REVOKED");
      expect(mockRevokeExtensionTokenFamily).not.toHaveBeenCalled();
    });
  });

  // ─── C5: replay detection (post-revocation lookup) ───────────
  // validateExtensionToken returns early (no row data) for a revoked token,
  // so the route re-hashes the presented bearer and looks the row up itself.

  describe("C5: replay detection", () => {
    beforeEach(() => {
      mockValidateExtensionToken.mockResolvedValue({
        ok: false,
        error: "EXTENSION_TOKEN_REVOKED",
      });
    });

    function makeRequest() {
      return createRequest("POST", "http://localhost/api/extension/token/refresh", {
        headers: { Authorization: "Bearer revoked-token" },
      });
    }

    it("revokes the family when replayed well after the grace window", async () => {
      mockExtTokenFindUnique.mockResolvedValueOnce({
        revokedAt: new Date(Date.now() - REFRESH_REPLAY_GRACE_MS - 1_000),
        familyId: "fam-1",
        userId: "user-1",
        tenantId: "tenant-1",
      });

      const res = await POST(makeRequest());
      expect(res.status).toBe(401);
      expect(mockRevokeExtensionTokenFamily).toHaveBeenCalledWith({
        familyId: "fam-1",
        userId: "user-1",
        tenantId: "tenant-1",
        reason: "replay_detected",
      });
    });

    it("does not revoke the family when replayed within the grace window", async () => {
      mockExtTokenFindUnique.mockResolvedValueOnce({
        revokedAt: new Date(Date.now() - 1_000),
        familyId: "fam-1",
        userId: "user-1",
        tenantId: "tenant-1",
      });

      const res = await POST(makeRequest());
      expect(res.status).toBe(401);
      expect(mockRevokeExtensionTokenFamily).not.toHaveBeenCalled();
    });

    it("boundary: replayed at exactly the grace window does not revoke the family", async () => {
      mockExtTokenFindUnique.mockResolvedValueOnce({
        revokedAt: new Date(Date.now() - REFRESH_REPLAY_GRACE_MS),
        familyId: "fam-1",
        userId: "user-1",
        tenantId: "tenant-1",
      });

      const res = await POST(makeRequest());
      expect(res.status).toBe(401);
      expect(mockRevokeExtensionTokenFamily).not.toHaveBeenCalled();
    });

    it("does nothing when the presented token's row cannot be found", async () => {
      mockExtTokenFindUnique.mockResolvedValueOnce(null);

      const res = await POST(makeRequest());
      expect(res.status).toBe(401);
      expect(mockRevokeExtensionTokenFamily).not.toHaveBeenCalled();
    });
  });

  // ─── C8: Passkey enforcement matrix ──────────────────────────

  describe("C8: passkey enforcement on refresh", () => {
    function makeRequest() {
      return createRequest("POST", "http://localhost/api/extension/token/refresh", {
        headers: { Authorization: "Bearer valid-token" },
      });
    }

    beforeEach(() => {
      mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    });

    it("6a-off: requirePasskey=false → rotates (extensionToken.create called)", async () => {
      mockDerivePasskeyState.mockResolvedValue({
        requirePasskey: false,
        hasPasskey: false,
        requirePasskeyEnabledAt: null,
        passkeyGracePeriodDays: null,
      });

      const res = await POST(makeRequest());
      const { status } = await parseResponse(res);

      expect(status).toBe(200);
      expect(mockExtTokenCreate).toHaveBeenCalled();
    });

    it("6a-haspasskey: requirePasskey=true + hasPasskey=true → rotates", async () => {
      mockDerivePasskeyState.mockResolvedValue({
        requirePasskey: true,
        hasPasskey: true,
        requirePasskeyEnabledAt: "2024-01-01T00:00:00.000Z",
        passkeyGracePeriodDays: 7,
      });

      const res = await POST(makeRequest());
      const { status } = await parseResponse(res);

      expect(status).toBe(200);
      expect(mockExtTokenCreate).toHaveBeenCalled();
    });

    it("6a-withingrace: requirePasskey=true + no passkey + within grace → rotates", async () => {
      // enabledAt = 3 days ago, grace = 7 days → 4 more days remain (genuinely within grace)
      const past3Days = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      mockDerivePasskeyState.mockResolvedValue({
        requirePasskey: true,
        hasPasskey: false,
        requirePasskeyEnabledAt: past3Days,
        passkeyGracePeriodDays: 7,
      });

      const res = await POST(makeRequest());
      const { status } = await parseResponse(res);

      expect(status).toBe(200);
      expect(mockExtTokenCreate).toHaveBeenCalled();
    });

    it("6a-graceexpired: requirePasskey=true + no passkey + grace expired → REFUSED (RT8) + audit", async () => {
      mockDerivePasskeyState.mockResolvedValue({
        requirePasskey: true,
        hasPasskey: false,
        requirePasskeyEnabledAt: "2020-01-01T00:00:00.000Z",
        passkeyGracePeriodDays: 7,
      });

      const res = await POST(makeRequest());
      const { status, json } = await parseResponse(res);

      // Refused with PASSKEY_REQUIRED (403)
      expect(status).toBe(403);
      expect(json.error).toBe("PASSKEY_REQUIRED");
      // RT8: extensionToken.create must NOT be called
      expect(mockExtTokenCreate).not.toHaveBeenCalled();
      // Audit must be emitted
      expect(mockRecordPasskeyAuditEmit).toHaveBeenCalledWith(
        "user-1",
        "/api/extension/token/refresh",
        expect.any(Number),
      );
      expect(mockLogAuditAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "PASSKEY_ENFORCEMENT_BLOCKED",
          metadata: { blockedPath: "/api/extension/token/refresh" },
        }),
      );
    });

    it("6a-throws: derivePasskeyState throws → fail closed (no rotation)", async () => {
      mockDerivePasskeyState.mockRejectedValue(new Error("DB error"));

      const req = makeRequest();
      await expect(POST(req)).rejects.toThrow("DB error");
      expect(mockExtTokenCreate).not.toHaveBeenCalled();
    });
  });
});
