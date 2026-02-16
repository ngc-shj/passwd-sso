import type { Page } from "@playwright/test";

export class DashboardPage {
  constructor(private page: Page) {}

  get newItemButton() {
    return this.page.getByRole("button", { name: /New Item|新規アイテム/i });
  }

  get newPasswordOption() {
    return this.page.getByRole("menuitem", { name: /New Password|新規パスワード/i });
  }

  get passwordList() {
    return this.page.locator("[data-password-list], main");
  }

  /**
   * Find a password entry in the list by its title text.
   */
  entryByTitle(title: string) {
    return this.page.getByText(title).first();
  }

  /**
   * Navigate to create a new password entry.
   */
  async createNewPassword(): Promise<void> {
    await this.newItemButton.click();
    await this.newPasswordOption.click();
    await this.page.waitForURL(/\/dashboard\/new/);
  }
}
