import { join } from "node:path";
import { config } from "dotenv";

/**
 * Load environment variables from .env.local (primary) and .env (fallback).
 * Call at the top of any standalone script (tsx, seed, e2e, worker).
 * Next.js dev/build handles this automatically — only needed for non-Next entry points.
 */
export function loadEnv(basedir: string = process.cwd()): void {
  config({ path: join(basedir, ".env.local") });
  config({ path: join(basedir, ".env") });
}
