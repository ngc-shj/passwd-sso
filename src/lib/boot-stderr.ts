/**
 * Raw stderr writer for boot-time diagnostics that run before any logger exists.
 *
 * Two callers, both structurally unable to use pino:
 *   - `@/lib/env` validates `process.env` during module initialization; the
 *     logger is constructed after env, so routing this through pino would
 *     invert a deliberate dependency order — and the failure being reported is
 *     precisely "the environment is misconfigured", which must still print when
 *     logging itself is misconfigured.
 *   - `@/lib/security/csp-builder` warns at module scope when a production
 *     build ignores `CSP_MODE`.
 *
 * This module exists so the `no-console` override lands on a file that holds no
 * secret itself, rather than on `env.ts`, which holds every secret in the
 * process. Note what that does and does not buy: THIS FILE cannot see a secret,
 * but the callers assemble `message`, and `env.ts` assembles it with all of
 * `process.env` in scope. Moving the override moved the lint exemption, not the
 * risk.
 *
 * Caller contract: a message must be built from string literals, closed-union
 * values, and numbers. It must never carry a credential, key, token, connection
 * string, an arbitrary env value, or `result.data` from env parsing — including
 * a value being reported as *rejected*, which is arbitrary operator input
 * precisely because it failed validation.
 *
 * The contract is enforced, not merely documented:
 * `scripts/checks/check-boot-stderr-callers.mjs` walks every call site and
 * fails the build on an interpolation it cannot prove bounded. That gate exists
 * because `check-console-sinks` guards only the shape of the `console.error`
 * call below — a caller passing `bootStderr(`token=${t}`)` was verified to pass
 * both that gate and `eslint` with exit 0.
 */

export function bootStderr(message: string): void {
  console.error(message);
}
