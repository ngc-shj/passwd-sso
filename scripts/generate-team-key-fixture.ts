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
 *   node_modules/.bin/tsx scripts/generate-team-key-fixture.ts [--fresh]
 *
 * The base vectors (account ECDH key, team key, itemKeyVersion 0/1 entries) are
 * random, so an existing fixture is kept as the base and only the re-key
 * vectors (itemKeyVersion 2 entry, team attachment CEK wrap "TW") are
 * recomputed on top of it. Those are deterministic given the base team key, so
 * a re-run leaves the committed JSON byte-identical. `--fresh` regenerates the
 * base too.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  deriveItemCekWrapKey,
  buildTeamAttachmentCekWrapAAD,
  unwrapItemKey,
  unwrapTeamAttachmentCek,
} from "../extension/src/lib/crypto-team.ts";
import { hexEncode, hexDecode, type EncryptedData } from "../extension/src/lib/crypto.ts";
// AT (attachment body) has no extension builder; the app's is the reference.
// The app's TW builder cross-checks the extension's at generation time.
import {
  buildAttachmentAAD,
  buildTeamAttachmentCekWrapAAD as appBuildTeamAttachmentCekWrapAAD,
} from "../src/lib/crypto/crypto-aad.ts";

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

/** Deterministic test bytes: SHA-256(label) truncated to n (n <= 32). */
function fixedBytes(label: string, n: number): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`team-key-fixture/${label}`).digest()).slice(0, n);
}

/** HKDF(ikm, salt=zero32, info) → extractable raw 32-byte AES key. */
async function hkdfRaw(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ab(ikm), "HKDF", false, ["deriveKey"]);
  const derived = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new ArrayBuffer(32), info: ab(new TextEncoder().encode(info)) },
    k, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],
  );
  return new Uint8Array(await crypto.subtle.exportKey("raw", derived));
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ab(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function aesGcmDecrypt(key: CryptoKey, enc: EncryptedData, aad: Uint8Array): Promise<Uint8Array> {
  const combined = new Uint8Array([...hexDecode(enc.ciphertext), ...hexDecode(enc.authTag)]);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ab(hexDecode(enc.iv)), additionalData: ab(aad) }, key, ab(combined)));
}

