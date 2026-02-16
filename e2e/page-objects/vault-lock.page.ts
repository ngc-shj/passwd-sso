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
    await this.unlock(passphrase);
    // Wait for PBKDF2 processing + dashboard load
    await this.page.waitForSelector("#unlock-passphrase", {
      state: "hidden",
      timeout: 15_000,
    });
  }
}
