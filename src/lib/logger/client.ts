/**
 * Browser-safe structured logger.
 *
 * The server logger (`@/lib/logger`) is pino, which imports `node:async_hooks`
 * and therefore cannot be bundled for the browser. Client components need a
 * diagnostic path that does not drag Node built-ins into the bundle, so this
 * module is deliberately dependency-free apart from the shared redaction keys.
 *
 * This file and `@/lib/boot-stderr` are the only modules under `src/` permitted
 * a raw `console` call; `no-console` is `error` everywhere else and grants an
 * override to exactly these two. Concentrating the sink here is what makes the
 * override list a reviewable audit surface.
 */

import { CLIENT_REDACT_KEYS, REDACTED } from "./redact-keys";

/**
 * Flat scalars only. A nested object cannot be redacted without traversing it,
 * and traversal is how a whole credential object ends up in a log line — so the
 * type makes "log the entire response" a compile error rather than a runtime
 * leak. Key-name redaction below covers the other half: a secret passed as a
 * bare string.
 */
export type ClientLogFields = Record<string, string | number | boolean | null>;

function redact(fields: ClientLogFields): ClientLogFields {
  const out: ClientLogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = CLIENT_REDACT_KEYS.includes(key) ? REDACTED : value;
  }
  return out;
}

/**
 * `message` MUST be a constant string — it is emitted verbatim and is the one
 * channel redaction cannot cover. Every variable value belongs in `fields`,
 * which is redacted by key name. Interpolating a caller-supplied value into the
 * message (a path, a URL, an error string) routes it around the denylist.
 */
export function clientLogWarn(message: string, fields?: ClientLogFields): void {
  if (fields) console.warn(message, redact(fields));
  else console.warn(message);
}

/** See {@link clientLogWarn} on the constant-message requirement. */
export function clientLogError(message: string, fields?: ClientLogFields): void {
  if (fields) console.error(message, redact(fields));
  else console.error(message);
}
