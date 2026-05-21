/**
 * Short-lived HMAC-signed access tokens for password-protected shares.
 *
 * After a viewer verifies the access password, they receive a token
 * scoped to a specific share ID with a 5-minute TTL. The token is
 * sent as an Authorization header to content/download APIs.
 *
 * Token format (3 dot-separated segments):
 *   ${kv}.${payloadB64}.${signature}
 *
 * - kv: master key version (integer, ASCII decimal). Bound into HMAC input
 *   to prevent downgrade attacks (an attacker cannot rewrite kv=2 → kv=1).
 * - payloadB64: base64url-encoded JSON { sid, exp }.
 * - signature: HMAC-SHA256 over `${kv}|${payloadB64}` using a per-version
 *   signing key derived as HMAC(masterKey[kv], "share-access-token-v${kv}").
 *
 * Pre-1.0: tokens without the kv-prefixed format are rejected. Token TTL
 * is 5 minutes so the impact window is bounded.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
} from "@/lib/crypto/crypto-server";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const TOKEN_TTL_MS = 5 * MS_PER_MINUTE;

function getSigningKey(version: number): Buffer {
  return createHmac("sha256", getMasterKeyByVersion(version))
    .update(`share-access-token-v${version}`)
    .digest();
}

function hmacBody(version: number, payloadB64: string): string {
  // kv is bound into HMAC input to prevent downgrade.
  return createHmac("sha256", getSigningKey(version))
    .update(`${version}|${payloadB64}`)
    .digest("base64url");
}

/** Create a signed access token for a specific share. */
export function createShareAccessToken(shareId: string): string {
  const version = getCurrentMasterKeyVersion();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = JSON.stringify({ sid: shareId, exp: expiresAt });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const signature = hmacBody(version, payloadB64);
  return `${version}.${payloadB64}.${signature}`;
}

/** Verify a signed access token. Returns true only if valid, not expired, and matches shareId. */
export function verifyShareAccessToken(
  token: string,
  expectedShareId: string
): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [versionStr, payloadB64, signature] = parts;
    if (!versionStr || !payloadB64 || !signature) return false;

    // Strict numeric version parse — reject "1.0", "01", " 1", etc.
    if (!/^[1-9][0-9]*$/.test(versionStr)) return false;
    const version = parseInt(versionStr, 10);

    // Compute expected signature with kv bound into the HMAC input.
    const expectedSig = hmacBody(version, payloadB64);
    const a = Buffer.from(signature, "base64url");
    const b = Buffer.from(expectedSig, "base64url");
    if (a.length !== b.length) return false;
    if (!timingSafeEqual(a, b)) return false;

    // Parse payload after signature verification.
    const parsed: { sid?: string; exp?: number } = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString()
    );
    if (parsed.sid !== expectedShareId) return false;
    if (typeof parsed.exp !== "number" || Date.now() > parsed.exp) return false;

    return true;
  } catch {
    return false;
  }
}
