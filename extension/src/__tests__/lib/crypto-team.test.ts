import { describe, it, expect } from "vitest";
import { hexEncode, type EncryptedData } from "../../lib/crypto";
import {
  buildTeamEntryAAD,
  buildItemKeyWrapAAD,
  buildTeamKeyWrapAAD,
  deriveTeamEncryptionKey,
  deriveItemEncryptionKey,
  unwrapTeamKey,
  unwrapItemKey,
  type TeamKeyWrapContext,
} from "../../lib/crypto-team";

// ─── Helpers ─────────────────────────────────────────────────

/** Encrypt plaintext with AES-256-GCM, returning hex-encoded EncryptedData. */
async function aesEncrypt(
  plaintext: Uint8Array,
  key: CryptoKey,
  aad?: Uint8Array,
): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params: AesGcmParams = { name: "AES-GCM", iv };
  if (aad) {
    params.additionalData = aad.buffer.slice(
      aad.byteOffset,
      aad.byteOffset + aad.byteLength,
    ) as ArrayBuffer;
  }

  const result = await crypto.subtle.encrypt(params, key, plaintext);
  const resultBytes = new Uint8Array(result);
  const ciphertext = resultBytes.slice(0, -16);
  const authTag = resultBytes.slice(-16);

  return {
    ciphertext: hexEncode(ciphertext),
    iv: hexEncode(iv),
    authTag: hexEncode(authTag),
  };
}

/** Generate a random AES-256-GCM key. */
async function makeAesKey(
  extractable = false,
): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"],
  );
}

/** Generate an ECDH P-256 key pair. */
async function makeEcdhKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
}

// ─── AAD Builders ────────────────────────────────────────────

describe("crypto-team AAD builders", () => {
  describe("buildTeamEntryAAD", () => {
    it("produces correct binary format for blob scope", () => {
      const aad = buildTeamEntryAAD("team-1", "entry-1", "blob", 0);
      expect(aad).toBeInstanceOf(Uint8Array);
      // Header: scope "OV" (2 bytes) + version 1 (1 byte) + field count 4 (1 byte)
      expect(aad[0]).toBe("O".charCodeAt(0));
      expect(aad[1]).toBe("V".charCodeAt(0));
      expect(aad[2]).toBe(1); // AAD_VERSION
      expect(aad[3]).toBe(4); // 4 fields
    });

    it("produces correct binary format for overview scope", () => {
      const aad = buildTeamEntryAAD("team-1", "entry-1", "overview", 0);
      expect(aad[0]).toBe("O".charCodeAt(0));
      expect(aad[1]).toBe("V".charCodeAt(0));
      expect(aad[3]).toBe(4);
    });

    it("produces different output for different vaultType", () => {
      const blob = buildTeamEntryAAD("team-1", "entry-1", "blob", 0);
      const overview = buildTeamEntryAAD("team-1", "entry-1", "overview", 0);
      expect(blob).not.toEqual(overview);
    });

    it("produces different output for different itemKeyVersion", () => {
      const v0 = buildTeamEntryAAD("team-1", "entry-1", "blob", 0);
      const v1 = buildTeamEntryAAD("team-1", "entry-1", "blob", 1);
      expect(v0).not.toEqual(v1);
    });

    it("produces different output for different teamId", () => {
      const a = buildTeamEntryAAD("team-1", "entry-1");
      const b = buildTeamEntryAAD("team-2", "entry-1");
      expect(a).not.toEqual(b);
    });

    it("produces different output for different entryId", () => {
      const a = buildTeamEntryAAD("team-1", "entry-1");
      const b = buildTeamEntryAAD("team-1", "entry-2");
      expect(a).not.toEqual(b);
    });

    it("defaults vaultType to blob and itemKeyVersion to 0", () => {
      const explicit = buildTeamEntryAAD("team-1", "entry-1", "blob", 0);
      const defaulted = buildTeamEntryAAD("team-1", "entry-1");
      expect(defaulted).toEqual(explicit);
    });
  });

  describe("buildItemKeyWrapAAD", () => {
    it("produces correct binary format with scope IK", () => {
      const aad = buildItemKeyWrapAAD("team-1", "entry-1", 1);
      expect(aad).toBeInstanceOf(Uint8Array);
      expect(aad[0]).toBe("I".charCodeAt(0));
      expect(aad[1]).toBe("K".charCodeAt(0));
      expect(aad[2]).toBe(1); // AAD_VERSION
      expect(aad[3]).toBe(3); // 3 fields
    });

    it("produces different output for different keyVersion", () => {
      const v1 = buildItemKeyWrapAAD("team-1", "entry-1", 1);
      const v2 = buildItemKeyWrapAAD("team-1", "entry-1", 2);
      expect(v1).not.toEqual(v2);
    });
  });

  describe("buildTeamKeyWrapAAD", () => {
    it("produces correct binary format with scope OK", () => {
      const aad = buildTeamKeyWrapAAD({
        teamId: "team-1",
        toUserId: "user-1",
        keyVersion: 1,
        wrapVersion: 0,
      });
      expect(aad).toBeInstanceOf(Uint8Array);
      expect(aad[0]).toBe("O".charCodeAt(0));
      expect(aad[1]).toBe("K".charCodeAt(0));
      expect(aad[2]).toBe(1); // AAD_VERSION
      expect(aad[3]).toBe(4); // 4 fields
    });

    it("produces different output for different toUserId", () => {
      const a = buildTeamKeyWrapAAD({
        teamId: "team-1",
        toUserId: "user-1",
        keyVersion: 1,
        wrapVersion: 0,
      });
      const b = buildTeamKeyWrapAAD({
        teamId: "team-1",
        toUserId: "user-2",
        keyVersion: 1,
        wrapVersion: 0,
      });
      expect(a).not.toEqual(b);
    });

    it("produces different output for different wrapVersion", () => {
      const a = buildTeamKeyWrapAAD({
        teamId: "team-1",
        toUserId: "user-1",
        keyVersion: 1,
        wrapVersion: 0,
      });
      const b = buildTeamKeyWrapAAD({
        teamId: "team-1",
        toUserId: "user-1",
        keyVersion: 1,
        wrapVersion: 1,
      });
      expect(a).not.toEqual(b);
    });
  });
});

