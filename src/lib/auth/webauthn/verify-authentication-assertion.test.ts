/**
 * Direct unit tests for verifyAuthenticationAssertion — the security-critical
 * helper that backs both sign-in (`/api/webauthn/authenticate/verify`) and PRF
 * re-bootstrap (`/api/webauthn/credentials/[id]/prf`).
 *
 * Consumer-route tests cover the helper indirectly, but the helper's
 * invariants (challenge consumption, counter CAS rollback safety, namespace
 * separation acceptance) are documented requirements that deserve direct
 * coverage so a future refactor cannot regress them through one consumer
 * while leaving the other passing (#433 / C5).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";

const { mockGetRedis, mockRedisGetdel, mockVerifyAuthLib } = vi.hoisted(() => ({
  mockGetRedis: vi.fn(),
  mockRedisGetdel: vi.fn(),
  mockVerifyAuthLib: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: mockVerifyAuthLib,
  };
});

import { verifyAuthenticationAssertion } from "./webauthn-server";

const ORIGINAL_RP_ID = process.env.WEBAUTHN_RP_ID;
const ORIGINAL_RP_ORIGIN = process.env.WEBAUTHN_RP_ORIGIN;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEBAUTHN_RP_ID = "localhost";
  process.env.WEBAUTHN_RP_ORIGIN = "http://localhost:3000";
  mockGetRedis.mockReturnValue({ getdel: mockRedisGetdel });
  mockRedisGetdel.mockResolvedValue("stored-challenge");
  mockVerifyAuthLib.mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 5 },
  });
});

afterAll(() => {
  if (ORIGINAL_RP_ID === undefined) delete process.env.WEBAUTHN_RP_ID;
  else process.env.WEBAUTHN_RP_ID = ORIGINAL_RP_ID;
  if (ORIGINAL_RP_ORIGIN === undefined) delete process.env.WEBAUTHN_RP_ORIGIN;
  else process.env.WEBAUTHN_RP_ORIGIN = ORIGINAL_RP_ORIGIN;
});

const validAssertion = {
  id: "credential-id-base64url",
  rawId: "credential-id-base64url",
  type: "public-key",
  response: {
    clientDataJSON: "fake",
    authenticatorData: "fake",
    signature: "fake",
  },
} as unknown as AuthenticationResponseJSON;

const storedCredential = {
  id: "cred-row-1",
  credentialId: "credential-id-base64url",
  publicKey: "AQID",
  counter: BigInt(4),
  transports: ["internal"],
  prfEncryptedSecretKey: null,
  prfSecretKeyIv: null,
  prfSecretKeyAuthTag: null,
};

function makeTxStub(overrides: Partial<{
  findFirstResult: typeof storedCredential | null;
  executeRawResult: number;
  executeRawSpy: ReturnType<typeof vi.fn>;
}> = {}) {
  // `in` check (NOT `??`) so an explicit `findFirstResult: null` is honored;
  // null is the "credential not found" path which `??` would silently swap
  // back to the default `storedCredential`.
  const credentialResult =
    "findFirstResult" in overrides ? overrides.findFirstResult : storedCredential;
  const findFirst = vi.fn().mockResolvedValue(credentialResult);
  const $executeRaw =
    overrides.executeRawSpy ?? vi.fn().mockResolvedValue(overrides.executeRawResult ?? 1);
  return {
    tx: {
      webAuthnCredential: { findFirst },
      $executeRaw,
    },
    findFirst,
    $executeRaw,
  };
}

describe("verifyAuthenticationAssertion", () => {
  it("returns 503 when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValue(null);
    const { tx } = makeTxStub();
    const result = await verifyAuthenticationAssertion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      "user-1",
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.code).toBe("SERVICE_UNAVAILABLE");
    }
  });

  it("returns 400 when challenge is expired or already consumed", async () => {
    mockRedisGetdel.mockResolvedValue(null);
    const { tx } = makeTxStub();
    const result = await verifyAuthenticationAssertion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      "user-1",
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.details).toContain("Challenge expired");
    }
  });

  it("consumes the challenge from the SUPPLIED key (proves namespace flexibility)", async () => {
    // Critical: consumer routes pass per-flow keys (sign-in vs PRF rebootstrap).
    // The helper MUST consume only the supplied key, never a hard-coded one.
    const { tx } = makeTxStub();
    await verifyAuthenticationAssertion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      "user-1",
      validAssertion,
      "webauthn:challenge:prf-rebootstrap:user-1",
    );
    expect(mockRedisGetdel).toHaveBeenCalledWith("webauthn:challenge:prf-rebootstrap:user-1");
    expect(mockRedisGetdel).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when WEBAUTHN_RP_ID is not configured", async () => {
    delete process.env.WEBAUTHN_RP_ID;
    const { tx } = makeTxStub();
    const result = await verifyAuthenticationAssertion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      "user-1",
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it("returns 400 when assertion lacks credential ID", async () => {
    const { tx } = makeTxStub();
    const result = await verifyAuthenticationAssertion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      "user-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...validAssertion, id: undefined } as any,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.details).toContain("Missing credential ID");
    }
  });

  it("returns 404 when the credential does not exist for the user", async () => {
    const { tx } = makeTxStub({ findFirstResult: null });
    const result = await verifyAuthenticationAssertion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      "user-1",
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.code).toBe("NOT_FOUND");
    }
  });

  it("looks up credential scoped to the supplied userId", async () => {
    const { tx, findFirst } = makeTxStub();
    await verifyAuthenticationAssertion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      "user-42",
      validAssertion,
      "webauthn:challenge:test:user-42",
    );
    // Critical for tenant isolation — a missing userId scope on this query
    // would let a user assert another user's credential id.
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: "user-42", credentialId: "credential-id-base64url" },
    });
  });

  it("returns 400 when @simplewebauthn/server reports verification failure", async () => {
    mockVerifyAuthLib.mockResolvedValue({ verified: false });
    const { tx } = makeTxStub();
    const result = await verifyAuthenticationAssertion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      "user-1",
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("returns 400 when @simplewebauthn/server throws", async () => {
    mockVerifyAuthLib.mockRejectedValue(new Error("invalid signature"));
    const { tx } = makeTxStub();
    const result = await verifyAuthenticationAssertion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      "user-1",
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("runs counter CAS on the SUPPLIED tx (not on the global prisma client) — #433/S-N4", async () => {
    // The replay-safety property: when the helper's caller wraps its work in
    // a transaction (e.g., the PRF rebootstrap endpoint inside its keyVersion
    // CAS), the counter UPDATE MUST be on the same tx so it rolls back
    // atomically if a subsequent step fails. If the helper accidentally ran
    // the UPDATE on `prisma.$executeRaw`, a captured assertion replayed
    // against the new endpoint could commit the counter advance even when
    // the keyVersion CAS rejects, breaking replay defense.
    const { tx, $executeRaw } = makeTxStub();
    await verifyAuthenticationAssertion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      "user-1",
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect($executeRaw).toHaveBeenCalledTimes(1);
    // The first arg is the tagged template's strings array; subsequent args
    // are the interpolated values. The new counter (BigInt(5)) must be the
    // first interpolated value.
    const firstCall = $executeRaw.mock.calls[0];
    expect(firstCall[1]).toBe(BigInt(5));
  });

  it("returns 400 when counter CAS UPDATE matches 0 rows (clone / replay attempt)", async () => {
    const { tx } = makeTxStub({ executeRawResult: 0 });
    const result = await verifyAuthenticationAssertion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      "user-1",
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.details).toContain("Counter mismatch");
    }
  });

  it("returns ok + credentialId + storedPrf on success", async () => {
    const credentialWithPrf = {
      ...storedCredential,
      prfEncryptedSecretKey: "wrapping-cipher",
      prfSecretKeyIv: "iv-hex",
      prfSecretKeyAuthTag: "tag-hex",
    };
    const { tx } = makeTxStub({ findFirstResult: credentialWithPrf });
    const result = await verifyAuthenticationAssertion(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      "user-1",
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentialId).toBe("credential-id-base64url");
      expect(result.storedPrf).toEqual({
        encryptedSecretKey: "wrapping-cipher",
        iv: "iv-hex",
        authTag: "tag-hex",
      });
    }
  });
});
