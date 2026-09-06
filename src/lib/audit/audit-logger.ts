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

const DEFAULT_APP_NAME = process.env.AUDIT_LOG_APP_NAME ?? "passwd-sso";

/**
 * Key names to strip from metadata during recursive sanitization.
 * Defense-in-depth: even if a caller accidentally passes sensitive data,
 * sanitizeMetadata() in audit.ts will remove these keys before pino sees them.
 *
 * Also used to generate pino redact paths for auditLogger.
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
  "encryptedTeamKey",
  "masterPasswordServerHash",
  "token",
  "tokenHash",
  "accessToken",
  "refreshToken",
  "idToken",
  "accountSalt",
  "passphraseVerifierHmac",
  "storedVersion",
  "entries",
]);


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
    opts?.appName ?? DEFAULT_APP_NAME;

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
    redact: {
      paths: [...METADATA_BLOCKLIST].map((k) => `audit.metadata.${k}`),
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
 * Dead-letter logger for audit entries that failed after max retries
 * or whose tenantId could not be resolved.
 *
 * Always enabled (unlike auditLogger which depends on AUDIT_LOG_FORWARD).
 * External alerting should monitor for `_logType: "audit-dead-letter"`.
 */
export const deadLetterLogger = pino({
  name: DEFAULT_APP_NAME,
  level: "warn",
  enabled: true,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    _logType: "audit-dead-letter",
    _app: DEFAULT_APP_NAME,
  },
  // No redact paths needed — but the reason is that every field deadLetterEntry()
  // emits is BOUNDED, not merely that they can be enumerated. The enumeration
  // was already correct while `error` held `String(err)`: a pg error's message
  // names the DB role and host, a Prisma error's carries the failing query with
  // its bound parameters, and pino's key-name redaction never reaches inside a
  // message. `error` is now ErrorLogFields — a token-shaped { name, code } —
  // which is what lets this logger ship without redact paths.
  //
  // Adding a free-text field here re-opens that hole silently. Reduce it at the
  // call site (errorLogFields) rather than adding a redact path, because a path
  // matches a key and the leak lives in the value.
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
});

/**
 * Audit emits refused because an RLS context was open.
 *
 * A SEPARATE `_logType` rather than another `audit-dead-letter` reason, because
 * the forwarder excludes that type wholesale (`infra/fluent-bit/fluent-bit.conf`)
 * and every OUTPUT there matches `app.*`. A reason added under the excluded type
 * would be dropped before any output saw it — and re-tagging it to escape the
 * exclusion produces a record no output matches either, which reads as a working
 * carve-out and forwards nothing.
 *
 * The exclusion's justification is that a dead-letter record carries whatever the
 * failing caller passed, including error text. That does not apply here: this
 * payload has no `error` field at all — the refusal is a control decision, not a
 * failure — so it ships without re-opening the hole the exclusion protects.
 *
 * This is the only audit-loss reason that fires with a healthy database AND is
 * forwarded. `invalid_user_id` also fires healthy, but it is a caller error and
 * remains under the excluded type — recorded as a known forwarding gap in
 * docs/operations/alerts.md rather than silently implied away here.
 *
 * It writes no row anywhere, so not forwarding it would make it unobservable.
 * External alerting should monitor `_logType: "audit-refused"`.
 *
 * No `redact` paths, for the same reason `deadLetterLogger` has none and with
 * MORE at stake: every field `deadLetterEntry` emits is BOUNDED — enum scope and
 * action, a UUID-checked actor id, a DB-derived tenant id, a constant reason —
 * and this call site passes no `error`, so no free text enters. That bound is
 * load-bearing here in a way it is not on the sibling, because this stream ships
 * by default. Adding a free-text field re-opens the hole silently; reduce it at
 * the call site rather than adding a redact path, which matches a key while the
 * leak lives in the value.
 */
export const refusedEmitLogger = pino({
  name: DEFAULT_APP_NAME,
  level: "warn",
  enabled: true,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    _logType: "audit-refused",
    _app: DEFAULT_APP_NAME,
  },
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
});
