import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";

test.describe("Recovery Key", () => {
  test("generate recovery key from header menu", async ({ context, page }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    await page.goto("/ja/dashboard");

    // Unlock vault first
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // Open user menu and click Recovery Key
    const userMenuButton = page.locator("header").getByRole("button").last();
    await userMenuButton.click();

    const recoveryKeyItem = page.getByRole("menuitem", {
      name: /Recovery Key|リカバリーキー/i,
    });
    await recoveryKeyItem.click();

    // Recovery Key dialog should open — enter passphrase
    const passphraseInput = page.locator("#rk-passphrase");
    await expect(passphraseInput).toBeVisible({ timeout: 5_000 });
    await passphraseInput.fill(vaultReady.passphrase!);

    // Click generate
    const generateButton = page.getByRole("button", {
      name: /Recovery Key|リカバリーキー|Generate|生成/i,
    });
    await generateButton.click();

    // Should display Base32 recovery key (XXXX-XXXX-... format)
    const keyDisplay = page.locator("code");
    await expect(keyDisplay).toBeVisible({ timeout: 15_000 });

    const keyText = await keyDisplay.textContent();
    expect(keyText).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}-[A-Z2-7]{2}$/);
  });

  test("invalid recovery key shows client-side error", async ({
    context,
    page,
  }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    await page.goto("/ja/recovery");

    // Enter an invalid recovery key (bad checksum)
    const keyInput = page.locator("#recovery-key");
    await expect(keyInput).toBeVisible({ timeout: 10_000 });
    await keyInput.fill("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH");

    // Submit — should show checksum error before server communication
    const verifyButton = page.getByRole("button", {
      name: /Verify|検証/i,
    });
    await verifyButton.click();

    // Should show error
    await expect(page.locator(".text-destructive")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("recovery key not set shows error", async ({ context, page }) => {
    // Use fresh user (no recovery key set)
    const { fresh } = getAuthState();
    await injectSession(context, fresh.sessionToken);
    await page.goto("/ja/recovery");

    const keyInput = page.locator("#recovery-key");
    await expect(keyInput).toBeVisible({ timeout: 10_000 });

    // Enter a syntactically valid but unregistered recovery key
    // (will pass checksum but fail server verification)
    await keyInput.fill("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZAB-CDEF");

    const verifyButton = page.getByRole("button", {
      name: /Verify|検証/i,
    });
    await verifyButton.click();

    // Should show error (recovery key not set or invalid)
    await expect(page.locator(".text-destructive")).toBeVisible({
      timeout: 10_000,
    });
  });
});
