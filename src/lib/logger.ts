/**
 * General-purpose structured logger for application events.
 *
 * Writes JSON to stdout with `_logType: "app"` (distinct from audit logs).
 * Use `getLogger()` inside request handlers wrapped with `withRequestLog()`
 * to get a child logger that includes requestId, method, and path.
 *
 * LOG_LEVEL env var controls the minimum level (default: "info").
 */

import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";
import { SECRET_REDACT_KEYS, REDACTED } from "@/lib/logger/redact-keys";

const appName = process.env.AUDIT_LOG_APP_NAME ?? "passwd-sso";

const logger = pino({
  name: appName,
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { _logType: "app", _app: appName },
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
});

/** AsyncLocalStorage for request-scoped logger */
export const requestContext = new AsyncLocalStorage<pino.Logger>();

/** Get request-scoped logger (inside withRequestLog) or fallback to app logger */
export function getLogger(): pino.Logger {
  return requestContext.getStore() ?? logger;
}

export default logger;
