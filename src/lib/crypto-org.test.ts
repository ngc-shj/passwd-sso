import { describe, it, expect } from "vitest";
import {
  generateOrgSymmetricKey,
  deriveOrgEncryptionKey,
  deriveEcdhWrappingKey,
  wrapOrgKeyForMember,
  unwrapOrgKey,
  createOrgKeyEscrow,
  encryptOrgEntry,
  decryptOrgEntry,
  encryptOrgAttachment,
  decryptOrgAttachment,
  buildOrgKeyWrapAAD,
  CURRENT_ORG_WRAP_VERSION,
  HKDF_ECDH_WRAP_INFO,
  generateECDHKeyPair,
  exportPublicKey,
  exportPrivateKey,
  importPrivateKey,
  hexEncode,
  hexDecode,
  type OrgKeyWrapContext,
} from "./crypto-org";
import { deriveEncryptionKey } from "./crypto-client";

const TEST_ORG_ID = "org-test-001";

const TEST_CTX: OrgKeyWrapContext = {
  orgId: TEST_ORG_ID,
  toUserId: "member-user-002",
  keyVersion: 1,
  wrapVersion: CURRENT_ORG_WRAP_VERSION,
};

function makeCtx(overrides?: Partial<OrgKeyWrapContext>): OrgKeyWrapContext {
  return { ...TEST_CTX, ...overrides };
}

