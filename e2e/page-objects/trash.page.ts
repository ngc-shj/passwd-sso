import type { Page } from "@playwright/test";

export class TrashPage {
  constructor(private page: Page) {}

  /**
   * The "Empty Trash" button that opens a confirmation dialog.
   * Rendered by TrashList when entries exist.
   * t("emptyTrash") = "Empty Trash" / "ゴミ箱を空にする"
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

  /** Entry list — each entry is a Card element containing the entry title. */
  get entryList() {
    return this.page.locator("[data-slot='card']");
  }

  /**
   * "Restore" button scoped to the card that contains the given title.
   * t("restore") = "Restore" / "復元"
   */
  restoreButton(title: string) {
    return this.page
      .locator("[data-slot='card']")
      .filter({ hasText: title })
      .getByRole("button", { name: /^Restore$|^復元$/i });
  }

  /**
   * "Delete Permanently" button scoped to the card that contains the given title.
   * t("deletePermanently") = "Delete Permanently" / "完全に削除"
   */
  deletePermanentlyButton(title: string) {
    return this.page
      .locator("[data-slot='card']")
      .filter({ hasText: title })
      .getByRole("button", { name: /Delete Permanently|完全に削除/i });
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
   * Click the "Restore" button for the entry matching the given title.
   * The restore is handled directly (no confirmation dialog).
   */
  async restoreEntry(title: string): Promise<void> {
    await this.restoreButton(title).click();
  }
}
