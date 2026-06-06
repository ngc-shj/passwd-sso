/**
 * SSH session-bind@openssh.com extension parser and verifier.
 *
 * Parses and cryptographically verifies the session-bind extension payload
 * so the agent can record the host-key fingerprint and forwarding flag for
 * audit metadata without trusting unauthenticated client assertions.
 *
 * Reference: RFC 9987 §4.7 + OpenSSH PROTOCOL.agent
 */

import {
  createPublicKey,
  createVerify,
  verify as cryptoVerify,
  createHash,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { readString } from "./ssh-agent-protocol.js";

// ─── Public types ──────────────────────────────────────────────

/** Verified session-binding metadata, usable as audit context. */
export type SessionBinding = {
  /** SHA256 fingerprint of the host public key ("SHA256:<base64nopad>") */
  hostKeyFingerprint: string;
  /** True if the agent is operating over a forwarded connection */
  forwarded: boolean;
};

// ─── Parsing ──────────────────────────────────────────────────

/**
 * Parse the payload of a session-bind@openssh.com extension message.
 *
 * The contents (after the extension name string) are:
 *   string  hostkey          (SSH wire-format public key blob)
 *   string  session-identifier
 *   string  signature        (SSH wire-format signature blob)
 *   bool    is_forwarding    (1 byte: 0x01 = true, 0x00 = false)
 *
 * @param rest Bytes immediately following the extension name string
 */
export function parseSessionBind(rest: Buffer): {
  hostKeyBlob: Buffer;
  sessionId: Buffer;
  signature: Buffer;
  isForwarding: boolean;
} {
  let offset = 0;

  const { data: hostKeyBlob, nextOffset: o1 } = readString(rest, offset);
  offset = o1;

  const { data: sessionId, nextOffset: o2 } = readString(rest, offset);
  offset = o2;

  const { data: signature, nextOffset: o3 } = readString(rest, offset);
  offset = o3;

  if (offset >= rest.length) {
    throw new Error("session-bind payload too short: missing is_forwarding byte");
  }
  const isForwarding = rest[offset] !== 0;

  return { hostKeyBlob, sessionId, signature, isForwarding };
}

// ─── Public key blob → KeyObject ──────────────────────────────

type ParsedPublicKey = { key: KeyObject; keyType: string };

/**
 * Convert an SSH wire-format public key blob into a Node.js KeyObject.
 *
 * Supported types:
 *   - ssh-ed25519
 *   - ssh-rsa
 *   - ecdsa-sha2-nistp256 / nistp384 / nistp521
 *
 * Throws an Error for unsupported key types so the caller (verifySessionBind)
 * can catch it and return false.
 */
export function sshWirePublicKeyToKeyObject(blob: Buffer): ParsedPublicKey {
  const { data: keyTypeBuf, nextOffset } = readString(blob, 0);
  const keyType = keyTypeBuf.toString("utf-8");

  switch (keyType) {
    case "ssh-ed25519": {
      const { data: pubPoint } = readString(blob, nextOffset);
      if (pubPoint.length !== 32) {
        throw new Error(`Invalid Ed25519 public key length: ${pubPoint.length}`);
      }
      const key = createPublicKey({
        key: {
          kty: "OKP",
          crv: "Ed25519",
          x: base64url(pubPoint),
        },
        format: "jwk",
      });
      return { key, keyType };
    }

    case "ssh-rsa": {
      // SSH RSA wire format: string(e), string(n) — both big-endian mpints
      const { data: e, nextOffset: o1 } = readString(blob, nextOffset);
      const { data: n } = readString(blob, o1);
      const key = createPublicKey({
        key: {
          kty: "RSA",
          n: base64url(stripLeadingZero(n)),
          e: base64url(stripLeadingZero(e)),
        },
        format: "jwk",
      });
      return { key, keyType };
    }

    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521": {
      // SSH ECDSA wire format: string(curve-name), string(Q point 0x04||x||y)
      const { data: curveNameBuf, nextOffset: o1 } = readString(blob, nextOffset);
      const curveName = curveNameBuf.toString("utf-8");
      const { data: qPoint } = readString(blob, o1);

      const curveMap: Record<string, { crv: string; size: number }> = {
        "nistp256": { crv: "P-256", size: 32 },
        "nistp384": { crv: "P-384", size: 48 },
        "nistp521": { crv: "P-521", size: 66 },
      };

      const curve = curveMap[curveName];
      if (!curve) {
        throw new Error(`Unsupported ECDSA curve: ${curveName}`);
      }

      if (qPoint[0] !== 0x04) {
        throw new Error("Only uncompressed ECDSA points are supported");
      }
      const x = qPoint.subarray(1, 1 + curve.size);
      const y = qPoint.subarray(1 + curve.size, 1 + 2 * curve.size);

      const key = createPublicKey({
        key: {
          kty: "EC",
          crv: curve.crv,
          x: base64url(x),
          y: base64url(y),
        },
        format: "jwk",
      });
      return { key, keyType };
    }

    default:
      throw new Error(`Unsupported SSH public key type: ${keyType}`);
  }
}

// ─── Signature verification ────────────────────────────────────

/**
 * Verify that the session-bind signature is valid.
 *
 * The host proves session control by signing the session identifier with the
 * host private key. This binds the agent connection to a specific SSH session
 * and host, preventing forwarded-agent hijack attacks.
 *
 * Algorithm binding (RFC 9987 §3.2): the signature algorithm name embedded in
 * the signature blob must be consistent with the host-key type. Inconsistent
 * algorithm names are rejected to prevent downgrade attacks.
 *
 * Returns false (never throws) on any parse error, unsupported type, or
 * invalid signature.
 */
