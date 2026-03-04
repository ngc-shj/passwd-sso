import { describe, it, expect, beforeEach } from "vitest";
import {
  setEncryptionKey,
  getEncryptionKey,
  getUserId,
  isUnlocked,
  lockVault,
} from "../../lib/vault-state.js";

// Create a mock CryptoKey for testing
async function createMockKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

describe("vault-state", () => {
  beforeEach(() => {
    lockVault(); // reset state
  });

  it("initial state is locked with no userId", () => {
    expect(isUnlocked()).toBe(false);
    expect(getEncryptionKey()).toBeNull();
    expect(getUserId()).toBeNull();
  });

  it("setEncryptionKey with userId unlocks vault and stores userId", async () => {
    const key = await createMockKey();
    setEncryptionKey(key, "user-123");

    expect(isUnlocked()).toBe(true);
    expect(getEncryptionKey()).toBe(key);
    expect(getUserId()).toBe("user-123");
  });

  it("setEncryptionKey without userId leaves userId null", async () => {
    const key = await createMockKey();
    setEncryptionKey(key);

    expect(isUnlocked()).toBe(true);
    expect(getUserId()).toBeNull();
  });

  it("lockVault clears both encryptionKey and userId", async () => {
    const key = await createMockKey();
    setEncryptionKey(key, "user-456");
    lockVault();

    expect(isUnlocked()).toBe(false);
    expect(getEncryptionKey()).toBeNull();
    expect(getUserId()).toBeNull();
  });
});