// ─── ECDH Key Derivation ─────────────────────────────────────

describe("ECDH key derivation round-trip", () => {
  it("derives a CryptoKey from P-256 key pair via ECDH + HKDF", async () => {
    const alice = await makeEcdhKeyPair();
    const bob = await makeEcdhKeyPair();

    // Derive shared secret from both sides
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const hkdfInfo = new TextEncoder().encode("passwd-sso-team-v1");

    async function deriveWrappingKey(
      privateKey: CryptoKey,
      publicKey: CryptoKey,
    ): Promise<CryptoKey> {
      const sharedBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: publicKey },
        privateKey,
        256,
      );
      const hkdfKey = await crypto.subtle.importKey(
        "raw",
        sharedBits,
        "HKDF",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt,
          info: hkdfInfo,
        },
        hkdfKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    }

    const keyAB = await deriveWrappingKey(alice.privateKey, bob.publicKey);
    const keyBA = await deriveWrappingKey(bob.privateKey, alice.publicKey);

    expect(keyAB).toBeInstanceOf(CryptoKey);
    expect(keyAB.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });

    // Both sides derive the same key: encrypt with one, decrypt with other
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode("shared-secret");
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      keyAB,
      plaintext,
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      keyBA,
      encrypted,
    );
    expect(new Uint8Array(decrypted)).toEqual(plaintext);
  });
});

// ─── Team Key Unwrap Round-trip ──────────────────────────────

