import type { Page } from "@playwright/test";
import { PasswordEntryPage } from "./password-entry.page";

export class TrashPage {
  private entry: PasswordEntryPage;

  constructor(private page: Page) {
    this.entry = new PasswordEntryPage(page);
  }

  /**
   * The "Empty Trash" button that opens a confirmation dialog. Rendered by the
   * unified EntryListView when trash entries exist — in the detail pane (master-detail,
   * no entry selected) or below the list (accordion).
   * tTrash("emptyTrash") = "Empty Trash" / "ゴミ箱を空にする"
   */
  get emptyTrashButton() {
    return this.page.getByRole("button", { name: /Empty Trash|ゴミ箱を空にする/i });
  }

  /**
   * The confirm button inside the "Empty Trash" dialog.
   * The dialog reuses the same label as the trigger button.
   */
  get emptyTrashConfirmButton() {
    return this.page
      .locator("[role='dialog']")
      .getByRole("button", { name: /Empty Trash|ゴミ箱を空にする/i });
  }

  /** Trash entry list — layout-agnostic (master-detail rows / accordion cards). */
  get entryList() {
    return this.entry.isMasterDetail
      ? this.page.getByRole("option")
      : this.page.locator("[data-slot='card']");
  }

  /**
   * Click "Empty Trash" and confirm in the dialog.
   * Waits for the dialog to close after confirmation.
   */
  async emptyTrash(): Promise<void> {
    await this.emptyTrashButton.click();
    await this.page.locator("[role='dialog']").waitFor({ timeout: 5_000 });
    await this.emptyTrashConfirmButton.click();
    await this.page.locator("[role='dialog']").waitFor({
      state: "hidden",
      timeout: 10_000,
    });
  }

  /**
   * Restore the entry matching the title via its ⋮ menu (no confirmation dialog).
   * The unified list surfaces Restore in the shared EntryActionsMenu for both layouts.
   */
  async restoreEntry(title: string): Promise<void> {
    await this.entry.restoreEntry(title);
  }
}
