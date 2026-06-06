/**
 * Tests for cli/src/lib/ssh-session-bind.ts (C6).
 *
 * All vectors are synthetic — generated in-test via node:crypto — so tests
 * run without a real OpenSSH handshake (VC1). A captured real ed25519
 * session-bind fixture (golden vector) is marked as nice-to-have and tracked
 * in the manual test plan (ssh-agent-rfc9987-manual-test.md).
 */

import { describe, it, expect } from "vitest";
import {
  generateKeyPairSync,
  createSign,
  sign as cryptoSign,
  createHash,
} from "node:crypto";
import {
  parseSessionBind,
  sshWirePublicKeyToKeyObject,
  verifySessionBind,
  fingerprintPublicKey,
} from "../../lib/ssh-session-bind";
import { encodeString } from "../../lib/ssh-agent-protocol";

// ─── Wire-format builders (test utilities) ────────────────────

/** Build an SSH wire-format Ed25519 public key blob. */
function buildEd25519PubBlob(pubKeyRaw: Buffer): Buffer {
  return Buffer.concat([
    encodeString("ssh-ed25519"),
    encodeString(pubKeyRaw),
  ]);
}

/** Build an SSH wire-format RSA public key blob (e then n). */
function buildRsaPubBlob(e: Buffer, n: Buffer): Buffer {
  return Buffer.concat([
    encodeString("ssh-rsa"),
    encodeString(e),
    encodeString(n),
  ]);
}

/** Build an SSH wire-format ECDSA public key blob. */
function buildEcdsaPubBlob(keyType: string, curveName: string, qPoint: Buffer): Buffer {
  return Buffer.concat([
    encodeString(keyType),
    encodeString(curveName),
    encodeString(qPoint),
  ]);
}

/** Encode an SSH wire-format signature blob: string(algoName) + string(rawSig). */
function buildSshSig(algoName: string, rawSig: Buffer): Buffer {
  return Buffer.concat([
    encodeString(algoName),
    encodeString(rawSig),
  ]);
}

/** Assemble a session-bind payload: string(hostkey) + string(sessionId) + string(sig) + bool. */
function buildSessionBindPayload(
  hostKeyBlob: Buffer,
  sessionId: Buffer,
  sigBlob: Buffer,
  isForwarding: boolean,
): Buffer {
  return Buffer.concat([
    encodeString(hostKeyBlob),
    encodeString(sessionId),
    encodeString(sigBlob),
    Buffer.from([isForwarding ? 1 : 0]),
  ]);
}

/** Convert DER ECDSA signature to SSH format (string(r) || string(s)). */
function derEcdsaToSsh(derSig: Buffer): Buffer {
  let offset = 0;
  if (derSig[offset++] !== 0x30) throw new Error("Not a DER SEQUENCE");
  const seqLen = derSig[offset++];
  if (seqLen & 0x80) offset += seqLen & 0x7f; // skip multi-byte length

  if (derSig[offset++] !== 0x02) throw new Error("Expected INTEGER r");
  const rLen = derSig[offset++];
  let r = derSig.subarray(offset, offset + rLen);
  offset += rLen;

  if (derSig[offset++] !== 0x02) throw new Error("Expected INTEGER s");
  const sLen = derSig[offset++];
  let s = derSig.subarray(offset, offset + sLen);

  // Strip leading zero bytes (DER uses them for positive sign)
  while (r.length > 1 && r[0] === 0) r = r.subarray(1);
  while (s.length > 1 && s[0] === 0) s = s.subarray(1);

  return Buffer.concat([encodeString(r), encodeString(s)]);
}

// ─── Ed25519 synthetic vector ─────────────────────────────────

