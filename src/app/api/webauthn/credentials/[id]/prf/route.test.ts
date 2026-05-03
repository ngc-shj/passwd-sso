import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRateLimiterCheck,
  mockPrismaCredentialFindFirst,
  mockTransaction,
  mockTxExecuteRaw,
  mockTxUserFindUnique,
  mockTxCredentialUpdate,
  mockWithUserTenantRls,
  mockVerifyAuthenticationAssertion,
  mockLogAuditAsync,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockPrismaCredentialFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxExecuteRaw: vi.fn(),
  mockTxUserFindUnique: vi.fn(),
  mockTxCredentialUpdate: vi.fn(),
  mockWithUserTenantRls: vi.fn(),
  mockVerifyAuthenticationAssertion: vi.fn(),
  mockLogAuditAsync: vi.fn(),
}));

const txMock = {
  $executeRaw: mockTxExecuteRaw,
  user: { findUnique: mockTxUserFindUnique },
  webAuthnCredential: { update: mockTxCredentialUpdate },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    webAuthnCredential: { findFirst: mockPrismaCredentialFindFirst },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/auth/webauthn/webauthn-server", () => ({
  verifyAuthenticationAssertion: mockVerifyAuthenticationAssertion,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

import { POST } from "./route";

const URL = "http://localhost:3000/api/webauthn/credentials/cred-row-1/prf";
const params = { params: Promise.resolve({ id: "cred-row-1" }) };

const validBody = {
  assertionResponse: { id: "credential-id-base64url", rawId: "credential-id-base64url", type: "public-key", response: {} },
  prfEncryptedSecretKey: "0".repeat(64),
  prfSecretKeyIv: "a".repeat(24),
  prfSecretKeyAuthTag: "b".repeat(32),
  keyVersion: 5,
};

describe("POST /api/webauthn/credentials/[id]/prf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockPrismaCredentialFindFirst.mockResolvedValue({
      credentialId: "credential-id-base64url",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockWithUserTenantRls.mockImplementation(async (_uid: string, fn: any) => fn());
    mockTransaction.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
    );
    mockTxExecuteRaw.mockResolvedValue(undefined);
    mockTxUserFindUnique.mockResolvedValue({ keyVersion: 5 });
    mockTxCredentialUpdate.mockResolvedValue({});
    mockVerifyAuthenticationAssertion.mockResolvedValue({
      ok: true,
      credentialId: "credential-id-base64url",
      storedPrf: { encryptedSecretKey: null, iv: null, authTag: null },
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, { body: validBody }), params);
    expect(res.status).toBe(401);
    expect(mockVerifyAuthenticationAssertion).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await POST(createRequest("POST", URL, { body: validBody }), params);
    expect(res.status).toBe(429);
    expect(mockVerifyAuthenticationAssertion).not.toHaveBeenCalled();
  });

  it("returns 404 when credential is not owned by the user (existence-leak symmetric with DELETE)", async () => {
    mockPrismaCredentialFindFirst.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, { body: validBody }), params);
    expect(res.status).toBe(404);
  });

  it("returns 400 when assertion verification fails", async () => {
    mockVerifyAuthenticationAssertion.mockResolvedValue({
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      details: "Authentication verification failed",
    });
    const res = await POST(createRequest("POST", URL, { body: validBody }), params);
    expect(res.status).toBe(400);
    // Adversarial signal — failed assertion is audited so a rebootstrap-storm
    // post-rotation surfaces in security logs (#433/S-N5 partial).
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBAUTHN_PRF_REBOOTSTRAP",
        metadata: expect.objectContaining({ result: "assertion_failed" }),
      }),
    );
  });

  it("returns 403 when asserted credentialId differs from URL [id]'s credential", async () => {
    // Owned credential is "cred-A", but the assertion was for "cred-B".
    mockPrismaCredentialFindFirst.mockResolvedValue({ credentialId: "cred-A" });
    mockVerifyAuthenticationAssertion.mockResolvedValue({
      ok: true,
      credentialId: "cred-B",
      storedPrf: { encryptedSecretKey: null, iv: null, authTag: null },
    });
    const res = await POST(createRequest("POST", URL, { body: validBody }), params);
    expect(res.status).toBe(403);
    expect(mockTxCredentialUpdate).not.toHaveBeenCalled();
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ result: "wrong_credential" }),
      }),
    );
  });

  it("returns 409 + currentKeyVersion when keyVersion CAS mismatches (#433/S4)", async () => {
    // Body says keyVersion=5 but server has 7 (concurrent rotation moved it).
    mockTxUserFindUnique.mockResolvedValue({ keyVersion: 7 });
    const res = await POST(createRequest("POST", URL, { body: validBody }), params);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.currentKeyVersion).toBe(7);
    expect(mockTxCredentialUpdate).not.toHaveBeenCalled();
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          result: "stale_keyversion",
          keyVersionAtBind: 5,
          currentKeyVersion: 7,
        }),
      }),
    );
  });

  it("returns 200 + writes new wrapping (without touching prfSupported per #433/F8)", async () => {
    const res = await POST(createRequest("POST", URL, { body: validBody }), params);
    expect(res.status).toBe(200);
    expect(mockTxCredentialUpdate).toHaveBeenCalledWith({
      where: { id: "cred-row-1" },
      data: {
        prfEncryptedSecretKey: validBody.prfEncryptedSecretKey,
        prfSecretKeyIv: validBody.prfSecretKeyIv,
        prfSecretKeyAuthTag: validBody.prfSecretKeyAuthTag,
        // Crucial: prfSupported is NOT in the data payload — it represents the
        // authenticator's PRF capability, not wrapping presence (#433/F8).
      },
    });
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBAUTHN_PRF_REBOOTSTRAP",
        metadata: expect.objectContaining({
          result: "success",
          keyVersionAtBind: 5,
        }),
      }),
    );
  });

  it("calls verifyAuthenticationAssertion with the DEDICATED PRF challenge key (#433/S-N1)", async () => {
    await POST(createRequest("POST", URL, { body: validBody }), params);
    expect(mockVerifyAuthenticationAssertion).toHaveBeenCalledWith(
      txMock, // tx, NOT prisma — counter CAS rolls back with this tx
      "user-1",
      validBody.assertionResponse,
      "webauthn:challenge:prf-rebootstrap:user-1",
      null, // no user-agent in test request
    );
  });

  it("acquires the user advisory lock before any work (#433/S4)", async () => {
    await POST(createRequest("POST", URL, { body: validBody }), params);
    // pg_advisory_xact_lock is the FIRST tx-bound call so it serializes against
    // a concurrent rotation acquiring the same lock.
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1);
  });
});
