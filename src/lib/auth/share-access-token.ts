/**
 * Short-lived HMAC-signed access tokens for password-protected shares.
 *
 * After a viewer verifies the access password, they receive a token
 * scoped to a specific share ID with a 5-minute TTL. The token is
 * sent as an Authorization header to content/download APIs.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { getMasterKeyByVersion } from "@/lib/crypto-server";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const TOKEN_TTL_MS = 5 * MS_PER_MINUTE;

function getSigningKey(): Buffer {
  return createHmac("sha256", getMasterKeyByVersion(1))
    .update("share-access-token-v1")
    .digest();
}

/** Create a signed access token for a specific share. */
export function createShareAccessToken(shareId: string): string {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = JSON.stringify({ sid: shareId, exp: expiresAt });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const signature = createHmac("sha256", getSigningKey())
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${signature}`;
}

/** Verify a signed access token. Returns true only if valid, not expired, and matches shareId. */
export function verifyShareAccessToken(
  token: string,
  expectedShareId: string
): boolean {
  try {
    const dotIdx = token.indexOf(".");
    if (dotIdx < 0) return false;
    const payloadB64 = token.slice(0, dotIdx);
    const signature = token.slice(dotIdx + 1);
    if (!payloadB64 || !signature) return false;

    // Verify signature first
    const expectedSig = createHmac("sha256", getSigningKey())
      .update(payloadB64)
      .digest("base64url");
    const a = Buffer.from(signature, "base64url");
    const b = Buffer.from(expectedSig, "base64url");
    if (a.length !== b.length) return false;
    if (!timingSafeEqual(a, b)) return false;

    // Parse payload after signature verification
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