describe("Ed25519 session-bind", () => {
  const { publicKey: pub, privateKey: priv } = generateKeyPairSync("ed25519");
  const pubRaw = pub.export({ type: "spki", format: "der" });
  // The raw 32-byte Ed25519 point is the last 32 bytes of the SPKI DER
  const pubPoint = Buffer.from(pubRaw).subarray(-32);
  const hostKeyBlob = buildEd25519PubBlob(pubPoint);
  const sessionId = Buffer.from("test-session-id-32-bytes-padding", "utf-8").subarray(0, 32);
  const rawSig = cryptoSign(null, sessionId, priv);
  const sigBlob = buildSshSig("ssh-ed25519", rawSig);
  const payload = buildSessionBindPayload(hostKeyBlob, sessionId, sigBlob, false);
  const parsed = parseSessionBind(payload);

  it("parseSessionBind extracts all fields correctly", () => {
    expect(Buffer.compare(parsed.hostKeyBlob, hostKeyBlob)).toBe(0);
    expect(Buffer.compare(parsed.sessionId, sessionId)).toBe(0);
    expect(Buffer.compare(parsed.signature, sigBlob)).toBe(0);
    expect(parsed.isForwarding).toBe(false);
  });

  it("verifySessionBind returns true for a valid Ed25519 signature", () => {
    expect(verifySessionBind(parsed)).toBe(true);
  });

  it("verifySessionBind returns false when one signature byte is flipped", () => {
    const badSig = Buffer.from(rawSig);
    badSig[0] ^= 0xff;
    const badSigBlob = buildSshSig("ssh-ed25519", badSig);
    const badParsed = { ...parsed, signature: badSigBlob };
    expect(verifySessionBind(badParsed)).toBe(false);
  });

  it("verifySessionBind returns false when sessionId is modified", () => {
    const badSessionId = Buffer.from(sessionId);
    badSessionId[0] ^= 0x01;
    const badParsed = { ...parsed, sessionId: badSessionId };
    expect(verifySessionBind(badParsed)).toBe(false);
  });

  it("records isForwarding=true when the flag byte is set", () => {
    const forwardedPayload = buildSessionBindPayload(hostKeyBlob, sessionId, sigBlob, true);
    const forwardedParsed = parseSessionBind(forwardedPayload);
    expect(forwardedParsed.isForwarding).toBe(true);
  });
});

// ─── RSA-sha2-256 synthetic vector ───────────────────────────

describe("RSA-sha2-256 session-bind", () => {
  const { publicKey: pub, privateKey: priv } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  // Extract n and e from the JWK representation
  const jwk = pub.export({ format: "jwk" }) as { n: string; e: string };
  const nBuf = Buffer.from(jwk.n, "base64url");
  const eBuf = Buffer.from(jwk.e, "base64url");
  // SSH RSA pubkey blob: string(e), string(n)
  const hostKeyBlob = buildRsaPubBlob(eBuf, nBuf);
  const sessionId = Buffer.from("rsa-session-identifier-32bytes!!", "utf-8").subarray(0, 32);

  const signer = createSign("sha256");
  signer.update(sessionId);
  const rawSig = signer.sign(priv);
  const sigBlob = buildSshSig("rsa-sha2-256", rawSig);
  const payload = buildSessionBindPayload(hostKeyBlob, sessionId, sigBlob, false);
  const parsed = parseSessionBind(payload);

  it("verifySessionBind returns true for a valid RSA-sha2-256 signature", () => {
    expect(verifySessionBind(parsed)).toBe(true);
  });

  it("verifySessionBind returns false when signature is corrupted", () => {
    const badSig = Buffer.from(rawSig);
    badSig[badSig.length - 1] ^= 0xff;
    const badSigBlob = buildSshSig("rsa-sha2-256", badSig);
    const badParsed = { ...parsed, signature: badSigBlob };
    expect(verifySessionBind(badParsed)).toBe(false);
  });

  // Regression guard for S1: the legacy "ssh-rsa" signature algorithm name must
  // be rejected by the allowlist. We sign with SHA-256 but label the blob "ssh-rsa"
  // so the allowlist is the ONLY thing that decides — before S1 the allowlist
  // admitted "ssh-rsa" and the SHA-256 verify would then succeed (true); after S1
  // the allowlist rejects "ssh-rsa" outright (false). This isolates the allowlist
  // change rather than relying on a hash mismatch.
  it("verifySessionBind rejects a SHA-256 signature labeled with the legacy ssh-rsa algorithm", () => {
    const legacyBlob = buildSshSig("ssh-rsa", rawSig); // rawSig is the SHA-256 signature
    expect(verifySessionBind({ ...parsed, signature: legacyBlob })).toBe(false);
  });
});

// ─── RSA-sha2-512 synthetic vector ───────────────────────────

describe("RSA-sha2-512 session-bind", () => {
  const { publicKey: pub, privateKey: priv } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  const jwk = pub.export({ format: "jwk" }) as { n: string; e: string };
  const nBuf = Buffer.from(jwk.n, "base64url");
  const eBuf = Buffer.from(jwk.e, "base64url");
  const hostKeyBlob = buildRsaPubBlob(eBuf, nBuf);
  const sessionId = Buffer.from("rsa512-session-identifier-32b---", "utf-8").subarray(0, 32);

  const signer = createSign("sha512");
  signer.update(sessionId);
  const rawSig = signer.sign(priv);
  const sigBlob = buildSshSig("rsa-sha2-512", rawSig);
  const payload = buildSessionBindPayload(hostKeyBlob, sessionId, sigBlob, false);
  const parsed = parseSessionBind(payload);

  it("verifySessionBind returns true for a valid RSA-sha2-512 signature", () => {
    expect(verifySessionBind(parsed)).toBe(true);
  });
});

