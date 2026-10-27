import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";
import { MS_PER_DAY } from "@/lib/constants/time";
import { TEST_SESSION_TOKEN } from "@/__tests__/helpers/fixtures";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { STEP_UP_WINDOW_MS } from "@/lib/auth/session/step-up";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockPrismaFindFirst,
  mockPrismaDelete,
  mockPrismaUpdate,
  mockWithUserTenantRls,
  mockLogAudit,
  mockInvalidateUserSessionsCache,
  mockLoggerError,
  mockDerivePasskeyState,
  mockRequireRecentCurrentAuthMethod,
  mockSessionFindUnique,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaFindFirst: vi.fn(),
  mockPrismaDelete: vi.fn(),
  mockPrismaUpdate: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: (tenantId: string) => unknown) => fn("tenant-1")),
  mockLogAudit: vi.fn(),
  mockInvalidateUserSessionsCache: vi.fn(),
  mockLoggerError: vi.fn(),
  mockDerivePasskeyState: vi.fn(),
  mockRequireRecentCurrentAuthMethod: vi.fn(),
  mockSessionFindUnique: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    webAuthnCredential: {
      findFirst: mockPrismaFindFirst,
      delete: mockPrismaDelete,
      update: mockPrismaUpdate,
    },
    // Read only by the real step-up helper the FN-7 cells run.
    session: { findUnique: mockSessionFindUnique },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-rls")>()),
  withBypassRls: (client: unknown, fn: (tx: unknown) => unknown) => fn(client),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));

// C9: DELETE gates on requireRecentCurrentAuthMethod. Each describe sets the
// stub: allow (null) by default; the FN-7 cells swap in the real helper.
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentCurrentAuthMethod,
}));

// #959 F5/F19: DELETE invalidates the user's cached sessions on success.
vi.mock("@/lib/auth/session/user-session-invalidation", () => ({
  invalidateUserSessionsCache: mockInvalidateUserSessionsCache,
}));

// FN-2: the DB reads are mocked; the real `passkeyEnforcementBlocks` (and the
// grace-period comparison under it) stays live.
vi.mock("@/lib/auth/policy/passkey-enforcement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/policy/passkey-enforcement")>()),
  derivePasskeyState: mockDerivePasskeyState,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ error: mockLoggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { DELETE, PATCH } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/webauthn/credentials/cred-1";

const EXISTING_CREDENTIAL = {
  id: "cred-1",
  credentialId: "cred-id-abc123",
};

const UPDATED_CREDENTIAL = {
  id: "cred-1",
  nickname: "My YubiKey",
  deviceType: "singleDevice",
  backedUp: false,
  prfSupported: false,
  createdAt: new Date("2024-01-01"),
  lastUsedAt: null,
};

const CTX = createParams({ id: "cred-1" });

// ── DELETE ────────────────────────────────────────────────────

describe("DELETE /api/webauthn/credentials/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(null);
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaFindFirst.mockResolvedValue(EXISTING_CREDENTIAL);
    mockPrismaDelete.mockResolvedValue(EXISTING_CREDENTIAL);
    mockInvalidateUserSessionsCache.mockResolvedValue({
      totalSessions: 0,
      cacheTombstoneFailures: 0,
    });
    // Default: the tenant does not require a passkey.
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: true,
      passkeyCount: 1,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when credential does not exist", async () => {
    mockPrismaFindFirst.mockResolvedValue(null);

    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when credential belongs to a different user", async () => {
    // The route filters by { id, userId } so a cross-user lookup returns null
    mockPrismaFindFirst.mockResolvedValue(null);

    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("deletes the credential and returns success", async () => {
    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaDelete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cred-1", userId: "user-1" } }),
    );
  });

  it("queries credential filtered by id and userId", async () => {
    const req = createRequest("DELETE", ROUTE_URL);
    await DELETE(req, CTX);

    expect(mockPrismaFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cred-1", userId: "user-1" },
      }),
    );
  });

  it("calls logAuditAsync with credential metadata", async () => {
    const req = createRequest("DELETE", ROUTE_URL);
    await DELETE(req, CTX);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBAUTHN_CREDENTIAL_DELETE",
        userId: "user-1",
        targetId: "cred-1",
        metadata: {
          credentialId: "cred-id-abc123",
          cacheInvalidatedSessions: 0,
          cacheTombstoneFailures: 0,
        },
      }),
    );
  });

  // ── Session cache invalidation (#959 F5/F19) ─────────────────────────────

  it("invalidates the user's cached sessions after a successful delete", async () => {
    const req = createRequest("DELETE", ROUTE_URL);
    const { status } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(200);
    expect(mockInvalidateUserSessionsCache).toHaveBeenCalledWith("user-1");
    expect(mockInvalidateUserSessionsCache).toHaveBeenCalledTimes(1);
  });

  it("does not invalidate when the credential does not exist", async () => {
    mockPrismaFindFirst.mockResolvedValue(null);

    const req = createRequest("DELETE", ROUTE_URL);
    await DELETE(req, CTX);

    expect(mockInvalidateUserSessionsCache).not.toHaveBeenCalled();
  });

  // A Redis tombstone failure does not throw: invalidateUserSessionsCache
  // returns it as a count, which the delete audit row records.
  it("records the tombstone failure count in the delete audit row", async () => {
    mockInvalidateUserSessionsCache.mockResolvedValue({
      totalSessions: 3,
      cacheTombstoneFailures: 2,
    });

    const req = createRequest("DELETE", ROUTE_URL);
    const { status } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBAUTHN_CREDENTIAL_DELETE",
        metadata: {
          credentialId: "cred-id-abc123",
          cacheInvalidatedSessions: 3,
          cacheTombstoneFailures: 2,
        },
      }),
    );
  });

  it("logs and does not fail the response when cache invalidation throws", async () => {
    mockInvalidateUserSessionsCache.mockRejectedValue(new Error("session read failed"));

    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    // The delete already committed — a cache-invalidation failure must not
    // turn a successful delete into an error response.
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockLoggerError).toHaveBeenCalled();
    // Nothing was counted, so the audit row carries only the credential.
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { credentialId: "cred-id-abc123" } }),
    );
  });
});