describe("crypto-org", () => {
  describe("generateOrgSymmetricKey", () => {
    it("generates a 32-byte (256-bit) random key", () => {
      const key = generateOrgSymmetricKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it("generates unique keys each time", () => {
      const key1 = generateOrgSymmetricKey();
      const key2 = generateOrgSymmetricKey();
      expect(hexEncode(key1)).not.toBe(hexEncode(key2));
    });
  });

  describe("deriveOrgEncryptionKey", () => {
    it("derives an AES-256-GCM key from org symmetric key", async () => {
      const orgKey = generateOrgSymmetricKey();
      const encKey = await deriveOrgEncryptionKey(orgKey);
      expect(encKey.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
      expect(encKey.usages).toContain("encrypt");
      expect(encKey.usages).toContain("decrypt");
    });

    it("produces deterministic output for same input", async () => {
      const orgKey = generateOrgSymmetricKey();
      const key1 = await deriveOrgEncryptionKey(orgKey);
      const key2 = await deriveOrgEncryptionKey(orgKey);

      // Encrypt with key1, decrypt with key2
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
      const data = new TextEncoder().encode("test-data");
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivBuf }, key1, data);
      const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuf }, key2, encrypted);
      expect(new TextDecoder().decode(decrypted)).toBe("test-data");
    });

    it("different org keys produce different encryption keys", async () => {
      const orgKey1 = generateOrgSymmetricKey();
      const orgKey2 = generateOrgSymmetricKey();
      const encKey1 = await deriveOrgEncryptionKey(orgKey1);
      const encKey2 = await deriveOrgEncryptionKey(orgKey2);

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

  describe("buildOrgKeyWrapAAD", () => {
    it("produces binary format with scope 'OK'", () => {
      const aad = buildOrgKeyWrapAAD(TEST_CTX);
      expect(aad).toBeInstanceOf(Uint8Array);
      // First 2 bytes = "OK"
      expect(String.fromCharCode(aad[0], aad[1])).toBe("OK");
      // 3rd byte = AAD version (1)
      expect(aad[2]).toBe(1);
      // 4th byte = nFields (4)
      expect(aad[3]).toBe(4);
    });

    it("produces byte-identical output for same inputs", () => {
      const aad1 = buildOrgKeyWrapAAD(TEST_CTX);
      const aad2 = buildOrgKeyWrapAAD(TEST_CTX);
      expect(aad1).toEqual(aad2);
    });

    it("differs when any single field changes", () => {
      const baseAAD = hexEncode(buildOrgKeyWrapAAD(TEST_CTX));
      const variants: OrgKeyWrapContext[] = [
        makeCtx({ orgId: "different-org" }),
        makeCtx({ toUserId: "different-to" }),
        makeCtx({ keyVersion: 99 }),
        makeCtx({ wrapVersion: 99 }),
      ];
      for (const variant of variants) {
        const variantAAD = hexEncode(buildOrgKeyWrapAAD(variant));
        expect(variantAAD).not.toBe(baseAAD);
      }
    });

    it("encodes field lengths as big-endian 16-bit", () => {
      const aad = buildOrgKeyWrapAAD(TEST_CTX);
      const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);
      // After header (4 bytes), first field length
      const firstFieldLen = view.getUint16(4, false);
      const encoder = new TextEncoder();
      expect(firstFieldLen).toBe(encoder.encode(TEST_CTX.orgId).length);
    });
  });

  describe("wrapOrgKeyForMember + unwrapOrgKey (round-trip)", () => {
    it("admin wraps org key, member unwraps it", async () => {
      const orgKey = generateOrgSymmetricKey();
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const saltHex = hexEncode(salt);

      // Admin generates ephemeral key pair
      const ephemeralKeyPair = await generateECDHKeyPair();
      const ephemeralPubJwk = await exportPublicKey(ephemeralKeyPair.publicKey);

      // Member has their own ECDH key pair
      const memberKeyPair = await generateECDHKeyPair();

      // Admin wraps org key for member
      const encrypted = await wrapOrgKeyForMember(
        orgKey,
        ephemeralKeyPair.privateKey,
        memberKeyPair.publicKey,
        salt,
        TEST_CTX,
      );
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toHaveLength(24); // 12 bytes hex
      expect(encrypted.authTag).toHaveLength(32); // 16 bytes hex

      // Member unwraps org key
      const unwrapped = await unwrapOrgKey(
        encrypted,
        ephemeralPubJwk,
        memberKeyPair.privateKey,
        saltHex,
        TEST_CTX,
      );

      expect(unwrapped).toEqual(orgKey);
    });

    it("fails with wrong member private key", async () => {
      const orgKey = generateOrgSymmetricKey();
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const saltHex = hexEncode(salt);
      const ephemeralKeyPair = await generateECDHKeyPair();
      const ephemeralPubJwk = await exportPublicKey(ephemeralKeyPair.publicKey);
      const memberKeyPair = await generateECDHKeyPair();
      const wrongKeyPair = await generateECDHKeyPair();

      const encrypted = await wrapOrgKeyForMember(
        orgKey,
        ephemeralKeyPair.privateKey,
        memberKeyPair.publicKey,
        salt,
        TEST_CTX,
      );

      await expect(
        unwrapOrgKey(encrypted, ephemeralPubJwk, wrongKeyPair.privateKey, saltHex, TEST_CTX),
      ).rejects.toThrow();
    });

    it("fails with wrong AAD (different orgId)", async () => {
      const orgKey = generateOrgSymmetricKey();
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const saltHex = hexEncode(salt);
      const ephemeralKeyPair = await generateECDHKeyPair();
      const ephemeralPubJwk = await exportPublicKey(ephemeralKeyPair.publicKey);
      const memberKeyPair = await generateECDHKeyPair();

      const encrypted = await wrapOrgKeyForMember(
        orgKey,
        ephemeralKeyPair.privateKey,
        memberKeyPair.publicKey,
        salt,
        TEST_CTX,
      );

      await expect(
        unwrapOrgKey(
          encrypted,
          ephemeralPubJwk,
          memberKeyPair.privateKey,
          saltHex,
          makeCtx({ orgId: "wrong-org-id" }),
        ),
      ).rejects.toThrow();
    });

    it("fails with different HKDF salt", async () => {
      const orgKey = generateOrgSymmetricKey();
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const wrongSalt = crypto.getRandomValues(new Uint8Array(32));
      const wrongSaltHex = hexEncode(wrongSalt);
      const ephemeralKeyPair = await generateECDHKeyPair();
      const ephemeralPubJwk = await exportPublicKey(ephemeralKeyPair.publicKey);
      const memberKeyPair = await generateECDHKeyPair();

      const encrypted = await wrapOrgKeyForMember(
        orgKey,
        ephemeralKeyPair.privateKey,
        memberKeyPair.publicKey,
        salt,
        TEST_CTX,
      );

      // Different salt produces different wrapping key → decryption fails
      await expect(
        unwrapOrgKey(
          encrypted,
          ephemeralPubJwk,
          memberKeyPair.privateKey,
          wrongSaltHex,
          TEST_CTX,
        ),
      ).rejects.toThrow();
    });
  });

  describe("createOrgKeyEscrow (one-shot wrap)", () => {
    it("creates escrow result with all required fields", async () => {
      const orgKey = generateOrgSymmetricKey();
      const memberKeyPair = await generateECDHKeyPair();
      const memberPubJwk = await exportPublicKey(memberKeyPair.publicKey);

      const result = await createOrgKeyEscrow(
        orgKey,
        memberPubJwk,
        TEST_ORG_ID,
        TEST_CTX.toUserId,
        TEST_CTX.keyVersion,
      );

      expect(result.ephemeralPublicKey).toBeTruthy();
      expect(result.encryptedOrgKey).toBeTruthy();
      expect(result.orgKeyIv).toHaveLength(24);
      expect(result.orgKeyAuthTag).toHaveLength(32);
      expect(result.hkdfSalt).toHaveLength(64);
      expect(result.wrapVersion).toBe(CURRENT_ORG_WRAP_VERSION);
      expect(result.keyVersion).toBe(1);
    });

    it("member can unwrap org key from escrow result", async () => {
      const orgKey = generateOrgSymmetricKey();
      const memberKeyPair = await generateECDHKeyPair();
      const memberPubJwk = await exportPublicKey(memberKeyPair.publicKey);

      const escrow = await createOrgKeyEscrow(
        orgKey,
        memberPubJwk,
        TEST_ORG_ID,
        TEST_CTX.toUserId,
        TEST_CTX.keyVersion,
      );

      const unwrapped = await unwrapOrgKey(
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

      expect(unwrapped).toEqual(orgKey);
    });

    it("derives same encryption key from unwrapped org key", async () => {
      const orgKey = generateOrgSymmetricKey();
      const orgEncKey = await deriveOrgEncryptionKey(orgKey);

      const memberKeyPair = await generateECDHKeyPair();
      const memberPubJwk = await exportPublicKey(memberKeyPair.publicKey);

      const escrow = await createOrgKeyEscrow(
        orgKey,
        memberPubJwk,
        TEST_ORG_ID,
        TEST_CTX.toUserId,
        TEST_CTX.keyVersion,
      );

      const unwrapped = await unwrapOrgKey(
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

      const memberEncKey = await deriveOrgEncryptionKey(unwrapped);

      // Encrypt with admin's key, decrypt with member's key
      const plaintext = "org-entry-secret-data";
      const encrypted = await encryptOrgEntry(plaintext, orgEncKey);
      const decrypted = await decryptOrgEntry(encrypted, memberEncKey);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("encryptOrgEntry + decryptOrgEntry", () => {
    it("encrypts and decrypts text data", async () => {
      const orgKey = generateOrgSymmetricKey();
      const encKey = await deriveOrgEncryptionKey(orgKey);
      const plaintext = '{"title":"My Login","password":"secret123"}';

      const encrypted = await encryptOrgEntry(plaintext, encKey);
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toHaveLength(24);
      expect(encrypted.authTag).toHaveLength(32);

      const decrypted = await decryptOrgEntry(encrypted, encKey);
      expect(decrypted).toBe(plaintext);
    });

    it("supports AAD binding", async () => {
      const orgKey = generateOrgSymmetricKey();
      const encKey = await deriveOrgEncryptionKey(orgKey);
      const plaintext = "aad-bound-data";
      const aad = new TextEncoder().encode("entry-id-123");

      const encrypted = await encryptOrgEntry(plaintext, encKey, aad);
      const decrypted = await decryptOrgEntry(encrypted, encKey, aad);
      expect(decrypted).toBe(plaintext);

      // Fails with wrong AAD
      const wrongAad = new TextEncoder().encode("wrong-entry-id");
      await expect(decryptOrgEntry(encrypted, encKey, wrongAad)).rejects.toThrow();
    });

    it("fails with wrong key", async () => {
      const orgKey1 = generateOrgSymmetricKey();
      const orgKey2 = generateOrgSymmetricKey();
      const encKey1 = await deriveOrgEncryptionKey(orgKey1);
      const encKey2 = await deriveOrgEncryptionKey(orgKey2);

      const encrypted = await encryptOrgEntry("test", encKey1);
      await expect(decryptOrgEntry(encrypted, encKey2)).rejects.toThrow();
    });
  });

  describe("encryptOrgAttachment + decryptOrgAttachment", () => {
    it("encrypts and decrypts binary data", async () => {
      const orgKey = generateOrgSymmetricKey();
      const encKey = await deriveOrgEncryptionKey(orgKey);
      const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
      const dataBuf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

      const encrypted = await encryptOrgAttachment(dataBuf, encKey);
      expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array);
      expect(encrypted.iv).toHaveLength(24);
      expect(encrypted.authTag).toHaveLength(32);

      const decrypted = await decryptOrgAttachment(encrypted, encKey);
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

  describe("CURRENT_ORG_WRAP_VERSION", () => {
    it("is 1", () => {
      expect(CURRENT_ORG_WRAP_VERSION).toBe(1);
    });
  });

  describe("HKDF_ECDH_WRAP_INFO", () => {
    it("has expected value for domain separation", () => {
      expect(HKDF_ECDH_WRAP_INFO).toBe("passwd-sso-ecdh-v1");
    });
  });

  describe("full org E2E flow", () => {
    it("simulates complete flow: org creation → key distribution → encrypt/decrypt", async () => {
      // 1. Admin creates org → generates org symmetric key
      const orgKey = generateOrgSymmetricKey();
      const orgEncKey = await deriveOrgEncryptionKey(orgKey);

      // 2. Admin encrypts org data
      const entry = '{"title":"Org Secret","password":"org-pass-123"}';
      const encryptedEntry = await encryptOrgEntry(entry, orgEncKey);

      // 3. Member joins → admin distributes org key
      const memberKeyPair = await generateECDHKeyPair();
      const memberPubJwk = await exportPublicKey(memberKeyPair.publicKey);

      const escrow = await createOrgKeyEscrow(
        orgKey,
        memberPubJwk,
        TEST_ORG_ID,
        "member-001",
        1,
      );

      // 4. Member unwraps org key
      const unwrapped = await unwrapOrgKey(
        {
          ciphertext: escrow.encryptedOrgKey,
          iv: escrow.orgKeyIv,
          authTag: escrow.orgKeyAuthTag,
        },
        escrow.ephemeralPublicKey,
        memberKeyPair.privateKey,
        escrow.hkdfSalt,
        {
          orgId: TEST_ORG_ID,
          toUserId: "member-001",
          keyVersion: 1,
          wrapVersion: escrow.wrapVersion,
        },
      );

      // 5. Member derives encryption key and decrypts data
      const memberEncKey = await deriveOrgEncryptionKey(unwrapped);
      const decrypted = await decryptOrgEntry(encryptedEntry, memberEncKey);
      expect(decrypted).toBe(entry);

      // 6. Member creates new entry
      const newEntry = '{"title":"Member Entry","password":"new-pass"}';
      const newEncrypted = await encryptOrgEntry(newEntry, memberEncKey);

      // 7. Admin can decrypt member's entry
      const adminDecrypted = await decryptOrgEntry(newEncrypted, orgEncKey);
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
