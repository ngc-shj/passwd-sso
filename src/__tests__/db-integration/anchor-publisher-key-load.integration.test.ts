/**
 * Integration tests for KeyProvider loading audit-anchor signing keys from env.
 *
 * Verifies:
 * 1. With AUDIT_ANCHOR_PUBLISHER_ENABLED=true and valid hex env vars,
 *    getKeyProvider() returns buffers that satisfy an Ed25519 sign/verify roundtrip.
 * 2. With AUDIT_ANCHOR_PUBLISHER_ENABLED=false (or unset), validateKeys() does NOT
 *    throw (publisher disabled path).
 * 3. With AUDIT_ANCHOR_PUBLISHER_ENABLED=true but AUDIT_ANCHOR_SIGNING_KEY unset,
 *    validateKeys() throws.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { getKeyProvider, _resetKeyProvider } from "@/lib/key-provider";

// Stable 64-char hex test keys (32 bytes each)
const SIGNING_KEY_HEX = randomBytes(32).toString("hex");
const TAG_SECRET_HEX = randomBytes(32).toString("hex");

// PKCS8 private key prefix for Ed25519 (RFC 8410) — same as anchor-manifest.ts
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function buildPrivateKeyObject(seedHex: string) {
  const seed = Buffer.from(seedHex, "hex");
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function buildPublicKeyFromSeed(seedHex: string) {
  // Node crypto has no direct "seed → public key" — derive via private key object.
  return createPublicKey(buildPrivateKeyObject(seedHex));
}

describe("anchor-publisher KeyProvider — env loading", () => {
  // Store original env values to restore after each test
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      AUDIT_ANCHOR_PUBLISHER_ENABLED: process.env.AUDIT_ANCHOR_PUBLISHER_ENABLED,
      AUDIT_ANCHOR_SIGNING_KEY: process.env.AUDIT_ANCHOR_SIGNING_KEY,
      AUDIT_ANCHOR_TAG_SECRET: process.env.AUDIT_ANCHOR_TAG_SECRET,
      SHARE_MASTER_KEY: process.env.SHARE_MASTER_KEY,
      SHARE_MASTER_KEY_V1: process.env.SHARE_MASTER_KEY_V1,
      KEY_PROVIDER: process.env.KEY_PROVIDER,
    };
    _resetKeyProvider();
  });

  afterEach(() => {
    // Restore original env
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k as keyof NodeJS.ProcessEnv];
      } else {
        process.env[k] = v;
      }
    }
    _resetKeyProvider();
  });

  it("returns signing key and tag-secret buffers matching env vars; sign/verify roundtrip succeeds", async () => {
    // Ensure a SHARE_MASTER_KEY is set for validateKeys() not to fail on that path
    process.env.SHARE_MASTER_KEY = "a".repeat(64);
    process.env.AUDIT_ANCHOR_PUBLISHER_ENABLED = "true";
    process.env.AUDIT_ANCHOR_SIGNING_KEY = SIGNING_KEY_HEX;
    process.env.AUDIT_ANCHOR_TAG_SECRET = TAG_SECRET_HEX;
    process.env.KEY_PROVIDER = "env";

    const provider = await getKeyProvider();

    const signingKeyBuf = await provider.getKey("audit-anchor-signing");
    const tagSecretBuf = await provider.getKey("audit-anchor-tag-secret");

    // Buffers must match the configured hex
    expect(signingKeyBuf.toString("hex")).toBe(SIGNING_KEY_HEX);
    expect(tagSecretBuf.toString("hex")).toBe(TAG_SECRET_HEX);
    expect(signingKeyBuf.byteLength).toBe(32);
    expect(tagSecretBuf.byteLength).toBe(32);

    // Ed25519 sign/verify roundtrip using the loaded key
    const privKey = buildPrivateKeyObject(signingKeyBuf.toString("hex"));
    const pubKey = buildPublicKeyFromSeed(signingKeyBuf.toString("hex"));
    const message = Buffer.from("audit-anchor-test-payload", "utf-8");

    const sig = nodeSign(null, message, privKey);
    const valid = nodeVerify(null, message, pubKey, sig);
    expect(valid).toBe(true);

    // Verify that a different message does NOT verify with the same signature
    const wrongMessage = Buffer.from("tampered-payload", "utf-8");
    const invalid = nodeVerify(null, wrongMessage, pubKey, sig);
    expect(invalid).toBe(false);
  });

  it("validateKeys() does NOT throw when AUDIT_ANCHOR_PUBLISHER_ENABLED is unset (publisher disabled)", async () => {
    process.env.SHARE_MASTER_KEY = "a".repeat(64);
    delete process.env.AUDIT_ANCHOR_PUBLISHER_ENABLED;
    delete process.env.AUDIT_ANCHOR_SIGNING_KEY;
    delete process.env.AUDIT_ANCHOR_TAG_SECRET;
    process.env.KEY_PROVIDER = "env";

    const provider = await getKeyProvider();
    // Must not throw when publisher is disabled
    await expect(provider.validateKeys()).resolves.toBeUndefined();
  });

  it("validateKeys() does NOT throw when AUDIT_ANCHOR_PUBLISHER_ENABLED=false", async () => {
    process.env.SHARE_MASTER_KEY = "a".repeat(64);
    process.env.AUDIT_ANCHOR_PUBLISHER_ENABLED = "false";
    delete process.env.AUDIT_ANCHOR_SIGNING_KEY;
    delete process.env.AUDIT_ANCHOR_TAG_SECRET;
    process.env.KEY_PROVIDER = "env";

    const provider = await getKeyProvider();
    await expect(provider.validateKeys()).resolves.toBeUndefined();
  });

  it("validateKeys() throws when AUDIT_ANCHOR_PUBLISHER_ENABLED=true but AUDIT_ANCHOR_SIGNING_KEY is unset", async () => {
    process.env.SHARE_MASTER_KEY = "a".repeat(64);
    process.env.AUDIT_ANCHOR_PUBLISHER_ENABLED = "true";
    delete process.env.AUDIT_ANCHOR_SIGNING_KEY;
    process.env.AUDIT_ANCHOR_TAG_SECRET = TAG_SECRET_HEX;
    process.env.KEY_PROVIDER = "env";

    const provider = await getKeyProvider();
    await expect(provider.validateKeys()).rejects.toThrow("AUDIT_ANCHOR_SIGNING_KEY");
  });

  it("validateKeys() throws when AUDIT_ANCHOR_PUBLISHER_ENABLED=true but AUDIT_ANCHOR_TAG_SECRET is unset", async () => {
    process.env.SHARE_MASTER_KEY = "a".repeat(64);
    process.env.AUDIT_ANCHOR_PUBLISHER_ENABLED = "true";
    process.env.AUDIT_ANCHOR_SIGNING_KEY = SIGNING_KEY_HEX;
    delete process.env.AUDIT_ANCHOR_TAG_SECRET;
    process.env.KEY_PROVIDER = "env";

    const provider = await getKeyProvider();
    await expect(provider.validateKeys()).rejects.toThrow("AUDIT_ANCHOR_TAG_SECRET");
  });
});
