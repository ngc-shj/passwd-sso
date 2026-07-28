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
 * Branded with a module-private symbol so it cannot be produced structurally,
 * and admitted only by membership in the caller-supplied set of DECLARED
 * variable names.
 *
 * Membership, not shape. An earlier version of this function tested
 * `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/` and called itself validated. It was not:
 * that pattern matches a 64-char hex master key, an `AKIA…` access key id, and
 * an `api_…` token — every secret encoding this repo actually handles is
 * identifier-shaped. `envVarName(process.env.SHARE_MASTER_KEY)` would have
 * type-checked and printed the key verbatim. A predicate over the value's FORM
 * cannot decide a question about its ORIGIN; an allowlist of names the schema
 * declares can, because no secret is ever a schema key.
 *
 * And the allowlist is built here, not passed in — see {@link declared}. Taking
 * it as a parameter moved the fail-open rather than closing it.
 */
export type EnvVarName = string & { readonly [envVarNameBrand]: true };

/** Placeholder for a path that names no declared variable. */
const NOT_A_VAR_NAME = "<unnamed>" as EnvVarName;

/**
 * The declared variable names, read from the schema itself.
 *
 * Derived HERE rather than accepted as a parameter. An earlier version took
 * `declared: ReadonlySet<string>` from the caller, which handed the trust anchor
 * to the code being constrained: `envVarName(secret, new Set([secret]))` type-checks
 * and prints the secret. A membership test is only as trustworthy as the set it
 * tests against, so the set cannot be an input.
 *
 * `@/lib/env-schema` is the side-effect-free half of env handling — it holds no
 * `parseEnv()` call — so importing it here costs nothing at boot and introduces
 * no cycle (it imports only zod and constants).
 */
let declaredNames: ReadonlySet<string> | null = null;

function declared(): ReadonlySet<string> {
  return (declaredNames ??= new Set(Object.keys(getSchemaShape())));
}

/**
 * A type PREDICATE, not a boolean helper.
 *
 * `raw is EnvVarName` is what ties the check to the value. With a plain
 * `boolean`, the brand had to be reapplied by hand — `check ? (raw as EnvVarName)
 * : …` — and a cast does not care what was checked, so
 *
 *     declared().has("DATABASE_URL") ? (raw as EnvVarName) : NOT_A_VAR_NAME
 *
 * compiled and branded any input. As a predicate, the compiler narrows the
 * ARGUMENT, so returning `raw` needs no cast and the same substitution is a
 * TS2322. The property "the value tested is the value returned" moved from
 * something a gate had to look for into something the compiler will not let you
 * write.
 */
function isDeclared(raw: string): raw is EnvVarName {
  return declared().has(raw);
}

/** @param raw candidate name, typically a Zod issue path */
export function envVarName(raw: string): EnvVarName {
  return isDeclared(raw) ? raw : NOT_A_VAR_NAME;
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
