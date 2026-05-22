/**
 * Server-side WebAuthn helpers.
 *
 * Wraps @simplewebauthn/server to provide application-level functions for
 * passkey registration, authentication, and PRF salt derivation.
 *
 * Env vars:
 *   WEBAUTHN_RP_ID        — required at runtime (e.g. "localhost" or "example.com")
 *   WEBAUTHN_RP_NAME      — optional (default "passwd-sso")
 *   WEBAUTHN_PRF_SECRET   — 64-char hex string (32 bytes) for PRF salt derivation
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  GenerateRegistrationOptionsOpts,
  VerifyRegistrationResponseOpts,
  GenerateAuthenticationOptionsOpts,
  VerifyAuthenticationResponseOpts,
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/types";
import { hkdfSync } from "node:crypto";
import type { TxOrPrisma } from "@/lib/prisma";
import { getKeyProviderSync } from "@/lib/key-provider";
import { getRedis } from "@/lib/redis";
import { parseDeviceFromUserAgent } from "@/lib/parse-user-agent";

// ── Shared constants ────────────────────────────────────────

/**
 * One-shot challenge TTL for WebAuthn options (sign-in AND PRF re-bootstrap).
 *
 * Both flows consume the challenge via `redis.getdel(...)` from a per-flow
 * dedicated key namespace. Tuning this value applies to both flows in
 * lockstep — sub-flows MUST NOT define a local override.
 */
export const WEBAUTHN_CHALLENGE_TTL_SECONDS = 300;

// ── Env helpers ──────────────────────────────────────────────

function getRpId(): string {
  const rpId = process.env.WEBAUTHN_RP_ID;
  if (!rpId) throw new Error("WEBAUTHN_RP_ID is not configured");
  return rpId;
}

function getRpName(): string {
  return process.env.WEBAUTHN_RP_NAME ?? "passwd-sso";
}

/**
 * Resolve the RP origin for verification.
 * Priority: WEBAUTHN_RP_ORIGIN > AUTH_URL origin > https://${rpId}
 */
export function getRpOrigin(rpId: string): string {
  if (process.env.WEBAUTHN_RP_ORIGIN) return process.env.WEBAUTHN_RP_ORIGIN;
  if (process.env.AUTH_URL) {
    try {
      const url = new URL(process.env.AUTH_URL);
      return url.origin;
    } catch {
      // fall through
    }
  }
  return `https://${rpId}`;
}

function getPrfSecret(): Buffer {
  return getKeyProviderSync().getKeySync("webauthn-prf");
}

// ── Existing-credential descriptor ──────────────────────────

export interface ExcludeCredential {
  credentialId: string; // base64url-encoded
  transports?: string[];
}

// ── Registration ────────────────────────────────────────────

