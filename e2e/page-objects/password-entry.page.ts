import type { Locator, Page } from "@playwright/test";

export class PasswordEntryPage {
  constructor(private page: Page) {}

  get titleInput() {
    // Personal vault forms use id="title"; team vault forms have no id on the title
    // input (EntryLoginMainFields hides it and renders a separate title field).
    // Use the first visible textbox inside the dialog as a fallback.
    return this.page.locator("[role='dialog'] #title, [role='dialog'] input").first();
  }

  get usernameInput() {
    // Personal: id="username", team: id="team-username"
    return this.page.locator("#username, #team-username");
  }

  get passwordInput() {
    // Personal: id="password", team: id="team-password"
    return this.page.locator("#password, #team-password");
  }

  get urlInput() {
    // Personal: id="url", team: id="team-url"
    return this.page.locator("#url, #team-url");
  }

  get notesInput() {
    // Personal: id="notes", team: id="team-notes"
    return this.page.locator("#notes, #team-notes");
  }

  get saveButton() {
    // Scope to the open dialog so we don't accidentally match other "保存"
    // buttons that may be present elsewhere on the page.
    return this.page.locator("[role='dialog']").getByRole("button", { name: /Save|保存/i });
  }

  get updateButton() {
    return this.page.getByRole("button", { name: /Update|更新/i });
  }

  /**
   * Return a locator scoped to the card containing the given title.
   * Useful when multiple entries are visible — avoids ambiguous matches.
   */
  card(title: string | RegExp): Locator {
    return this.page.locator("[data-slot='card']").filter({ hasText: title });
  }

  /**
   * Three-dot (⋮) menu button scoped to a specific card.
   * Falls back to first match when no title is given (single-entry scenarios).
   */
  moreMenuButton(title?: string | RegExp): Locator {
    const scope = title ? this.card(title) : this.page;
    return scope.getByRole("button", {
      name: /More actions|その他のアクション/i,
    });
  }

  /** "Edit" / "編集" — portal-rendered, page-scoped is correct. */
  get editMenuItem() {
    return this.page.getByRole("menuitem", { name: /Edit|編集/i });
  }

  /** "Move to Trash" / "ゴミ箱に移動" — portal-rendered, page-scoped is correct. */
  get deleteMenuItem() {
    return this.page.getByRole("menuitem", {
      name: /Move to Trash|ゴミ箱に移動/i,
    });
  }

  /** Confirm button inside the delete confirmation dialog. */
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

  /** Open ⋮ menu → Edit → wait for edit dialog. Card-scoped when title given. */
  async openEditDialog(title?: string | RegExp): Promise<void> {
    await this.moreMenuButton(title).click();
    await this.editMenuItem.click();
    await this.page.locator("[role='dialog']").waitFor({ timeout: 5_000 });
  }

  /** Open ⋮ menu → Delete → confirm in dialog. Card-scoped when title given. */
  async deleteEntry(title?: string | RegExp): Promise<void> {
    await this.moreMenuButton(title).click();
    // Wait for the dropdown to be open and the menu item to be visible
    await this.deleteMenuItem.waitFor({ state: "visible", timeout: 5_000 });
    await this.deleteMenuItem.click();
    await this.deleteConfirmButton.click();
  }
}
