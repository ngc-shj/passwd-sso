import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { verifyAuthentication } from "./webauthn-server";

type VerifiedAuth = Awaited<ReturnType<typeof verifyAuthentication>>;

// ── Hoisted mocks ────────────────────────────────────────────

// T6 (Round-1 plan): mock typed against verifyAuthentication's real signature.
// Structural drift between v11+'s VerifiedAuthenticationResponse and a partial
// mock return value becomes a compile-time error rather than a silent
// vacuous-pass test.
const {
  mockGetRedis,
  mockRedisGetDel,
  mockPrismaFindFirst,
  mockPrismaExecuteRaw,
  mockVerifyAuthentication,
  mockGetRpOrigin,
  mockBase64urlToUint8Array,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockGetRedis: vi.fn(),
  mockRedisGetDel: vi.fn(),
  mockPrismaFindFirst: vi.fn(),
  mockPrismaExecuteRaw: vi.fn(),
  mockVerifyAuthentication: vi.fn() as Mock<typeof verifyAuthentication>,
  mockGetRpOrigin: vi.fn(),
  mockBase64urlToUint8Array: vi.fn(),
  mockWithBypassRls: vi.fn(),
}));

// Helper: build a complete VerifiedAuthenticationResponse for mocks. See the
// matching helper in verify-authentication-assertion.test.ts.
function makeVerifiedAuth(
  overrides: { verified?: boolean; info?: Partial<VerifiedAuth["authenticationInfo"]> } = {},
): VerifiedAuth {
  return {
    verified: overrides.verified ?? true,
    authenticationInfo: {
      credentialID: "mock-credential-id",
      newCounter: 6,
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: false,
      origin: "http://localhost:3000",
      rpID: "localhost",
      ...overrides.info,
    },
  };
}

vi.mock("@/lib/redis", () => ({
  getRedis: mockGetRedis,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    webAuthnCredential: { findFirst: mockPrismaFindFirst },
    $executeRaw: mockPrismaExecuteRaw,
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/auth/webauthn/webauthn-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/webauthn/webauthn-server")>()),
  verifyAuthentication: mockVerifyAuthentication,
  getRpOrigin: mockGetRpOrigin,
  base64urlToUint8Array: mockBase64urlToUint8Array,
}));

import { authorizeWebAuthn } from "./webauthn-authorize";

// ── Test data ────────────────────────────────────────────────

const VALID_CHALLENGE_ID = "a".repeat(32);
const STORED_CHALLENGE = "randomChallenge123";
const CREDENTIAL_ID = "dGVzdC1jcmVkZW50aWFs"; // base64url

const mockStoredCredential = {
  id: "cred-uuid-1",
  credentialId: CREDENTIAL_ID,
  publicKey: "dGVzdC1wdWJsaWMta2V5",
  counter: BigInt(5),
  transports: ["internal"],
  prfSupported: false,
  prfEncryptedSecretKey: null,
  prfSecretKeyIv: null,
  prfSecretKeyAuthTag: null,
  user: { id: "user-1", email: "test@example.com", name: "Test User" },
};

const mockStoredCredentialWithPrf = {
  ...mockStoredCredential,
  prfSupported: true,
  prfEncryptedSecretKey: "encrypted-key-hex",
  prfSecretKeyIv: "iv-hex",
  prfSecretKeyAuthTag: "auth-tag-hex",
};

const validCredentials = {
  credentialResponse: JSON.stringify({
    id: CREDENTIAL_ID,
    rawId: CREDENTIAL_ID,
    type: "public-key",
    response: {
      clientDataJSON: "Y2xpZW50RGF0YQ",
      authenticatorData: "YXV0aERhdGE",
      signature: "c2lnbmF0dXJl",
    },
  }),
  challengeId: VALID_CHALLENGE_ID,
};

// ── Setup ────────────────────────────────────────────────────

