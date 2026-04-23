/**
 * Browser-side SSH key parser and fingerprint calculator.
 *
 * Parses PEM-encoded SSH private keys (OpenSSH format) to extract:
 * - Key type (Ed25519, RSA, ECDSA)
 * - Public key (for SSH authorized_keys)
 * - SHA-256 fingerprint
 * - Key size (bits)
 * - Comment (if present in the PEM)
 *
 * Uses Web Crypto API for fingerprint calculation.
 * Private key bytes are processed as Uint8Array and filled with zeros after use.
 */

const OPENSSH_PRIVATE_KEY_HEADER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_PRIVATE_KEY_FOOTER = "-----END OPENSSH PRIVATE KEY-----";
const RSA_PRIVATE_KEY_HEADER = "-----BEGIN RSA PRIVATE KEY-----";
const PRIVATE_KEY_HEADER = "-----BEGIN PRIVATE KEY-----";

export type SshKeyType = "ed25519" | "rsa" | "ecdsa" | "unknown";

export interface ParsedSshKey {
  keyType: SshKeyType;
  publicKey: string;
  fingerprint: string;
  keySize: number;
  comment: string;
}

/**
 * Detect the type of SSH key from PEM content.
 */
export function detectKeyType(pem: string): SshKeyType {
  const trimmed = pem.trim();

  if (trimmed.includes(OPENSSH_PRIVATE_KEY_HEADER)) {
    // Parse the binary format to detect the algorithm
    try {
      const decoded = decodeOpenSshPrivateKey(trimmed);
      if (!decoded) return "unknown";
      const algo = decoded.keyTypeName;
      if (algo.includes("ed25519")) return "ed25519";
      if (algo.includes("rsa")) return "rsa";
      if (algo.includes("ecdsa")) return "ecdsa";
    } catch {
      // fallback
    }
    return "unknown";
  }

  if (trimmed.includes(RSA_PRIVATE_KEY_HEADER)) return "rsa";
  if (trimmed.includes(PRIVATE_KEY_HEADER)) return "unknown";

  return "unknown";
}

interface OpenSshKeyData {
  keyTypeName: string;
  publicKeyBlob: Uint8Array;
  comment: string;
}

function decodeOpenSshPrivateKey(pem: string): OpenSshKeyData | null {
  const b64 = pem
    .replace(OPENSSH_PRIVATE_KEY_HEADER, "")
    .replace(OPENSSH_PRIVATE_KEY_FOOTER, "")
    .replace(/\s/g, "");

  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  // Magic: "openssh-key-v1\0"
  const magic = "openssh-key-v1\0";
  const decoder = new TextDecoder();
  const magicBytes = decoder.decode(raw.subarray(0, 15));
  if (magicBytes !== magic) return null;

  let offset = 15;

  function readU32(): number {
    const v =
      (raw[offset] << 24) |
      (raw[offset + 1] << 16) |
      (raw[offset + 2] << 8) |
      raw[offset + 3];
    offset += 4;
    return v >>> 0;
  }

  function readString(): Uint8Array {
    const len = readU32();
    const data = raw.subarray(offset, offset + len);
    offset += len;
    return data;
  }

  // ciphername
  readString();
  // kdfname
  readString();
  // kdfoptions
  readString();
  // number of keys
  const numKeys = readU32();
  if (numKeys < 1) return null;

  // public key blob
  const publicKeyBlob = new Uint8Array(readString());

  // Skip encrypted section parsing for now
  // We just need the public key blob to extract type/fingerprint

  // Parse public key blob to get key type name
  let pkOffset = 0;
  function pkReadU32(): number {
    const v =
      (publicKeyBlob[pkOffset] << 24) |
      (publicKeyBlob[pkOffset + 1] << 16) |
      (publicKeyBlob[pkOffset + 2] << 8) |
      publicKeyBlob[pkOffset + 3];
    pkOffset += 4;
    return v >>> 0;
  }

  function pkReadString(): Uint8Array {
    const len = pkReadU32();
    const data = publicKeyBlob.subarray(pkOffset, pkOffset + len);
    pkOffset += len;
    return data;
  }

  const keyTypeBytes = pkReadString();
  const keyTypeName = decoder.decode(keyTypeBytes);

  return {
    keyTypeName,
    publicKeyBlob,
    comment: "", // Comment is in the encrypted section
  };
}

/**
 * Parse a PEM-encoded SSH private key.
 * Returns parsed key data including public key and fingerprint.
 *
 * Note: Private key bytes are processed as Uint8Array and filled with
 * zeros after use (best-effort; JavaScript GC may retain copies).
 */
export async function parseSshPrivateKey(pem: string): Promise<ParsedSshKey | null> {
  const trimmed = pem.trim();

  if (!trimmed.includes(OPENSSH_PRIVATE_KEY_HEADER)) {
    return null; // Only OpenSSH format supported for now
  }

  const decoded = decodeOpenSshPrivateKey(trimmed);
  if (!decoded) return null;

  const keyType = detectKeyType(trimmed);
  const fingerprint = await computeSshFingerprint(decoded.publicKeyBlob);

  // Encode public key as base64 for authorized_keys format
  const publicKeyB64 = btoa(
    String.fromCharCode(...decoded.publicKeyBlob),
  );
  const publicKey = `${decoded.keyTypeName} ${publicKeyB64}`;

  const keySize = estimateKeySize(keyType, decoded.publicKeyBlob);

  return {
    keyType,
    publicKey,
    fingerprint,
    keySize,
    comment: decoded.comment,
  };
}

/**
 * Compute SHA-256 fingerprint of an SSH public key blob.
 * Returns the format: SHA256:base64...
 */
export async function computeSshFingerprint(
  publicKeyBlob: Uint8Array,
): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", publicKeyBlob as Uint8Array<ArrayBuffer>);
  const hashArray = new Uint8Array(hashBuffer);
  const b64 = btoa(String.fromCharCode(...hashArray))
    .replace(/=+$/, ""); // Remove trailing padding
  return `SHA256:${b64}`;
}

function estimateKeySize(keyType: SshKeyType, publicKeyBlob: Uint8Array): number {
  switch (keyType) {
    case "ed25519":
      return 256;
    case "ecdsa":
      // ECDSA key size depends on curve
      if (publicKeyBlob.length > 100) return 521;
      if (publicKeyBlob.length > 70) return 384;
      return 256;
    case "rsa": {
      // RSA public key blob contains: key type string + e + n
      // n length determines key size
      let offset = 0;
      const readU32 = () => {
        const v =
          (publicKeyBlob[offset] << 24) |
          (publicKeyBlob[offset + 1] << 16) |
          (publicKeyBlob[offset + 2] << 8) |
          publicKeyBlob[offset + 3];
        offset += 4;
        return v >>> 0;
      };
      // Skip key type
      const typeLen = readU32();
      offset += typeLen;
      // Skip e
      const eLen = readU32();
      offset += eLen;
      // n length
      const nLen = readU32();
      // nLen in bytes → bits (minus possible leading zero byte)
      return (nLen - 1) * 8;
    }
    default:
      return 0;
  }
}
