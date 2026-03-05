/**
 * SSH key agent — PEM parsing + signing using Node.js crypto.
 *
 * Manages loaded SSH keys and performs signing operations for the
 * SSH agent protocol.
 */

import { createPrivateKey, createSign, sign as cryptoSign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  encodeString,
  SSH_AGENT_RSA_SHA2_256,
  SSH_AGENT_RSA_SHA2_512,
} from "./ssh-agent-protocol.js";

export interface LoadedSshKey {
  /** Entry ID from the vault */
  entryId: string;
  /** PEM-encoded private key */
  pem: string;
  /** Optional passphrase for encrypted keys */
  passphrase?: string;
  /** SSH public key blob (for identity listing) */
  publicKeyBlob: Buffer;
  /** Key comment (usually user@host) */
  comment: string;
  /** Node.js KeyObject (parsed from PEM) */
  keyObject: KeyObject;
  /** Key type identifier */
  keyType: "ed25519" | "rsa" | "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521";
}

const loadedKeys = new Map<string, LoadedSshKey>();

/**
 * Load a PEM private key into memory.
 *
 * @returns The public key blob for identity listing
 */
export function loadKey(
  entryId: string,
  pem: string,
  publicKeyBlob: Buffer,
  comment: string,
  passphrase?: string,
): LoadedSshKey {
  const keyObject = createPrivateKey({
    key: pem,
    format: "pem",
    ...(passphrase ? { passphrase } : {}),
  });

  const keyType = detectKeyType(keyObject);

  const loaded: LoadedSshKey = {
    entryId,
    pem,
    passphrase,
    publicKeyBlob,
    comment,
    keyObject,
    keyType,
  };

  loadedKeys.set(entryId, loaded);
  return loaded;
}

/**
 * Get all loaded keys for identity listing.
 */
export function getLoadedKeys(): LoadedSshKey[] {
  return Array.from(loadedKeys.values());
}

/**
 * Find a loaded key by its public key blob.
 */
export function findKeyByBlob(publicKeyBlob: Buffer): LoadedSshKey | undefined {
  for (const key of loadedKeys.values()) {
    if (key.publicKeyBlob.equals(publicKeyBlob)) {
      return key;
    }
  }
  return undefined;
}

/**
 * Clear all loaded keys. Zeroes PEM data in memory.
 */
export function clearKeys(): void {
  for (const key of loadedKeys.values()) {
    // Best-effort zero of PEM data in memory
    const buf = Buffer.from(key.pem);
    buf.fill(0);
  }
  loadedKeys.clear();
}

/**
 * Sign data with a loaded key using the SSH agent protocol conventions.
 *
 * @param key The loaded key to sign with
 * @param data The data to sign
 * @param flags SSH agent flags (for RSA algorithm selection)
 * @returns The SSH-formatted signature blob
 */
export function signData(
  key: LoadedSshKey,
  data: Buffer,
  flags: number,
): Buffer {
  switch (key.keyType) {
    case "ed25519": {
      const sig = cryptoSign(null, data, key.keyObject);
      return Buffer.concat([
        encodeString("ssh-ed25519"),
        encodeString(sig),
      ]);
    }

    case "rsa": {
      const algo = flags & SSH_AGENT_RSA_SHA2_512
        ? "sha512"
        : flags & SSH_AGENT_RSA_SHA2_256
          ? "sha256"
          : "sha256"; // Default to SHA-256 for modern SSH
      const algoName = algo === "sha512"
        ? "rsa-sha2-512"
        : "rsa-sha2-256";
      const signer = createSign(algo);
      signer.update(data);
      const sig = signer.sign(key.keyObject);
      return Buffer.concat([
        encodeString(algoName),
        encodeString(sig),
      ]);
    }

    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521": {
      const hashMap: Record<string, string> = {
        "ecdsa-sha2-nistp256": "sha256",
        "ecdsa-sha2-nistp384": "sha384",
        "ecdsa-sha2-nistp521": "sha512",
      };
      const hash = hashMap[key.keyType];
      const signer = createSign(hash);
      signer.update(data);
      // ECDSA sign returns DER-encoded signature by default
      const derSig = signer.sign(key.keyObject);
      const sshSig = derToSshEcdsa(derSig);
      return Buffer.concat([
        encodeString(key.keyType),
        encodeString(sshSig),
      ]);
    }

    default:
      throw new Error(`Unsupported key type: ${key.keyType}`);
  }
}

/**
 * Detect the SSH key type from a Node.js KeyObject.
 */
function detectKeyType(keyObject: KeyObject): LoadedSshKey["keyType"] {
  const info = keyObject.asymmetricKeyType;

  if (info === "ed25519") return "ed25519";
  if (info === "rsa") return "rsa";
  if (info === "ec") {
    // Determine curve from key details
    const details = keyObject.asymmetricKeyDetails;
    switch (details?.namedCurve) {
      case "prime256v1":
      case "P-256":
        return "ecdsa-sha2-nistp256";
      case "secp384r1":
      case "P-384":
        return "ecdsa-sha2-nistp384";
      case "secp521r1":
      case "P-521":
        return "ecdsa-sha2-nistp521";
      default:
        throw new Error(`Unsupported EC curve: ${details?.namedCurve}`);
    }
  }

  throw new Error(`Unsupported key type: ${info}`);
}

/**
 * Convert DER-encoded ECDSA signature to SSH mpint format.
 * DER: SEQUENCE { INTEGER r, INTEGER s }
 * SSH: string(r) || string(s)
 */
function derToSshEcdsa(derSig: Buffer): Buffer {
  // Parse DER SEQUENCE
  let offset = 0;
  if (derSig[offset++] !== 0x30) throw new Error("Invalid DER sequence");
  // Skip length byte(s)
  let seqLen = derSig[offset++];
  if (seqLen & 0x80) {
    const lenBytes = seqLen & 0x7f;
    offset += lenBytes;
    // We don't actually need seqLen
    seqLen = 0;
  }

  // Read r INTEGER
  if (derSig[offset++] !== 0x02) throw new Error("Expected INTEGER for r");
  const rLen = derSig[offset++];
  let r = derSig.subarray(offset, offset + rLen);
  offset += rLen;

  // Read s INTEGER
  if (derSig[offset++] !== 0x02) throw new Error("Expected INTEGER for s");
  const sLen = derSig[offset++];
  let s = derSig.subarray(offset, offset + sLen);

  // Strip leading zero bytes (DER uses them for positive sign)
  while (r.length > 1 && r[0] === 0) r = r.subarray(1);
  while (s.length > 1 && s[0] === 0) s = s.subarray(1);

  return Buffer.concat([encodeString(r), encodeString(s)]);
}

// Cleanup on process exit
process.on("exit", () => {
  clearKeys();
});