describe("authorizeWebAuthn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WEBAUTHN_RP_ID", "localhost");

    mockGetRedis.mockReturnValue({ getdel: mockRedisGetDel });
    mockRedisGetDel.mockResolvedValue(STORED_CHALLENGE);
    mockGetRpOrigin.mockReturnValue("http://localhost:3000");
    mockBase64urlToUint8Array.mockReturnValue(new Uint8Array(32));

    // Default: withBypassRls calls the callback directly
    mockWithBypassRls.mockImplementation(
      (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma),
    );

    mockPrismaFindFirst.mockResolvedValue(mockStoredCredential);
    mockPrismaExecuteRaw.mockResolvedValue(1);

    mockVerifyAuthentication.mockResolvedValue(makeVerifiedAuth());
  });

  it("returns user on successful verification", async () => {
    const result = await authorizeWebAuthn(validCredentials);
    expect(result).toEqual({
      id: "user-1",
      email: "test@example.com",
      name: "Test User",
    });
    // T4 (v11 shape regression guard): verify the WebAuthnCredential
    // passed to verifyAuthentication has v11 shape — string `id` (base64url),
    // Uint8Array `publicKey`, numeric `counter`. The v9 shape used `credentialID`
    // (Uint8Array) and `credentialPublicKey` — those names must NOT appear.
    expect(mockVerifyAuthentication).toHaveBeenCalledWith(
      expect.anything(), // response
      expect.anything(), // challenge
      expect.anything(), // rpId
      expect.anything(), // origin
      expect.objectContaining({
        id: expect.any(String),
        publicKey: expect.any(Uint8Array),
        counter: expect.any(Number),
      }),
    );
  });

  it("returns null when credentialResponse is missing", async () => {
    const result = await authorizeWebAuthn({ challengeId: VALID_CHALLENGE_ID });
    expect(result).toBeNull();
  });

  it("returns null when challengeId is missing", async () => {
    const result = await authorizeWebAuthn({
      credentialResponse: validCredentials.credentialResponse,
    });
    expect(result).toBeNull();
  });

  it("returns null when challengeId format is invalid (not 32-char hex)", async () => {
    const result = await authorizeWebAuthn({
      ...validCredentials,
      challengeId: "invalid-challenge-id!",
    });
    expect(result).toBeNull();
    // Redis should NOT be called
    expect(mockRedisGetDel).not.toHaveBeenCalled();
  });

  it("returns null when challengeId is too short", async () => {
    const result = await authorizeWebAuthn({
      ...validCredentials,
      challengeId: "abcd",
    });
    expect(result).toBeNull();
  });

  it("returns null when challengeId has uppercase (not lowercase hex)", async () => {
    const result = await authorizeWebAuthn({
      ...validCredentials,
      challengeId: "A".repeat(32),
    });
    expect(result).toBeNull();
  });

  it("returns null when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValue(null);
    const result = await authorizeWebAuthn(validCredentials);
    expect(result).toBeNull();
  });

  it("returns null when challenge not found in Redis", async () => {
    mockRedisGetDel.mockResolvedValue(null);
    const result = await authorizeWebAuthn(validCredentials);
    expect(result).toBeNull();
  });

  it("returns null when credentialResponse is invalid JSON", async () => {
    const result = await authorizeWebAuthn({
      ...validCredentials,
      credentialResponse: "not-json",
    });
    expect(result).toBeNull();
  });

  it("returns null when response has no id field", async () => {
    const result = await authorizeWebAuthn({
      ...validCredentials,
      credentialResponse: JSON.stringify({ type: "public-key" }),
    });
    expect(result).toBeNull();
  });

  it("returns null when credential not found and verification fails (timing equalization)", async () => {
    mockPrismaFindFirst.mockResolvedValue(null);
    mockVerifyAuthentication.mockRejectedValue(new Error("Invalid"));
    const result = await authorizeWebAuthn(validCredentials);
    expect(result).toBeNull();
    // T4 + C5 (v11 dummy-credential shape regression guard): the dummy branch
    // must build a WebAuthnCredential-shaped object so verifyAuthentication
    // runs the same CBOR-decode + ECDSA-verify path as the real branch. Without
    // this assertion, a refactor that ships a malformed dummy could create a
    // credential-enumeration timing oracle.
    expect(mockVerifyAuthentication).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        id: expect.any(String),
        publicKey: expect.any(Uint8Array),
        counter: 0,
      }),
    );
  });

  it("returns null when verification fails", async () => {
    mockVerifyAuthentication.mockResolvedValue(
      makeVerifiedAuth({ verified: false, info: { newCounter: 5 } }),
    );
    const result = await authorizeWebAuthn(validCredentials);
    expect(result).toBeNull();
  });

  it("returns null when verification throws", async () => {
    mockVerifyAuthentication.mockRejectedValue(new Error("Verification error"));
    const result = await authorizeWebAuthn(validCredentials);
    expect(result).toBeNull();
  });

  it("returns null when CAS counter update affects 0 rows", async () => {
    mockPrismaExecuteRaw.mockResolvedValue(0);
    const result = await authorizeWebAuthn(validCredentials);
    expect(result).toBeNull();
  });

  it("returns null when WEBAUTHN_RP_ID is not set", async () => {
    delete process.env.WEBAUTHN_RP_ID;
    const result = await authorizeWebAuthn(validCredentials);
    expect(result).toBeNull();
  });

  it("consumes challenge atomically via getDel", async () => {
    await authorizeWebAuthn(validCredentials);
    expect(mockRedisGetDel).toHaveBeenCalledWith(
      `webauthn:challenge:signin:${VALID_CHALLENGE_ID}`,
    );
  });

  it("uses withBypassRls for cross-tenant credential lookup", async () => {
    await authorizeWebAuthn(validCredentials);
    expect(mockWithBypassRls).toHaveBeenCalled();
  });

  it("returns null when user.email is null", async () => {
    mockPrismaFindFirst.mockResolvedValue({
      ...mockStoredCredential,
      user: { id: "user-1", email: null, name: "Test User" },
    });
    const result = await authorizeWebAuthn(validCredentials);
    expect(result).toBeNull();
  });

  it("returns null name when user.name is null", async () => {
    mockPrismaFindFirst.mockResolvedValue({
      ...mockStoredCredential,
      user: { id: "user-1", email: "test@example.com", name: null },
    });
    const result = await authorizeWebAuthn(validCredentials);
    expect(result).toEqual({
      id: "user-1",
      email: "test@example.com",
      name: null,
    });
  });

  it("returns PRF data when credential supports PRF", async () => {
    mockPrismaFindFirst.mockResolvedValue(mockStoredCredentialWithPrf);
    const result = await authorizeWebAuthn(validCredentials);
    expect(result).toEqual({
      id: "user-1",
      email: "test@example.com",
      name: "Test User",
      prf: {
        prfEncryptedSecretKey: "encrypted-key-hex",
        prfSecretKeyIv: "iv-hex",
        prfSecretKeyAuthTag: "auth-tag-hex",
      },
    });
  });

  it("omits PRF data when credential does not support PRF", async () => {
    const result = await authorizeWebAuthn(validCredentials);
    expect(result).toBeDefined();
    expect(result!.prf).toBeUndefined();
  });
});
