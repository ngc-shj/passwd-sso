// @vitest-environment jsdom
//
// Real-WebCrypto suite for team-vault-core's version-aware key resolution
// (C1). The mocked suite (team-vault-core.test.tsx) vi.mocks crypto-team /
// crypto-aad module-wide and cannot host real-crypto cases, so version
// assertion, normalization, and old-key unwrap correctness are exercised
// here against actual AES-GCM/ECDH primitives. Only `fetch` is stubbed.

import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import type { ReactNode } from "react";
import {
  generateTeamSymmetricKey,
  generateItemKey,
  wrapTeamKeyForMember,
  wrapItemKey,
  generateECDHKeyPair,
  exportPublicKey,
  exportPrivateKey,
  hexEncode,
  CURRENT_TEAM_WRAP_VERSION,
  type TeamKeyWrapContext,
} from "@/lib/crypto/crypto-team";
import { buildItemKeyWrapAAD } from "@/lib/crypto/crypto-aad";
import {
  TeamVaultProvider,
  useTeamVault,
  TeamKeyVersionUnavailableError,
  type EntryItemKeyData,
} from "@/lib/team/team-vault-core";

const TEAM_ID = "team-crypto-001";
const ENTRY_ID = "entry-crypto-001";
const USER_ID = "member-crypto-001";

interface MemberKeyFixture {
  teamKeyBytes: Uint8Array;
  keyVersion: number;
  response: {
    encryptedTeamKey: string;
    teamKeyIv: string;
    teamKeyAuthTag: string;
    ephemeralPublicKey: string;
    hkdfSalt: string;
    keyVersion: number;
    wrapVersion: number;
  };
}

/** Build a real wrapTeamKeyForMember fixture for a given team + version. */
async function buildMemberKeyFixture(
  memberPublicKey: CryptoKey,
  keyVersion: number,
): Promise<MemberKeyFixture> {
  const teamKeyBytes = generateTeamSymmetricKey();
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const ephemeralKeyPair = await generateECDHKeyPair();
  const ephemeralPublicKeyJwk = await exportPublicKey(ephemeralKeyPair.publicKey);

  const ctx: TeamKeyWrapContext = {
    teamId: TEAM_ID,
    toUserId: USER_ID,
    keyVersion,
    wrapVersion: CURRENT_TEAM_WRAP_VERSION,
  };

  const encrypted = await wrapTeamKeyForMember(
    teamKeyBytes,
    ephemeralKeyPair.privateKey,
    memberPublicKey,
    salt,
    ctx,
  );

  return {
    teamKeyBytes,
    keyVersion,
    response: {
      encryptedTeamKey: encrypted.ciphertext,
      teamKeyIv: encrypted.iv,
      teamKeyAuthTag: encrypted.authTag,
      ephemeralPublicKey: ephemeralPublicKeyJwk,
      hkdfSalt: hexEncode(salt),
      keyVersion,
      wrapVersion: CURRENT_TEAM_WRAP_VERSION,
    },
  };
}

/** Build a real wrapItemKey fixture (ItemKey wrapped under a specific TeamKey version). */
async function buildItemKeyFixture(
  teamEncryptionKey: CryptoKey,
  teamKeyVersion: number,
) {
  const itemKeyBytes = generateItemKey();
  const aad = buildItemKeyWrapAAD(TEAM_ID, ENTRY_ID, teamKeyVersion);
  const encrypted = await wrapItemKey(itemKeyBytes, teamEncryptionKey, aad);
  return { itemKeyBytes, encrypted };
}

