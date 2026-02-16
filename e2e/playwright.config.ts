// IMPROVE(#35): add docs/e2e-guidelines.md (test isolation, destructive-test rules)
// IMPROVE(#37): add ESLint rule to forbid conditional assertion skip in e2e/tests
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // vault state is per-browser — run serially for safety
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "html" : "list",

  timeout: 30_000, // PBKDF2 600k iterations ≈ 1-3s in browser

  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  globalSetup: require.resolve("./global-setup"),
  globalTeardown: require.resolve("./global-teardown"),

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // CI: production build for parity; local: dev server for speed.
    // Skip --experimental-https so Playwright can connect over plain HTTP.
    command: process.env.CI
      ? "npm run build && npm start"
      : "npx next dev --turbopack",
    cwd: "..",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
