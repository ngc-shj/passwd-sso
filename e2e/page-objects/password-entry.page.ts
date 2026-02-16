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

  /** Three-dot (⋮) menu on the expanded password card. */
  get moreMenuButton() {
    return this.page.getByRole("button", {
      name: /More actions|その他のアクション/i,
    });
  }

  /** "Edit" / "編集" in the card's more-actions dropdown. */
  get editMenuItem() {
    return this.page.getByRole("menuitem", { name: /Edit|編集/i });
  }

  /** "Move to Trash" / "ゴミ箱に移動" in the card's more-actions dropdown. */
  get deleteMenuItem() {
    return this.page.getByRole("menuitem", { name: /Move to Trash|ゴミ箱に移動/i });
  }

  /** Confirm button inside the delete confirmation dialog (common namespace: "削除" / "Delete"). */
  get deleteConfirmButton() {
    return this.page
      .locator("[role='dialog']")
      .getByRole("button", { name: /Delete|削除/i });
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
    // Dialog closes after successful save (encryption + API call may take a few seconds)
    await this.page.locator("[role='dialog']").waitFor({
      state: "hidden",
      timeout: 15_000,
    });
  }

  /** Open ⋮ menu → Edit → wait for edit dialog. */
  async openEditDialog(): Promise<void> {
    await this.moreMenuButton.click();
    await this.editMenuItem.click();
    await this.page.locator("[role='dialog']").waitFor({ timeout: 5_000 });
  }

  /** Open ⋮ menu → Delete → confirm in dialog. */
  async deleteEntry(): Promise<void> {
    await this.moreMenuButton.click();
    await this.deleteMenuItem.click();
    await this.deleteConfirmButton.click();
  }
}
