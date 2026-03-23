import { defineConfig, devices } from "@playwright/test";

// E2E_BASE_URL allows pointing at an already-running dev server
// (e.g. E2E_BASE_URL=https://localhost:3001).
// Falls back to http://localhost:3000 for CI where webServer auto-starts.
//
// Local usage:
//   NEXT_PUBLIC_BASE_PATH="" npx next dev --turbopack --port 3001
//   E2E_BASE_URL=https://localhost:3001 E2E_ALLOW_DB_MUTATION=true npx playwright test
//
// Tests use absolute paths (/ja/dashboard) so the dev server must run
// WITHOUT basePath. CI runs without basePath by default.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // vault state is per-browser — run serially for safety
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "html" : "list",

  timeout: 30_000, // PBKDF2 600k iterations ≈ 1-3s in browser

  use: {
    baseURL,
    ignoreHTTPSErrors: baseURL.startsWith("https://"),
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

  // Skip webServer when E2E_BASE_URL is set (external server already running).
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: process.env.CI
            ? "npm run build && npm start"
            : "npx next dev --turbopack",
          cwd: "..",
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
