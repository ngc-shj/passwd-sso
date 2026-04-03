import { describe, it, expect, vi } from "vitest";
import {
  delegationEntryKey,
  delegationIndexKey,
  encryptDelegationEntry,
  decryptDelegationEntry,
  DELEGATION_DEFAULT_TTL_SEC,
  DELEGATION_MAX_TTL_SEC,
  DELEGATION_MAX_ENTRIES,
  DELEGATION_MIN_TTL_SEC,
} from "./delegation";

// Mock crypto-server — must mock before import
vi.mock("@/lib/crypto-server", async () => {
  const nodeCrypto = await import("node:crypto");
  const { createCipheriv, createDecipheriv, randomBytes } = nodeCrypto;
  const ALGORITHM = "aes-256-gcm";
  const IV_LENGTH = 12;
  const AUTH_TAG_LENGTH = 16;
  // Use a fixed test key
  const testKey = Buffer.from("a".repeat(64), "hex");

  return {
    getCurrentMasterKeyVersion: vi.fn(() => 1),
    getMasterKeyByVersion: vi.fn(() => testKey),
    encryptServerData: vi.fn((plaintext: string, key: Buffer, aad?: Buffer) => {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
      if (aad) cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return {
        ciphertext: ciphertext.toString("hex"),
        iv: iv.toString("hex"),
        authTag: authTag.toString("hex"),
      };
    }),
    decryptServerData: vi.fn((encrypted: { ciphertext: string; iv: string; authTag: string }, key: Buffer, aad?: Buffer) => {
      const iv = Buffer.from(encrypted.iv, "hex");
      const authTag = Buffer.from(encrypted.authTag, "hex");
      const ciphertext = Buffer.from(encrypted.ciphertext, "hex");
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
      if (aad) decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    }),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/redis", () => ({ getRedis: vi.fn(() => null) }));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withBypassRls: vi.fn((_p: unknown, fn: () => unknown) => fn()) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

describe("delegation", () => {
  describe("Redis key builders", () => {
    it("delegationEntryKey builds correct format", () => {
      const key = delegationEntryKey("user-1", "session-1", "entry-1");
      expect(key).toBe("delegation:user-1:session-1:entry:entry-1");
    });

    it("delegationIndexKey builds correct format", () => {
      const key = delegationIndexKey("user-1", "session-1");
      expect(key).toBe("delegation:user-1:session-1:entries_index");
    });

    it("keys with different IDs are distinct", () => {
      const k1 = delegationEntryKey("u1", "s1", "e1");
      const k2 = delegationEntryKey("u1", "s1", "e2");
      expect(k1).not.toBe(k2);
    });

    it("different sessions for same user produce distinct keys", () => {
      const k1 = delegationEntryKey("u1", "s1", "e1");
      const k2 = delegationEntryKey("u1", "s2", "e1");
      expect(k1).not.toBe(k2);
    });
  });

  describe("envelope encryption", () => {
    it("encrypt/decrypt round-trip preserves data", () => {
      const plaintext = JSON.stringify({ id: "test", title: "GitHub", password: "secret" });
      const aadKey = "delegation:user:session:entry:test";
      const payload = encryptDelegationEntry(plaintext, aadKey);
      const decrypted = decryptDelegationEntry(payload, aadKey);
      expect(decrypted).toBe(plaintext);
    });

    it("includes masterKeyVersion in payload", () => {
      const payload = encryptDelegationEntry("test", "aad");
      expect(payload.masterKeyVersion).toBe(1);
      expect(payload.encrypted).toBeDefined();
      expect(payload.encrypted.ciphertext).toBeDefined();
      expect(payload.encrypted.iv).toBeDefined();
      expect(payload.encrypted.authTag).toBeDefined();
    });

    it("decryption with wrong AAD fails", () => {
      const payload = encryptDelegationEntry("test", "correct-aad");
      expect(() => decryptDelegationEntry(payload, "wrong-aad")).toThrow();
    });

    it("same plaintext produces different ciphertext (random IV)", () => {
      const p1 = encryptDelegationEntry("same", "aad");
      const p2 = encryptDelegationEntry("same", "aad");
      expect(p1.encrypted.ciphertext).not.toBe(p2.encrypted.ciphertext);
    });
  });

  describe("constants", () => {
    it("has correct default values", () => {
      expect(DELEGATION_DEFAULT_TTL_SEC).toBe(900);
      expect(DELEGATION_MAX_TTL_SEC).toBe(3600);
      expect(DELEGATION_MAX_ENTRIES).toBe(20);
      expect(DELEGATION_MIN_TTL_SEC).toBe(300);
    });
  });
});
