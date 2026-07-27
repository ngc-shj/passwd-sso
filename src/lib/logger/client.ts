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
import type { ClientLogEvent, ClientErrorCode, ClientLogStage } from "./client-events";

export {
  CLIENT_LOG_EVENT,
  CLIENT_ERROR_CODE,
  CLIENT_LOG_STAGE,
  toClientErrorCode,
} from "./client-events";
export type { ClientLogEvent, ClientErrorCode, ClientLogStage } from "./client-events";

/**
 * A value that cannot smuggle free text into a browser console.
 *
 * `string` is deliberately absent. It was the last hole in this design: field
 * NAMES are redacted, so `{ detail: `token=${secret}` }` typechecked and was
 * emitted verbatim. What the call sites actually need is narrower than `string`
 * anyway — an opaque id, a status code, a closed vocabulary, a boolean.
 *
 * `Opaque` is the escape hatch for the one legitimate string-ish case: a value
 * the caller has already bounded (an id, a truncated path segment). Wrapping is
 * explicit, so a reviewer sees the claim being made and can check it, rather
 * than a bare template literal sliding through.
 */
export type ClientLogValue =
  | ClientLogEnum
  | number
  | boolean
  | null
  | Opaque;

/** A member of a closed vocabulary declared in client-events.ts. */
export type ClientLogEnum = ClientErrorCode | ClientLogStage;

/**
 * An explicitly bounded string. Construct with {@link opaque}, whose contract
 * is: the value contains no user input, no server text, and no URL query.
 *
 * Branded with a module-private symbol rather than a visible property. An
 * earlier version used `{ readonly __opaque: string }`, which had three
 * problems: the emitted log value became an object (contradicting "flat values
 * only" and changing the field shape downstream consumers see), and the shape
 * was public, so `{ __opaque: `token=${secret}` }` assigned cleanly and skipped
 * the truncation entirely. The symbol is not exported, so the brand cannot be
 * produced structurally — `opaque()` is the only way in — and at runtime the
 * value stays an ordinary string.
 */
declare const opaqueBrand: unique symbol;

export type Opaque = string & { readonly [opaqueBrand]: true };

/**
 * Mark a string as safe to log. Truncates as a backstop — an id that grew into
 * a serialized blob still cannot flood the console.
 */
export function opaque(value: string, maxLength = 64): Opaque {
  return value.slice(0, maxLength) as Opaque;
}

/**
 * Flat values only. A nested object cannot be redacted without traversing it,
 * and traversal is how a whole credential object ends up in a log line — so the
 * type makes "log the entire response" a compile error rather than a runtime
 * leak. Key-name redaction below covers a secret stored under a known key.
 */
export type ClientLogFields = Record<string, ClientLogValue>;

/** Emitted shape: like ClientLogFields, but a censored slot holds REDACTED. */
type EmittedFields = Record<string, ClientLogValue | typeof REDACTED>;

function redact(fields: ClientLogFields): EmittedFields {
  const out: EmittedFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = CLIENT_REDACT_KEYS.includes(key) ? REDACTED : value;
  }
  return out;
}

/**
 * `event` is a `ClientLogEvent`, not a `string`. The message channel is emitted
 * verbatim and is the one thing redaction cannot cover, so it is closed by the
 * type system rather than by a lint rule: a template literal, a variable, or a
 * concatenation simply does not assign. Variable data goes in `fields`, which is
 * redacted by key name.
 */
export function clientLogWarn(event: ClientLogEvent, fields?: ClientLogFields): void {
  if (fields) console.warn(event, redact(fields));
  else console.warn(event);
}

/** See {@link clientLogWarn} on why `event` is not a string. */
export function clientLogError(event: ClientLogEvent, fields?: ClientLogFields): void {
  if (fields) console.error(event, redact(fields));
  else console.error(event);
}
