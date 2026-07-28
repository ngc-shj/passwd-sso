/**
 * Raw stderr writer for boot-time diagnostics that run before any logger exists.
 *
 * Callers, all structurally unable to use pino:
 *   - `@/lib/env` validates `process.env` during module initialization; the
 *     logger is constructed after env, so routing this through pino would
 *     invert a deliberate dependency order — and the failure being reported is
 *     precisely "the environment is misconfigured", which must still print when
 *     logging itself is misconfigured.
 *   - `@/lib/security/csp-builder` warns at module scope when a production
 *     build ignores `CSP_MODE`.
 *   - `@/lib/key-provider/base-cloud-provider` reports a stale cached key when
 *     the logger import itself failed.
 *
 * The guarantee is in the TYPE, not in a caller contract or a lint rule.
 * `bootStderr` takes a {@link BootDiagnostic} — a closed union whose every field
 * is a brand, a closed union, or a number — so a secret has no parameter it fits
 * into, under any import form and from any call position. The prose text is
 * rendered HERE, from data the caller could not have forged, rather than
 * assembled by the caller and inspected afterwards. See `@/lib/boot-events` for
 * why the previous `(message: string)` signature was abandoned.
 *
 * This file and `@/lib/logger/client` are the only modules under `src/`
 * permitted a raw `console` call; `scripts/checks/check-console-sinks.mjs`
 * guards the shape of the call below, and
 * `scripts/checks/check-boot-diagnostic-shape.mjs` guards that the payload types
 * never widen back toward `string`.
 */

import { BOOT_EVENT, type BootDiagnostic } from "@/lib/boot-events";

const RULE = "=".repeat(60);

/**
 * Render a diagnostic to its operator-facing text.
 *
 * Exhaustive over the union: a new `BootDiagnostic` member with no case here is
 * a compile error, so a diagnostic cannot ship with no rendering.
 */
function render(diagnostic: BootDiagnostic): string {
  switch (diagnostic.event) {
    case BOOT_EVENT.ENV_VALIDATION_FAILED: {
      const names = diagnostic.variables.map((name) => `  ${name}`).join("\n");
      return `\n${RULE}\n ENVIRONMENT VARIABLE VALIDATION FAILED\n${RULE}\n${names}\n${RULE}`;
    }
    case BOOT_EVENT.CSP_MODE_IGNORED:
      // The rejected value is NOT echoed: it reaches this branch precisely
      // because it is not one of the two accepted modes, so it is arbitrary
      // operator input. The operator set it and can read it back themselves.
      return '[CSP] CSP_MODE is set to an unsupported value and is ignored in production builds; using "strict"';
    case BOOT_EVENT.KEY_PROVIDER_STALE_KEY:
      return `[key-provider] ${diagnostic.provider} stale key used for "${diagnostic.keyName}" (${diagnostic.elapsedSec}s old)`;
  }
}

export function bootStderr(diagnostic: BootDiagnostic): void {
  // Inline, not via a local: `check-console-sinks` asserts the argument text,
  // and while `message` was the typed PARAMETER that assertion carried the whole
  // caller→console chain. Once rendering moved in here, a local named `message`
  // satisfied the same string while proving nothing about its provenance.
  console.error(render(diagnostic));
}
