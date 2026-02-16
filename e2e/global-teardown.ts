/**
 * Playwright global teardown — clean up test data and generated files.
 */
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assertTestDatabase, cleanup, closePool } from "./helpers/db";

const AUTH_STATE_PATH = join(__dirname, ".auth-state.json");

export default async function globalTeardown(): Promise<void> {
  try {
    // Safety check before any DB operations
    assertTestDatabase();
    await cleanup();
    console.log("[E2E Teardown] Test data cleaned up.");
  } catch (error) {
    console.error("[E2E Teardown] Cleanup failed:", error);
  } finally {
    await closePool();
  }

  // Remove auth state file
  if (existsSync(AUTH_STATE_PATH)) {
    unlinkSync(AUTH_STATE_PATH);
    console.log("[E2E Teardown] Auth state file removed.");
  }
}
