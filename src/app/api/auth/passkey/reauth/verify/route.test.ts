import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockAssertOrigin,
  mockRateLimiterCheck,
  mockCreateRateLimiter,
  mockVerifyAssertionForCredential,
  mockSessionFindUnique,
  mockSessionUpdate,
  mockCredentialFindFirst,
  mockPrismaTransaction,
  mockWithBypassRls,
  mockLogAudit,
} = vi.hoisted(() => {
  const mockRateLimiterCheck = vi.fn();
  return {
    mockAuth: vi.fn(),
    mockAssertOrigin: vi.fn(),
    mockRateLimiterCheck,
    // T4: recording factory so tests can attribute the limiter instance
    // back to the failClosedOnRedisError option it was constructed with.
    mockCreateRateLimiter: vi.fn(() => ({ check: mockRateLimiterCheck, clear: vi.fn() })),
    mockVerifyAssertionForCredential: vi.fn(),
    mockSessionFindUnique: vi.fn(),
    mockSessionUpdate: vi.fn(),
    mockCredentialFindFirst: vi.fn(),
    mockPrismaTransaction: vi.fn(),
    mockWithBypassRls: vi.fn(),
    mockLogAudit: vi.fn(),
  };
});

vi.mock("@/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/auth/session/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));

vi.mock("@/lib/auth/webauthn/webauthn-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/webauthn/webauthn-server")>()),
  verifyAssertionForCredential: mockVerifyAssertionForCredential,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: null,
    userAgent: null,
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockPrismaTransaction,
    // The session mutation now runs directly on the withBypassRls callback's
    // tx (redundant inner $transaction removed), so the outer tx (this prisma
    // mock passed through by mockWithBypassRls) must carry session.findUnique
    // / session.update / webAuthnCredential.findFirst (C4 steps 1 and 6).
    session: { findUnique: mockSessionFindUnique, update: mockSessionUpdate },
    webAuthnCredential: { findFirst: mockCredentialFindFirst },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: unknown) => fn,
}));
// H4: getSessionTokenDigest hashes the cookie token; deterministic hash so the
// where-clause assertion is predictable.
vi.mock("@/lib/auth/session/session-cache", () => ({
  hashSessionToken: (token: string) => `hashed:${token}`,
}));

import { POST } from "./route";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const ROUTE_URL = "http://localhost:3000/api/auth/passkey/reauth/verify";

// The route constructs its rate limiter once at module load
// (`const rateLimiter = createRateLimiter({...})`). `beforeEach` clears all
// mocks each test, wiping `mockCreateRateLimiter.mock.calls`/`.mock.results`
// — snapshotFactory captures the real construction call/result here (module
// scope, before any beforeEach runs) so `.replay()` can rebuild it after
// each clear for the fail-closed helper's identity-based attribution.
const rateLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const rateLimiterInstance = mockCreateRateLimiter.mock.results[0]?.value as
  | { check: typeof mockRateLimiterCheck }
  | undefined;
if (!rateLimiterInstance) {
  throw new Error(
    "route.test.ts: expected createRateLimiter to have been called once at module load",
  );
}

function makeVerifyRequest(credentialResponseId = "cred-1") {
  return createRequest("POST", ROUTE_URL, {
    headers: {
      origin: "http://localhost:3000",
      cookie: "authjs.session-token=sess-1",
      "Content-Type": "application/json",
    },
    body: {
      credentialResponse: JSON.stringify({ id: credentialResponseId, type: "public-key" }),
      challengeId: "a".repeat(32),
    },
  });
}