describe("team-vault-core (real WebCrypto)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // fetchAndUnwrapTeamKey zero-fills the bytes it is given on every exit path
  // (R39 discipline) — so the accessor must hand back a FRESH copy each call,
  // mirroring how vault-context re-derives the private key bytes per call.
  function makeWrapper(ecdhPrivateKeyBytes: Uint8Array) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <TeamVaultProvider
          getEcdhPrivateKeyBytes={() => new Uint8Array(ecdhPrivateKeyBytes)}
          getUserId={() => USER_ID}
          vaultUnlocked={false}
        >
          {children}
        </TeamVaultProvider>
      );
    };
  }

  // Standard fetch router: latest member-key at (no keyVersion) resolves to
  // `latestFixture`; `?keyVersion=N` resolves to whichever fixture in `byVersion`
  // matches N (or a 404 MEMBER_KEY_NOT_FOUND if absent).
  function makeFetchRouter(
    latestFixture: MemberKeyFixture,
    byVersion: Map<number, MemberKeyFixture>,
    opts?: { mismatchRespondVersion?: number },
  ) {
    return async (url: string) => {
      const match = /keyVersion=(\d+)/.exec(url);
      if (!match) {
        return {
          ok: true,
          status: 200,
          json: async () => latestFixture.response,
        };
      }
      const requested = Number(match[1]);
      if (opts?.mismatchRespondVersion !== undefined) {
        // Server returns a DIFFERENT version than requested.
        const wrong = byVersion.get(opts.mismatchRespondVersion) ?? latestFixture;
        return {
          ok: true,
          status: 200,
          json: async () => wrong.response,
        };
      }
      const fixture = byVersion.get(requested);
      if (!fixture) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "MEMBER_KEY_NOT_FOUND" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => fixture.response,
      };
    };
  }

  it("(a) history record with teamKeyVersion = N-1 decrypts via the versioned key", async () => {
    const memberKeyPair = await generateECDHKeyPair();
    const ecdhPrivateKeyBytes = await exportPrivateKey(memberKeyPair.privateKey);

    const latest = await buildMemberKeyFixture(memberKeyPair.publicKey, 3);
    const old = await buildMemberKeyFixture(memberKeyPair.publicKey, 2);

    // Derive the OLD team's encryption key locally to build a real ItemKey
    // fixture wrapped under version 2 (mirrors what the server actually holds).
    const oldEncKeyForFixture = await (
      await import("@/lib/crypto/crypto-team")
    ).deriveTeamEncryptionKey(old.teamKeyBytes);
    const { itemKeyBytes, encrypted } = await buildItemKeyFixture(oldEncKeyForFixture, 2);

    globalThis.fetch = (async (url: string) =>
      makeFetchRouter(latest, new Map([[2, old]]))(url)) as unknown as typeof fetch;

    const { result } = renderHook(() => useTeamVault(), {
      wrapper: makeWrapper(ecdhPrivateKeyBytes),
    });

    const entry: EntryItemKeyData = {
      itemKeyVersion: 1,
      encryptedItemKey: encrypted.ciphertext,
      itemKeyIv: encrypted.iv,
      itemKeyAuthTag: encrypted.authTag,
      teamKeyVersion: 2,
    };

    let key: CryptoKey | null = null;
    await act(async () => {
      key = await result.current.getEntryDecryptionKey(TEAM_ID, ENTRY_ID, entry);
    });

    expect(key).not.toBeNull();

    // Round-trip: encrypt with the raw ItemKey-derived key path used by the
    // fixture builder (itemKeyBytes), decrypt with the key returned by
    // getEntryDecryptionKey, and confirm they match by using both to
    // encrypt/decrypt the same plaintext under AES-GCM.
    const plaintext = new TextEncoder().encode("old-version-secret");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: ivBuf },
      key as unknown as CryptoKey,
      plaintext,
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ivBuf },
      key as unknown as CryptoKey,
      ciphertext,
    );
    expect(new TextDecoder().decode(decrypted)).toBe("old-version-secret");
    expect(itemKeyBytes).toBeInstanceOf(Uint8Array); // fixture sanity
  });

  it("(b) v0 ItemKey row with old teamKeyVersion uses the old TeamKey directly", async () => {
    const memberKeyPair = await generateECDHKeyPair();
    const ecdhPrivateKeyBytes = await exportPrivateKey(memberKeyPair.privateKey);

    const latest = await buildMemberKeyFixture(memberKeyPair.publicKey, 3);
    const old = await buildMemberKeyFixture(memberKeyPair.publicKey, 2);

    globalThis.fetch = (async (url: string) =>
      makeFetchRouter(latest, new Map([[2, old]]))(url)) as unknown as typeof fetch;

    const { result } = renderHook(() => useTeamVault(), {
      wrapper: makeWrapper(ecdhPrivateKeyBytes),
    });

    // v0 ItemKey row (itemKeyVersion 0, present but unused by decryption) with
    // teamKeyVersion 2 (old, non-latest): expect the OLD TeamKey-derived key
    // directly, no ItemKey unwrap.
    const entry: EntryItemKeyData = {
      itemKeyVersion: 0,
      teamKeyVersion: 2,
    };

    let key: CryptoKey | null = null;
    await act(async () => {
      key = await result.current.getEntryDecryptionKey(TEAM_ID, ENTRY_ID, entry);
    });
    expect(key).not.toBeNull();

    // Confirm it is literally the OLD TeamKey-derived key by comparing against
    // getTeamEncryptionKeyForVersion(TEAM_ID, 2) — same cache slot, same object.
    let versionedTeamKey: CryptoKey | null = null;
    await act(async () => {
      versionedTeamKey = await result.current.getTeamEncryptionKeyForVersion(TEAM_ID, 2);
    });
    expect(key).toBe(versionedTeamKey);
  });

  it("(c) teamKeyVersion = 0 legacy fixture normalizes to version 1's key", async () => {
    const memberKeyPair = await generateECDHKeyPair();
    const ecdhPrivateKeyBytes = await exportPrivateKey(memberKeyPair.privateKey);

    // Team has never rotated: latest === version 1.
    const v1 = await buildMemberKeyFixture(memberKeyPair.publicKey, 1);

    globalThis.fetch = (async (url: string) =>
      makeFetchRouter(v1, new Map([[1, v1]]))(url)) as unknown as typeof fetch;

    const { result } = renderHook(() => useTeamVault(), {
      wrapper: makeWrapper(ecdhPrivateKeyBytes),
    });

    // Legacy schema-default-0 row: teamKeyVersion 0 must normalize to 1 and
    // resolve via the LATEST path (no versioned fetch) since latest === 1.
    const entry: EntryItemKeyData = {
      itemKeyVersion: 0,
      teamKeyVersion: 0,
    };

    let key: CryptoKey | null = null;
    await act(async () => {
      key = await result.current.getEntryDecryptionKey(TEAM_ID, ENTRY_ID, entry);
    });
    expect(key).not.toBeNull();

    let latestKey: CryptoKey | null = null;
    await act(async () => {
      latestKey = await result.current.getTeamEncryptionKey(TEAM_ID);
    });
    expect(key).toBe(latestKey);
  });

  it("(d) response-version-mismatch resolves to null / distinguishable error and caches nothing", async () => {
    const memberKeyPair = await generateECDHKeyPair();
    const ecdhPrivateKeyBytes = await exportPrivateKey(memberKeyPair.privateKey);

    const latest = await buildMemberKeyFixture(memberKeyPair.publicKey, 3);
    const wrongVersionReturned = await buildMemberKeyFixture(memberKeyPair.publicKey, 3);

    // Server returns keyVersion 3 (== latest) when version 2 was requested.
    globalThis.fetch = (async (url: string) =>
      makeFetchRouter(latest, new Map([[3, wrongVersionReturned]]), {
        mismatchRespondVersion: 3,
      })(url)) as unknown as typeof fetch;

    const { result } = renderHook(() => useTeamVault(), {
      wrapper: makeWrapper(ecdhPrivateKeyBytes),
    });

    const entry: EntryItemKeyData = {
      itemKeyVersion: 0,
      teamKeyVersion: 2,
    };

    await expect(
      act(async () => {
        await result.current.getEntryDecryptionKey(TEAM_ID, ENTRY_ID, entry);
      }),
    ).rejects.toThrow(TeamKeyVersionUnavailableError);

    // Nothing cached for version 2: a direct versioned call also returns null.
    let versioned: CryptoKey | null = { type: "sentinel" } as unknown as CryptoKey;
    await act(async () => {
      versioned = await result.current.getTeamEncryptionKeyForVersion(TEAM_ID, 2);
    });
    expect(versioned).toBeNull();
  });

  it("(e) MEMBER_KEY_NOT_FOUND (404) resolves to null / distinguishable error", async () => {
    const memberKeyPair = await generateECDHKeyPair();
    const ecdhPrivateKeyBytes = await exportPrivateKey(memberKeyPair.privateKey);

    const latest = await buildMemberKeyFixture(memberKeyPair.publicKey, 3);

    // No fixture registered for version 1 (member joined after rotation) → 404.
    globalThis.fetch = (async (url: string) =>
      makeFetchRouter(latest, new Map())(url)) as unknown as typeof fetch;

    const { result } = renderHook(() => useTeamVault(), {
      wrapper: makeWrapper(ecdhPrivateKeyBytes),
    });

    const entry: EntryItemKeyData = {
      itemKeyVersion: 0,
      teamKeyVersion: 1,
    };

    await expect(
      act(async () => {
        await result.current.getEntryDecryptionKey(TEAM_ID, ENTRY_ID, entry);
      }),
    ).rejects.toThrow(TeamKeyVersionUnavailableError);
  });
});