// ─── ECDSA nistp256 synthetic vector ─────────────────────────

describe("ECDSA-nistp256 session-bind", () => {
  const { publicKey: pub, privateKey: priv } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });

  // Extract the uncompressed public key point from SPKI DER
  // SPKI DER for P-256: last 65 bytes are 0x04 + x(32) + y(32)
  const spkiDer = Buffer.from(pub.export({ type: "spki", format: "der" }));
  const qPoint = spkiDer.subarray(-65);
  const hostKeyBlob = buildEcdsaPubBlob("ecdsa-sha2-nistp256", "nistp256", qPoint);
  const sessionId = Buffer.from("ecdsa-session-identifier-32byte!", "utf-8").subarray(0, 32);

  const signer = createSign("sha256");
  signer.update(sessionId);
  const derSig = signer.sign(priv);
  const sshEcdsaSig = derEcdsaToSsh(derSig);
  const sigBlob = buildSshSig("ecdsa-sha2-nistp256", sshEcdsaSig);
  const payload = buildSessionBindPayload(hostKeyBlob, sessionId, sigBlob, false);
  const parsed = parseSessionBind(payload);

  it("verifySessionBind returns true for a valid ECDSA-nistp256 signature", () => {
    expect(verifySessionBind(parsed)).toBe(true);
  });

  it("verifySessionBind returns false when signature is corrupted", () => {
    const badSshSig = Buffer.from(sshEcdsaSig);
    // Flip the last byte of the SSH-format sig (within s component)
    badSshSig[badSshSig.length - 1] ^= 0x01;
    const badSigBlob = buildSshSig("ecdsa-sha2-nistp256", badSshSig);
    const badParsed = { ...parsed, signature: badSigBlob };
    expect(verifySessionBind(badParsed)).toBe(false);
  });
});

// ─── ECDSA nistp521 synthetic vector (exercises DER long-form length) ───

describe("ECDSA-nistp521 session-bind", () => {
  const { publicKey: pub, privateKey: priv } = generateKeyPairSync("ec", {
    namedCurve: "P-521",
  });

  // P-521 uncompressed point: 0x04 + x(66) + y(66) = 133 bytes
  const spkiDer = Buffer.from(pub.export({ type: "spki", format: "der" }));
  const qPoint = spkiDer.subarray(-133);
  const hostKeyBlob = buildEcdsaPubBlob("ecdsa-sha2-nistp521", "nistp521", qPoint);
  const sessionId = Buffer.from("ecdsa521-session-identifier-32by", "utf-8").subarray(0, 32);

  const signer = createSign("sha512");
  signer.update(sessionId);
  const derSig = signer.sign(priv);
  const sshEcdsaSig = derEcdsaToSsh(derSig);
  const sigBlob = buildSshSig("ecdsa-sha2-nistp521", sshEcdsaSig);
  const payload = buildSessionBindPayload(hostKeyBlob, sessionId, sigBlob, false);
  const parsed = parseSessionBind(payload);

  it("verifySessionBind returns true for a valid ECDSA-nistp521 signature (long-form DER)", () => {
    expect(verifySessionBind(parsed)).toBe(true);
  });

  it("verifySessionBind returns false when signature is corrupted", () => {
    const badSshSig = Buffer.from(sshEcdsaSig);
    badSshSig[badSshSig.length - 1] ^= 0x01;
    const badSigBlob = buildSshSig("ecdsa-sha2-nistp521", badSshSig);
    expect(verifySessionBind({ ...parsed, signature: badSigBlob })).toBe(false);
  });
});

// ─── Algorithm mismatch ───────────────────────────────────────

describe("algorithm mismatch rejection", () => {
  it("rejects ed25519 key with rsa-sha2-256 algo name", () => {
    const { publicKey: pub, privateKey: priv } = generateKeyPairSync("ed25519");
    const pubRaw = Buffer.from(pub.export({ type: "spki", format: "der" })).subarray(-32);
    const hostKeyBlob = buildEd25519PubBlob(pubRaw);
    const sessionId = Buffer.from("mismatch-test-sessionid-32bytes!", "utf-8").subarray(0, 32);

    // Sign with the ed25519 key but label the algo as rsa-sha2-256
    const rawSig = cryptoSign(null, sessionId, priv);
    const sigBlob = buildSshSig("rsa-sha2-256", rawSig); // WRONG algo name
    const payload = buildSessionBindPayload(hostKeyBlob, sessionId, sigBlob, false);
    const parsed = parseSessionBind(payload);

    expect(verifySessionBind(parsed)).toBe(false);
  });

  it("rejects rsa key with ssh-ed25519 algo name", () => {
    const { publicKey: pub, privateKey: priv } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = pub.export({ format: "jwk" }) as { n: string; e: string };
    const hostKeyBlob = buildRsaPubBlob(
      Buffer.from(jwk.e, "base64url"),
      Buffer.from(jwk.n, "base64url"),
    );
    const sessionId = Buffer.from("mismatch-rsa-sessionid-32bytes!!", "utf-8").subarray(0, 32);
    const signer = createSign("sha256");
    signer.update(sessionId);
    const rawSig = signer.sign(priv);
    const sigBlob = buildSshSig("ssh-ed25519", rawSig); // WRONG algo name
    const payload = buildSessionBindPayload(hostKeyBlob, sessionId, sigBlob, false);
    const parsed = parseSessionBind(payload);

    expect(verifySessionBind(parsed)).toBe(false);
  });
});

