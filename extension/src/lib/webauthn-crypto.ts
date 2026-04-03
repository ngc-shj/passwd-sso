// WebAuthn cryptographic operations for the passkey provider.
// All functions run in the service worker (trusted extension context).

import { cborEncode, cborEncodeIntKeyMap } from "./cbor";
import type { CborMap } from "./cbor";

// ── Key Generation ──

export interface PasskeyKeypair {
  privateKeyJwk: JsonWebKey;
  publicKeyCose: Uint8Array;
  publicKeyRaw: Uint8Array;
}

/**
 * Generate a P-256 (ES256) key pair for passkey registration.
 * Returns the private key as extractable JWK and the public key in COSE format.
 */
export async function generatePasskeyKeypair(): Promise<PasskeyKeypair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );

  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  const publicKeyCose = encodeCoseEC2Key(publicKeyRaw);

  return { privateKeyJwk, publicKeyCose, publicKeyRaw };
}

/**
 * Encode an uncompressed P-256 public key (65 bytes: 0x04 || x || y) as COSE_Key.
 *
 * COSE_Key map (RFC 8152):
 *   1 (kty): 2 (EC2)
 *   3 (alg): -7 (ES256)
 *  -1 (crv): 1 (P-256)
 *  -2 (x):   32 bytes
 *  -3 (y):   32 bytes
 */
export function encodeCoseEC2Key(rawPublicKey: Uint8Array): Uint8Array {
  if (rawPublicKey.length !== 65 || rawPublicKey[0] !== 0x04) {
    throw new Error("Expected uncompressed P-256 public key (65 bytes, 0x04 prefix)");
  }
  const x = rawPublicKey.slice(1, 33);
  const y = rawPublicKey.slice(33, 65);

  return cborEncodeIntKeyMap([
    [1, 2],    // kty: EC2
    [3, -7],   // alg: ES256
    [-1, 1],   // crv: P-256
    [-2, x],   // x coordinate
    [-3, y],   // y coordinate
  ]);
}

// ── Authenticator Data ──

const FLAG_UP = 0x01; // User Present
const FLAG_UV = 0x04; // User Verified
const FLAG_AT = 0x40; // Attested credential data included

/**
 * Build authenticator data for an assertion (get).
 * Flags: UP + UV (vault unlock = user verification).
 */
export async function buildAssertionAuthData(
  rpId: string,
  signCount: number,
): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
  );
  const flags = FLAG_UP | FLAG_UV; // 0x05
  return buildAuthDataBytes(rpIdHash, flags, signCount);
}

/**
 * Build authenticator data for attestation (create).
 * Includes attested credential data (AAGUID + credentialId + COSE public key).
 */
export async function buildAttestationAuthData(
  rpId: string,
  signCount: number,
  credentialId: Uint8Array,
  publicKeyCose: Uint8Array,
): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
  );
  const flags = FLAG_UP | FLAG_UV | FLAG_AT; // 0x45

  const base = buildAuthDataBytes(rpIdHash, flags, signCount);

  // Attested credential data: AAGUID (16) + credIdLen (2) + credId + COSE key
  const aaguid = new Uint8Array(16); // all zeros for software authenticator
  const credIdLen = new Uint8Array(2);
  credIdLen[0] = (credentialId.length >> 8) & 0xff;
  credIdLen[1] = credentialId.length & 0xff;

  const result = new Uint8Array(
    base.length + 16 + 2 + credentialId.length + publicKeyCose.length,
  );
  let offset = 0;
  result.set(base, offset); offset += base.length;
  result.set(aaguid, offset); offset += 16;
  result.set(credIdLen, offset); offset += 2;
  result.set(credentialId, offset); offset += credentialId.length;
  result.set(publicKeyCose, offset);

  return result;
}

function buildAuthDataBytes(
  rpIdHash: Uint8Array,
  flags: number,
  signCount: number,
): Uint8Array {
  // rpIdHash (32) + flags (1) + signCount (4) = 37 bytes
  const buf = new Uint8Array(37);
  buf.set(rpIdHash, 0);
  buf[32] = flags;
  buf[33] = (signCount >> 24) & 0xff;
  buf[34] = (signCount >> 16) & 0xff;
  buf[35] = (signCount >> 8) & 0xff;
  buf[36] = signCount & 0xff;
  return buf;
}

// ── Signing ──

/**
 * Sign an assertion using the stored P-256 private key.
 * Input: authenticatorData || SHA-256(clientDataJSON)
 * Output: DER-encoded ECDSA signature.
 */
export async function signAssertion(
  privateKeyJwk: JsonWebKey,
  authenticatorData: Uint8Array,
  clientDataJSON: string,
): Promise<Uint8Array> {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(clientDataJSON),
    ),
  );

  // signedData = authenticatorData || clientDataHash
  const signedData = new Uint8Array(
    authenticatorData.length + clientDataHash.length,
  );
  signedData.set(authenticatorData);
  signedData.set(clientDataHash, authenticatorData.length);

  const rawSig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      signedData,
    ),
  );

  // Web Crypto outputs P1363 format (r || s, 64 bytes); WebAuthn expects DER
  return p1363ToDer(rawSig);
}

// ── Attestation Object ──

/**
 * Build a "none" attestation object (self-attestation for software authenticator).
 */
export function buildAttestationObject(authData: Uint8Array): Uint8Array {
  const obj: CborMap = {
    fmt: "none",
    attStmt: {},
    authData,
  };
  return cborEncode(obj);
}

// ── DER Encoding ──

/**
 * Convert IEEE P1363 signature (r || s, 64 bytes for P-256) to DER ASN.1.
 *
 * DER SEQUENCE { INTEGER r, INTEGER s }
 * Each integer is minimally encoded: strip leading zeros, add 0x00 pad if high bit set.
 */
export function p1363ToDer(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64) {
    throw new Error(`Expected 64-byte P1363 signature, got ${sig.length}`);
  }

  const r = derInteger(sig.slice(0, 32));
  const s = derInteger(sig.slice(32, 64));

  // SEQUENCE tag (0x30) + length + r + s
  const seqLen = r.length + s.length;
  const der = new Uint8Array(2 + seqLen);
  der[0] = 0x30; // SEQUENCE
  der[1] = seqLen;
  der.set(r, 2);
  der.set(s, 2 + r.length);
  return der;
}

function derInteger(bytes: Uint8Array): Uint8Array {
  // Strip leading zeros (but keep at least one byte)
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.slice(start);

  // Add 0x00 padding if high bit is set (positive integer in ASN.1)
  const needsPad = trimmed[0] & 0x80;
  const len = trimmed.length + (needsPad ? 1 : 0);

  const result = new Uint8Array(2 + len);
  result[0] = 0x02; // INTEGER tag
  result[1] = len;
  if (needsPad) {
    result[2] = 0x00;
    result.set(trimmed, 3);
  } else {
    result.set(trimmed, 2);
  }
  return result;
}

// ── Base64url Helpers ──

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Generate a random credential ID (32 bytes).
 */
export function generateCredentialId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
