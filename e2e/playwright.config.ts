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
    ignoreHTTPSErrors: /^https:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(baseURL),
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  globalSetup: require.resolve("./global-setup"),
  globalTeardown: require.resolve("./global-teardown"),

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // Skip mobile-tagged tests — they run in the dedicated mobile projects
      grepInvert: /@mobile/,
    },
    {
      // iPhone 13 viewport with chromium engine.
      // Note: Playwright's `devices["iPhone 13"]` defaults to webkit, but our
      // session-cookie injection (e2e/helpers/auth.ts) is currently unreliable
      // under WebKit (cookies not honoured on first navigation). We test the
      // mobile viewport behaviour (touch, responsive layout) under chromium
      // until the WebKit cookie path is fixed. mobile-android already provides
      // chromium-mobile coverage; this project adds the iPhone 13 viewport
      // (different sizing) on top.
      name: "mobile-ios",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
      // Only run tests tagged @mobile
      grep: /@mobile/,
    },
    {
      name: "mobile-android",
      use: { ...devices["Pixel 7"] },
      // Only run tests tagged @mobile
      grep: /@mobile/,
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