// ─── Unsupported key type ─────────────────────────────────────

describe("unsupported key type", () => {
  it("returns false (not throw) for an unknown key type blob", () => {
    // Build a blob with an unsupported key type string
    const fakeBlob = Buffer.concat([
      encodeString("ssh-dss"), // unsupported type
      encodeString(Buffer.from("fake-key-data")),
    ]);
    const sessionId = Buffer.from("test-session-id");
    const fakeSig = buildSshSig("ssh-dss", Buffer.from("fake-sig"));
    const payload = buildSessionBindPayload(fakeBlob, sessionId, fakeSig, false);
    const parsed = parseSessionBind(payload);

    expect(() => verifySessionBind(parsed)).not.toThrow();
    expect(verifySessionBind(parsed)).toBe(false);
  });
});

// ─── sshWirePublicKeyToKeyObject ──────────────────────────────

describe("sshWirePublicKeyToKeyObject", () => {
  it("parses Ed25519 public key blob", () => {
    const { publicKey: pub } = generateKeyPairSync("ed25519");
    const pubPoint = Buffer.from(pub.export({ type: "spki", format: "der" })).subarray(-32);
    const blob = buildEd25519PubBlob(pubPoint);
    const { keyType } = sshWirePublicKeyToKeyObject(blob);
    expect(keyType).toBe("ssh-ed25519");
  });

  it("parses RSA public key blob", () => {
    const { publicKey: pub } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = pub.export({ format: "jwk" }) as { n: string; e: string };
    const blob = buildRsaPubBlob(
      Buffer.from(jwk.e, "base64url"),
      Buffer.from(jwk.n, "base64url"),
    );
    const { keyType } = sshWirePublicKeyToKeyObject(blob);
    expect(keyType).toBe("ssh-rsa");
  });

  it("parses ECDSA-nistp256 public key blob", () => {
    const { publicKey: pub } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spkiDer = Buffer.from(pub.export({ type: "spki", format: "der" }));
    const qPoint = spkiDer.subarray(-65);
    const blob = buildEcdsaPubBlob("ecdsa-sha2-nistp256", "nistp256", qPoint);
    const { keyType } = sshWirePublicKeyToKeyObject(blob);
    expect(keyType).toBe("ecdsa-sha2-nistp256");
  });

  it("throws on unsupported key type", () => {
    const blob = Buffer.concat([
      encodeString("ssh-dss"),
      encodeString(Buffer.from("fake")),
    ]);
    expect(() => sshWirePublicKeyToKeyObject(blob)).toThrow();
  });
});

// ─── fingerprintPublicKey ─────────────────────────────────────

describe("fingerprintPublicKey", () => {
  it("returns SHA256:<base64-no-padding> format", () => {
    const blob = Buffer.from("arbitrary key blob data");
    const fp = fingerprintPublicKey(blob);
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    // Must not end with '='
    expect(fp).not.toMatch(/=$/);
  });

  it("produces the correct SHA256 fingerprint", () => {
    const blob = Buffer.from("test blob");
    const expected = "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    expect(fingerprintPublicKey(blob)).toBe(expected);
  });

  it("different blobs produce different fingerprints", () => {
    const fp1 = fingerprintPublicKey(Buffer.from("blob-a"));
    const fp2 = fingerprintPublicKey(Buffer.from("blob-b"));
    expect(fp1).not.toBe(fp2);
  });
});

// ─── parseSessionBind edge cases ─────────────────────────────

describe("parseSessionBind edge cases", () => {
  it("throws when is_forwarding byte is missing", () => {
    // Build a payload missing the final boolean byte
    const hostKeyBlob = Buffer.from("fake-host-key");
    const sessionId = Buffer.from("session-id");
    const sigBlob = Buffer.from("sig");
    const truncated = Buffer.concat([
      encodeString(hostKeyBlob),
      encodeString(sessionId),
      encodeString(sigBlob),
      // intentionally omit the is_forwarding byte
    ]);
    expect(() => parseSessionBind(truncated)).toThrow();
  });
});
