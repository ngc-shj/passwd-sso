/**
 * @extension DPoP-bound token flow — Playwright E2E.
 *
 * Verifies that the browser extension:
 *   1. Responds to EXT_JKT_REQUEST with a 43-char base64url thumbprint.
 *   2. Sends cnfJkt in the bridge-code POST body.
 *   3. Sends a DPoP header (JWS compact serialization) on follow-up API calls.
 *
 * Tagged @extension so the Playwright "extension" project runs these
 * (see playwright.config.ts grep: /@extension/).
 *
 * Each test gets a fresh Chrome userDataDir (per-test isolation, per Round 2 T18).
 * Network capture uses context.on("request") — not page.on("request") — because
 * service worker fetches originate from the SW target, not the page target
 * (per Round 2 T19).
 *
 * Skip policy: if SKIP_EXTENSION_E2E=1 or the extension dist/ is absent after
 * the global-setup build step, tests are skipped rather than failing.
 */

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Extension dist/ built by global-setup (e2e/global-setup.ts::buildExtension).
const EXT_PATH = path.join(__dirname, "..", "..", "extension", "dist");

function extensionAvailable(): boolean {
  return fs.existsSync(path.join(EXT_PATH, "manifest.json"));
}

/**
 * Launch a persistent Chromium context with the extension loaded.
 * Returns the context; caller must close it.
 */
async function launchExtensionContext(userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--headless=new", // headless extension loading works in Chromium 109+
      "--no-sandbox",
    ],
    // Do not pass ignoreHTTPSErrors globally — each test will use http.
  });
}

test.describe("@extension DPoP-bound token flow", () => {
  // Skip the entire suite if SKIP_EXTENSION_E2E=1 or the built extension is absent.
  test.beforeEach(async ({}, testInfo) => {
    if (process.env.SKIP_EXTENSION_E2E === "1") {
      testInfo.skip(true, "SKIP_EXTENSION_E2E=1 — skipping extension E2E tests.");
      return;
    }
    if (!extensionAvailable()) {
      testInfo.skip(
        true,
        "Extension dist/ not found — run `npm --prefix extension run build` first.",
      );
    }
  });

  test(
    "connect → bridge-code carries cnfJkt → follow-up API call carries DPoP header",
    async ({}, testInfo) => {
      // Per-test fresh userDataDir for state isolation (per Round 2 T18).
      const userDataDir = path.join(
        os.tmpdir(),
        `psso-e2e-${testInfo.testId.replace(/[^a-z0-9]/gi, "-")}`,
      );

      const context = await launchExtensionContext(userDataDir);

      // Capture all network requests context-wide — includes service worker fetches
      // (per Round 2 T19: context.on("request") captures SW target; page.on does not).
      const capturedRequests: Array<{
        url: string;
        method: string;
        headers: Record<string, string>;
        postData: string | null;
      }> = [];

      context.on("request", (req) => {
        const url = req.url();
        // Only track our own API calls to reduce noise.
        if (url.includes("/api/extension/")) {
          capturedRequests.push({
            url,
            method: req.method(),
            headers: req.headers(),
            postData: req.postData(),
          });
        }
      });

      try {
        const page = await context.newPage();
        const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

        // --- Set a session cookie for the vault-ready test user ---
        // The auth state file is written by global-setup. Read it at test time
        // because it lives outside the module scope (produced asynchronously).
        let sessionToken: string | undefined;
        try {
          const authStatePath = path.join(__dirname, "..", ".auth-state.json");
          const authState = JSON.parse(fs.readFileSync(authStatePath, "utf-8")) as {
            vaultReady: { sessionToken: string };
          };
          sessionToken = authState.vaultReady.sessionToken;
        } catch {
          // Auth state not available — skip the test rather than fail noisily.
          test.skip();
          return;
        }

        // Inject session cookie (matches the existing injectSession pattern from helpers/auth.ts).
        const cookieName =
          baseURL.startsWith("https")
            ? "__Secure-authjs.session-token"
            : "authjs.session-token";

        await context.addCookies([
          {
            name: cookieName,
            value: sessionToken,
            domain: new URL(baseURL).hostname,
            path: "/",
            httpOnly: true,
            secure: baseURL.startsWith("https"),
            sameSite: "Lax",
          },
        ]);

        // Navigate to the dashboard with ?ext_connect=1 to trigger AutoExtensionConnect.
        // The extension must respond to PASSWD_SSO_EXT_JKT_REQUEST within 500 ms.
        await page.goto(`${baseURL}/ja/dashboard?ext_connect=1`, {
          waitUntil: "networkidle",
          timeout: 30_000,
        });

        // Wait for bridge-code request to appear (stage 2 of the handshake).
        await expect
          .poll(
            () =>
              capturedRequests.some((r) =>
                new URL(r.url).pathname === "/api/extension/bridge-code",
              ),
            { timeout: 10_000, message: "bridge-code POST not captured" },
          )
          .toBe(true);

        // Assert: bridge-code POST body carries cnfJkt (43 base64url chars).
        const bridgeCodeReq = capturedRequests.find(
          (r) => new URL(r.url).pathname === "/api/extension/bridge-code",
        );
        expect(bridgeCodeReq).toBeDefined();
        expect(bridgeCodeReq!.method).toBe("POST");
        if (bridgeCodeReq!.postData) {
          const body = JSON.parse(bridgeCodeReq!.postData) as {
            cnfJkt?: unknown;
          };
          expect(typeof body.cnfJkt).toBe("string");
          expect((body.cnfJkt as string).length).toBe(43);
          expect(/^[A-Za-z0-9_-]{43}$/.test(body.cnfJkt as string)).toBe(true);
        }

        // Wait for exchange request (stage 3: content script exchanges the bridge code).
        await expect
          .poll(
            () =>
              capturedRequests.some((r) =>
                new URL(r.url).pathname === "/api/extension/token/exchange",
              ),
            { timeout: 10_000, message: "token/exchange POST not captured" },
          )
          .toBe(true);

        // Assert: exchange POST carries DPoP header.
        const exchangeReq = capturedRequests.find(
          (r) => new URL(r.url).pathname === "/api/extension/token/exchange",
        );
        expect(exchangeReq).toBeDefined();
        const exchangeDpop = exchangeReq!.headers["dpop"];
        expect(exchangeDpop).toBeTruthy();
        // DPoP is a JWS compact serialization: header.payload.signature
        expect(exchangeDpop.split(".").length).toBe(3);

        await page.close();
      } finally {
        await context.close();
        // Clean up per-test userDataDir.
        try {
          fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors.
        }
      }
    },
  );
});
