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
  PublicKeyCredentialDescriptorFuture,
  AuthenticatorDevice,
} from "@simplewebauthn/types";
import { hkdfSync } from "node:crypto";

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
  const hex = process.env.WEBAUTHN_PRF_SECRET;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "WEBAUTHN_PRF_SECRET must be a 64-character hex string (32 bytes)",
    );
  }
  return Buffer.from(hex, "hex");
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

  const excludeCredentials: PublicKeyCredentialDescriptorFuture[] =
    existingCredentials.map((c) => ({
      id: base64urlToUint8Array(c.credentialId),
      type: "public-key" as const,
      transports: (c.transports ?? []) as AuthenticatorTransportFuture[],
    }));

  const opts: GenerateRegistrationOptionsOpts = {
    rpName,
    rpID: rpId,
    userID: Buffer.from(userId, "utf-8").toString("base64url"),
    userName,
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
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

  const allow: PublicKeyCredentialDescriptorFuture[] = allowCredentials.map(
    (c) => ({
      id: base64urlToUint8Array(c.credentialId),
      type: "public-key" as const,
      transports: (c.transports ?? []) as AuthenticatorTransportFuture[],
    }),
  );

  const opts: GenerateAuthenticationOptionsOpts = {
    rpID: rpId,
    allowCredentials: allow,
    userVerification: "preferred",
  };

  return generateAuthenticationOptions(opts);
}

export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  rpId: string,
  rpOrigin: string,
  credential: AuthenticatorDevice,
): Promise<VerifiedAuthenticationResponse> {
  const opts: VerifyAuthenticationResponseOpts = {
    response,
    expectedChallenge,
    expectedOrigin: rpOrigin,
    expectedRPID: rpId,
    authenticator: credential,
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
 *   salt = `${rpId}:${userId}` (UTF-8)
 *   info = "prf-vault-unlock-v1" (UTF-8)
 *
 * Returns the salt as a hex string (64 chars).
 */
export function derivePrfSalt(userId: string): string {
  const rpId = getRpId();
  const ikm = getPrfSecret();
  const salt = Buffer.from(`${rpId}:${userId}`, "utf-8");
  const info = Buffer.from("prf-vault-unlock-v1", "utf-8");

  const derived = hkdfSync("sha256", ikm, salt, info, 32);
  return Buffer.from(derived).toString("hex");
}

// ── Helpers ─────────────────────────────────────────────────

function base64urlToUint8Array(base64url: string): Uint8Array {
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
