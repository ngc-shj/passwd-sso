import type { Page } from "@playwright/test";

export class PasswordEntryPage {
  constructor(private page: Page) {}

  get titleInput() {
    return this.page.locator("#title");
  }

  get usernameInput() {
    return this.page.locator("#username");
  }

  get passwordInput() {
    return this.page.locator("#password");
  }

  get urlInput() {
    return this.page.locator("#url");
  }

  get notesInput() {
    return this.page.locator("#notes");
  }

  get saveButton() {
    return this.page.getByRole("button", { name: /Save|保存/i });
  }

  get updateButton() {
    return this.page.getByRole("button", { name: /Update|更新/i });
  }

  get deleteButton() {
    return this.page.getByRole("button", { name: /Move to Trash|ゴミ箱に移動|Delete|削除/i });
  }

  get editButton() {
    return this.page.getByRole("link", { name: /Edit|編集/i });
  }

  get deleteConfirmButton() {
    // Inside the confirmation dialog
    return this.page.getByRole("button", { name: /Delete|削除/i }).last();
  }

  async fill(data: {
    title: string;
    username?: string;
    password?: string;
    url?: string;
    notes?: string;
  }): Promise<void> {
    await this.titleInput.fill(data.title);
    if (data.username) await this.usernameInput.fill(data.username);
    if (data.password) await this.passwordInput.fill(data.password);
    if (data.url) await this.urlInput.fill(data.url);
    if (data.notes) await this.notesInput.fill(data.notes);
  }

  async save(): Promise<void> {
    await this.saveButton.click();
    // Wait for navigation back to dashboard or detail
    await this.page.waitForURL(/\/dashboard(?!\/new)/, { timeout: 10_000 });
  }
}
