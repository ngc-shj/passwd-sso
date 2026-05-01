import { describe, it, expect, vi } from "vitest";
import {
  encryptAccountToken,
  decryptAccountToken,
  encryptAccountTokenTriple,
  decryptAccountTokenTriple,
  isEncryptedAccountToken,
  DECRYPT_FAILURE_KIND,
} from "./account-token-crypto";
import legacyFixture from "@/__tests__/fixtures/account-token-legacy-ciphertext.json";

const aad = {
  userId: "11111111-1111-1111-1111-111111111111",
  provider: "google",
  providerAccountId: "alice@example.com",
};

describe("account-token-crypto", () => {
  it("round-trips a plaintext through encrypt → decrypt", () => {
    const plaintext = "ya29.A0ARrdaM-..._sample_oauth_refresh_token";
    const ciphertext = encryptAccountToken(plaintext, aad);
    expect(ciphertext.startsWith("psoenc1:")).toBe(true);
    expect(ciphertext).not.toContain(plaintext);
    const recovered = decryptAccountToken(ciphertext, aad);
    expect(recovered).toBe(plaintext);
  });

  it("produces a different ciphertext for the same plaintext on each call (random IV)", () => {
    const plaintext = "stable-plaintext";
    const a = encryptAccountToken(plaintext, aad);
    const b = encryptAccountToken(plaintext, aad);
    expect(a).not.toBe(b);
    expect(decryptAccountToken(a, aad)).toBe(plaintext);
    expect(decryptAccountToken(b, aad)).toBe(plaintext);
  });

  it("isEncryptedAccountToken matches only the encrypted form", () => {
    expect(isEncryptedAccountToken(encryptAccountToken("p", aad))).toBe(true);
    expect(isEncryptedAccountToken("plain-string")).toBe(false);
    expect(isEncryptedAccountToken("")).toBe(false);
  });

  it("returns null for null/undefined inputs (decrypt)", () => {
    expect(decryptAccountToken(null, aad)).toBeNull();
    expect(decryptAccountToken(undefined, aad)).toBeNull();
  });

  it("treats legacy plaintext (no sentinel) as a passthrough", () => {
    // Backward-compat: rows that pre-date encryption are returned verbatim
    // until the data migration script rewrites them.
    expect(decryptAccountToken("legacy-plaintext-token", aad)).toBe(
      "legacy-plaintext-token",
    );
  });

  it("rejects ciphertext when the AAD context does not match", () => {
    const ct = encryptAccountToken("secret", aad);
    // Different providerAccountId
    expect(() =>
      decryptAccountToken(ct, { ...aad, providerAccountId: "different@example.com" }),
    ).toThrow();
    // Different provider
    expect(() => decryptAccountToken(ct, { ...aad, provider: "github" })).toThrow();
    // Different userId — the userId binding is the key new defense
    // (closes Vector A: DB-write attacker pivots accounts.user_id).
    expect(() =>
      decryptAccountToken(ct, {
        ...aad,
        userId: "22222222-2222-2222-2222-222222222222",
      }),
    ).toThrow();
  });

  it("encrypted ciphertext for one userId is undecryptable as another userId (cross-user pivot resistance)", () => {
    const ctForAlice = encryptAccountToken("alice-token", aad);
    const bobAad = { ...aad, userId: "22222222-2222-2222-2222-222222222222" };
    expect(() => decryptAccountToken(ctForAlice, bobAad)).toThrow();
    // And decrypting with Alice's AAD still works.
    expect(decryptAccountToken(ctForAlice, aad)).toBe("alice-token");
  });

  it("encrypted ciphertext for one (provider, providerAccountId) pair is undecryptable as another (cross-row pivot resistance)", () => {
    const ctForAlice = encryptAccountToken("alice-token", aad);
    const otherAad = { ...aad, providerAccountId: "carol@example.com" };
    expect(() => decryptAccountToken(ctForAlice, otherAad)).toThrow();
  });

  it("rejects malformed ciphertext", () => {
    expect(() => decryptAccountToken("psoenc1:notaversion:zzzz", aad)).toThrow();
    expect(() => decryptAccountToken("psoenc1:0:", aad)).toThrow();
    expect(() => decryptAccountToken("psoenc1:0:dGVzdA", aad)).toThrow(); // too short to be iv+tag
  });

  it("rejects ciphertext with a tampered tag", () => {
    const ct = encryptAccountToken("secret", aad);
    // Decode, flip a bit in the auth tag region, re-encode, and try to decrypt.
    const [prefix, versionAndBlob] = ct.split(":", 2);
    const colonIdx = ct.indexOf(":", prefix.length + 1);
    const versionStr = ct.slice(prefix.length + 1, colonIdx);
    const blobB64 = ct.slice(colonIdx + 1);
    const blob = Buffer.from(blobB64, "base64url");
    blob[12] ^= 0xff; // flip first byte of auth tag
    const tampered = `${prefix}:${versionStr}:${blob.toString("base64url")}`;
    expect(() => decryptAccountToken(tampered, aad)).toThrow();
    // Use versionAndBlob so unused-var rule does not fire.
    expect(versionAndBlob).toBeDefined();
  });

  describe("triple helpers", () => {
    it("encrypts the present fields and leaves null/undefined fields null", () => {
      const out = encryptAccountTokenTriple(
        { refresh_token: "rt", access_token: null, id_token: undefined },
        aad,
      );
      expect(out.refresh_token).toMatch(/^psoenc1:/);
      expect(out.access_token).toBeNull();
      expect(out.id_token).toBeNull();
    });

    it("decrypts encrypted fields and passes legacy plaintext through", () => {
      const encrypted = encryptAccountToken("rt-plain", aad);
      const out = decryptAccountTokenTriple(
        { refresh_token: encrypted, access_token: "legacy-at", id_token: null },
        aad,
      );
      expect(out.refresh_token).toBe("rt-plain");
      expect(out.access_token).toBe("legacy-at");
      expect(out.id_token).toBeNull();
    });

    it("decryptAccountTokenTriple without onFieldError throws on corrupt input", () => {
      expect(() =>
        decryptAccountTokenTriple(
          { refresh_token: "psoenc1:0:zzzz", access_token: null, id_token: null },
          aad,
        ),
      ).toThrow();
    });

    it("decryptAccountTokenTriple with onFieldError continues past a corrupt field", () => {
      const good = encryptAccountToken("good-token", aad);
      const errors: { field: string; err: unknown; kind: string }[] = [];
      const out = decryptAccountTokenTriple(
        {
          refresh_token: "psoenc1:0:zzzz",
          access_token: good,
          id_token: null,
        },
        aad,
        {
          onFieldError: (field, err, kind) => {
            errors.push({ field, err, kind });
          },
        },
      );
      expect(out.refresh_token).toBeNull();
      expect(out.access_token).toBe("good-token");
      expect(out.id_token).toBeNull();
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe("refresh_token");
      // Malformed envelope → CORRUPT classification (operationally benign).
      expect(errors[0].kind).toBe(DECRYPT_FAILURE_KIND.CORRUPT);
    });

    it("decryptAccountTokenTriple classifies AAD mismatch as TAMPERED", () => {
      const ct = encryptAccountToken("secret", aad);
      const wrongAad = { ...aad, userId: "22222222-2222-2222-2222-222222222222" };
      const errors: { field: string; kind: string }[] = [];
      const out = decryptAccountTokenTriple(
        { refresh_token: ct, access_token: null, id_token: null },
        wrongAad,
        {
          onFieldError: (field, _err, kind) => {
            errors.push({ field, kind });
          },
        },
      );
      expect(out.refresh_token).toBeNull();
      expect(errors).toEqual([
        { field: "refresh_token", kind: DECRYPT_FAILURE_KIND.TAMPERED },
      ]);
    });
  });

  // AAD-byte drift detection. The fixture is a known plaintext encrypted
  // under a deterministic test master key in the on-disk envelope format,
  // using the AAD shape `userId:provider:providerAccountId`. If `buildAad`
  // ever changes shape without regenerating the fixture, this test fails —
  // forcing intentional reconciliation. Regenerate via
  // `npx tsx scripts/regenerate-account-token-legacy-fixture.ts`.
  describe("AAD-byte drift regression", () => {
    it("decrypts a fixture ciphertext using the current AAD shape", async () => {
      const cryptoServer = await import("@/lib/crypto/crypto-server");
      const fixtureKey = Buffer.from(legacyFixture.masterKeyHex, "hex");
      const spy = vi
        .spyOn(cryptoServer, "getMasterKeyByVersion")
        .mockImplementation((version: number) => {
          if (version !== legacyFixture.masterKeyVersion) {
            throw new Error(
              `unexpected key version ${version}, fixture is v${legacyFixture.masterKeyVersion}`,
            );
          }
          return fixtureKey;
        });
      try {
        const recovered = decryptAccountToken(legacyFixture.ciphertext, {
          userId: legacyFixture.userId,
          provider: legacyFixture.provider,
          providerAccountId: legacyFixture.providerAccountId,
        });
        expect(recovered).toBe(legacyFixture.plaintext);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