export async function generateRegistrationOpts(
  userId: string,
  userName: string,
  existingCredentials: ExcludeCredential[],
) {
  const rpId = getRpId();
  const rpName = getRpName();

  // v11: excludeCredentials uses inline type with string id (base64url) — no
  // PublicKeyCredentialDescriptorFuture wrapping, no base64urlToUint8Array conversion.
  const excludeCredentials = existingCredentials.map((c) => ({
    id: c.credentialId,
    transports: (c.transports ?? []) as AuthenticatorTransportFuture[],
  }));

  const opts: GenerateRegistrationOptionsOpts = {
    rpName,
    rpID: rpId,
    // v11: userID type narrowed from `string | Uint8Array` to `Uint8Array`.
    userID: new TextEncoder().encode(userId),
    userName,
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    extensions: {
      credProps: true,
      minPinLength: true,
      largeBlob: { support: "preferred" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };

  return generateRegistrationOptions(opts);
}

export async function verifyRegistration(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  rpId: string,
  rpOrigin: string,
): Promise<VerifiedRegistrationResponse> {
  const opts: VerifyRegistrationResponseOpts = {
    response,
    expectedChallenge,
    expectedOrigin: rpOrigin,
    expectedRPID: rpId,
    requireUserVerification: true,
  };

  return verifyRegistrationResponse(opts);
}

// ── Authentication ──────────────────────────────────────────

export interface AllowCredential {
  credentialId: string; // base64url-encoded
  transports?: string[];
}

export async function generateAuthenticationOpts(
  allowCredentials: AllowCredential[],
) {
  const rpId = getRpId();

  // v11: allowCredentials uses inline type with string id (base64url) — no
  // PublicKeyCredentialDescriptorFuture wrapping, no base64urlToUint8Array conversion.
  const allow = allowCredentials.map((c) => ({
    id: c.credentialId,
    transports: (c.transports ?? []) as AuthenticatorTransportFuture[],
  }));

  const opts: GenerateAuthenticationOptionsOpts = {
    rpID: rpId,
    allowCredentials: allow,
    userVerification: "preferred",
  };

  return generateAuthenticationOptions(opts);
}

// v11: option renamed `authenticator` → `credential`; type `AuthenticatorDevice` removed in favor
// of `WebAuthnCredential` (string `id` instead of Uint8Array `credentialID`, `publicKey` instead
// of `credentialPublicKey`). C9: project policy keeps rpId as single string (defensive narrowing
// vs v11's widening to `string | string[]`).
export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  rpId: string,
  rpOrigin: string,
  credential: WebAuthnCredential,
): Promise<VerifiedAuthenticationResponse> {
  const opts: VerifyAuthenticationResponseOpts = {
    response,
    expectedChallenge,
    expectedOrigin: rpOrigin,
    expectedRPID: rpId,
    credential,
    requireUserVerification: true,
  };

  return verifyAuthenticationResponse(opts);
}

// ── PRF Salt derivation ─────────────────────────────────────

/**
 * Derive a deterministic 32-byte PRF salt for vault unlock.
 *
 * Uses HKDF-SHA256 with:
 *   ikm  = WEBAUTHN_PRF_SECRET (32 bytes from env)
 *   salt = rpId (UTF-8)
 *   info = "prf-vault-unlock-v1" (UTF-8)
 *
 * The salt is RP-global (not per-user) because the PRF output is already
 * unique per credential. This allows the sign-in flow (which doesn't know
 * the userId upfront) to request PRF in the same ceremony.
 *
 * BREAKING CHANGE (from per-user salt `${rpId}:${userId}`):
 * Existing PRF-wrapped keys created with the old per-user salt are
 * incompatible. Users must delete and re-register their passkey to
 * restore PRF vault auto-unlock. Manual passphrase unlock is unaffected.
 *
 * Returns the salt as a hex string (64 chars).
 */
export function derivePrfSalt(): string {
  const rpId = getRpId();
  const ikm = getPrfSecret();
  const salt = Buffer.from(rpId, "utf-8");
  const info = Buffer.from("prf-vault-unlock-v1", "utf-8");

  const derived = hkdfSync("sha256", ikm, salt, info, 32);
  return Buffer.from(derived).toString("hex");
}

// ── Discoverable authentication (for sign-in) ──────────────

/**
 * Generate authentication options for discoverable credentials (passkey sign-in).
 * Unlike generateAuthenticationOpts(), this uses empty allowCredentials
 * so the browser presents all discoverable credentials for the RP.
 */
export async function generateDiscoverableAuthOpts() {
  const rpId = getRpId();

  const opts: GenerateAuthenticationOptionsOpts = {
    rpID: rpId,
    allowCredentials: [],
    userVerification: "required",
  };

  return generateAuthenticationOptions(opts);
}

// ── Helpers ─────────────────────────────────────────────────

export function base64urlToUint8Array(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(pad);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Shared assertion verification helper ────────────────────

/**
 * Outcome of {@link verifyAuthenticationAssertion}.
 *
 * On `ok: true`, callers receive the credential ID plus any stored PRF wrapping
 * fields (for sign-in to relay back to the client). On failure, callers receive
 * an HTTP-style status + an API_ERROR-compatible code so the route can produce
 * a uniform response shape.
 */
export type VerifyAssertionResult =
  | {
      ok: true;
      credentialId: string;
      storedPrf: {
        encryptedSecretKey: string | null;
        iv: string | null;
        authTag: string | null;
      };
    }
  | {
      ok: false;
      status: 400 | 401 | 404 | 503;
      code: string;
      details?: string;
    };

/**
 * Verify a WebAuthn assertion AND advance the credential counter atomically.
 *
 * Shared by sign-in (`/api/webauthn/authenticate/verify`) and PRF re-bootstrap
 * (`/api/webauthn/credentials/[id]/prf`). The counter UPDATE runs on the
 * supplied `tx` so callers can roll it back atomically with their own work
 * (e.g., the PRF endpoint's keyVersion CAS).
 *
 * Caller obligations:
 * - Set RLS context (e.g., `withUserTenantRls(userId, ...)`) BEFORE invoking,
 *   so the credential lookup and counter UPDATE see only the user's row.
 * - Pass a per-flow Redis challenge key namespace. Sign-in uses
 *   `webauthn:challenge:authenticate:${userId}`; PRF rebootstrap uses
 *   `webauthn:challenge:prf-rebootstrap:${userId}`. Sharing a namespace
 *   between flows opens race / DoS / replay windows (#433 / S-N1).
 * - When called inside a `prisma.$transaction`, pass the tx client so the
 *   counter advance rolls back if the surrounding tx aborts. Otherwise pass
 *   `prisma` directly.
 */
export async function verifyAuthenticationAssertion(
  tx: TxOrPrisma,
  userId: string,
  response: AuthenticationResponseJSON,
  challengeKey: string,
  userAgent: string | null = null,
): Promise<VerifyAssertionResult> {
  const redis = getRedis();
  if (!redis) {
    return { ok: false, status: 503, code: "SERVICE_UNAVAILABLE" };
  }

  const challenge = await redis.getdel(challengeKey);
  if (!challenge) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      details: "Challenge expired or already used",
    };
  }

  const rpId = process.env.WEBAUTHN_RP_ID;
  if (!rpId) {
    return { ok: false, status: 503, code: "SERVICE_UNAVAILABLE" };
  }

  const responseCredentialId = (response as unknown as { id?: string }).id;
  if (!responseCredentialId) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      details: "Missing credential ID in response",
    };
  }

  const storedCredential = await tx.webAuthnCredential.findFirst({
    where: { userId, credentialId: responseCredentialId },
  });

  if (!storedCredential) {
    return { ok: false, status: 404, code: "NOT_FOUND", details: "Credential not found" };
  }

  // v11: WebAuthnCredential shape — string `id` (no Uint8Array conversion),
  // `publicKey` (was `credentialPublicKey`).
  const credential: WebAuthnCredential = {
    id: storedCredential.credentialId,
    publicKey: base64urlToUint8Array(storedCredential.publicKey),
    counter: Number(storedCredential.counter),
    transports: storedCredential.transports as WebAuthnCredential["transports"],
  };

  const origin = getRpOrigin(rpId);

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthentication(response, challenge, rpId, origin, credential);
  } catch {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      details: "Authentication verification failed",
    };
  }

  if (!verification.verified) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      details: "Authentication verification failed",
    };
  }

  // Counter CAS — runs on the SUPPLIED tx so it rolls back if the caller's tx
  // aborts. Without this, a captured assertion replayed against the new endpoint
  // could commit the counter advance even when the surrounding keyVersion CAS
  // rejects the wrap update (#433 / S-N4).
  const newCounter = BigInt(verification.authenticationInfo.newCounter);
  const lastUsedDevice = parseDeviceFromUserAgent(userAgent);
  const updatedRows = await tx.$executeRaw`
    UPDATE "webauthn_credentials"
    SET counter = ${newCounter},
        "last_used_at" = ${new Date()},
        "last_used_device" = ${lastUsedDevice}
    WHERE id = ${storedCredential.id}
      AND counter = ${storedCredential.counter}
  `;

  if (updatedRows === 0) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      details: "Counter mismatch — credential may be cloned. Re-register your passkey.",
    };
  }

  return {
    ok: true,
    credentialId: storedCredential.credentialId,
    storedPrf: {
      encryptedSecretKey: storedCredential.prfEncryptedSecretKey,
      iv: storedCredential.prfSecretKeyIv,
      authTag: storedCredential.prfSecretKeyAuthTag,
    },
  };
}
