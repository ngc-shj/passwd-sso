/**
 * Tests for loadKey — focuses on the requireReprompt defensive default (C8/C9).
 * A non-boolean requireReprompt (serializer regression) must default deny-side
 * to true, never permissive false.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { loadKey, getLoadedKeys, clearKeys } from "../../lib/ssh-key-agent.js";

// A real ed25519 PKCS#8 PEM so createPrivateKey succeeds.
const { privateKey: pem } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

// publicKeyBlob content is opaque to loadKey; any Buffer works for these tests.
const pubBlob = Buffer.from("ssh-ed25519-test-blob");

describe("loadKey requireReprompt defensive default", () => {
  beforeEach(() => clearKeys());

  it("stores requireReprompt=true when passed true", async () => {
    const key = await loadKey("e1", pem, pubBlob, "c", undefined, true);
    expect(key.requireReprompt).toBe(true);
  });

  it("stores requireReprompt=false when passed false", async () => {
    const key = await loadKey("e2", pem, pubBlob, "c", undefined, false);
    expect(key.requireReprompt).toBe(false);
  });

  it("defaults to true (deny-side) when requireReprompt is undefined", async () => {
    const key = await loadKey("e3", pem, pubBlob, "c", undefined, undefined);
    expect(key.requireReprompt).toBe(true);
  });

  it("defaults to true (deny-side) when requireReprompt is a non-boolean (serializer regression)", async () => {
    // Simulate a serializer returning a non-boolean (e.g. undefined-as-string / null).
    const bad = "yes" as unknown as boolean;
    const key = await loadKey("e4", pem, pubBlob, "c", undefined, bad);
    expect(key.requireReprompt).toBe(true);
  });

  it("exposes entryId and a detected keyType on the loaded record", async () => {
    const key = await loadKey("e5", pem, pubBlob, "c", undefined, false);
    expect(key.entryId).toBe("e5");
    expect(key.keyType).toBe("ed25519");
    expect(getLoadedKeys().map((k) => k.entryId)).toContain("e5");
  });
});
