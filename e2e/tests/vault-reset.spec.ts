import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";

/**
 * Vault Reset tests.
 *
 * Each test uses its own user so they are fully independent
 * and safe for parallel execution or retry:
 * - "wrong confirmation" → vaultReady (non-destructive, read-only page visit)
 * - "correct reset"      → reset (destructive, dedicated user)
 */
test.describe("Vault Reset", () => {
  test("wrong confirmation text keeps button disabled", async ({
    context,
    page,
  }) => {
    // Non-destructive — safe to use shared vaultReady user
    // IMPROVE(#27): use dedicated user for full independence
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    await page.goto("/ja/vault-reset");

    const confirmInput = page.locator("#confirm-reset");
    await expect(confirmInput).toBeVisible({ timeout: 10_000 });

    // Type wrong confirmation
    await confirmInput.fill("delete my vault"); // lowercase — must be exact

    const resetButton = page.getByRole("button", {
      name: /Reset|リセット/i,
    });

    await expect(resetButton).toBeDisabled();
  });

  test("reset vault with correct confirmation", async ({ context, page }) => {
    // Destructive — uses dedicated reset user
    const { reset } = getAuthState();
    await injectSession(context, reset.sessionToken);
    await page.goto("/ja/vault-reset");

    const confirmInput = page.locator("#confirm-reset");
    await expect(confirmInput).toBeVisible({ timeout: 10_000 });

    // Type the exact confirmation token
    await confirmInput.fill("DELETE MY VAULT");

    const resetButton = page.getByRole("button", {
      name: /Reset|リセット/i,
    });
    await resetButton.click();

    // Should redirect to dashboard with setup form (vault cleared)
    await page.waitForURL(/\/dashboard/, { timeout: 10_000 });

    // Setup form should be visible (vault is now in SETUP_REQUIRED state)
    await expect(page.locator("#passphrase")).toBeVisible({ timeout: 10_000 });
  });
});