// ── DELETE: last passkey in a passkey-required tenant (#959 FN-2) ───────────

describe("DELETE /api/webauthn/credentials/[id] — last passkey", () => {
  const NOW = new Date("2026-10-27T12:00:00.000Z").getTime();
  const GRACE_DAYS = 7;
  const GRACE_END = NOW - GRACE_DAYS * MS_PER_DAY;

  function requirement(enabledAtMs: number, requirePasskey = true, passkeyCount = 1) {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey,
      hasPasskey: passkeyCount > 0,
      passkeyCount,
      requirePasskeyEnabledAt: new Date(enabledAtMs).toISOString(),
      passkeyGracePeriodDays: GRACE_DAYS,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(null);
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaFindFirst.mockResolvedValue(EXISTING_CREDENTIAL);
    mockPrismaDelete.mockResolvedValue(EXISTING_CREDENTIAL);
    mockInvalidateUserSessionsCache.mockResolvedValue({ totalSessions: 0, cacheTombstoneFailures: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses the last passkey 1 ms past the grace period, deleting nothing", async () => {
    requirement(GRACE_END - 1);

    const { status, json } = await parseResponse(await DELETE(createRequest("DELETE", ROUTE_URL), CTX));

    expect(status).toBe(403);
    expect(json.error).toBe("CANNOT_DELETE_LAST_PASSKEY");
    expect(mockDerivePasskeyState).toHaveBeenCalledWith({ userId: "user-1", tenantId: "tenant-1" });
    expect(mockPrismaDelete).not.toHaveBeenCalled();
    expect(mockInvalidateUserSessionsCache).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("deletes the last passkey at the exact end of the grace period (still within it)", async () => {
    requirement(GRACE_END);

    const { status } = await parseResponse(await DELETE(createRequest("DELETE", ROUTE_URL), CTX));

    expect(status).toBe(200);
    expect(mockPrismaDelete).toHaveBeenCalledTimes(1);
  });

  it("deletes a passkey that is not the last one past the grace period", async () => {
    requirement(GRACE_END - 1, true, 2);

    const { status } = await parseResponse(await DELETE(createRequest("DELETE", ROUTE_URL), CTX));

    expect(status).toBe(200);
    expect(mockPrismaDelete).toHaveBeenCalledTimes(1);
  });

  it("deletes the last passkey when the tenant does not require one", async () => {
    requirement(GRACE_END - 1, false);

    const { status } = await parseResponse(await DELETE(createRequest("DELETE", ROUTE_URL), CTX));

    expect(status).toBe(200);
    expect(mockPrismaDelete).toHaveBeenCalledTimes(1);
  });

  it("checks nothing for a credential the user does not own (404 first)", async () => {
    requirement(GRACE_END - 1);
    mockPrismaFindFirst.mockResolvedValue(null);

    const { status } = await parseResponse(await DELETE(createRequest("DELETE", ROUTE_URL), CTX));

    expect(status).toBe(404);
    expect(mockDerivePasskeyState).not.toHaveBeenCalled();
  });

  it("fails the request, deleting nothing, when the passkey state read rejects (fail-closed)", async () => {
    mockDerivePasskeyState.mockRejectedValue(new Error("db down"));

    await expect(DELETE(createRequest("DELETE", ROUTE_URL), CTX)).rejects.toThrow("db down");

    expect(mockRequireRecentCurrentAuthMethod).not.toHaveBeenCalled();
    expect(mockPrismaDelete).not.toHaveBeenCalled();
    expect(mockInvalidateUserSessionsCache).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  // ── FN-7: the refusal runs before the step-up ──────────────────────────
  // Runs the real requireRecentCurrentAuthMethod over a session row keyed by
  // this request's cookie digest, so "stale" is the window comparison itself.

  describe("ordering against the step-up", () => {
    const COOKIE = { cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` };

    beforeEach(async () => {
      vi.stubEnv("AUTH_URL", "http://localhost:3000");
      const real = await vi.importActual<
        typeof import("@/lib/auth/session/recent-current-auth-method")
      >("@/lib/auth/session/recent-current-auth-method");
      mockRequireRecentCurrentAuthMethod.mockImplementation(real.requireRecentCurrentAuthMethod);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    function signedInAgo(ageMs: number) {
      mockSessionFindUnique.mockImplementation(
        async ({ where }: { where: { sessionToken: string } }) =>
          where.sessionToken === hashSessionToken(TEST_SESSION_TOKEN)
            ? {
                userId: "user-1",
                provider: "google",
                createdAt: new Date(NOW - ageMs),
                passkeyVerifiedAt: null,
                authCredentialId: null,
              }
            : null,
      );
    }

    function send() {
      return DELETE(createRequest("DELETE", ROUTE_URL, { headers: COOKIE }), CTX);
    }

    it("refuses the last passkey on a stale session without asking for a step-up", async () => {
      requirement(GRACE_END - 1);
      signedInAgo(STEP_UP_WINDOW_MS + 1);

      const { status, json } = await parseResponse(await send());

      expect(status).toBe(403);
      expect(json.error).toBe("CANNOT_DELETE_LAST_PASSKEY");
      expect(mockSessionFindUnique).not.toHaveBeenCalled();
      expect(mockPrismaDelete).not.toHaveBeenCalled();
    });

    it("still requires the step-up to delete a passkey that is not the last one", async () => {
      requirement(GRACE_END - 1, true, 2);
      signedInAgo(STEP_UP_WINDOW_MS + 1);

      const { status, json } = await parseResponse(await send());

      expect(status).toBe(403);
      expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
      expect(mockPrismaDelete).not.toHaveBeenCalled();
      expect(mockInvalidateUserSessionsCache).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("deletes a passkey that is not the last one on a fresh session", async () => {
      requirement(GRACE_END - 1, true, 2);
      signedInAgo(STEP_UP_WINDOW_MS);

      const { status } = await parseResponse(await send());

      expect(status).toBe(200);
      expect(mockPrismaDelete).toHaveBeenCalledTimes(1);
    });

    it("answers 404 for a foreign credential id on a stale session, reading no policy", async () => {
      requirement(GRACE_END - 1);
      signedInAgo(STEP_UP_WINDOW_MS + 1);
      mockPrismaFindFirst.mockResolvedValue(null);

      const { status, json } = await parseResponse(await send());

      expect(status).toBe(404);
      expect(json.error).toBe("NOT_FOUND");
      expect(mockDerivePasskeyState).not.toHaveBeenCalled();
      expect(mockSessionFindUnique).not.toHaveBeenCalled();
    });
  });
});

// ── PATCH ─────────────────────────────────────────────────────

describe("PATCH /api/webauthn/credentials/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaFindFirst.mockResolvedValue({ id: "cred-1" });
    mockPrismaUpdate.mockResolvedValue(UPDATED_CREDENTIAL);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("PATCH", ROUTE_URL, { body: { nickname: "My Key" } });
    const { status, json } = await parseResponse(await PATCH(req, CTX));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when credential does not exist", async () => {
    mockPrismaFindFirst.mockResolvedValue(null);

    const req = createRequest("PATCH", ROUTE_URL, { body: { nickname: "My Key" } });
    const { status, json } = await parseResponse(await PATCH(req, CTX));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 400 when nickname is missing", async () => {
    const req = createRequest("PATCH", ROUTE_URL, { body: {} });
    const { status, json } = await parseResponse(await PATCH(req, CTX));

    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it("returns 400 when nickname exceeds max length", async () => {
    const req = createRequest("PATCH", ROUTE_URL, {
      body: { nickname: "a".repeat(500) },
    });
    const { status, json } = await parseResponse(await PATCH(req, CTX));

    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it("updates nickname and returns updated credential", async () => {
    const req = createRequest("PATCH", ROUTE_URL, { body: { nickname: "My YubiKey" } });
    const { status, json } = await parseResponse(await PATCH(req, CTX));

    expect(status).toBe(200);
    expect(json.nickname).toBe("My YubiKey");
    expect(mockPrismaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cred-1", userId: "user-1" },
        data: { nickname: "My YubiKey" },
      }),
    );
  });

  it("queries credential filtered by id and userId before updating", async () => {
    const req = createRequest("PATCH", ROUTE_URL, { body: { nickname: "Key" } });
    await PATCH(req, CTX);

    expect(mockPrismaFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cred-1", userId: "user-1" },
      }),
    );
  });
});
