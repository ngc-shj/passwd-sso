import { config } from "dotenv";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Load .env.local so AUTH_URL is available at config time
config({ path: join(__dirname, "..", ".env.local") });

// Derive base URL from E2E_BASE_URL or AUTH_URL (same env the app uses).
// Falls back to http://localhost:3000 for CI where neither is set.
const baseURL =
  process.env.E2E_BASE_URL ??
  process.env.AUTH_URL ??
  "http://localhost:3000";

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

  // webServer auto-starts a dev server when needed.
  // Skip entirely when E2E_BASE_URL is set (external server already running).
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
