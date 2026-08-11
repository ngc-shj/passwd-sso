/**
 * Direct unit tests for verifyAssertionForCredential / verifyAssertionAnyCredential
 * — the security-critical shared body that backs both sign-in
 * (`/api/webauthn/authenticate/verify`) and PRF re-bootstrap
 * (`/api/webauthn/credentials/[id]/prf`), both via verifyAssertionAnyCredential,
 * plus the step-up reauth ceremony via verifyAssertionForCredential.
 *
 * Consumer-route tests cover the helper indirectly, but the helper's
 * invariants (challenge consumption, counter CAS rollback safety, namespace
 * separation acceptance, credential-row scoping) are documented requirements
 * that deserve direct coverage so a future refactor cannot regress them
 * through one consumer while leaving the others passing (#433 / C5;
 * bind-stepup-to-session-credential plan / C4).
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { verifyAuthenticationResponse } from "@simplewebauthn/server";

type VerifiedAuth = Awaited<ReturnType<typeof verifyAuthenticationResponse>>;

// T6 (Round-1 plan): mock typed against the real lib signature so a future
// @simplewebauthn major bump that changes VerifiedAuthenticationResponse's
// shape (e.g., field renamed, new required field) becomes a compile-time
// error rather than a silent vacuous-pass test. Without the type binding,
// `.mockResolvedValue({ verified, authenticationInfo: { newCounter } })`
// would compile even if the real type adds required fields.
const { mockGetRedis, mockRedisGetdel, mockVerifyAuthLib } = vi.hoisted(() => ({
  mockGetRedis: vi.fn(),
  mockRedisGetdel: vi.fn(),
  mockVerifyAuthLib: vi.fn() as Mock<typeof verifyAuthenticationResponse>,
}));

// Helper: build a complete VerifiedAuthenticationResponse with sensible
// defaults so individual tests can override only the fields they care about.
// Without this helper, every mockResolvedValue would need to spell out the
// 7 required authenticationInfo fields.
function makeVerifiedAuth(
  overrides: { verified?: boolean; info?: Partial<VerifiedAuth["authenticationInfo"]> } = {},
): VerifiedAuth {
  return {
    verified: overrides.verified ?? true,
    authenticationInfo: {
      credentialID: "mock-credential-id",
      newCounter: 5,
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: false,
      origin: "http://localhost:3000",
      rpID: "localhost",
      ...overrides.info,
    },
  };
}

vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: mockVerifyAuthLib,
  };
});

import type { TxOrPrisma } from "@/lib/prisma";
import { verifyAssertionForCredential, verifyAssertionAnyCredential } from "./webauthn-server";

// Migrated from direct process.env mutation to vi.stubEnv per pre-pr.sh
// `check-test-hygiene` gate. The vitest setup wires afterEach unstubs so we
// no longer need the manual save/restore via afterAll.
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WEBAUTHN_RP_ID", "localhost");
  vi.stubEnv("WEBAUTHN_RP_ORIGIN", "http://localhost:3000");
  mockGetRedis.mockReturnValue({ getdel: mockRedisGetdel });
  mockRedisGetdel.mockResolvedValue("stored-challenge");
  mockVerifyAuthLib.mockResolvedValue(makeVerifiedAuth());
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
  prfEncryptedSecretKey: null as string | null,
  prfSecretKeyIv: null as string | null,
  prfSecretKeyAuthTag: null as string | null,
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
  // Argument-aware, mirroring what Postgres does for `WHERE id = ...`:
  // verifyAssertionForCredential's lookup includes `where.id`, and a stub that
  // returns credentialResult regardless of the filter would make any assertion
  // about credential-row scoping vacuous (RT1) — a DENY test for a mismatched
  // row id would pass even if the production `where` never carried `id` at all.
  const findFirst = vi.fn().mockImplementation(
    async ({ where }: { where: { id?: string; userId: string; credentialId: string } }) => {
      if (credentialResult == null) return null;
      if (where.id !== undefined && where.id !== credentialResult.id) return null;
      return credentialResult;
    },
  );
  const $executeRaw =
    overrides.executeRawSpy ?? vi.fn().mockResolvedValue(overrides.executeRawResult ?? 1);
  return {
    // Typed once here rather than cast at every call site: the stub carries only
    // the two members the verifier touches, so it is not structurally a
    // TransactionClient. Same convention as tenant-management.test.ts:45.
    tx: {
      webAuthnCredential: { findFirst },
      $executeRaw,
    } as unknown as TxOrPrisma,
    findFirst,
    $executeRaw,
  };
}

describe("verifyAssertionAnyCredential (shared verifier body)", () => {
  it("returns 503 when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValue(null);
    const { tx } = makeTxStub();
    const result = await verifyAssertionAnyCredential(
      tx,
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
    const result = await verifyAssertionAnyCredential(
      tx,
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
    await verifyAssertionAnyCredential(
      tx,
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
    const result = await verifyAssertionAnyCredential(
      tx,
      "user-1",
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it("returns 400 when assertion lacks credential ID", async () => {
    const { tx } = makeTxStub();
    const result = await verifyAssertionAnyCredential(
      tx,
      "user-1",
      // Deliberately malformed: `id` is required by the type, and dropping it is
      // the only way to reach the missing-credential-id branch.
      { ...validAssertion, id: undefined } as unknown as AuthenticationResponseJSON,
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
    const result = await verifyAssertionAnyCredential(
      tx,
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
    await verifyAssertionAnyCredential(
      tx,
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
    mockVerifyAuthLib.mockResolvedValue(makeVerifiedAuth({ verified: false }));
    const { tx } = makeTxStub();
    const result = await verifyAssertionAnyCredential(
      tx,
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
    const result = await verifyAssertionAnyCredential(
      tx,
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
    await verifyAssertionAnyCredential(
      tx,
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
    const result = await verifyAssertionAnyCredential(
      tx,
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
    const result = await verifyAssertionAnyCredential(
      tx,
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

// C4: verifyAssertionForCredential restricts the lookup to a single named
// credential row; verifyAssertionAnyCredential deliberately does not. A
// forbidden-pattern grep for the literal `null` cannot catch a caller that
// silently widens the bound lookup, so these are exercised directly against
// the real verifier rather than trusted from the type signature alone.
describe("verifyAssertionForCredential vs verifyAssertionAnyCredential — credential-row scoping", () => {
  it("DENY: verifyAssertionForCredential rejects an assertion from the user's OTHER credential", async () => {
    // Same userId, same asserted credentialId — but the row the caller expects
    // (a different DB row id) does not match the row the mock stub is scoped
    // to return. This is exactly the shape the bound function must refuse:
    // the session is bound to credential A, but credential B produced the
    // assertion.
    const { tx } = makeTxStub();
    const result = await verifyAssertionForCredential(
      tx,
      "user-1",
      "some-other-row-id",
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.reason).toBe("credential_not_found");
    }
  });

  it("ALLOW: verifyAssertionForCredential succeeds when the assertion's row id matches", async () => {
    const { tx, findFirst } = makeTxStub();
    const result = await verifyAssertionForCredential(
      tx,
      "user-1",
      storedCredential.id,
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(true);
    // The bound lookup's `where` must carry `id` as a literal filter — never
    // an optional `id: x ?? undefined`, which Prisma reads as "no id filter"
    // and would silently widen this to any credential of the user (M2).
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: storedCredential.id,
        userId: "user-1",
        credentialId: "credential-id-base64url",
      },
    });
  });

  it("ALLOW: verifyAssertionAnyCredential still accepts any credential of the user", async () => {
    // Proves the split did not accidentally narrow the presence-ceremony path
    // too: no `id` scoping at all, so a different row id than any caller
    // expects still succeeds as long as it belongs to the user.
    const { tx, findFirst } = makeTxStub();
    const result = await verifyAssertionAnyCredential(
      tx,
      "user-1",
      validAssertion,
      "webauthn:challenge:test:user-1",
    );
    expect(result.ok).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", credentialId: "credential-id-base64url" },
    });
  });
});
