/**
 * OpenSSH private key format parser.
 *
 * Handles `-----BEGIN OPENSSH PRIVATE KEY-----` format that
 * Node.js/OpenSSL `createPrivateKey()` cannot always parse
 * (notably encrypted keys using bcrypt-pbkdf).
 *
 * Supports: Ed25519, RSA, ECDSA (encrypted and unencrypted).
 *
 * Reference: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key
 */

import { createPrivateKey, createDecipheriv } from "node:crypto";
import type { KeyObject } from "node:crypto";

const OPENSSH_MAGIC = "openssh-key-v1\0";

/**
 * Parse an OpenSSH private key PEM into a Node.js KeyObject.
 * Falls back to this when `createPrivateKey()` can't handle the format.
 */
export async function parseOpenSshPrivateKey(
  pem: string,
  passphrase?: string,
): Promise<KeyObject> {
  const lines = pem.trim().split(/\r?\n/);
  if (
    lines[0] !== "-----BEGIN OPENSSH PRIVATE KEY-----" ||
    lines[lines.length - 1] !== "-----END OPENSSH PRIVATE KEY-----"
  ) {
    throw new Error("Not an OpenSSH private key");
  }

  const b64 = lines.slice(1, -1).join("");
  const buf = Buffer.from(b64, "base64");
  let offset = 0;

  // Verify magic
  const magic = buf.subarray(0, OPENSSH_MAGIC.length).toString("ascii");
  if (magic !== OPENSSH_MAGIC) {
    throw new Error("Invalid OpenSSH key magic");
  }
  offset += OPENSSH_MAGIC.length;

  // Read cipher name
  const cipherName = readString(buf, offset);
  offset += 4 + cipherName.length;

  // Read KDF name
  const kdfName = readString(buf, offset);
  offset += 4 + kdfName.length;

  // Read KDF options
  const kdfOptionsLen = buf.readUInt32BE(offset);
  offset += 4;
  const kdfOptions = buf.subarray(offset, offset + kdfOptionsLen);
  offset += kdfOptionsLen;

  // Number of keys
  const numKeys = buf.readUInt32BE(offset);
  offset += 4;

  if (numKeys !== 1) {
    throw new Error(`Expected 1 key, got ${numKeys}`);
  }

  // Skip public key blob
  const pubKeyLen = buf.readUInt32BE(offset);
  offset += 4 + pubKeyLen;

  // Read private section
  const privSectionLen = buf.readUInt32BE(offset);
  offset += 4;
  let privSection: Buffer = buf.subarray(offset, offset + privSectionLen);

  // Decrypt if encrypted
  const isEncrypted = cipherName !== "none" || kdfName !== "none";
  if (isEncrypted) {
    if (!passphrase) {
      throw new Error(
        "This SSH key is encrypted but no passphrase is stored. " +
        "Edit the vault entry and add the key passphrase.",
      );
    }
    privSection = await decryptPrivateSection(
      privSection, cipherName, kdfName, kdfOptions, passphrase,
    );
  }

  // Parse unencrypted private section
  let pOff = 0;

  // Check integers (random, must match)
  const check1 = privSection.readUInt32BE(pOff);
  pOff += 4;
  const check2 = privSection.readUInt32BE(pOff);
  pOff += 4;

  if (check1 !== check2) {
    throw new Error("Check integers mismatch — key data may be corrupted");
  }

  // Key type
  const keyType = readString(privSection, pOff);
  pOff += 4 + keyType.length;

  switch (keyType) {
    case "ssh-ed25519":
      return parseEd25519(privSection, pOff);
    case "ssh-rsa":
      return parseRsa(privSection, pOff);
    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521":
      return parseEcdsa(privSection, pOff, keyType);
    default:
      throw new Error(`Unsupported OpenSSH key type: ${keyType}`);
  }
}

// ─── Decryption ───────────────────────────────────────────

/** Cipher info: Node.js algorithm name, key length, IV length */
const CIPHER_INFO: Record<string, { algo: string; keyLen: number; ivLen: number }> = {
  "aes256-ctr": { algo: "aes-256-ctr", keyLen: 32, ivLen: 16 },
  "aes256-cbc": { algo: "aes-256-cbc", keyLen: 32, ivLen: 16 },
  "aes128-ctr": { algo: "aes-128-ctr", keyLen: 16, ivLen: 16 },
  "aes128-cbc": { algo: "aes-128-cbc", keyLen: 16, ivLen: 16 },
  "aes192-ctr": { algo: "aes-192-ctr", keyLen: 24, ivLen: 16 },
  "aes192-cbc": { algo: "aes-192-cbc", keyLen: 24, ivLen: 16 },
};

