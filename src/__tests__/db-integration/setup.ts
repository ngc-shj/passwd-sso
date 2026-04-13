/**
 * Setup file for real-DB integration tests.
 * Loads .env.local so DATABASE_URL and role-specific URLs are available.
 * Does NOT set up mocks — integration tests run against a real database.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

// For integration tests, superuser must be the default DATABASE_URL
// so that createTestContext() can create tenants and manage test data.
if (!process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
}