describe("unwrapTeamKey round-trip", () => {
  it("wraps and unwraps a 256-bit team key via ECDH", async () => {
    const teamKey = crypto.getRandomValues(new Uint8Array(32));
    const member = await makeEcdhKeyPair();
    const ephemeral = await makeEcdhKeyPair();

    const salt = crypto.getRandomValues(new Uint8Array(32));
    const hkdfInfo = new TextEncoder().encode("passwd-sso-team-v1");

    // Derive wrapping key: ECDH(ephemeral.private, member.public)
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: member.publicKey },
      ephemeral.privateKey,
      256,
    );
    const hkdfKey = await crypto.subtle.importKey(
      "raw",
      sharedBits,
      "HKDF",
      false,
      ["deriveKey"],
    );
    const wrappingKey = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: hkdfInfo,
      },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );

    const ctx: TeamKeyWrapContext = {
      teamId: "team-abc",
      toUserId: "user-xyz",
      keyVersion: 1,
      wrapVersion: 0,
    };
    const aad = buildTeamKeyWrapAAD(ctx);
    const encrypted = await aesEncrypt(teamKey, wrappingKey, aad);

    // Export ephemeral public key as JWK string
    const ephemeralPubJwk = JSON.stringify(
      await crypto.subtle.exportKey("jwk", ephemeral.publicKey),
    );
    const hkdfSaltHex = hexEncode(salt);

    const unwrapped = await unwrapTeamKey(
      encrypted,
      ephemeralPubJwk,
      member.privateKey,
      hkdfSaltHex,
      ctx,
    );

    expect(unwrapped).toEqual(teamKey);
  });
});

// ─── ItemKey Unwrap Round-trip ───────────────────────────────

describe("unwrapItemKey round-trip", () => {
  it("wraps and unwraps a 256-bit item key with team encryption key", async () => {
    const teamKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const itemKeyBytes = crypto.getRandomValues(new Uint8Array(32));

    const teamEncKey = await deriveTeamEncryptionKey(teamKeyBytes);
    const aad = buildItemKeyWrapAAD("team-1", "entry-1", 1);

    const encrypted = await aesEncrypt(itemKeyBytes, teamEncKey, aad);
    const unwrapped = await unwrapItemKey(encrypted, teamEncKey, aad);

    expect(unwrapped).toEqual(itemKeyBytes);
  });

  it("fails with wrong AAD", async () => {
    const teamKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const itemKeyBytes = crypto.getRandomValues(new Uint8Array(32));

    const teamEncKey = await deriveTeamEncryptionKey(teamKeyBytes);
    const aad = buildItemKeyWrapAAD("team-1", "entry-1", 1);
    const wrongAad = buildItemKeyWrapAAD("team-1", "entry-1", 2);

    const encrypted = await aesEncrypt(itemKeyBytes, teamEncKey, aad);

    await expect(
      unwrapItemKey(encrypted, teamEncKey, wrongAad),
    ).rejects.toThrow();
  });
});

// ─── Encryption Key Derivation ───────────────────────────────

describe("deriveTeamEncryptionKey", () => {
  it("returns an AES-256-GCM CryptoKey", async () => {
    const teamKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await deriveTeamEncryptionKey(teamKey);

    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");
  });

  it("produces deterministic output for the same input", async () => {
    const teamKey = new Uint8Array(32).fill(42);
    const key1 = await deriveTeamEncryptionKey(teamKey);
    const key2 = await deriveTeamEncryptionKey(teamKey);

    // Verify by encrypting with key1 and decrypting with key2
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("deterministic-test");
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key1,
      data,
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key2,
      encrypted,
    );
    expect(new Uint8Array(decrypted)).toEqual(data);
  });

  it("produces different keys for different team keys", async () => {
    const key1 = await deriveTeamEncryptionKey(new Uint8Array(32).fill(1));
    const key2 = await deriveTeamEncryptionKey(new Uint8Array(32).fill(2));

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("test");
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key1,
      data,
    );
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, encrypted),
    ).rejects.toThrow();
  });
});

describe("deriveItemEncryptionKey", () => {
  it("returns an AES-256-GCM CryptoKey", async () => {
    const itemKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await deriveItemEncryptionKey(itemKey);

    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");
  });

  it("produces deterministic output for the same input", async () => {
    const itemKey = new Uint8Array(32).fill(99);
    const key1 = await deriveItemEncryptionKey(itemKey);
    const key2 = await deriveItemEncryptionKey(itemKey);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("item-deterministic");
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key1,
      data,
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key2,
      encrypted,
    );
    expect(new Uint8Array(decrypted)).toEqual(data);
  });

  it("produces different keys for different item keys", async () => {
    const key1 = await deriveItemEncryptionKey(new Uint8Array(32).fill(10));
    const key2 = await deriveItemEncryptionKey(new Uint8Array(32).fill(20));

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("test");
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key1,
      data,
    );
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, encrypted),
    ).rejects.toThrow();
  });
});