describe("POST /api/auth/passkey/reauth/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockAssertOrigin.mockReturnValue(null);
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    // ALLOW-path fixture: a session bound to the credential the request
    // presents, so tests reach the verifier they exist to exercise.
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      authCredentialId: "cred-row-1",
      authCredential: { credentialId: "cred-1", userId: "user-1" },
    });
    mockVerifyAssertionForCredential.mockResolvedValue({
      ok: true,
      credentialId: "cred-1",
      storedPrf: {
        encryptedSecretKey: null,
        iv: null,
        authTag: null,
      },
    });
    mockWithBypassRls.mockImplementation(
      (prisma: unknown, fn: (tx: unknown) => unknown, _purpose: string) => fn(prisma),
    );
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn({
        session: { update: mockSessionUpdate },
      }),
    );
    mockSessionUpdate.mockResolvedValue({});
  });

  it("updates passkey freshness on the current session", async () => {
    const res = await POST(makeVerifyRequest());

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.verifiedAt).toEqual(expect.any(String));
    expect(mockVerifyAssertionForCredential).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "cred-row-1",
      expect.objectContaining({ id: "cred-1" }),
      "webauthn:challenge:reauth:user-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(mockSessionUpdate).toHaveBeenCalledWith({
      where: { sessionToken: "hashed:sess-1" },
      data: { passkeyVerifiedAt: expect.any(Date) },
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUTH_PASSKEY_REAUTH",
        metadata: expect.objectContaining({
          credentialId: "cred-1",
        }),
      }),
    );
    // Allow side: zero denial audit rows (assert the count, or an added
    // emission is invisible).
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
  });

  it("returns 401 when the request has no authenticated session", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await POST(makeVerifyRequest());

    expect(res.status).toBe(401);
    expect(mockSessionUpdate).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 401 when the session cookie is absent (no sessionToken)", async () => {
    const res = await POST(
      createRequest("POST", ROUTE_URL, {
        headers: {
          origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: {
          credentialResponse: JSON.stringify({ id: "cred-1", type: "public-key" }),
          challengeId: "a".repeat(32),
        },
      }),
    );

    expect(res.status).toBe(401);
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it("returns 401 when the cookie is valid but the session row is missing (DB miss)", async () => {
    mockSessionFindUnique.mockResolvedValue(null);

    const res = await POST(makeVerifyRequest());

    expect(res.status).toBe(401);
    expect(mockVerifyAssertionForCredential).not.toHaveBeenCalled();
    expect(mockSessionUpdate).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limiter denies the request", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 60_000 });

    const res = await POST(makeVerifyRequest());

    expect(res.status).toBe(429);
    expect(mockVerifyAssertionForCredential).not.toHaveBeenCalled();
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    const req = makeVerifyRequest();

    await assertRedisFailClosed({
      invoke: () => POST(req),
      limiter: rateLimiterInstance,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockSessionUpdate],
      limiterFactory: rateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  // ── C4: the binding gate (step 3) — refused before the verifier runs ──

  describe("C4 binding gate", () => {
    it("denies a non-webauthn session with PASSKEY_REAUTH_UNAVAILABLE, verifier not called", async () => {
      mockSessionFindUnique.mockResolvedValue({
        provider: "nodemailer",
        authCredentialId: null,
        authCredential: null,
      });

      const res = await POST(makeVerifyRequest());

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "PASSKEY_REAUTH_UNAVAILABLE" });
      expect(mockVerifyAssertionForCredential).not.toHaveBeenCalled();
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTH_PASSKEY_REAUTH_UNAVAILABLE",
          metadata: expect.objectContaining({ reason: "provider" }),
        }),
      );
    });

    it("denies an unbound webauthn session, verifier not called (Redis challenge left unconsumed)", async () => {
      mockSessionFindUnique.mockResolvedValue({
        provider: "webauthn",
        authCredentialId: null,
        authCredential: null,
      });

      const res = await POST(makeVerifyRequest());

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "PASSKEY_REAUTH_UNAVAILABLE" });
      // I9b: the verifier owns redis.getdel — not calling it is what leaves
      // the challenge unconsumed. This layer cannot see Redis directly (the
      // module is mocked wholesale), so "not called" is the observable proxy.
      expect(mockVerifyAssertionForCredential).not.toHaveBeenCalled();
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTH_PASSKEY_REAUTH_UNAVAILABLE",
          metadata: expect.objectContaining({ reason: "no_binding" }),
        }),
      );
    });

    it("denies a binding that resolves to another user's credential, and records no id for it", async () => {
      // The FK guarantees only that the row exists — referential integrity
      // spans no user predicate — so a corrupt binding is not excluded by the
      // schema. Without the userId check the relation read would put the other
      // user's credentialId into this user's audit metadata.
      mockSessionFindUnique.mockResolvedValue({
        provider: "webauthn",
        authCredentialId: "cred-row-other",
        authCredential: { credentialId: "cred-belonging-to-user-2", userId: "user-2" },
      });

      const res = await POST(makeVerifyRequest());

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "PASSKEY_REAUTH_UNAVAILABLE" });
      expect(mockVerifyAssertionForCredential).not.toHaveBeenCalled();
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTH_PASSKEY_REAUTH_UNAVAILABLE",
          metadata: expect.objectContaining({
            reason: "no_binding",
            boundCredentialId: null,
          }),
        }),
      );
      // The whole point: the other user's identifier must not appear anywhere.
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain("cred-belonging-to-user-2");
    });
  });

  // ── C4 step 6: denial classification on the verifier's structured reason ──

  describe("C4 denial classification", () => {
    it("credential_not_found + bound row GONE -> PASSKEY_REAUTH_UNAVAILABLE / credential_missing", async () => {
      mockVerifyAssertionForCredential.mockResolvedValue({
        ok: false,
        status: 404,
        code: "NOT_FOUND",
        reason: "credential_not_found",
        details: "Credential not found",
      });
      mockCredentialFindFirst.mockResolvedValue(null);

      const res = await POST(makeVerifyRequest("cred-other"));

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "PASSKEY_REAUTH_UNAVAILABLE" });
      expect(mockCredentialFindFirst).toHaveBeenCalledWith({
        where: { id: "cred-row-1", userId: "user-1" },
        select: { id: true },
      });
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTH_PASSKEY_REAUTH_UNAVAILABLE",
          metadata: expect.objectContaining({ reason: "credential_missing", boundCredentialId: "cred-1" }),
        }),
      );
    });

    it("credential_not_found + bound row PRESENT -> PASSKEY_REAUTH_CREDENTIAL_MISMATCH / presented_credential", async () => {
      mockVerifyAssertionForCredential.mockResolvedValue({
        ok: false,
        status: 404,
        code: "NOT_FOUND",
        reason: "credential_not_found",
        details: "Credential not found",
      });
      mockCredentialFindFirst.mockResolvedValue({ id: "cred-row-1" });

      const res = await POST(makeVerifyRequest("cred-other"));

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "PASSKEY_REAUTH_CREDENTIAL_MISMATCH" });
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH",
          metadata: expect.objectContaining({
            reason: "presented_credential",
            boundCredentialId: "cred-1",
            presentedCredentialId: "cred-other",
          }),
        }),
      );
    });

    it("signature_invalid -> unchanged 400 VALIDATION_ERROR, no existence re-check", async () => {
      mockVerifyAssertionForCredential.mockResolvedValue({
        ok: false,
        status: 400,
        code: "VALIDATION_ERROR",
        reason: "signature_invalid",
        details: "Authentication verification failed",
      });

      const res = await POST(makeVerifyRequest("cred-1"));

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "VALIDATION_ERROR",
        details: "Authentication verification failed",
      });
      // The re-check runs only for credential_not_found / counter_mismatch.
      expect(mockCredentialFindFirst).not.toHaveBeenCalled();
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH",
          metadata: expect.objectContaining({
            reason: "signature_invalid",
            boundCredentialId: "cred-1",
            presentedCredentialId: "cred-1",
          }),
        }),
      );
    });

    it("counter_mismatch + bound row GONE -> PASSKEY_REAUTH_UNAVAILABLE / credential_missing", async () => {
      mockVerifyAssertionForCredential.mockResolvedValue({
        ok: false,
        status: 400,
        code: "VALIDATION_ERROR",
        reason: "counter_mismatch",
        details: "Counter mismatch — credential may be cloned. Re-register your passkey.",
      });
      mockCredentialFindFirst.mockResolvedValue(null);

      const res = await POST(makeVerifyRequest("cred-1"));

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "PASSKEY_REAUTH_UNAVAILABLE" });
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTH_PASSKEY_REAUTH_UNAVAILABLE",
          metadata: expect.objectContaining({ reason: "credential_missing" }),
        }),
      );
    });

    it("counter_mismatch + bound row PRESENT -> unchanged clone-mismatch 400", async () => {
      mockVerifyAssertionForCredential.mockResolvedValue({
        ok: false,
        status: 400,
        code: "VALIDATION_ERROR",
        reason: "counter_mismatch",
        details: "Counter mismatch — credential may be cloned. Re-register your passkey.",
      });
      mockCredentialFindFirst.mockResolvedValue({ id: "cred-row-1" });

      const res = await POST(makeVerifyRequest("cred-1"));

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "VALIDATION_ERROR",
        details: "Counter mismatch — credential may be cloned. Re-register your passkey.",
      });
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH",
          metadata: expect.objectContaining({ reason: "counter_mismatch" }),
        }),
      );
    });

    // The four reasons the verifier itself has no reason to re-classify:
    // forward its own status/code unchanged, no re-check, no audit row.
    it.each([
      { reason: "challenge_missing", status: 400, code: "VALIDATION_ERROR" },
      { reason: "response_credential_id_missing", status: 400, code: "VALIDATION_ERROR" },
      { reason: "redis_unavailable", status: 503, code: "SERVICE_UNAVAILABLE" },
      { reason: "rp_id_unconfigured", status: 503, code: "SERVICE_UNAVAILABLE" },
    ] as const)("passes through $reason unchanged with zero audit rows", async ({ reason, status, code }) => {
      mockVerifyAssertionForCredential.mockResolvedValue({
        ok: false,
        status,
        code,
        reason,
      });

      const res = await POST(makeVerifyRequest());

      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toEqual({ error: code });
      expect(mockCredentialFindFirst).not.toHaveBeenCalled();
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });
  });

  // ── C7: bound/presented credential id metadata bounds ──────────────────

  describe("C7 audit metadata bounds", () => {
    it("truncates an oversized boundCredentialId (600 chars) and marks it, without collapsing the row", async () => {
      const longBoundId = "a".repeat(600);
      mockSessionFindUnique.mockResolvedValue({
        provider: "webauthn",
        authCredentialId: "cred-row-1",
        authCredential: { credentialId: longBoundId, userId: "user-1" },
      });
      mockVerifyAssertionForCredential.mockResolvedValue({
        ok: false,
        status: 404,
        code: "NOT_FOUND",
        reason: "credential_not_found",
        details: "Credential not found",
      });
      mockCredentialFindFirst.mockResolvedValue({ id: "cred-row-1" });

      const res = await POST(makeVerifyRequest("cred-other"));

      expect(res.status).toBe(403);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            boundCredentialId: "a".repeat(512),
            boundCredentialIdTruncated: true,
          }),
        }),
      );
    });

    it("keeps a boundCredentialId of exactly 512 chars whole, with no truncation marker", async () => {
      const exactBoundId = "a".repeat(512);
      mockSessionFindUnique.mockResolvedValue({
        provider: "webauthn",
        authCredentialId: "cred-row-1",
        authCredential: { credentialId: exactBoundId, userId: "user-1" },
      });
      mockVerifyAssertionForCredential.mockResolvedValue({
        ok: false,
        status: 404,
        code: "NOT_FOUND",
        reason: "credential_not_found",
        details: "Credential not found",
      });
      mockCredentialFindFirst.mockResolvedValue({ id: "cred-row-1" });

      await POST(makeVerifyRequest("cred-other"));

      const call = mockLogAudit.mock.calls.find(
        (args) => (args[0] as { action: string }).action === "AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH",
      );
      const metadata = (call?.[0] as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.boundCredentialId).toBe(exactBoundId);
      expect(metadata).not.toHaveProperty("boundCredentialIdTruncated");
    });

    it("rejects a presentedCredentialId over 512 chars: records null + rejected flag, keeps boundCredentialId", async () => {
      const oversizedPresented = "a".repeat(600);
      mockVerifyAssertionForCredential.mockResolvedValue({
        ok: false,
        status: 404,
        code: "NOT_FOUND",
        reason: "credential_not_found",
        details: "Credential not found",
      });
      mockCredentialFindFirst.mockResolvedValue({ id: "cred-row-1" });

      const res = await POST(makeVerifyRequest(oversizedPresented));

      expect(res.status).toBe(403);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            presentedCredentialId: null,
            presentedCredentialIdRejected: true,
            boundCredentialId: "cred-1",
          }),
        }),
      );
    });

    it("rejects a presentedCredentialId with a non-base64url character even under the length bound", async () => {
      mockVerifyAssertionForCredential.mockResolvedValue({
        ok: false,
        status: 404,
        code: "NOT_FOUND",
        reason: "credential_not_found",
        details: "Credential not found",
      });
      mockCredentialFindFirst.mockResolvedValue({ id: "cred-row-1" });

      const res = await POST(makeVerifyRequest('has"quote'));

      expect(res.status).toBe(403);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            presentedCredentialId: null,
            presentedCredentialIdRejected: true,
          }),
        }),
      );
    });
  });
});
