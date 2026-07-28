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
import type {
  ClientLogEvent,
  ClientLogPayloads,
  ClientErrorCode,
  ClientLogStage,
  Opaque,
} from "./client-events";

export {
  CLIENT_LOG_EVENT,
  CLIENT_ERROR_CODE,
  CLIENT_LOG_STAGE,
  toClientErrorCode,
  opaque,
} from "./client-events";
export type {
  ClientLogEvent,
  ClientLogPayloads,
  ClientErrorCode,
  ClientLogStage,
  Opaque,
} from "./client-events";

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
 * Flat values only. A nested object cannot be redacted without traversing it,
 * and traversal is how a whole credential object ends up in a log line — so the
 * type makes "log the entire response" a compile error rather than a runtime
 * leak. Key-name redaction below covers a secret stored under a known key.
 */
export type ClientLogFields = Record<string, ClientLogValue>;

/** Emitted shape: like ClientLogFields, but a censored slot holds REDACTED. */
type EmittedFields = Record<string, ClientLogValue | typeof REDACTED>;

/**
 * Exported for tests: the public API now constrains keys per event, so the
 * sink-side layer can only be exercised directly. That is the point of keeping
 * it — it defends the paths the types do not reach.
 *
 * Scope, precisely: this inspects TOP-LEVEL KEY NAMES only. It catches a secret
 * stored under a known key on a payload that reached here via a cast or untyped
 * JS. It does NOT traverse, so a cast-in nested object (`{ context: { token } }`)
 * is emitted with `context` intact — the top-level key is `context`, which is
 * not on the list. Nesting is a compile error through the typed API, which is
 * where that case is actually prevented; this is the backstop for known keys,
 * not a general-purpose sanitizer.
 */
export function redact(fields: Record<string, ClientLogValue>): EmittedFields {
  const out: EmittedFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = CLIENT_REDACT_KEYS.includes(key) ? REDACTED : value;
  }
  return out;
}

/**
 * Two independent restrictions, both at compile time.
 *
 * `event` is a `ClientLogEvent`, not a `string`: the id is emitted verbatim and
 * is the one channel redaction cannot cover, so a template literal, a variable,
 * or a concatenation simply does not assign. (A lint rule tried this first and
 * was bypassable by an aliased import.)
 *
 * `fields` is `ClientLogPayloads[E]` — the exact key set declared for THAT
 * event. Restricting the value type alone was not enough: it says nothing about
 * which fields exist, so `{ otp: 123456 }` and `{ detail: opaque(secret) }`
 * both typechecked. An unlisted key is now an error.
 *
 * `fields` is required, not optional. Every declared payload has at least one
 * required key, so an optional parameter let `clientLogError(EVENT)` compile
 * with the payload simply absent. If an event ever legitimately carries no
 * fields, widen this to a conditional rest tuple rather than making the
 * parameter optional for all of them.
 *
 * `CLIENT_REDACT_KEYS` still runs beneath this as the sink-side layer, for the
 * cases the types cannot see (a cast, a call from untyped JS, a future widening).
 */
export function clientLogWarn<E extends ClientLogEvent>(
  event: E,
  fields: ClientLogPayloads[E],
): void {
  console.warn(event, redact(fields));
}

/** See {@link clientLogWarn} on why both parameters are constrained. */
export function clientLogError<E extends ClientLogEvent>(
  event: E,
  fields: ClientLogPayloads[E],
): void {
  console.error(event, redact(fields));
}
