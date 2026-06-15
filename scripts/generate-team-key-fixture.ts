/**
 * Golden-vector capture for the iOS team-key crypto (C9).
 *
 * Runs the browser extension's ACTUAL crypto-team.ts decrypt functions on fixed
 * inputs and emits ios/PasswdSSOTests/fixtures/team-key-fixture.json. The iOS
 * TeamKeyCryptoTests load this fixture and assert the iOS implementation
 * reproduces the same outputs — proving byte-for-byte parity with the extension.
 *
 * The DECRYPT path (unwrapEcdhPrivateKey / unwrapTeamKey / deriveTeamEncryptionKey)
 * exercises the real extension code. The ENCRYPT path (producing the wrapped
 * blobs) uses raw Web Crypto and mirrors the server's storage layout
 * (ciphertext || authTag split, IV separate). Run:
 *   node_modules/.bin/tsx scripts/generate-team-key-fixture.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildTeamKeyWrapAAD,
  buildTeamEntryAAD,
  buildItemKeyWrapAAD,
  deriveEcdhWrappingKey,
  importEcdhPrivateKey,
  unwrapEcdhPrivateKey,
  unwrapTeamKey,
  deriveTeamEncryptionKey,
  deriveItemEncryptionKey,
} from "../extension/src/lib/crypto-team.ts";
import { hexEncode, type EncryptedData } from "../extension/src/lib/crypto.ts";

const HKDF_TEAM_WRAP_INFO = "passwd-sso-team-v1";

function ab(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}
function rand(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}
/** AES-256-GCM encrypt → split into {ciphertext, iv, authTag} hex (server layout). */
async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  iv: Uint8Array,
  aad?: Uint8Array,
): Promise<EncryptedData> {
  const params: AesGcmParams = { name: "AES-GCM", iv: ab(iv) };
  if (aad) params.additionalData = ab(aad);
  const out = new Uint8Array(await crypto.subtle.encrypt(params, key, ab(plaintext)));
  const ct = out.slice(0, out.length - 16);
  const tag = out.slice(out.length - 16);
  return { ciphertext: hexEncode(ct), iv: hexEncode(iv), authTag: hexEncode(tag) };
}

