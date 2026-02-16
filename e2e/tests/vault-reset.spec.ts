import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";

test.describe("Vault Reset", () => {
  test("reset vault with correct confirmation", async ({ context, page }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
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

  test("wrong confirmation text keeps button disabled", async ({
    context,
    page,
  }) => {
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
});
