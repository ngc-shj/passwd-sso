/**
 * Field names that must never appear verbatim in a log line.
 *
 * Single source of truth for two redaction implementations: the server-side
 * pino `redact.paths` config (`@/lib/logger`) and the client-side logger
 * (`@/lib/logger/client`). Two hand-maintained copies of one redaction policy
 * drift; this file is why they cannot.
 *
 * No `node:*` imports — this module is reachable from the browser bundle
 * through the client logger.
 */

/** Secret material. Redacted on both server and client. */
export const SECRET_REDACT_KEYS = [
  "password",
  "passphrase",
  "secret",
  "secretKey",
  "authHash",
  "encryptedBlob",
  "encryptedOverview",
  "encryptedData",
  "encryptedSecretKey",
  "token",
  "tokenHash",
  "codeHash",
  "accessToken",
  "refreshToken",
  "idToken",
  "authorization",
  "cookie",
] as const;

/**
 * Identity values redacted on the client only.
 *
 * A browser console is a lower-trust sink than server stdout: any extension
 * holding `debugger` permission can read it, and error-reporting SDKs ship it
 * off the machine. Server logs already correlate by opaque id, so these are
 * additive rather than a widening of the server policy.
 */
export const CLIENT_ONLY_REDACT_KEYS = [
  "email",
  "userId",
  "sessionToken",
  "credentialId",
] as const;

/** Client-side redaction set — a superset of the server's. */
export const CLIENT_REDACT_KEYS: readonly string[] = [
  ...SECRET_REDACT_KEYS,
  ...CLIENT_ONLY_REDACT_KEYS,
];

export const REDACTED = "[REDACTED]";