export function verifySessionBind(parsed: {
  hostKeyBlob: Buffer;
  sessionId: Buffer;
  signature: Buffer;
  isForwarding: boolean;
}): boolean {
  try {
    const { key, keyType } = sshWirePublicKeyToKeyObject(parsed.hostKeyBlob);

    // Parse the SSH signature blob: string(algo-name) + string(raw-sig)
    const { data: algoNameBuf, nextOffset } = readString(parsed.signature, 0);
    const algoName = algoNameBuf.toString("utf-8");
    const { data: rawSig } = readString(parsed.signature, nextOffset);

    // Algorithm-binding check: reject mismatched algo/key pairs
    if (!isAlgoConsistentWithKeyType(algoName, keyType)) {
      return false;
    }

    return verifySshSignature(key, keyType, algoName, rawSig, parsed.sessionId);
  } catch {
    // Any parse or crypto error → treat as invalid
    return false;
  }
}

// ─── Fingerprint ──────────────────────────────────────────────

/**
 * Compute the standard OpenSSH SHA256 fingerprint of a public key blob.
 *
 * Format: "SHA256:<base64-no-padding>" (matches `ssh-keygen -l -E sha256` output).
 */
export function fingerprintPublicKey(blob: Buffer): string {
  const digest = createHash("sha256").update(blob).digest("base64");
  // Remove trailing "=" padding to match OpenSSH output
  const base64noPad = digest.replace(/=+$/, "");
  return `SHA256:${base64noPad}`;
}

// ─── Internal helpers ─────────────────────────────────────────

/**
 * Check that a signature algorithm name is consistent with the host key type.
 *
 * Prevents an attacker from substituting a weaker algorithm (e.g. ssh-rsa/SHA1)
 * for a key that supports stronger hashes, or from mixing algorithms across
 * key families entirely.
 */
function isAlgoConsistentWithKeyType(algoName: string, keyType: string): boolean {
  switch (keyType) {
    case "ssh-ed25519":
      return algoName === "ssh-ed25519";
    case "ssh-rsa":
      // Accept SHA-2 variants; tolerate legacy ssh-rsa (SHA-1) for compatibility
      return algoName === "rsa-sha2-256"
        || algoName === "rsa-sha2-512"
        || algoName === "ssh-rsa";
    case "ecdsa-sha2-nistp256":
      return algoName === "ecdsa-sha2-nistp256";
    case "ecdsa-sha2-nistp384":
      return algoName === "ecdsa-sha2-nistp384";
    case "ecdsa-sha2-nistp521":
      return algoName === "ecdsa-sha2-nistp521";
    default:
      return false;
  }
}

/**
 * Dispatch to the correct crypto.verify call based on algorithm.
 */
function verifySshSignature(
  key: KeyObject,
  keyType: string,
  algoName: string,
  rawSig: Buffer,
  data: Buffer,
): boolean {
  switch (keyType) {
    case "ssh-ed25519":
      // Ed25519: no hash (null), raw 64-byte signature
      return cryptoVerify(null, data, key, rawSig);

    case "ssh-rsa": {
      const hash = algoName === "rsa-sha2-512" ? "sha512" : "sha256";
      const verifier = createVerify(hash);
      verifier.update(data);
      return verifier.verify(key, rawSig);
    }

    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521": {
      const hashMap: Record<string, string> = {
        "ecdsa-sha2-nistp256": "sha256",
        "ecdsa-sha2-nistp384": "sha384",
        "ecdsa-sha2-nistp521": "sha512",
      };
      const hash = hashMap[keyType];
      // SSH ECDSA raw sig: string(r) || string(s) — convert to DER for Node crypto
      const derSig = sshEcdsaToDer(rawSig);
      const verifier = createVerify(hash);
      verifier.update(data);
      return verifier.verify(key, derSig);
    }

    default:
      return false;
  }
}

/**
 * Convert an SSH ECDSA signature (string(r) || string(s)) to DER format.
 *
 * SSH format: uint32(rLen) || r || uint32(sLen) || s
 * DER format: SEQUENCE { INTEGER r, INTEGER s }
 *
 * This is the inverse of derToSshEcdsa in ssh-key-agent.ts.
 */
function sshEcdsaToDer(sshSig: Buffer): Buffer {
  const { data: r, nextOffset } = readString(sshSig, 0);
  const { data: s } = readString(sshSig, nextOffset);

  // DER definite-length encoding: short form (<128) is one byte; long form
  // (>=128) is 0x80|n followed by n big-endian length bytes. P-521 signatures
  // push the SEQUENCE length past 127, so short-form-only encoding is invalid.
  const encodeLen = (len: number): Buffer => {
    if (len < 0x80) return Buffer.from([len]);
    const bytes: number[] = [];
    let v = len;
    while (v > 0) {
      bytes.unshift(v & 0xff);
      v >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  };

  // DER-encode each integer: 0x02 + length + value (with leading 0x00 if MSB set)
  const encodeInt = (n: Buffer): Buffer => {
    const needsPad = n[0] !== undefined && (n[0] & 0x80) !== 0;
    const value = needsPad ? Buffer.concat([Buffer.from([0x00]), n]) : n;
    return Buffer.concat([Buffer.from([0x02]), encodeLen(value.length), value]);
  };

  const rDer = encodeInt(r);
  const sDer = encodeInt(s);
  const seq = Buffer.concat([rDer, sDer]);

  return Buffer.concat([Buffer.from([0x30]), encodeLen(seq.length), seq]);
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
