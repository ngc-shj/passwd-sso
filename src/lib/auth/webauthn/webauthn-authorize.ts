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
  CHALLENGE_ID_RE,
} from "@/lib/auth/webauthn/webauthn-server";
import type { WebAuthnCredential, AuthenticationResponseJSON } from "@simplewebauthn/server";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { MS_PER_SECOND } from "@/lib/constants/time";

// C10: window in which two counter==0 authentications are treated as
// suspected rapid-reuse (defense-in-depth audit telemetry only — never
// rejects). 5s captures human-impossible re-tap intervals without
// flagging legitimate rapid Touch ID on modern hardware.
const COUNTER_ZERO_REUSE_WINDOW_MS = 5 * MS_PER_SECOND;

// C5: Dummy credential for timing equalization when credential not found.
//
// v9 used an all-zeros 65-byte buffer as DUMMY_PUBLIC_KEY. v11's CBOR-based
// COSE-key decoder may short-circuit on the all-zeros buffer before reaching
// signature verification, which would make the dummy branch faster than the
// real branch and create a credential-enumeration timing oracle.
//
// Replacement: a valid COSE-encoded EC2/P-256 public key built from the
// standard P-256 generator point (FIPS 186-4 / SEC 2). This is a well-known
// constant — there is no private key to leak. Signature verification still
// fails (because the assertion was not signed with the matching private
// key), but the verification code path executes the full CBOR decode + ECDSA
// verify, keeping dummy-branch timing comparable to the real branch.
//
// COSE layout (RFC 8152 §13.1, deterministic encoding):
//   A5                       // map(5)
//   01 02                    // kty (1) = EC2 (2)
//   03 26                    // alg (3) = ES256 (-7)
//   20 01                    // crv (-1) = P-256 (1)
//   21 58 20 <x: 32 bytes>   // x (-2)
//   22 58 20 <y: 32 bytes>   // y (-3)
const DUMMY_PUBLIC_KEY = new Uint8Array([
  0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01,
  0x21, 0x58, 0x20,
  // x = P-256 generator x-coordinate
  0x6b, 0x17, 0xd1, 0xf2, 0xe1, 0x2c, 0x42, 0x47, 0xf8, 0xbc, 0xe6, 0xe5,
  0x63, 0xa4, 0x40, 0xf2, 0x77, 0x03, 0x7d, 0x81, 0x2d, 0xeb, 0x33, 0xa0,
  0xf4, 0xa1, 0x39, 0x45, 0xd8, 0x98, 0xc2, 0x96,
  0x22, 0x58, 0x20,
  // y = P-256 generator y-coordinate
  0x4f, 0xe3, 0x42, 0xe2, 0xfe, 0x1a, 0x7f, 0x9b, 0x8e, 0xe7, 0xeb, 0x4a,
  0x7c, 0x0f, 0x9e, 0x16, 0x2b, 0xce, 0x33, 0x57, 0x6b, 0x31, 0x5e, 0xce,
  0xcb, 0xb6, 0x40, 0x68, 0x37, 0xbf, 0x51, 0xf5,
]);
// 43-char base64url string = 32-byte dummy credential ID (matches the previous
// new Uint8Array(32) length so byte-equivalence with v9 timing is preserved).
const DUMMY_CRED_ID = "A".repeat(43);

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
  const storedCredential = await withBypassRls(prisma, async (tx) =>
    tx.webAuthnCredential.findFirst({
      where: { credentialId: responseCredentialId },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  // 4. Build WebAuthnCredential (dummy if not found for timing equalization).
  // v11 renamed AuthenticatorDevice → WebAuthnCredential, with `id: string`
  // (base64url, not Uint8Array) and `publicKey` (not `credentialPublicKey`).
  const credential: WebAuthnCredential = storedCredential
    ? {
        id: storedCredential.credentialId,
        publicKey: base64urlToUint8Array(storedCredential.publicKey),
        counter: Number(storedCredential.counter),
        transports:
          storedCredential.transports as WebAuthnCredential["transports"],
      }
    : {
        id: DUMMY_CRED_ID,
        publicKey: DUMMY_PUBLIC_KEY,
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
      credential,
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
  const updatedRows = await withBypassRls(prisma, async (tx) =>
    tx.$executeRaw`
      UPDATE "webauthn_credentials"
      SET counter = ${BigInt(newCounter)},
          "last_used_at" = ${new Date()}
      WHERE id = ${storedCredential.id}
        AND counter = ${storedCredential.counter}
    `,
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (updatedRows === 0) return null;

  // C10 (OWASP A07-2): defense-in-depth audit telemetry for counter==0
  // devices (older YubiKey models / some Windows Hello impls don't bump
  // the signCount). Primary defense is still the CAS above; this emits
  // a warning when we see two zero-counter authentications < 5s apart
  // for the same credential — a pattern that's normal-but-suspicious
  // on counter-less devices and would indicate replay on a counter-full
  // device. NEVER rejects — that produced FPs on legit rapid Touch ID.
  // Emitted request-less because the Auth.js Credentials provider
  // authorize() function does not have access to the NextRequest.
  if (
    BigInt(storedCredential.counter) === 0n &&
    newCounter === 0 &&
    storedCredential.lastUsedAt &&
    Date.now() - storedCredential.lastUsedAt.getTime() < COUNTER_ZERO_REUSE_WINDOW_MS
  ) {
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      userId: storedCredential.userId,
      action: AUDIT_ACTION.WEBAUTHN_COUNTER_ZERO_RAPID_REUSE,
      metadata: {
        credentialId: storedCredential.id,
        intervalMs: Date.now() - storedCredential.lastUsedAt.getTime(),
      },
    });
  }

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
