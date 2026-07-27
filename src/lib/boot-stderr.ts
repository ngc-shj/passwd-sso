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
 * This module exists so the `no-console` override lands on a file that cannot
 * see a secret, rather than on `env.ts`, which holds every secret in the
 * process.
 *
 * Caller contract: a message may name a variable and may echo a *non-secret*
 * value back to the operator (`CSP_MODE="dev"` is the operator's own setting,
 * drawn from a two-value enum). It must never carry a credential, key, token,
 * connection string, or `result.data` from env parsing. The env banner honors
 * this by building only from Zod issue paths and messages — variable names,
 * not values.
 */

export function bootStderr(message: string): void {
  console.error(message);
}
