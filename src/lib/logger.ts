/**
 * General-purpose structured logger for application events.
 *
 * Writes JSON to stdout with `_stream: "app"` (distinct from audit logs, which
 * carry `_logType: "audit"` from their own pino instance in
 * @/lib/audit/audit-logger).
 * Use `getLogger()` inside request handlers wrapped with `withRequestLog()`
 * to get a child logger that includes requestId, method, and path.
 *
 * LOG_LEVEL env var controls the minimum level (default: "info").
 *
 * WHY `_stream` AND NOT `_logType`: this base used to set `_logType: "app"`,
 * and call sites that name an alert identifier set `_logType` too — pino writes
 * `base` first and the per-call object after, so every alert line went out with
 * the key TWICE:
 *
 *   {"level":50,"_logType":"app",...,"_logType":"worker.pool.error","msg":...}
 *
 * RFC 8259 leaves duplicate-name handling to the implementation. Last-wins
 * parsers (Go encoding/json, JSON.parse) yield the alert value, so every rule
 * in docs/operations/alerts.md happened to work — but a first-wins or
 * reject-duplicates consumer sees "app" and matches nothing, and that silence
 * is indistinguishable from a healthy pipeline. The stream label and the alert
 * identifier are two different facts and were sharing one key; separating them
 * removes the dependency on parser behaviour rather than documenting it.
 */

import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";
import { SECRET_REDACT_KEYS, REDACTED } from "@/lib/logger/redact-keys";

const appName = process.env.AUDIT_LOG_APP_NAME ?? "passwd-sso";

/**
 * Exported so tests assert against the REAL configuration. Reconstructing an
 * equivalent-looking pino instance in the test file is how a base-field change
 * ships green: the copy and the assertion agree with each other and neither
 * with this module.
 */
export const loggerOptions: pino.LoggerOptions = {
  name: appName,
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { _stream: "app", _app: appName },
  redact: {
    // Shared with the client logger (@/lib/logger/client) so one redaction
    // policy cannot exist as two hand-maintained copies that drift apart.
    paths: [...SECRET_REDACT_KEYS],
    censor: REDACTED,
  },
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
};

const logger = pino(loggerOptions);

/** AsyncLocalStorage for request-scoped logger */
export const requestContext = new AsyncLocalStorage<pino.Logger>();

/** Get request-scoped logger (inside withRequestLog) or fallback to app logger */
export function getLogger(): pino.Logger {
  return requestContext.getStore() ?? logger;
}

export default logger;
