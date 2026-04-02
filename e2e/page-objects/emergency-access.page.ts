import type { Locator, Page } from "@playwright/test";

export class EmergencyAccessPage {
  constructor(private page: Page) {}

  get addTrustedContactButton() {
    return this.page.getByRole("button", {
      name: /Add Trusted Contact|信頼(できる|する)連絡先を追加/i,
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
      .getByRole("button", { name: /Create|作成/i });
  }

  get grantList() {
    // Both "Trusted Contacts" and "Trusted By Others" sections render GrantCard components
    return this.page.locator("[data-slot='card']");
  }

  /**
   * Return a locator scoped to the grant card for a specific email address or display name.
   * The grant card shows the other party's name if available, falling back to their email.
   * This method matches cards by email text; use grantByText() for name-based matching.
   */
  grantByEmail(email: string): Locator {
    return this.page.locator("[data-slot='card']").filter({ hasText: email });
  }

  /**
   * Return a locator scoped to the individual grant card matching either the display name
   * or email. Excludes outer section container cards (which have a card-title slot) to avoid
   * strict-mode violations from nested card matches.
   */
  grantByUser(nameOrEmail: string): Locator {
    // Section container cards have a CardTitle (data-slot="card-title"); individual GrantCards do not.
    return this.page
      .locator("[data-slot='card']")
      .filter({ hasText: nameOrEmail })
      .filter({ hasNot: this.page.locator("[data-slot='card-title']") });
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
