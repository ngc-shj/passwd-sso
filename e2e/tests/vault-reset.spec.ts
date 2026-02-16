import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";

/**
 * Vault Reset tests use a dedicated "reset" user.
 * Non-destructive test runs first; destructive reset runs last
 * to avoid state contamination between tests.
 */
test.describe("Vault Reset", () => {
  test("wrong confirmation text keeps button disabled", async ({
    context,
    page,
  }) => {
    const { reset } = getAuthState();
    await injectSession(context, reset.sessionToken);
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