async function generateBase(): Promise<Record<string, unknown>> {
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

  return {
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
}

/**
 * Re-key vectors (#988): an itemKeyVersion 2 entry (ItemKey wrapped under the
 * team enc key with the IK AAD; overview under the item enc key with an OV AAD
 * carrying itemKeyVersion 2) and a mode-2 team attachment (CEK wrapped under
 * HKDF(ItemKey, item-cekwrap) with the TW AAD; body under the CEK with the AT
 * AAD). Deterministic given the base team key.
 */
async function generateRekeyVectors(base: Record<string, unknown>): Promise<Record<string, unknown>> {
  const teamId = base.teamId as string;
  const teamKeyVersion = base.keyVersion as number;
  const rawTeamKey = hexDecode(base.rawTeamKeyHex as string);
  const teamEncKeyBytes = await hkdfRaw(rawTeamKey, "passwd-sso-team-enc-v1");
  if (hexEncode(teamEncKeyBytes) !== base.teamEncKeyHex) throw new Error("base fixture team enc key mismatch");
  const teamEncKey = await aesKey(teamEncKeyBytes);

  // --- itemKeyVersion 2 entry ---
  const entryIdV2 = "00000000-0000-4000-8000-000000000003";
  const itemKeyVersionV2 = 2;
  const itemKeyV2 = fixedBytes("itemKeyV2", 32);
  const itemKeyWrapAADV2 = buildItemKeyWrapAAD(teamId, entryIdV2, teamKeyVersion);
  const encryptedItemKeyV2 = await aesGcmEncrypt(teamEncKey, itemKeyV2, fixedBytes("itemKeyV2/iv", 12), itemKeyWrapAADV2);
  const itemEncKeyV2Bytes = await hkdfRaw(itemKeyV2, "passwd-sso-item-enc-v1");
  const overviewPlainV2 = JSON.stringify({ title: "Team Login v2", username: "carol@example.com", urlHost: "v2.example.com" });
  const overviewAADV2 = buildTeamEntryAAD(teamId, entryIdV2, "overview", itemKeyVersionV2);
  const encryptedOverviewV2 = await aesGcmEncrypt(
    await aesKey(itemEncKeyV2Bytes), new TextEncoder().encode(overviewPlainV2), fixedBytes("overviewV2/iv", 12), overviewAADV2);

  // --- Team attachment CEK wrap (TW) under the v2 entry's ItemKey ---
  const attachmentId = "00000000-0000-4000-8000-0000000000a1";
  const cekWrapAadVersion = 1;
  const cek = fixedBytes("attachmentCek", 32);
  const cekWrapKeyBytes = await hkdfRaw(itemKeyV2, "passwd-sso-item-cekwrap-v1");
  const cekWrapAAD = buildTeamAttachmentCekWrapAAD(teamId, entryIdV2, attachmentId, itemKeyVersionV2, cekWrapAadVersion);
  if (hexEncode(cekWrapAAD) !== hexEncode(appBuildTeamAttachmentCekWrapAAD(teamId, entryIdV2, attachmentId, itemKeyVersionV2, cekWrapAadVersion))) {
    throw new Error("TW AAD mismatch between extension and app builders");
  }
  const encryptedCek = await aesGcmEncrypt(await aesKey(cekWrapKeyBytes), cek, fixedBytes("attachmentCek/iv", 12), cekWrapAAD);
  const attachmentBodyPlain = "team attachment body v2\n";
  const attachmentAAD = buildAttachmentAAD(entryIdV2, attachmentId);
  const encryptedAttachmentBody = await aesGcmEncrypt(
    await aesKey(cek), new TextEncoder().encode(attachmentBodyPlain), fixedBytes("attachmentBody/iv", 12), attachmentAAD);

  // --- VERIFY via the REAL extension functions ---
  const recoveredItemKey = await unwrapItemKey(encryptedItemKeyV2, teamEncKey, itemKeyWrapAADV2);
  const decOverview = await aesGcmDecrypt(await deriveItemEncryptionKey(recoveredItemKey), encryptedOverviewV2, overviewAADV2);
  if (new TextDecoder().decode(decOverview) !== overviewPlainV2) throw new Error("v2 overview decrypt failed");
  const recoveredCek = await unwrapTeamAttachmentCek(encryptedCek, await deriveItemCekWrapKey(recoveredItemKey), {
    teamId, entryId: entryIdV2, attachmentId, itemKeyVersion: itemKeyVersionV2, cekWrapAadVersion,
  });
  if (hexEncode(recoveredCek) !== hexEncode(cek)) throw new Error("TW CEK unwrap mismatch");
  const decBody = await aesGcmDecrypt(await aesKey(recoveredCek), encryptedAttachmentBody, attachmentAAD);
  if (new TextDecoder().decode(decBody) !== attachmentBodyPlain) throw new Error("attachment body decrypt failed");

  return {
    // itemKeyVersion 2 entry (re-keyed ItemKey).
    entryIdV2,
    itemKeyVersionV2,
    encryptedItemKeyV2,
    itemKeyV2Hex: hexEncode(itemKeyV2),
    itemEncKeyV2Hex: hexEncode(itemEncKeyV2Bytes),
    itemKeyWrapAADV2Hex: hexEncode(itemKeyWrapAADV2),
    encryptedOverviewV2,
    overviewPlaintextV2: overviewPlainV2,
    overviewAADV2Hex: hexEncode(overviewAADV2),
    // Team attachment CEK wrap ("TW") under the v2 entry's ItemKey.
    attachmentId,
    cekWrapAadVersion,
    cekWrapKeyHex: hexEncode(cekWrapKeyBytes),
    cekHex: hexEncode(cek),
    encryptedCek,
    cekWrapAADHex: hexEncode(cekWrapAAD),
    encryptedAttachmentBody,
    attachmentBodyPlaintext: attachmentBodyPlain,
    attachmentAADHex: hexEncode(attachmentAAD),
  };
}

async function main() {
  const out = join(dirname(new URL(import.meta.url).pathname), "../ios/PasswdSSOTests/fixtures/team-key-fixture.json");
  const fresh = process.argv.includes("--fresh") || !existsSync(out);
  const base = fresh ? await generateBase() : (JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>);
  const fixture = { ...base, ...(await generateRekeyVectors(base)) };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log("wrote", out);
}

main().catch((e) => { console.error(e); process.exit(1); });
