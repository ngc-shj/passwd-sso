/**
 * Startup-time environment variable validation — SIDE-EFFECTFUL.
 *
 * Importing this module triggers parseEnv() against the full envSchema
 * and throws if any required var is missing/invalid. Imported by
 * src/instrumentation.ts → register() at Next.js server boot.
 *
 * For side-effect-free access to the schema (e.g. from the audit-outbox
 * worker, tests, or the generator/drift-checker), import from
 * "@/lib/env-schema" instead — that module has no parseEnv() call.
 *
 * Phase 1: Validation only. Existing process.env references are unchanged.
 * Phase 2 (future): Migrate consumers to import { env } from "@/lib/env".
 */

import { envObject, envSchema, type Env, getSchemaShape } from "@/lib/env-schema";
import { bootStderr } from "@/lib/boot-stderr";
import { BOOT_EVENT, envVarName } from "@/lib/boot-events";

// Re-export schema surface so existing imports (`from "@/lib/env"`) keep working.
export { envObject, envSchema, getSchemaShape };
export type { Env };

// ─── Parse and validate ─────────────────────────────────────

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    // Two channels, deliberately asymmetric.
    //
    // The raw stderr sink gets variable NAMES only. It runs before the logger
    // exists and has no redaction beneath it, and Zod messages are not a bounded
    // channel — `env-schema.ts` already builds one by interpolation, so a future
    // `.refine(…, { message: `bad: ${v}` })` would put a value there with
    // nothing to stop it. `envVarName` validates the shape rather than asserting
    // it, so a nested or synthetic issue path cannot smuggle text through.
    // Deduplicated on the full path, not on the resolved name: two distinct
    // paths that both fail the allowlist stay two entries, so several problems
    // cannot collapse into a single `<unnamed>` line.
    const declared = new Set(Object.keys(getSchemaShape()));
    const paths = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];

    bootStderr({
      event: BOOT_EVENT.ENV_VALIDATION_FAILED,
      variables: paths.map((path) => envVarName(path, declared)),
    });

    // The thrown Error keeps the full per-issue detail. It travels the normal
    // exception path, not the raw console, so the operator loses nothing.
    throw new Error(`Invalid environment variables:\n${formatted}`);
  }

  return result.data;
}

// ─── Singleton ──────────────────────────────────────────────

export const env = parseEnv();
