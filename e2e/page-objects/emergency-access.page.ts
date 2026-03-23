import type { Locator, Page } from "@playwright/test";

export class EmergencyAccessPage {
  constructor(private page: Page) {}

  get addTrustedContactButton() {
    return this.page.getByRole("button", {
      name: /Add Trusted Contact|信頼できる連絡先を追加/i,
    });
  }

  get granteeEmailInput() {
    return this.page.locator("#grantee-email");
  }

  get waitDaysSelect() {
    return this.page.locator("#wait-days");
  }

  get createGrantButton() {
    return this.page
      .locator("[role='dialog']")
      .getByRole("button", { name: /Create Grant|グラントを作成/i });
  }

  get grantList() {
    // Both "Trusted Contacts" and "Trusted By Others" sections render GrantCard components
    return this.page.locator("[data-slot='card']");
  }

  /**
   * Return a locator scoped to the grant card for a specific email address.
   * Works for both owner and grantee views since the card displays the other party's name/email.
   */
  grantByEmail(email: string): Locator {
    return this.page.locator("[data-slot='card']").filter({ hasText: email });
  }

  /**
   * Open the create grant dialog, fill in the grantee email and wait days, then submit.
   */
  async createGrant(email: string, waitDays: 7 | 14 | 30 = 7): Promise<void> {
    await this.addTrustedContactButton.click();
    await this.page.locator("[role='dialog']").waitFor({ timeout: 5_000 });

    await this.granteeEmailInput.fill(email);

    // Open the select and choose the matching option
    await this.waitDaysSelect.click();
    await this.page
      .getByRole("option", { name: new RegExp(String(waitDays)) })
      .click();

    await this.createGrantButton.click();
    await this.page.locator("[role='dialog']").waitFor({
      state: "hidden",
      timeout: 10_000,
    });
  }

  /**
   * Click the "Approve Request" button on the grant card for the given email.
   * Shows an AlertDialog — this method also confirms the dialog.
   */
  async approveGrant(email: string): Promise<void> {
    const card = this.grantByEmail(email);
    await card
      .getByRole("button", { name: /Approve Request|リクエストを承認/i })
      .click();
    // Confirm in the AlertDialog
    await this.page
      .locator("[role='alertdialog']")
      .getByRole("button", { name: /Approve Request|リクエストを承認/i })
      .click();
  }

  /**
   * Click the "Request Access" button on the grant card for the given email.
   * Shows an AlertDialog — this method also confirms the dialog.
   */
  async requestAccess(email: string): Promise<void> {
    const card = this.grantByEmail(email);
    await card
      .getByRole("button", { name: /Request Access|アクセスをリクエスト/i })
      .click();
    // Confirm in the AlertDialog
    await this.page
      .locator("[role='alertdialog']")
      .getByRole("button", { name: /Request Access|アクセスをリクエスト/i })
      .click();
  }

  /**
   * Click the "Access Vault" button on the grant card for the given email.
   * Navigates to the grantor's vault page.
   */
  async accessVault(email: string): Promise<void> {
    const card = this.grantByEmail(email);
    await card
      .getByRole("button", { name: /Access Vault|Vaultにアクセス/i })
      .click();
  }
}
