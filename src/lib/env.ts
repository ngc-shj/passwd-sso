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

// Re-export schema surface so existing imports (`from "@/lib/env"`) keep working.
export { envObject, envSchema, getSchemaShape };
export type { Env };

// ─── Parse and validate ─────────────────────────────────────

/**
 * Variable NAMES that failed validation — never their values.
 *
 * Split out from the banner so the "no value ever reaches stderr" claim is a
 * property of a small function with a `string[]` return, rather than a promise
 * made in a comment above a 20-line string concatenation. `issue.path` is the
 * schema key; `issue.message` is Zod's own text ("Required", "Invalid url").
 * Neither is derived from the parsed value, so neither can carry a secret.
 */
function failedVariableNames(issues: readonly StandardIssue[]): string[] {
  return issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
}

type StandardIssue = { path: PropertyKey[]; message: string };

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = failedVariableNames(result.error.issues).join("\n");

    // Log to stderr for visibility in container logs. Routed through
    // boot-stderr because this runs before the logger exists; keeping the raw
    // console call out of this module means `no-console` stays enforced here,
    // where every secret in process.env is in scope.
    //
    // Built inline from string literals and `formatted` (variable names only)
    // so `check-boot-stderr-callers` can verify the shape at the call site. A
    // precomputed `banner` local was equally safe but opaque to the gate, and
    // this is the one caller where an unnoticed change could echo a secret.
    bootStderr(
      `\n${"=".repeat(60)}\n ENVIRONMENT VARIABLE VALIDATION FAILED\n${"=".repeat(60)}\n${formatted}\n${"=".repeat(60)}`,
    );

    throw new Error(`Invalid environment variables:\n${formatted}`);
  }

  return result.data;
}

// ─── Singleton ──────────────────────────────────────────────

export const env = parseEnv();
