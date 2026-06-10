#!/usr/bin/env node
// Regenerates ios/../extension/test/fixtures/vault-unlock-fixture.json — a
// cross-platform parity fixture for the iOS VaultUnlocker test (C13.3 / M6).
//
// It produces the SAME wire shape the web crypto-client emits for the
// kdfType=0 (PBKDF2-SHA256 → AES-256-GCM) path, using the identical Web Crypto
// algorithm/parameters (see src/lib/crypto/crypto-client.ts deriveWrapping
// KeyWithParams + wrapSecretKey). Deterministic inputs (fixed salt + secret
// key) so the committed fixture is stable and the iOS test can assert the
// derived vault key. The iOS test feeds this to the REAL VaultUnlocker; a drift
// between the web hex format and iOS hexDecode turns that test red.
import { webcrypto as crypto } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PBKDF2_ITERATIONS = 600_000; // matches crypto-client PBKDF2_ITERATIONS
const PASSPHRASE = "cross-platform-test-passphrase";
const accountSalt = new Uint8Array(32).fill(0xaa);
const secretKey = new Uint8Array(32).fill(0x42);

const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const keyMaterial = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(PASSPHRASE),
  "PBKDF2",
  false,
  ["deriveKey"],
);
const wrappingKey = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt: accountSalt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
  keyMaterial,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt"],
);
const iv = new Uint8Array(12).fill(0x11);
const encrypted = new Uint8Array(
  await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrappingKey, secretKey),
);
// Web Crypto appends the 16-byte auth tag to the ciphertext.
const ciphertext = encrypted.slice(0, encrypted.length - 16);
const authTag = encrypted.slice(encrypted.length - 16);

const fixture = {
  _comment:
    "Web-Crypto-generated (PBKDF2-SHA256 600k → AES-256-GCM), matching crypto-client kdfType=0. Regenerate via scripts/generate-vault-unlock-fixture.mjs.",
  passphrase: PASSPHRASE,
  accountSalt: hex(accountSalt),
  encryptedSecretKey: hex(ciphertext),
  secretKeyIv: hex(iv),
  secretKeyAuthTag: hex(authTag),
  keyVersion: 1,
  kdfType: 0,
  kdfIterations: PBKDF2_ITERATIONS,
  userId: "cross-platform-user",
  expectedSecretKeyHex: hex(secretKey),
};

const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../extension/test/fixtures/vault-unlock-fixture.json",
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${out}`);
