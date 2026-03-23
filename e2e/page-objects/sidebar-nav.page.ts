import type { Page } from "@playwright/test";

export class SidebarNavPage {
  constructor(private page: Page) {}

  // --- Primary vault views ---

  get allPasswordsLink() {
    // t("passwords") = "Passwords" / "パスワード"
    return this.page.getByRole("link", { name: /^Passwords$|^パスワード$/i });
  }

  get favoritesLink() {
    // t("favorites") = "Favorites" / "お気に入り"
    return this.page.getByRole("link", { name: /^Favorites$|^お気に入り$/i });
  }

  get archiveLink() {
    // t("archive") = "Archive" / "アーカイブ"
    return this.page.getByRole("link", { name: /^Archive$|^アーカイブ$/i });
  }

  get trashLink() {
    // t("trash") = "Trash" / "ゴミ箱"
    return this.page.getByRole("link", { name: /^Trash$|^ゴミ箱$/i });
  }

  get shareLinksLink() {
    // t("shareLinks") = "Sharing" / "共有"
    return this.page.getByRole("link", { name: /^Sharing$|^共有$/i });
  }

  get watchtowerLink() {
    // t("watchtower") = "Watchtower" / "ウォッチタワー"
    return this.page.getByRole("link", { name: /^Watchtower$|^ウォッチタワー$/i });
  }

  get auditLogLink() {
    // t("auditLog") = "Audit Log" / "監査ログ"
    return this.page.getByRole("link", { name: /^Audit Log$|^監査ログ$/i });
  }

  get settingsLink() {
    // t("settings") = "Personal Settings" / "個人設定"
    return this.page.getByRole("link", { name: /Personal Settings|個人設定/i });
  }

  // --- Manage section (folders and tags) ---

  /** Plus button that opens the folder/tag creation dropdown in the Manage section. */
  get manageCreateButton() {
    // The Plus icon button sits next to the "Manage" collapsible header
    return this.page
      .locator("nav")
      .getByRole("button", { name: /^$/ })
      .filter({ has: this.page.locator("svg") })
      .first();
  }

  get createFolderMenuItem() {
    // t("createFolder") = "New Folder" / "新規フォルダー"
    return this.page.getByRole("menuitem", { name: /New Folder|新規フォルダー/i });
  }

  get createTagMenuItem() {
    // t("createTag") = "New Tag" / "新規タグ"
    return this.page.getByRole("menuitem", { name: /New Tag|新規タグ/i });
  }

  /**
   * Navigate to a top-level view by clicking the corresponding sidebar link
   * and waiting for the URL to settle.
   */
  async navigateTo(
    view: "passwords" | "favorites" | "archive" | "trash" | "shareLinks" | "watchtower" | "auditLog" | "settings"
  ): Promise<void> {
    const linkMap = {
      passwords: this.allPasswordsLink,
      favorites: this.favoritesLink,
      archive: this.archiveLink,
      trash: this.trashLink,
      shareLinks: this.shareLinksLink,
      watchtower: this.watchtowerLink,
      auditLog: this.auditLogLink,
      settings: this.settingsLink,
    };
    await linkMap[view].click();
    await this.page.waitForLoadState("networkidle");
  }

  /** Open the Manage section's create dropdown, then click "New Folder". */
  async createFolder(name: string): Promise<void> {
    await this.manageCreateButton.click();
    await this.createFolderMenuItem.click();
    // Fill in the folder name dialog
    const dialog = this.page.locator("[role='dialog']");
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.getByRole("textbox").fill(name);
    await dialog.getByRole("button", { name: /Save|保存/i }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  }

  /** Open the Manage section's create dropdown, then click "New Tag". */
  async createTag(name: string): Promise<void> {
    await this.manageCreateButton.click();
    await this.createTagMenuItem.click();
    const dialog = this.page.locator("[role='dialog']");
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.getByRole("textbox").fill(name);
    await dialog.getByRole("button", { name: /Save|保存/i }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  }
}
