/**
 * The closed vocabulary of boot-time diagnostics.
 *
 * `bootStderr` writes to a raw, unredacted `console.error` — it runs before the
 * logger exists, so there is nothing beneath it to catch a mistake. What may be
 * said there is therefore fixed here, as types, and the sink renders the text
 * itself. A caller supplies bounded data; it never supplies prose.
 *
 * WHY THIS SHAPE, and not a `string` parameter guarded by a CI gate:
 *
 * The previous design took `(message: string)` and relied on an AST gate to
 * prove each call site's message was secret-free. Three review rounds found
 * successive escapes from that gate — an aliased import, a namespace import, a
 * re-exporting barrel, a `string[]` helper whose body read `process.env`, a
 * module-scope capture of the same, a cast to a closed union, a mutable class
 * member, a `join` separator, callers outside the scanned root. The member set
 * grew every round, which is the signature of a class whose boundary was never
 * derived from the real primitive (R42). The real primitive was the parameter
 * type: proving arbitrary strings safe after the fact is taint analysis, and a
 * hand-rolled taint analyser always has one more shape it has not seen.
 *
 * This codebase already learned that, in `@/lib/logger/client-events`:
 *
 *   "a detector always has one more spelling it has not seen, whereas an
 *    unassignable type has none."
 *
 * That is why the client logger takes a closed event id and a per-event payload
 * rather than a string. The boot sink now matches it. A secret cannot be passed
 * here in any import form, from any call position, because there is no
 * parameter it fits.
 */

import type { KeyName, ProviderName } from "@/lib/key-provider/types";
import { getSchemaShape } from "@/lib/env-schema";

export const BOOT_EVENT = {
  ENV_VALIDATION_FAILED: "boot.env_validation_failed",
  CSP_MODE_IGNORED: "boot.csp_mode_ignored",
  KEY_PROVIDER_STALE_KEY: "boot.key_provider_stale_key",
} as const;

export type BootEvent = (typeof BOOT_EVENT)[keyof typeof BOOT_EVENT];

declare const envVarNameBrand: unique symbol;

/**
 * The NAME of an environment variable — never its value.
 *
 * Branded with a module-private symbol, so it cannot be produced structurally.
 * Exactly two things carry the brand: the schema's own keys ({@link DECLARED})
 * and the fixed {@link NOT_A_VAR_NAME} sentinel. {@link envVarName} returns one
 * or the other and nothing else — see there for why it looks values up rather
 * than checking them.
 */
export type EnvVarName = string & { readonly [envVarNameBrand]: true };

/**
 * Placeholder for a path that names no declared variable.
 *
 * A constant, so it carries no caller data. Shaped so it cannot collide with a
 * real name: `<` is not legal in an environment variable identifier.
 */
const NOT_A_VAR_NAME = "<unnamed>" as EnvVarName;

/**
 * The declared names — the only branding site that carries data.
 *
 * (The other is {@link NOT_A_VAR_NAME}, a constant.)
 *
 * Read from the schema here rather than accepted from a caller. An earlier
 * version took the allowed set as a PARAMETER, which handed the trust anchor to
 * the code being constrained: `envVarName(secret, new Set([secret]))`
 * type-checked and printed the secret.
 *
 * `@/lib/env-schema` is the side-effect-free half of env handling — it holds no
 * `parseEnv()` call — so importing it costs nothing at boot and introduces no
 * cycle (it imports only zod and constants).
 *
 * `as unknown as` because a branded element type is not directly assignable from
 * `string[]`. Deliberately NOT `.map(k => k as EnvVarName)`: a callback would be
 * one more body to trust, whereas this array IS the schema's key list rather
 * than something computed from it.
 */
const DECLARED = Object.keys(getSchemaShape()) as unknown as readonly EnvVarName[];

/**
 * Look the name up; never re-brand the input.
 *
 * `find` returns an ELEMENT OF `DECLARED`, so what comes back is a schema key —
 * or, on no match, the fixed {@link NOT_A_VAR_NAME} sentinel. `raw` is only ever
 * compared, never returned. That is the whole guarantee, and it does not depend
 * on the comparison being right: a broken comparison here returns the WRONG
 * VARIABLE NAME, never a secret.
 *
 * Three earlier shapes all failed because each left something to be trusted:
 *
 *   1. `regex.test(raw) ? (raw as EnvVarName) : …` — shape says nothing about
 *      origin; a 64-char hex master key matched.
 *   2. `declared.has(raw) ? (raw as EnvVarName) : …` with `declared` a
 *      PARAMETER — the caller chose the trust anchor.
 *   3. `isDeclared(raw) ? raw : …` with a `raw is EnvVarName` predicate — the
 *      call site became compiler-checked, but a type predicate is an assertion
 *      the compiler TRUSTS, not one it verifies, so
 *      `{ declared().has(raw); return true; }` branded everything.
 *
 * Each fix made the check harder to fake and left a check to fake. Returning a
 * stored value removes the check from the trusted path entirely: there is no
 * boolean to get wrong and no predicate to lie about.
 *
 * @param raw candidate name, typically a Zod issue path
 */
export function envVarName(raw: string): EnvVarName {
  return DECLARED.find((declared) => declared === raw) ?? NOT_A_VAR_NAME;
}

/**
 * Everything the boot sink can be asked to report.
 *
 * A discriminated union rather than a map of payloads, so `render` in
 * `@/lib/boot-stderr` gets exhaustiveness checking: adding a member here without
 * rendering it is a compile error.
 *
 * Note what no member carries: a bare `string`. Every field is a brand, a closed
 * union, or a number. That is the whole guarantee — there is no slot an
 * arbitrary value fits into.
 */
export type BootDiagnostic =
  | {
      event: typeof BOOT_EVENT.ENV_VALIDATION_FAILED;
      /**
       * Variable names only. Zod's per-issue messages are deliberately absent:
       * `env-schema.ts` already builds at least one message by interpolation,
       * so the message channel is not bounded. The full detail still reaches
       * the operator through the thrown Error, which is not this raw sink.
       */
      variables: readonly EnvVarName[];
    }
  | { event: typeof BOOT_EVENT.CSP_MODE_IGNORED }
  | {
      event: typeof BOOT_EVENT.KEY_PROVIDER_STALE_KEY;
      provider: ProviderName;
      keyName: KeyName;
      elapsedSec: number;
    };
