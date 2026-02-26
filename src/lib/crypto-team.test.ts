import { describe, it, expect } from "vitest";
import {
  generateTeamSymmetricKey,
  deriveTeamEncryptionKey,
  deriveEcdhWrappingKey,
  wrapTeamKeyForMember,
  unwrapTeamKey,
  createTeamKeyEscrow,
  encryptTeamEntry,
  decryptTeamEntry,
  encryptTeamAttachment,
  decryptTeamAttachment,
  buildTeamKeyWrapAAD,
  CURRENT_TEAM_WRAP_VERSION,
  HKDF_ECDH_WRAP_INFO,
  generateECDHKeyPair,
  exportPublicKey,
  exportPrivateKey,
  importPrivateKey,
  hexEncode,
  hexDecode,
  type TeamKeyWrapContext,
} from "./crypto-team";
import { deriveEncryptionKey } from "./crypto-client";

const TEST_TEAM_ID = "team-test-001";

const TEST_CTX: TeamKeyWrapContext = {
  teamId: TEST_TEAM_ID,
  toUserId: "member-user-002",
  keyVersion: 1,
  wrapVersion: CURRENT_TEAM_WRAP_VERSION,
};

function makeCtx(overrides?: Partial<TeamKeyWrapContext>): TeamKeyWrapContext {
  return { ...TEST_CTX, ...overrides };
}

