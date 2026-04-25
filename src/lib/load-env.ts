import { join } from "node:path";
import { config } from "dotenv";

/**
 * Load environment variables from .env (primary) and .env.local (override).
 *
 * Matches the Next.js convention AND Docker Compose's auto-load convention:
 * `.env` is the canonical source-of-truth file; `.env.local` is read second
 * for individual-developer overrides. Because dotenv.config() does NOT
 * overwrite already-set vars by default, the FIRST call to config() wins —
 * we therefore call .env.local FIRST so override values take precedence,
 * then fall back to .env for any keys not set by the override.
 *
 * Call at the top of any standalone script (tsx, seed, e2e, worker).
 * Next.js dev/build handles this automatically — only needed for non-Next
 * entry points.
 */
export function loadEnv(basedir: string = process.cwd()): void {
  // Override file first (precedence wins under dotenv's no-overwrite policy).
  config({ path: join(basedir, ".env.local") });
  // Canonical / shared file second — fills in keys the override did not set.
  config({ path: join(basedir, ".env") });
}
