// Regenerate the account-token ciphertext fixture used by the regression
// test in `src/lib/crypto/account-token-crypto.test.ts`.
//
// The fixture captures a known plaintext / AAD pair encrypted under a
// deterministic test master key in the on-disk envelope format
// (`psoenc1:0:<base64url(iv||tag||ct)>`). The test then asserts that
// `decryptAccountToken()` recovers the original plaintext — catching any
// AAD-byte drift introduced by helper-module refactors.
//
// IMPORTANT: this script intentionally builds AAD inline so the fixture is
// a faithful snapshot of the on-disk format, independent of the helper
// module under test. AAD shape MUST be kept in sync with `buildAccountTokenAAD`
// in `src/lib/crypto/crypto-aad.ts`. Current shape:
//   binary length-prefixed, scope "AC", 3 fields: userId, provider, providerAccountId
//
// Run: `npx tsx scripts/regenerate-account-token-legacy-fixture.ts`

import { createCipheriv, randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SENTINEL = "psoenc1:";
const AAD_VERSION = 1;

const fixture = {
  // Deterministic 256-bit test key (NOT a real production key).
  masterKeyHex:
    "0001020304050607" +
    "08090a0b0c0d0e0f" +
    "1011121314151617" +
    "18191a1b1c1d1e1f",
  masterKeyVersion: 0,
  userId: "00000000-0000-0000-0000-000000000001",
  provider: "google",
  providerAccountId: "test-provider-account-id",
  plaintext: "test_refresh_token_value",
};

const key = Buffer.from(fixture.masterKeyHex, "hex");
if (key.length !== 32) {
  throw new Error(`master key must be 32 bytes, got ${key.length}`);
}

// Build binary length-prefixed AAD (scope "AC", 3 fields) — must match
// buildAccountTokenAAD in src/lib/crypto/crypto-aad.ts.
function buildAadBytes(scope: string, fields: string[]): Buffer {
  const encoder = new TextEncoder();
  const encodedFields = fields.map((f) => encoder.encode(f));
  const headerSize = 4; // scope(2) + aadVersion(1) + nFields(1)
  const fieldsSize = encodedFields.reduce((sum, ef) => sum + 2 + ef.length, 0);
  const buf = new ArrayBuffer(headerSize + fieldsSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let offset = 0;
  bytes[offset] = scope.charCodeAt(0); bytes[offset + 1] = scope.charCodeAt(1); offset += 2;
  view.setUint8(offset, AAD_VERSION); offset += 1;
  view.setUint8(offset, fields.length); offset += 1;
  for (const encoded of encodedFields) {
    view.setUint16(offset, encoded.length, false); offset += 2;
    bytes.set(encoded, offset); offset += encoded.length;
  }
  return Buffer.from(buf);
}

const aad = buildAadBytes("AC", [fixture.userId, fixture.provider, fixture.providerAccountId]);

const iv = randomBytes(IV_LENGTH);
const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
cipher.setAAD(aad);
const ciphertextBytes = Buffer.concat([
  cipher.update(fixture.plaintext, "utf8"),
  cipher.final(),
]);
const tag = cipher.getAuthTag();
const blob = Buffer.concat([iv, tag, ciphertextBytes]).toString("base64url");
const ciphertext = `${SENTINEL}${fixture.masterKeyVersion}:${blob}`;

const out = { ...fixture, ciphertext };

const outPath = resolve(
  process.cwd(),
  "src/__tests__/fixtures/account-token-legacy-ciphertext.json",
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log(`wrote fixture: ${outPath}`);
