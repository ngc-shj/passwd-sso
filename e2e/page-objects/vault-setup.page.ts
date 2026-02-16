import type { Page } from "@playwright/test";

export class VaultSetupPage {
  constructor(private page: Page) {}

  get passphraseInput() {
    return this.page.locator("#passphrase");
  }

  get confirmInput() {
    return this.page.locator("#confirm");
  }

  get submitButton() {
    return this.page.getByRole("button", { name: /Set Up Vault|Vaultをセットアップ/i });
  }

  async setup(passphrase: string): Promise<void> {
    await this.passphraseInput.fill(passphrase);
    await this.confirmInput.fill(passphrase);
    await this.submitButton.click();
    // Wait for setup to complete (PBKDF2 takes ~1-3s)
    await this.page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  }
}
