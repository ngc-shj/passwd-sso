// Regenerate the legacy account-token ciphertext fixture used by the
// `decryptAccountToken` regression test in
// `src/lib/crypto/account-token-crypto.test.ts`.
//
// The fixture captures a known plaintext / AAD pair encrypted under a
// deterministic test master key in the on-disk envelope format
// (`psoenc1:0:<base64url(iv||tag||ct)>`). The test then asserts that the
// post-refactor `decryptAccountToken()` recovers the original plaintext —
// catching any AAD-byte drift introduced by extracting envelope ops into
// `src/lib/crypto/envelope.ts` (S10 fix).
//
// IMPORTANT: this script intentionally builds AAD inline using the LEGACY
// expression `${provider}:${providerAccountId}` so the fixture is a faithful
// snapshot of pre-refactor ciphertext, independent of any helper module.
//
// Run: `npx tsx scripts/regenerate-account-token-legacy-fixture.ts`

import { createCipheriv, randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SENTINEL = "psoenc1:";

const fixture = {
  // Deterministic 256-bit test key (NOT a real production key).
  masterKeyHex:
    "0001020304050607" +
    "08090a0b0c0d0e0f" +
    "1011121314151617" +
    "18191a1b1c1d1e1f",
  masterKeyVersion: 0,
  provider: "google",
  providerAccountId: "test-provider-account-id",
  plaintext: "test_refresh_token_value",
};

const key = Buffer.from(fixture.masterKeyHex, "hex");
if (key.length !== 32) {
  throw new Error(`master key must be 32 bytes, got ${key.length}`);
}

const aad = Buffer.from(
  `${fixture.provider}:${fixture.providerAccountId}`,
  "utf8",
);

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