async function main() {
  // --- Fixed identity / context ---
  const teamId = "team-fixture-1";
  const toUserId = "user-fixture-1";
  const entryId = "00000000-0000-4000-8000-000000000001";
  const keyVersion = 1;
  const wrapVersion = 1;

  // --- Member account ECDH keypair (P-256) ---
  const memberPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
  const memberPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", memberPair.privateKey));
  const memberPubRaw = await crypto.subtle.exportKey("raw", memberPair.publicKey); // 0x04‖x‖y

  // --- Wrap the member ECDH private key under HKDF(secretKey,"passwd-sso-ecdh-v1") ---
  const secretKey = rand(32);
  const ecdhWrappingKey = await deriveEcdhWrappingKey(secretKey);
  const encryptedEcdhPrivateKey = await aesGcmEncrypt(ecdhWrappingKey, memberPkcs8, rand(12));

  // --- Server-side team-key wrap: ECDH(ephemeral, member) → HKDF(team-v1, salt) → AES-GCM(teamKey, AAD) ---
  const rawTeamKey = rand(32);
  const ephemeralPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
  const ephemeralPublicKeyJwk = JSON.stringify(
    await crypto.subtle.exportKey("jwk", ephemeralPair.publicKey),
  );
  const hkdfSaltBytes = rand(32);
  // wrappingKey = HKDF(ECDH(ephemeralPriv, memberPub), salt, info=team-v1)
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: memberPair.publicKey }, ephemeralPair.privateKey, 256,
  );
  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const teamWrappingKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: ab(hkdfSaltBytes), info: ab(new TextEncoder().encode(HKDF_TEAM_WRAP_INFO)) },
    hkdfKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
  const teamKeyWrapAAD = buildTeamKeyWrapAAD({ teamId, toUserId, keyVersion, wrapVersion });
  const encryptedTeamKey = await aesGcmEncrypt(teamWrappingKey, rawTeamKey, rand(12), teamKeyWrapAAD);

  // --- Sample team entry overview encrypted under the DERIVED team enc key ---
  const teamEncKeyBytes = await crypto.subtle.exportKey(
    "raw",
    await crypto.subtle.importKey("raw", ab(rawTeamKey), "HKDF", false, ["deriveKey"]).then((k) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new ArrayBuffer(32), info: ab(new TextEncoder().encode("passwd-sso-team-enc-v1")) },
        k, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],
      ),
    ),
  );
  const overviewPlain = new TextEncoder().encode(
    JSON.stringify({ title: "Team Login", username: "alice@example.com", urlHost: "team.example.com" }),
  );
  const teamEncKeyForEnc = await crypto.subtle.importKey("raw", teamEncKeyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const overviewAAD = buildTeamEntryAAD(teamId, entryId, "overview", 0);
  const encryptedOverview = await aesGcmEncrypt(teamEncKeyForEnc, overviewPlain, rand(12), overviewAAD);

  // --- VERIFY via the REAL extension decrypt functions; capture canonical hex ---
  const recoveredPkcs8 = await unwrapEcdhPrivateKey(encryptedEcdhPrivateKey, ecdhWrappingKey);
  const memberPriv = await importEcdhPrivateKey(recoveredPkcs8);
  const recoveredTeamKey = await unwrapTeamKey(
    encryptedTeamKey, ephemeralPublicKeyJwk, memberPriv, hexEncode(hkdfSaltBytes),
    { teamId, toUserId, keyVersion, wrapVersion },
  );
  if (hexEncode(recoveredTeamKey) !== hexEncode(rawTeamKey)) throw new Error("team key round-trip mismatch");
  // The extension derives a NON-extractable enc key, so prove equivalence by
  // decrypting the overview (encrypted under our extractable teamEncKeyBytes)
  // with the extension-derived key — success proves the two keys are identical.
  const teamEncKey = await deriveTeamEncryptionKey(recoveredTeamKey);
  const combined = new Uint8Array([
    ...Array.from(Buffer.from(encryptedOverview.ciphertext, "hex")),
    ...Array.from(Buffer.from(encryptedOverview.authTag, "hex")),
  ]);
  const dec = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ab(Buffer.from(encryptedOverview.iv, "hex")), additionalData: ab(overviewAAD) },
    teamEncKey, ab(combined),
  ));
  if (new TextDecoder().decode(dec) !== new TextDecoder().decode(overviewPlain)) {
    throw new Error("team enc key mismatch (overview decrypt failed)");
  }
  const teamEncKeyHex = hexEncode(new Uint8Array(teamEncKeyBytes));

  // --- itemKeyVersion >= 1 entry: per-entry ItemKey wrapped under teamEncKey,
  //     entry encrypted under deriveItemEncryptionKey(itemKey) (regression guard
  //     for the item-enc HKDF step). ---
  const entryIdV1 = "00000000-0000-4000-8000-000000000002";
  const itemKey = rand(32);
  const itemKeyWrapAAD = buildItemKeyWrapAAD(teamId, entryIdV1, keyVersion);
  const encryptedItemKey = await aesGcmEncrypt(teamEncKeyForEnc, itemKey, rand(12), itemKeyWrapAAD);
  const itemEncKeyBytes = await crypto.subtle.exportKey(
    "raw",
    await crypto.subtle.importKey("raw", ab(itemKey), "HKDF", false, ["deriveKey"]).then((k) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new ArrayBuffer(32), info: ab(new TextEncoder().encode("passwd-sso-item-enc-v1")) },
        k, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]),
    ),
  );
  const overviewPlainV1 = new TextEncoder().encode(
    JSON.stringify({ title: "Team Login v1", username: "bob@example.com", urlHost: "v1.example.com" }));
  const itemEncKeyForEnc = await crypto.subtle.importKey("raw", itemEncKeyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const overviewAADV1 = buildTeamEntryAAD(teamId, entryIdV1, "overview", 1);
  const encryptedOverviewV1 = await aesGcmEncrypt(itemEncKeyForEnc, overviewPlainV1, rand(12), overviewAADV1);
  // Verify via the REAL extension deriveItemEncryptionKey.
  const extItemEncKey = await deriveItemEncryptionKey(itemKey);
  const combinedV1 = new Uint8Array([
    ...Array.from(Buffer.from(encryptedOverviewV1.ciphertext, "hex")),
    ...Array.from(Buffer.from(encryptedOverviewV1.authTag, "hex")),
  ]);
  const decV1 = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ab(Buffer.from(encryptedOverviewV1.iv, "hex")), additionalData: ab(overviewAADV1) },
    extItemEncKey, ab(combinedV1)));
  if (new TextDecoder().decode(decV1) !== new TextDecoder().decode(overviewPlainV1)) {
    throw new Error("item enc key mismatch (v1 overview decrypt failed)");
  }

  const fixture = {
    _comment: "Captured from extension/src/lib/crypto-team.ts via scripts/generate-team-key-fixture.ts. Do not hand-edit.",
    secretKeyHex: hexEncode(secretKey),
    encryptedEcdhPrivateKey,
    pkcs8PrivKeyHex: hexEncode(recoveredPkcs8),
    ephemeralPublicKeyJwk,
    hkdfSaltHex: hexEncode(hkdfSaltBytes),
    encryptedTeamKey,
    teamId, toUserId, keyVersion, wrapVersion,
    rawTeamKeyHex: hexEncode(rawTeamKey),
    teamEncKeyHex,
    entryId,
    encryptedOverview,
    overviewPlaintext: new TextDecoder().decode(overviewPlain),
    teamKeyWrapAADHex: hexEncode(teamKeyWrapAAD),
    overviewAADHex: hexEncode(overviewAAD),
    memberPublicKeyRawHex: hexEncode(new Uint8Array(memberPubRaw)),
    // itemKeyVersion >= 1 entry (per-entry ItemKey + item-enc HKDF).
    teamKeyVersion: keyVersion,
    entryIdV1,
    encryptedItemKey,
    itemKeyHex: hexEncode(itemKey),
    itemEncKeyHex: hexEncode(new Uint8Array(itemEncKeyBytes)),
    encryptedOverviewV1,
    overviewPlaintextV1: new TextDecoder().decode(overviewPlainV1),
  };

  const out = join(dirname(new URL(import.meta.url).pathname), "../ios/PasswdSSOTests/fixtures/team-key-fixture.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log("wrote", out);
}

main().catch((e) => { console.error(e); process.exit(1); });
