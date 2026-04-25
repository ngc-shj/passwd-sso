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

    const banner =
      "\n" +
      "=".repeat(60) +
      "\n" +
      " ENVIRONMENT VARIABLE VALIDATION FAILED\n" +
      "=".repeat(60) +
      "\n" +
      formatted +
      "\n" +
      "=".repeat(60);

    // Log to stderr for visibility in container logs
    console.error(banner);

    throw new Error(`Invalid environment variables:\n${formatted}`);
  }

  return result.data;
}

// ─── Singleton ──────────────────────────────────────────────

export const env = parseEnv();
