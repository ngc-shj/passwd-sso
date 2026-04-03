/**
 * WebAuthn authorization for Auth.js Credentials provider.
 *
 * Called by the "webauthn" Credentials provider's authorize function
 * to verify a passkey authentication response and return a user object.
 *
 * Uses withBypassRls for cross-tenant credential lookup since the
 * user is not yet authenticated at this point.
 */

import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import {
  verifyAuthentication,
  getRpOrigin,
  base64urlToUint8Array,
} from "@/lib/webauthn-server";
import type { AuthenticatorDevice } from "@simplewebauthn/types";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";

// challengeId must be a 32-char hex string (16 random bytes)
const CHALLENGE_ID_RE = /^[0-9a-f]{32}$/;

// Dummy public key for timing equalization when credential not found.
// This is an invalid key that will cause verification to fail, but ensures
// the verification code path still runs (preventing timing oracle attacks).
const DUMMY_PUBLIC_KEY = new Uint8Array(65);
const DUMMY_CRED_ID = new Uint8Array(32);

// ── Main authorize function ──────────────────────────────────

export interface WebAuthnAuthResult {
  id: string;
  email: string;
  name: string | null;
  prf?: {
    prfEncryptedSecretKey: string;
    prfSecretKeyIv: string;
    prfSecretKeyAuthTag: string;
  };
}

export async function authorizeWebAuthn(
  credentials: Record<string, unknown>,
): Promise<WebAuthnAuthResult | null> {
  const credentialResponse =
    typeof credentials.credentialResponse === "string"
      ? credentials.credentialResponse
      : null;
  const challengeId =
    typeof credentials.challengeId === "string"
      ? credentials.challengeId
      : null;

  if (!credentialResponse || !challengeId) return null;

  // Validate challengeId format before using in Redis key
  if (!CHALLENGE_ID_RE.test(challengeId)) return null;

  // 1. Redis: consume challenge atomically
  const redis = getRedis();
  if (!redis) return null;

  const challenge = await redis.getdel(
    `webauthn:challenge:signin:${challengeId}`,
  );
  if (!challenge) return null;

  // 2. Parse credential response
  let response: AuthenticationResponseJSON;
  try {
    response = JSON.parse(credentialResponse);
  } catch {
    return null;
  }

  const responseCredentialId = response.id;
  if (!responseCredentialId) return null;

  // 3. Look up credential via withBypassRls (cross-tenant)
  const storedCredential = await withBypassRls(prisma, async () =>
    prisma.webAuthnCredential.findFirst({
      where: { credentialId: responseCredentialId },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  // 4. Build authenticator device object (dummy if not found for timing equalization)
  const authenticator: AuthenticatorDevice = storedCredential
    ? {
        credentialPublicKey: base64urlToUint8Array(
          storedCredential.publicKey,
        ),
        credentialID: base64urlToUint8Array(storedCredential.credentialId),
        counter: Number(storedCredential.counter),
        transports:
          storedCredential.transports as AuthenticatorDevice["transports"],
      }
    : {
        credentialPublicKey: DUMMY_PUBLIC_KEY,
        credentialID: DUMMY_CRED_ID,
        counter: 0,
      };

  // 5. Verify authentication (runs even with dummy credential for timing equalization)
  const rpId = process.env.WEBAUTHN_RP_ID;
  if (!rpId) return null;
  const origin = getRpOrigin(rpId);

  let verified = false;
  let newCounter = 0;
  try {
    const result = await verifyAuthentication(
      response,
      challenge,
      rpId,
      origin,
      authenticator,
    );
    // Only accept if credential was actually found AND verified
    verified = !!storedCredential && result.verified;
    if (result.verified) {
      newCounter = result.authenticationInfo.newCounter;
    }
  } catch {
    verified = false;
  }

  if (!verified || !storedCredential) return null;

  // 6. CAS counter update (prevents replay/clone attacks)
  // last_used_device is set to NULL here; device info is captured
  // by session metadata when Auth.js creates the session.
  const updatedRows = await withBypassRls(prisma, async () =>
    prisma.$executeRaw`
      UPDATE "webauthn_credentials"
      SET counter = ${BigInt(newCounter)},
          "last_used_at" = ${new Date()}
      WHERE id = ${storedCredential.id}
        AND counter = ${storedCredential.counter}
    `,
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (updatedRows === 0) return null;

  // Users without email should not authenticate via passkey
  if (!storedCredential.user.email) return null;

  // Include PRF-wrapped vault key if the credential supports PRF
  const prf =
    storedCredential.prfSupported &&
    storedCredential.prfEncryptedSecretKey &&
    storedCredential.prfSecretKeyIv &&
    storedCredential.prfSecretKeyAuthTag
      ? {
          prfEncryptedSecretKey: storedCredential.prfEncryptedSecretKey,
          prfSecretKeyIv: storedCredential.prfSecretKeyIv,
          prfSecretKeyAuthTag: storedCredential.prfSecretKeyAuthTag,
        }
      : undefined;

  return {
    id: storedCredential.user.id,
    email: storedCredential.user.email,
    name: storedCredential.user.name ?? null,
    prf,
  };
}
