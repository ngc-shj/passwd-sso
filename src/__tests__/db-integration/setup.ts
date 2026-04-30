/**
 * Setup file for real-DB integration tests.
 * Loads .env (canonical) then .env.local (per-developer override) — matches
 * the project convention documented in CLAUDE.md and src/lib/load-env.ts.
 * Does NOT set up mocks — integration tests run against a real database.
 */
import { config } from "dotenv";
config({ path: ".env" });
config({ path: ".env.local", override: true });

// For integration tests, superuser must be the default DATABASE_URL
// so that createTestContext() can create tenants and manage test data.
if (!process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
}
