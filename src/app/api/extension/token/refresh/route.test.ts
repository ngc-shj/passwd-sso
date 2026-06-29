import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockValidateExtensionToken,
  mockRevokeExtensionTokenFamily,
  mockCheck,
  mockSessionFindFirst,
  mockTenantFindUnique,
  mockExtTokenUpdateMany,
  mockExtTokenCreate,
  mockTransaction,
  mockWithUserTenantRls,
  mockWithBypassRls,
  mockEnforceAccessRestriction,
  mockDerivePasskeyState,
  mockRecordPasskeyAuditEmit,
  mockLogAuditAsync,
} = vi.hoisted(() => ({
  mockValidateExtensionToken: vi.fn(),
  mockRevokeExtensionTokenFamily: vi.fn().mockResolvedValue({ rowsRevoked: 0 }),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockSessionFindFirst: vi.fn(),
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
}));

vi.mock("@/lib/auth/tokens/extension-token", () => ({
  validateExtensionToken: mockValidateExtensionToken,
  revokeExtensionTokenFamily: mockRevokeExtensionTokenFamily,
  EXTENSION_TOKEN_REVOKE_REASON: {
    FAMILY_EXPIRED: "family_expired",
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
    session: { findFirst: mockSessionFindFirst },
    tenant: { findUnique: mockTenantFindUnique },
    extensionToken: {
      updateMany: mockExtTokenUpdateMany,
      create: mockExtTokenCreate,
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
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
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
}));

import { POST } from "./route";

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
    mockExtTokenUpdateMany.mockResolvedValue({ count: 1 });
    mockExtTokenCreate.mockResolvedValue({
      expiresAt: new Date("2030-01-01"),
      scope: "passwords:read,vault:unlock-data",
      cnfJkt: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb",
    });
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

  it("returns 401 when Auth.js session has expired", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    mockSessionFindFirst.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/extension/token/refresh", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when client IP is outside the tenant access restriction", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });
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
    mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });

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

  it("revokes old token and creates new in transaction", async () => {
    mockValidateExtensionToken.mockResolvedValue(validTokenResult());
    mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });

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
    mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });
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
    mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });
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

  // ─── Replay attack flow ──────────────────────────────────────
  // Simulates the full refresh-then-replay sequence: a legitimate refresh
  // rotates the token, the old plaintext leaks (e.g. via XSS or a sniffed
  // cache), and an attacker presents the rotated token expecting to refresh
  // it. The validation layer must reject the rotated token and the route
  // must NOT mint a new one.

  describe("replay of a rotated token", () => {
    it("first refresh succeeds, then replay of the original token is rejected with REVOKED", async () => {
      mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });

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
      // observes revokedAt != null and short-circuits with REVOKED.
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
      mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });

      // Replay arriving AFTER the family's absolute timeout would normally
      // race with the family-expired branch. Even so, the replayed token is
      // already revoked and validateExtensionToken short-circuits before the
      // family-expired check fires — verify that the family-expired audit
      // path is NOT used to mask the replay-rejected response.
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
      // family revocation must not be triggered by a generic replay — that
      // path is reserved for explicit family_expired and other policy
      // signals, not for the validation layer's REVOKED short-circuit.
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
      mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });
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
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      mockDerivePasskeyState.mockResolvedValue({
        requirePasskey: true,
        hasPasskey: false,
        requirePasskeyEnabledAt: future,
        passkeyGracePeriodDays: 30,
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