async function decryptPrivateSection(
  encrypted: Buffer,
  cipherName: string,
  kdfName: string,
  kdfOptions: Buffer,
  passphrase: string,
): Promise<Buffer> {
  if (kdfName !== "bcrypt") {
    throw new Error(`Unsupported KDF: ${kdfName}`);
  }

  const cipher = CIPHER_INFO[cipherName];
  if (!cipher) {
    throw new Error(`Unsupported cipher: ${cipherName}`);
  }

  // Parse KDF options: uint32 salt_len, salt, uint32 rounds
  let kOff = 0;
  const saltLen = kdfOptions.readUInt32BE(kOff);
  kOff += 4;
  const salt = kdfOptions.subarray(kOff, kOff + saltLen);
  kOff += saltLen;
  const rounds = kdfOptions.readUInt32BE(kOff);

  // Derive key + IV using bcrypt-pbkdf
  const { pbkdf } = await import("bcrypt-pbkdf");
  const derivedLen = cipher.keyLen + cipher.ivLen;
  const derived = Buffer.alloc(derivedLen);
  const ret = pbkdf(
    Buffer.from(passphrase, "utf-8"), passphrase.length,
    salt, salt.length,
    derived, derivedLen,
    rounds,
  );
  if (ret !== 0) {
    throw new Error("bcrypt-pbkdf failed");
  }

  const key = derived.subarray(0, cipher.keyLen);
  const iv = derived.subarray(cipher.keyLen);

  // Decrypt
  const decipher = createDecipheriv(cipher.algo, key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  // Zero derived key material
  derived.fill(0);
  key.fill(0);
  iv.fill(0);

  return decrypted;
}

// ─── Ed25519 ──────────────────────────────────────────────

function parseEd25519(buf: Buffer, offset: number): KeyObject {
  // Public key (32 bytes)
  const pubLen = buf.readUInt32BE(offset);
  offset += 4;
  const pubKey = buf.subarray(offset, offset + pubLen);
  offset += pubLen;

  // Private key (64 bytes = 32-byte seed + 32-byte pubkey)
  const _privLen = buf.readUInt32BE(offset);
  offset += 4;
  const seed = buf.subarray(offset, offset + 32);

  // Build JWK from raw key material
  return createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: base64url(seed),
      x: base64url(pubKey),
    },
    format: "jwk",
  });
}

// ─── RSA ──────────────────────────────────────────────────

function parseRsa(buf: Buffer, offset: number): KeyObject {
  // OpenSSH RSA format: n, e, d, iqmp, p, q
  const n = readMpint(buf, offset);
  offset += 4 + n.length;
  const e = readMpint(buf, offset);
  offset += 4 + e.length;
  const d = readMpint(buf, offset);
  offset += 4 + d.length;
  const iqmp = readMpint(buf, offset);
  offset += 4 + iqmp.length;
  const p = readMpint(buf, offset);
  offset += 4 + p.length;
  const q = readMpint(buf, offset);

  return createPrivateKey({
    key: {
      kty: "RSA",
      n: base64url(stripLeadingZero(n)),
      e: base64url(stripLeadingZero(e)),
      d: base64url(stripLeadingZero(d)),
      p: base64url(stripLeadingZero(p)),
      q: base64url(stripLeadingZero(q)),
      qi: base64url(stripLeadingZero(iqmp)),
      // dp and dq are required by JWK but can be derived
      dp: base64url(stripLeadingZero(modBuf(d, pMinus1(p)))),
      dq: base64url(stripLeadingZero(modBuf(d, pMinus1(q)))),
    },
    format: "jwk",
  });
}

// ─── ECDSA ────────────────────────────────────────────────

function parseEcdsa(
  buf: Buffer,
  offset: number,
  keyType: string,
): KeyObject {
  // Curve identifier string
  const curveId = readString(buf, offset);
  offset += 4 + curveId.length;

  // Public key point (uncompressed: 0x04 + x + y)
  const pubPointLen = buf.readUInt32BE(offset);
  offset += 4;
  const pubPoint = buf.subarray(offset, offset + pubPointLen);
  offset += pubPointLen;

  // Private key scalar
  const privScalar = readMpint(buf, offset);

  const curveMap: Record<string, { crv: string; size: number }> = {
    "ecdsa-sha2-nistp256": { crv: "P-256", size: 32 },
    "ecdsa-sha2-nistp384": { crv: "P-384", size: 48 },
    "ecdsa-sha2-nistp521": { crv: "P-521", size: 66 },
  };

  const curve = curveMap[keyType];
  if (!curve) throw new Error(`Unsupported ECDSA curve: ${keyType}`);

  // pubPoint format: 0x04 + x (size bytes) + y (size bytes)
  const x = pubPoint.subarray(1, 1 + curve.size);
  const y = pubPoint.subarray(1 + curve.size, 1 + 2 * curve.size);
  const d = stripLeadingZero(privScalar);

  // Pad d to curve size if needed
  const dPadded = d.length < curve.size
    ? Buffer.concat([Buffer.alloc(curve.size - d.length), d])
    : d;

  return createPrivateKey({
    key: {
      kty: "EC",
      crv: curve.crv,
      x: base64url(x),
      y: base64url(y),
      d: base64url(dPadded),
    },
    format: "jwk",
  });
}

// ─── Binary helpers ───────────────────────────────────────

function readString(buf: Buffer, offset: number): string {
  const len = buf.readUInt32BE(offset);
  return buf.subarray(offset + 4, offset + 4 + len).toString("utf-8");
}

function readMpint(buf: Buffer, offset: number): Buffer {
  const len = buf.readUInt32BE(offset);
  return buf.subarray(offset + 4, offset + 4 + len);
}

function base64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function stripLeadingZero(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return i > 0 ? buf.subarray(i) : buf;
}

// ─── BigInt math for RSA dp/dq ────────────────────────────

function bufToBigInt(buf: Buffer): bigint {
  let result = 0n;
  for (const byte of buf) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

function bigIntToBuf(n: bigint): Buffer {
  if (n === 0n) return Buffer.from([0]);
  const hex = n.toString(16);
  const padded = hex.length % 2 ? "0" + hex : hex;
  return Buffer.from(padded, "hex");
}

function pMinus1(p: Buffer): bigint {
  return bufToBigInt(stripLeadingZero(p)) - 1n;
}

function modBuf(d: Buffer, m: bigint): Buffer {
  const dBig = bufToBigInt(stripLeadingZero(d));
  const result = dBig % m;
  return bigIntToBuf(result);
}
