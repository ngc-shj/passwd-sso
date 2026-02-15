/**
 * Structured audit log emitter for external forwarding.
 *
 * Writes JSON to stdout when AUDIT_LOG_FORWARD=true.
 * Fluent Bit (or any log aggregator) captures these lines
 * by filtering on `_logType: "audit"`.
 *
 * This module NEVER replaces the existing DB-based audit logging.
 */

import pino, { type DestinationStream } from "pino";

/**
 * Factory to create a pino logger instance for audit events.
 *
 * In production, use the `auditLogger` singleton exported below.
 * In tests, call `createAuditLogger({ destination })` to capture output.
 */
export function createAuditLogger(opts?: {
  enabled?: boolean;
  appName?: string;
  destination?: DestinationStream;
}): pino.Logger {
  const enabled = opts?.enabled ?? process.env.AUDIT_LOG_FORWARD === "true";
  const appName =
    opts?.appName ?? process.env.AUDIT_LOG_APP_NAME ?? "passwd-sso";

  const pinoOpts: pino.LoggerOptions = {
    name: appName,
    level: "info",
    enabled,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      _logType: "audit",
      _app: appName,
      _version: "1",
    },
    // Redact paths match the object structure passed to pino.info():
    //   { audit: { metadata: { ... } } }
    redact: {
      paths: [
        "audit.metadata.password",
        "audit.metadata.passphrase",
        "audit.metadata.secret",
        "audit.metadata.secretKey",
        "audit.metadata.encryptedBlob",
        "audit.metadata.encryptedOverview",
        "audit.metadata.encryptedData",
        "audit.metadata.encryptedSecretKey",
        "audit.metadata.token",
        "audit.metadata.tokenHash",
        "audit.metadata.accessToken",
        "audit.metadata.refreshToken",
        "audit.metadata.idToken",
      ],
      censor: "[REDACTED]",
    },
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  };

  return opts?.destination
    ? pino(pinoOpts, opts.destination)
    : pino(pinoOpts);
}

/** Production singleton */
export const auditLogger = createAuditLogger();

/**
 * Key names to strip from metadata during recursive sanitization.
 * Defense-in-depth: even if a caller accidentally passes sensitive data,
 * sanitizeMetadata() in audit.ts will remove these keys before pino sees them.
 */
export const METADATA_BLOCKLIST = new Set([
  "password",
  "passphrase",
  "secret",
  "secretKey",
  "encryptedBlob",
  "encryptedOverview",
  "encryptedData",
  "encryptedSecretKey",
  "encryptedOrgKey",
  "masterPasswordServerHash",
  "token",
  "tokenHash",
  "accessToken",
  "refreshToken",
  "idToken",
  "accountSalt",
  "passphraseVerifierHmac",
]);
