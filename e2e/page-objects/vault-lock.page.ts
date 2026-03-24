import type { Page } from "@playwright/test";

export class VaultLockPage {
  constructor(private page: Page) {}

  get passphraseInput() {
    return this.page.locator("#unlock-passphrase");
  }

  get unlockButton() {
    return this.page.getByRole("button", { name: /^Unlock$|^解錠$|^アンロック$/i });
  }

  get errorMessage() {
    return this.page.locator(".text-destructive");
  }

  get recoveryLink() {
    return this.page.getByRole("link", { name: /Forgot passphrase|パスフレーズを忘れた/i });
  }

  get resetLink() {
    return this.page.getByRole("link", { name: /Reset vault|Vaultをリセット/i });
  }

  async unlock(passphrase: string): Promise<void> {
    await this.passphraseInput.fill(passphrase);
    await this.unlockButton.click();
  }

  async unlockAndWait(passphrase: string): Promise<void> {
    // Register the response waiter BEFORE clicking unlock to avoid missing the
    // response if PBKDF2 completes and the fetch fires before waitForResponse is set.
    // This resolves once the dashboard fetches the password list, guaranteeing
    // encryptionKey is fully propagated through the React tree. Pages that don't
    // render the password list (e.g. /settings) won't fire this request, so we
    // race against a short timeout and proceed regardless.
    const passwordsFetched = this.page
      .waitForResponse(
        (r) => /\/api\/passwords(?:[?#]|$)/.test(r.url()) && r.request().method() === "GET",
        { timeout: 10_000 }
      )
      .catch(() => null); // non-fatal: some pages don't load the password list
    await this.unlock(passphrase);
    // Wait for PBKDF2 processing + lock screen to disappear
    await this.page.waitForSelector("#unlock-passphrase", {
      state: "hidden",
      timeout: 15_000,
    });
    // Wait for the initial fetchPasswords() triggered by VaultContext switching to
    // UNLOCKED state. This guarantees encryptionKey is fully propagated through the
    // React tree before any test starts creating or editing entries.
    await passwordsFetched;
  }
}