describe("crypto-team", () => {
  describe("generateTeamSymmetricKey", () => {
    it("generates a 32-byte (256-bit) random key", () => {
      const key = generateTeamSymmetricKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it("generates unique keys each time", () => {
      const key1 = generateTeamSymmetricKey();
      const key2 = generateTeamSymmetricKey();
      expect(hexEncode(key1)).not.toBe(hexEncode(key2));
    });
  });

  describe("deriveTeamEncryptionKey", () => {
    it("derives an AES-256-GCM key from team symmetric key", async () => {
      const teamKey = generateTeamSymmetricKey();
      const encKey = await deriveTeamEncryptionKey(teamKey);
      expect(encKey.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
      expect(encKey.usages).toContain("encrypt");
      expect(encKey.usages).toContain("decrypt");
    });

    it("produces deterministic output for same input", async () => {
      const teamKey = generateTeamSymmetricKey();
      const key1 = await deriveTeamEncryptionKey(teamKey);
      const key2 = await deriveTeamEncryptionKey(teamKey);

      // Encrypt with key1, decrypt with key2
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
      const data = new TextEncoder().encode("test-data");
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivBuf }, key1, data);
      const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuf }, key2, encrypted);
      expect(new TextDecoder().decode(decrypted)).toBe("test-data");
    });

    it("different team keys produce different encryption keys", async () => {
      const teamKey1 = generateTeamSymmetricKey();
      const teamKey2 = generateTeamSymmetricKey();
      const encKey1 = await deriveTeamEncryptionKey(teamKey1);
      const encKey2 = await deriveTeamEncryptionKey(teamKey2);

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
      const data = new TextEncoder().encode("cross-key-test");
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivBuf }, encKey1, data);
      await expect(
        crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuf }, encKey2, encrypted),
      ).rejects.toThrow();
    });
  });

  describe("deriveEcdhWrappingKey", () => {
    it("derives an AES-256-GCM key from secretKey (domain-separated)", async () => {
      const secretKey = crypto.getRandomValues(new Uint8Array(32));
      const wrapKey = await deriveEcdhWrappingKey(secretKey);
      expect(wrapKey.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
      expect(wrapKey.usages).toContain("encrypt");
      expect(wrapKey.usages).toContain("decrypt");
    });

    it("produces different key than deriveEncryptionKey (domain separation)", async () => {
      const secretKey = crypto.getRandomValues(new Uint8Array(32));
      const ecdhWrapKey = await deriveEcdhWrappingKey(secretKey);
      const encKey = await deriveEncryptionKey(secretKey);

      // Encrypt with ecdhWrapKey, should fail to decrypt with encKey
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
      const data = new TextEncoder().encode("domain-sep-test");
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivBuf }, ecdhWrapKey, data);
      await expect(
        crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuf }, encKey, encrypted),
      ).rejects.toThrow();
    });
  });

  describe("buildTeamKeyWrapAAD", () => {
    it("produces binary format with scope 'OK'", () => {
      const aad = buildTeamKeyWrapAAD(TEST_CTX);
      expect(aad).toBeInstanceOf(Uint8Array);
      // First 2 bytes = "OK"
      expect(String.fromCharCode(aad[0], aad[1])).toBe("OK");
      // 3rd byte = AAD version (1)
      expect(aad[2]).toBe(1);
      // 4th byte = nFields (4)
      expect(aad[3]).toBe(4);
    });

    it("produces byte-identical output for same inputs", () => {
      const aad1 = buildTeamKeyWrapAAD(TEST_CTX);
      const aad2 = buildTeamKeyWrapAAD(TEST_CTX);
      expect(aad1).toEqual(aad2);
    });

    it("differs when any single field changes", () => {
      const baseAAD = hexEncode(buildTeamKeyWrapAAD(TEST_CTX));
      const variants: TeamKeyWrapContext[] = [
        makeCtx({ teamId: "different-team" }),
        makeCtx({ toUserId: "different-to" }),
        makeCtx({ keyVersion: 99 }),
        makeCtx({ wrapVersion: 99 }),
      ];
      for (const variant of variants) {
        const variantAAD = hexEncode(buildTeamKeyWrapAAD(variant));
        expect(variantAAD).not.toBe(baseAAD);
      }
    });

    it("encodes field lengths as big-endian 16-bit", () => {
      const aad = buildTeamKeyWrapAAD(TEST_CTX);
      const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);
      // After header (4 bytes), first field length
      const firstFieldLen = view.getUint16(4, false);
      const encoder = new TextEncoder();
      expect(firstFieldLen).toBe(encoder.encode(TEST_CTX.teamId).length);
    });
  });

  describe("wrapTeamKeyForMember + unwrapTeamKey (round-trip)", () => {
    it("admin wraps team key, member unwraps it", async () => {
      const teamKey = generateTeamSymmetricKey();
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const saltHex = hexEncode(salt);

      // Admin generates ephemeral key pair
      const ephemeralKeyPair = await generateECDHKeyPair();
      const ephemeralPubJwk = await exportPublicKey(ephemeralKeyPair.publicKey);

      // Member has their own ECDH key pair
      const memberKeyPair = await generateECDHKeyPair();

      // Admin wraps team key for member
      const encrypted = await wrapTeamKeyForMember(
        teamKey,
        ephemeralKeyPair.privateKey,
        memberKeyPair.publicKey,
        salt,
        TEST_CTX,
      );
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toHaveLength(24); // 12 bytes hex
      expect(encrypted.authTag).toHaveLength(32); // 16 bytes hex

      // Member unwraps team key
      const unwrapped = await unwrapTeamKey(
        encrypted,
        ephemeralPubJwk,
        memberKeyPair.privateKey,
        saltHex,
        TEST_CTX,
      );

      expect(unwrapped).toEqual(teamKey);
    });

    it("fails with wrong member private key", async () => {
      const teamKey = generateTeamSymmetricKey();
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const saltHex = hexEncode(salt);
      const ephemeralKeyPair = await generateECDHKeyPair();
      const ephemeralPubJwk = await exportPublicKey(ephemeralKeyPair.publicKey);
      const memberKeyPair = await generateECDHKeyPair();
      const wrongKeyPair = await generateECDHKeyPair();

      const encrypted = await wrapTeamKeyForMember(
        teamKey,
        ephemeralKeyPair.privateKey,
        memberKeyPair.publicKey,
        salt,
        TEST_CTX,
      );

      await expect(
        unwrapTeamKey(encrypted, ephemeralPubJwk, wrongKeyPair.privateKey, saltHex, TEST_CTX),
      ).rejects.toThrow();
    });

    it("fails with wrong AAD (different teamId)", async () => {
      const teamKey = generateTeamSymmetricKey();
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const saltHex = hexEncode(salt);
      const ephemeralKeyPair = await generateECDHKeyPair();
      const ephemeralPubJwk = await exportPublicKey(ephemeralKeyPair.publicKey);
      const memberKeyPair = await generateECDHKeyPair();

      const encrypted = await wrapTeamKeyForMember(
        teamKey,
        ephemeralKeyPair.privateKey,
        memberKeyPair.publicKey,
        salt,
        TEST_CTX,
      );

      await expect(
        unwrapTeamKey(
          encrypted,
          ephemeralPubJwk,
          memberKeyPair.privateKey,
          saltHex,
          makeCtx({ teamId: "wrong-team-id" }),
        ),
      ).rejects.toThrow();
    });

    it("fails with different HKDF salt", async () => {
      const teamKey = generateTeamSymmetricKey();
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const wrongSalt = crypto.getRandomValues(new Uint8Array(32));
      const wrongSaltHex = hexEncode(wrongSalt);
      const ephemeralKeyPair = await generateECDHKeyPair();
      const ephemeralPubJwk = await exportPublicKey(ephemeralKeyPair.publicKey);
      const memberKeyPair = await generateECDHKeyPair();

      const encrypted = await wrapTeamKeyForMember(
        teamKey,
        ephemeralKeyPair.privateKey,
        memberKeyPair.publicKey,
        salt,
        TEST_CTX,
      );

      // Different salt produces different wrapping key → decryption fails
      await expect(
        unwrapTeamKey(
          encrypted,
          ephemeralPubJwk,
          memberKeyPair.privateKey,
          wrongSaltHex,
          TEST_CTX,
        ),
      ).rejects.toThrow();
    });
  });

  describe("createTeamKeyEscrow (one-shot wrap)", () => {
    it("creates escrow result with all required fields", async () => {
      const teamKey = generateTeamSymmetricKey();
      const memberKeyPair = await generateECDHKeyPair();
      const memberPubJwk = await exportPublicKey(memberKeyPair.publicKey);

      const result = await createTeamKeyEscrow(
        teamKey,
        memberPubJwk,
        TEST_TEAM_ID,
        TEST_CTX.toUserId,
        TEST_CTX.keyVersion,
      );

      expect(result.ephemeralPublicKey).toBeTruthy();
      expect(result.encryptedOrgKey).toBeTruthy();
      expect(result.orgKeyIv).toHaveLength(24);
      expect(result.orgKeyAuthTag).toHaveLength(32);
      expect(result.hkdfSalt).toHaveLength(64);
      expect(result.wrapVersion).toBe(CURRENT_TEAM_WRAP_VERSION);
      expect(result.keyVersion).toBe(1);
    });

    it("member can unwrap team key from escrow result", async () => {
      const teamKey = generateTeamSymmetricKey();
      const memberKeyPair = await generateECDHKeyPair();
      const memberPubJwk = await exportPublicKey(memberKeyPair.publicKey);

      const escrow = await createTeamKeyEscrow(
        teamKey,
        memberPubJwk,
        TEST_TEAM_ID,
        TEST_CTX.toUserId,
        TEST_CTX.keyVersion,
      );

      const unwrapped = await unwrapTeamKey(
        {
          ciphertext: escrow.encryptedOrgKey,
          iv: escrow.orgKeyIv,
          authTag: escrow.orgKeyAuthTag,
        },
        escrow.ephemeralPublicKey,
        memberKeyPair.privateKey,
        escrow.hkdfSalt,
        TEST_CTX,
      );

      expect(unwrapped).toEqual(teamKey);
    });

    it("derives same encryption key from unwrapped team key", async () => {
      const teamKey = generateTeamSymmetricKey();
      const teamEncKey = await deriveTeamEncryptionKey(teamKey);

      const memberKeyPair = await generateECDHKeyPair();
      const memberPubJwk = await exportPublicKey(memberKeyPair.publicKey);

      const escrow = await createTeamKeyEscrow(
        teamKey,
        memberPubJwk,
        TEST_TEAM_ID,
        TEST_CTX.toUserId,
        TEST_CTX.keyVersion,
      );

      const unwrapped = await unwrapTeamKey(
        {
          ciphertext: escrow.encryptedOrgKey,
          iv: escrow.orgKeyIv,
          authTag: escrow.orgKeyAuthTag,
        },
        escrow.ephemeralPublicKey,
        memberKeyPair.privateKey,
        escrow.hkdfSalt,
        TEST_CTX,
      );

      const memberEncKey = await deriveTeamEncryptionKey(unwrapped);

      // Encrypt with admin's key, decrypt with member's key
      const plaintext = "team-entry-secret-data";
      const encrypted = await encryptTeamEntry(plaintext, teamEncKey);
      const decrypted = await decryptTeamEntry(encrypted, memberEncKey);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("encryptTeamEntry + decryptTeamEntry", () => {
    it("encrypts and decrypts text data", async () => {
      const teamKey = generateTeamSymmetricKey();
      const encKey = await deriveTeamEncryptionKey(teamKey);
      const plaintext = '{"title":"My Login","password":"secret123"}';

      const encrypted = await encryptTeamEntry(plaintext, encKey);
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toHaveLength(24);
      expect(encrypted.authTag).toHaveLength(32);

      const decrypted = await decryptTeamEntry(encrypted, encKey);
      expect(decrypted).toBe(plaintext);
    });

    it("supports AAD binding", async () => {
      const teamKey = generateTeamSymmetricKey();
      const encKey = await deriveTeamEncryptionKey(teamKey);
      const plaintext = "aad-bound-data";
      const aad = new TextEncoder().encode("entry-id-123");

      const encrypted = await encryptTeamEntry(plaintext, encKey, aad);
      const decrypted = await decryptTeamEntry(encrypted, encKey, aad);
      expect(decrypted).toBe(plaintext);

      // Fails with wrong AAD
      const wrongAad = new TextEncoder().encode("wrong-entry-id");
      await expect(decryptTeamEntry(encrypted, encKey, wrongAad)).rejects.toThrow();
    });

    it("fails with wrong key", async () => {
      const teamKey1 = generateTeamSymmetricKey();
      const teamKey2 = generateTeamSymmetricKey();
      const encKey1 = await deriveTeamEncryptionKey(teamKey1);
      const encKey2 = await deriveTeamEncryptionKey(teamKey2);

      const encrypted = await encryptTeamEntry("test", encKey1);
      await expect(decryptTeamEntry(encrypted, encKey2)).rejects.toThrow();
    });
  });

  describe("encryptTeamAttachment + decryptTeamAttachment", () => {
    it("encrypts and decrypts binary data", async () => {
      const teamKey = generateTeamSymmetricKey();
      const encKey = await deriveTeamEncryptionKey(teamKey);
      const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
      const dataBuf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

      const encrypted = await encryptTeamAttachment(dataBuf, encKey);
      expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array);
      expect(encrypted.iv).toHaveLength(24);
      expect(encrypted.authTag).toHaveLength(32);

      const decrypted = await decryptTeamAttachment(encrypted, encKey);
      expect(new Uint8Array(decrypted)).toEqual(data);
    });
  });

  describe("ECDH private key encryption with ecdhWrappingKey", () => {
    it("encrypts and decrypts ECDH private key via domain-separated wrapping key", async () => {
      const secretKey = crypto.getRandomValues(new Uint8Array(32));
      const ecdhWrapKey = await deriveEcdhWrappingKey(secretKey);

      const keyPair = await generateECDHKeyPair();
      const privBytes = await exportPrivateKey(keyPair.privateKey);

      // Encrypt with ecdhWrappingKey
      const { encryptBinary, decryptBinary } = await import("./crypto-client");
      const privBuf = privBytes.buffer.slice(
        privBytes.byteOffset,
        privBytes.byteOffset + privBytes.byteLength,
      ) as ArrayBuffer;
      const encrypted = await encryptBinary(privBuf, ecdhWrapKey);

      // Decrypt
      const decrypted = await decryptBinary(encrypted, ecdhWrapKey);
      const recoveredBytes = new Uint8Array(decrypted);
      expect(recoveredBytes).toEqual(privBytes);

      // Verify the recovered bytes produce a working ECDH private key
      const recovered = await importPrivateKey(recoveredBytes);
      expect(recovered.algorithm).toMatchObject({ name: "ECDH", namedCurve: "P-256" });
    });
  });

  describe("CURRENT_TEAM_WRAP_VERSION", () => {
    it("is 1", () => {
      expect(CURRENT_TEAM_WRAP_VERSION).toBe(1);
    });
  });

  describe("HKDF_ECDH_WRAP_INFO", () => {
    it("has expected value for domain separation", () => {
      expect(HKDF_ECDH_WRAP_INFO).toBe("passwd-sso-ecdh-v1");
    });
  });

  describe("full team E2E flow", () => {
    it("simulates complete flow: team creation → key distribution → encrypt/decrypt", async () => {
      // 1. Admin creates team → generates team symmetric key
      const teamKey = generateTeamSymmetricKey();
      const teamEncKey = await deriveTeamEncryptionKey(teamKey);

      // 2. Admin encrypts team data
      const entry = '{"title":"Team Secret","password":"team-pass-123"}';
      const encryptedEntry = await encryptTeamEntry(entry, teamEncKey);

      // 3. Member joins -> admin distributes team key
      const memberKeyPair = await generateECDHKeyPair();
      const memberPubJwk = await exportPublicKey(memberKeyPair.publicKey);

      const escrow = await createTeamKeyEscrow(
        teamKey,
        memberPubJwk,
        TEST_TEAM_ID,
        "member-001",
        1,
      );

      // 4. Member unwraps team key
      const unwrapped = await unwrapTeamKey(
        {
          ciphertext: escrow.encryptedOrgKey,
          iv: escrow.orgKeyIv,
          authTag: escrow.orgKeyAuthTag,
        },
        escrow.ephemeralPublicKey,
        memberKeyPair.privateKey,
        escrow.hkdfSalt,
        {
          teamId: TEST_TEAM_ID,
          toUserId: "member-001",
          keyVersion: 1,
          wrapVersion: escrow.wrapVersion,
        },
      );

      // 5. Member derives encryption key and decrypts data
      const memberEncKey = await deriveTeamEncryptionKey(unwrapped);
      const decrypted = await decryptTeamEntry(encryptedEntry, memberEncKey);
      expect(decrypted).toBe(entry);

      // 6. Member creates new entry
      const newEntry = '{"title":"Member Entry","password":"new-pass"}';
      const newEncrypted = await encryptTeamEntry(newEntry, memberEncKey);

      // 7. Admin can decrypt member's entry
      const adminDecrypted = await decryptTeamEntry(newEncrypted, teamEncKey);
      expect(adminDecrypted).toBe(newEntry);
    });
  });

  describe("re-exports", () => {
    it("re-exports ECDH functions from crypto-emergency", () => {
      expect(typeof generateECDHKeyPair).toBe("function");
      expect(typeof exportPublicKey).toBe("function");
    });

    it("re-exports hex functions from crypto-client", () => {
      const data = new Uint8Array([0xca, 0xfe]);
      expect(hexEncode(data)).toBe("cafe");
      expect(hexDecode("cafe")).toEqual(data);
    });
  });
});
