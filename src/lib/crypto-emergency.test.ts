import { describe, it, expect } from "vitest";
import {
  generateECDHKeyPair,
  exportPublicKey,
  exportPrivateKey,
  importPublicKey,
  importPrivateKey,
  deriveSharedKey,
  encryptPrivateKey,
  decryptPrivateKey,
  createKeyEscrow,
  unwrapSecretKeyAsGrantee,
  type WrapContext,
} from "./crypto-emergency";
import { deriveEncryptionKey, hexDecode } from "./crypto-client";

const TEST_CTX: Omit<WrapContext, "wrapVersion" | "keyVersion"> = {
  grantId: "test-grant-id-123",
  ownerId: "owner-user-001",
  granteeId: "grantee-user-002",
};

function makeWrapCtx(overrides?: Partial<WrapContext>): WrapContext {
  return { ...TEST_CTX, keyVersion: 1, wrapVersion: 1, ...overrides };
}

describe("crypto-emergency", () => {
  describe("generateECDHKeyPair", () => {
    it("generates a valid ECDH key pair", async () => {
      const keyPair = await generateECDHKeyPair();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
      expect(keyPair.publicKey.algorithm).toMatchObject({ name: "ECDH", namedCurve: "P-256" });
    });
  });

  describe("key export/import round-trip", () => {
    it("exports and imports public key via JWK", async () => {
      const keyPair = await generateECDHKeyPair();
      const jwkString = await exportPublicKey(keyPair.publicKey);

      expect(typeof jwkString).toBe("string");
      const jwk = JSON.parse(jwkString);
      expect(jwk.kty).toBe("EC");
      expect(jwk.crv).toBe("P-256");

      const imported = await importPublicKey(jwkString);
      expect(imported.algorithm).toMatchObject({ name: "ECDH", namedCurve: "P-256" });
    });

    it("exports and imports private key via PKCS8", async () => {
      const keyPair = await generateECDHKeyPair();
      const pkcs8 = await exportPrivateKey(keyPair.privateKey);

      expect(pkcs8).toBeInstanceOf(Uint8Array);
      expect(pkcs8.length).toBeGreaterThan(0);

      const imported = await importPrivateKey(pkcs8);
      expect(imported.algorithm).toMatchObject({ name: "ECDH", namedCurve: "P-256" });
    });
  });

  describe("deriveSharedKey", () => {
    it("derives identical shared keys from both sides", async () => {
      const aliceKeyPair = await generateECDHKeyPair();
      const bobKeyPair = await generateECDHKeyPair();
      const salt = crypto.getRandomValues(new Uint8Array(32));

      // Alice derives shared key using her private + Bob's public
      const aliceShared = await deriveSharedKey(aliceKeyPair.privateKey, bobKeyPair.publicKey, salt);
      // Bob derives shared key using his private + Alice's public
      const bobShared = await deriveSharedKey(bobKeyPair.privateKey, aliceKeyPair.publicKey, salt);

      // Encrypt with Alice's key, decrypt with Bob's key
      const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength);
      const ptBuf = plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength);

      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: ivBuf },
        aliceShared,
        ptBuf
      );

      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: ivBuf },
        bobShared,
        encrypted
      );

      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });

    it("different salts produce different keys", async () => {
      const aliceKeyPair = await generateECDHKeyPair();
      const bobKeyPair = await generateECDHKeyPair();
      const salt1 = crypto.getRandomValues(new Uint8Array(32));
      const salt2 = crypto.getRandomValues(new Uint8Array(32));

      const key1 = await deriveSharedKey(aliceKeyPair.privateKey, bobKeyPair.publicKey, salt1);
      const key2 = await deriveSharedKey(aliceKeyPair.privateKey, bobKeyPair.publicKey, salt2);

      // Encrypt with key1, should fail to decrypt with key2
      const plaintext = new Uint8Array([1, 2, 3]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength);
      const ptBuf = plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength);

      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: ivBuf },
        key1,
        ptBuf
      );

      await expect(
        crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuf }, key2, encrypted)
      ).rejects.toThrow();
    });
  });

  describe("private key encryption", () => {
    it("encrypts and decrypts grantee ECDH private key", async () => {
      // Generate a mock vault encryptionKey
      const secretKey = crypto.getRandomValues(new Uint8Array(32));
      const encKey = await deriveEncryptionKey(secretKey);

      // Generate ECDH key pair
      const keyPair = await generateECDHKeyPair();
      const privateKeyBytes = await exportPrivateKey(keyPair.privateKey);

      // Encrypt private key
      const encrypted = await encryptPrivateKey(privateKeyBytes, encKey);
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toHaveLength(24);
      expect(encrypted.authTag).toHaveLength(32);

      // Decrypt private key
      const decrypted = await decryptPrivateKey(encrypted, encKey);
      expect(decrypted).toEqual(privateKeyBytes);

      // Verify the decrypted bytes import correctly
      const imported = await importPrivateKey(decrypted);
      expect(imported.algorithm).toMatchObject({ name: "ECDH", namedCurve: "P-256" });
    });
  });

  describe("createKeyEscrow + unwrapSecretKeyAsGrantee (full round-trip)", () => {
    it("owner wraps secretKey, grantee unwraps it", async () => {
      // Simulate owner's secret key (random 256-bit)
      const ownerSecretKey = crypto.getRandomValues(new Uint8Array(32));

      // Grantee generates ECDH key pair
      const granteeKeyPair = await generateECDHKeyPair();
      const granteePublicKeyJwk = await exportPublicKey(granteeKeyPair.publicKey);

      // Owner creates key escrow (with WrapContext for AAD)
      const escrow = await createKeyEscrow(ownerSecretKey, granteePublicKeyJwk, TEST_CTX);
      expect(escrow.ownerEphemeralPublicKey).toBeTruthy();
      expect(escrow.encryptedSecretKey).toBeTruthy();
      expect(escrow.secretKeyIv).toHaveLength(24);
      expect(escrow.secretKeyAuthTag).toHaveLength(32);
      expect(escrow.hkdfSalt).toHaveLength(64); // 32 bytes hex
      expect(escrow.wrapVersion).toBe(1);

      // Grantee unwraps owner's secret key (with same salt and WrapContext)
      const unwrapped = await unwrapSecretKeyAsGrantee(
        {
          ciphertext: escrow.encryptedSecretKey,
          iv: escrow.secretKeyIv,
          authTag: escrow.secretKeyAuthTag,
        },
        escrow.ownerEphemeralPublicKey,
        granteeKeyPair.privateKey,
        hexDecode(escrow.hkdfSalt),
        makeWrapCtx()
      );

      expect(unwrapped).toEqual(ownerSecretKey);
    });

    it("derives same encryptionKey from unwrapped secretKey", async () => {
      const ownerSecretKey = crypto.getRandomValues(new Uint8Array(32));
      const ownerEncKey = await deriveEncryptionKey(ownerSecretKey);

      const granteeKeyPair = await generateECDHKeyPair();
      const granteePublicKeyJwk = await exportPublicKey(granteeKeyPair.publicKey);

      const escrow = await createKeyEscrow(ownerSecretKey, granteePublicKeyJwk, TEST_CTX);

      const unwrapped = await unwrapSecretKeyAsGrantee(
        {
          ciphertext: escrow.encryptedSecretKey,
          iv: escrow.secretKeyIv,
          authTag: escrow.secretKeyAuthTag,
        },
        escrow.ownerEphemeralPublicKey,
        granteeKeyPair.privateKey,
        hexDecode(escrow.hkdfSalt),
        makeWrapCtx()
      );

      const granteeEncKey = await deriveEncryptionKey(unwrapped);

      // Encrypt with owner's key, decrypt with grantee's derived key
      const plaintext = "test vault data";
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength);
      const ptBuf = new TextEncoder().encode(plaintext);

      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: ivBuf },
        ownerEncKey,
        ptBuf
      );

      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: ivBuf },
        granteeEncKey,
        encrypted
      );

      expect(new TextDecoder().decode(decrypted)).toBe(plaintext);
    });

    it("fails with wrong grantee private key", async () => {
      const ownerSecretKey = crypto.getRandomValues(new Uint8Array(32));

      const granteeKeyPair = await generateECDHKeyPair();
      const granteePublicKeyJwk = await exportPublicKey(granteeKeyPair.publicKey);

      const escrow = await createKeyEscrow(ownerSecretKey, granteePublicKeyJwk, TEST_CTX);

      // Wrong key pair
      const wrongKeyPair = await generateECDHKeyPair();

      await expect(
        unwrapSecretKeyAsGrantee(
          {
            ciphertext: escrow.encryptedSecretKey,
            iv: escrow.secretKeyIv,
            authTag: escrow.secretKeyAuthTag,
          },
          escrow.ownerEphemeralPublicKey,
          wrongKeyPair.privateKey,
          hexDecode(escrow.hkdfSalt),
          makeWrapCtx()
        )
      ).rejects.toThrow();
    });

    it("fails with wrong AAD (different grantId)", async () => {
      const ownerSecretKey = crypto.getRandomValues(new Uint8Array(32));

      const granteeKeyPair = await generateECDHKeyPair();
      const granteePublicKeyJwk = await exportPublicKey(granteeKeyPair.publicKey);

      const escrow = await createKeyEscrow(ownerSecretKey, granteePublicKeyJwk, TEST_CTX);

      // Try unwrapping with a different grantId (AAD mismatch)
      await expect(
        unwrapSecretKeyAsGrantee(
          {
            ciphertext: escrow.encryptedSecretKey,
            iv: escrow.secretKeyIv,
            authTag: escrow.secretKeyAuthTag,
          },
          escrow.ownerEphemeralPublicKey,
          granteeKeyPair.privateKey,
          hexDecode(escrow.hkdfSalt),
          makeWrapCtx({ grantId: "wrong-grant-id" })
        )
      ).rejects.toThrow();
    });
  });

  describe("full emergency access crypto flow", () => {
    it("simulates the complete flow from invitation to vault access", async () => {
      const fullFlowCtx: Omit<WrapContext, "wrapVersion" | "keyVersion"> = {
        grantId: "full-flow-grant-001",
        ownerId: "full-flow-owner",
        granteeId: "full-flow-grantee",
      };

      // 1. Owner has a vault with a secretKey
      const ownerSecretKey = crypto.getRandomValues(new Uint8Array(32));
      const ownerEncKey = await deriveEncryptionKey(ownerSecretKey);

      // 2. Grantee generates ECDH key pair and encrypts private key
      const granteeVaultSecretKey = crypto.getRandomValues(new Uint8Array(32));
      const granteeEncKey = await deriveEncryptionKey(granteeVaultSecretKey);

      const granteeECDH = await generateECDHKeyPair();
      const granteePublicKeyJwk = await exportPublicKey(granteeECDH.publicKey);
      const granteePrivateKeyBytes = await exportPrivateKey(granteeECDH.privateKey);
      const encryptedGranteePrivKey = await encryptPrivateKey(granteePrivateKeyBytes, granteeEncKey);

      // 3. Owner performs key escrow (on vault unlock)
      const escrow = await createKeyEscrow(ownerSecretKey, granteePublicKeyJwk, fullFlowCtx);
      expect(escrow.hkdfSalt).toHaveLength(64);
      expect(escrow.wrapVersion).toBe(1);

      // 4. Later: Grantee recovers their ECDH private key
      const recoveredPrivKeyBytes = await decryptPrivateKey(encryptedGranteePrivKey, granteeEncKey);
      const recoveredPrivKey = await importPrivateKey(recoveredPrivKeyBytes);

      // 5. Grantee unwraps owner's secretKey (with salt + WrapContext AAD)
      const unwrappedSecretKey = await unwrapSecretKeyAsGrantee(
        {
          ciphertext: escrow.encryptedSecretKey,
          iv: escrow.secretKeyIv,
          authTag: escrow.secretKeyAuthTag,
        },
        escrow.ownerEphemeralPublicKey,
        recoveredPrivKey,
        hexDecode(escrow.hkdfSalt),
        { ...fullFlowCtx, keyVersion: 1, wrapVersion: escrow.wrapVersion }
      );

      // 6. Grantee derives owner's encryptionKey
      const derivedOwnerEncKey = await deriveEncryptionKey(unwrappedSecretKey);

      // 7. Verify: encrypt with owner's key, decrypt with grantee's derived key
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength);
      const data = new TextEncoder().encode('{"title":"My Login","password":"secret123"}');

      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: ivBuf },
        ownerEncKey,
        data
      );

      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: ivBuf },
        derivedOwnerEncKey,
        ciphertext
      );

      expect(new TextDecoder().decode(plaintext)).toBe('{"title":"My Login","password":"secret123"}');
    });
  });
});
