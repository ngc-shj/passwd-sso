import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";

/**
 * Vault Reset tests.
 *
 * Each test uses its own dedicated user for full independence
 * and safe parallel execution or retry:
 * - "wrong confirmation" → resetValidation (non-destructive, dedicated user)
 * - "correct reset"      → reset (destructive, dedicated user)
 */
test.describe("Vault Reset", () => {
  test("wrong confirmation text keeps button disabled", async ({
    context,
    page,
  }) => {
    const { resetValidation } = getAuthState();
    await injectSession(context, resetValidation.sessionToken);
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

    // Self-reset invalidates the user's session/tokens server-side, so the
    // browser must be bounced to signin (callbackUrl carries them back to
    // /dashboard after re-auth, where the SETUP_REQUIRED state shows the
    // setup form). Verifying the signin redirect proves invalidation took
    // effect — a stronger check than the prior /dashboard assertion.
    await page.waitForURL(/\/auth\/signin/, { timeout: 10_000 });
    expect(page.url()).toMatch(/callbackUrl=/);
  });
});
