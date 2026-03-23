import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";

/**
 * Password Generator tests.
 *
 * Uses the shared `vaultReady` user.
 * Exercises the in-dialog generator panel that lives inside the "New Password"
 * form (PersonalLoginForm → EntryLoginMainFields → PasswordGenerator).
 */
test.describe("Password Generator", () => {
  test("generator produces a password and fills the field on Use", async ({
    context,
    page,
  }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    const dashboard = new DashboardPage(page);
    await dashboard.createNewPassword();

    // Dialog is open; fill the title so the form is valid
    await page.locator("#title").fill(`Generator Test ${Date.now()}`);

    await test.step("open the password generator panel", async () => {
      // The generator toggle button lives next to the password field
      await page
        .getByRole("button", { name: /Generate|Generator|生成|ジェネレーター/i })
        .click();

      // Generator panel renders inline (not a dialog) — wait for the Use button
      await expect(
        page.getByRole("button", { name: /^Use$|^使用$/i })
      ).toBeVisible({ timeout: 5_000 });
    });

    await test.step("set password length to 32", async () => {
      // The length input has id "gen-length"
      const lengthInput = page.locator("#gen-length");
      await expect(lengthInput).toBeVisible({ timeout: 5_000 });

      await lengthInput.fill("");
      await lengthInput.type("32");
      // Trigger blur so the component clamps the value
      await lengthInput.blur();
    });

    let generatedPassword: string;

    await test.step("read the generated password text", async () => {
      // Generated password is displayed in a <p> with font-mono inside the
      // generator panel.  We wait for it to be non-empty.
      const passwordDisplay = page
        .locator("p.font-mono, p.\\!font-mono")
        .first();
      await expect(passwordDisplay).toBeVisible({ timeout: 10_000 });
      generatedPassword = (await passwordDisplay.textContent()) ?? "";
      expect(generatedPassword.length).toBeGreaterThan(0);
    });

    await test.step("click Use to apply the generated password", async () => {
      await page.getByRole("button", { name: /^Use$|^使用$/i }).click();

      // Generator panel closes
      await expect(
        page.getByRole("button", { name: /^Use$|^使用$/i })
      ).not.toBeVisible({ timeout: 5_000 });
    });

    await test.step("verify password field is populated", async () => {
      const passwordInput = page.locator("#password");
      const value = await passwordInput.inputValue();
      // The field should not be empty
      expect(value.length).toBeGreaterThan(0);
      // Length should match the requested 32 characters
      expect(value.length).toBe(32);
    });
  });

  test("generator refresh produces a different password", async ({
    context,
    page,
  }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    const dashboard = new DashboardPage(page);
    await dashboard.createNewPassword();

    await page
      .getByRole("button", { name: /Generate|Generator|生成|ジェネレーター/i })
      .click();

    const passwordDisplay = page.locator("p.font-mono, p.\\!font-mono").first();
    await expect(passwordDisplay).toBeVisible({ timeout: 10_000 });

    const first = (await passwordDisplay.textContent()) ?? "";

    // Click the refresh (↺) icon button inside the generator panel
    await page.getByRole("button", { name: /Refresh|更新/i }).click();

    // Wait briefly for the API call to return a new password
    await page.waitForTimeout(500);

    const second = (await passwordDisplay.textContent()) ?? "";

    // Two randomly generated passwords are extremely unlikely to be identical
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    // Note: theoretically they could be equal, but the probability is negligible
    expect(second).not.toBe(first);
  });
});
