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

  get teamsLink() {
    // tTeam("teamSettings") = "Team Settings" / "チーム設定" — links to the /dashboard/teams list
    return this.page.getByRole("link", { name: /Team Settings|チーム設定/i });
  }

  get tenantSettingsLink() {
    // t("tenantSettings") = "Tenant Settings" / "テナント設定"
    return this.page.getByRole("link", { name: /Tenant Settings|テナント設定/i });
  }

  get emergencyAccessLink() {
    // t("emergencyAccess") = "Emergency Access" / "緊急アクセス"
    return this.page.getByRole("link", { name: /Emergency Access|緊急アクセス/i });
  }

  get exportLink() {
    // t("export") = "Export" / "エクスポート"
    return this.page.getByRole("link", { name: /^Export$|^エクスポート$/i });
  }

  get importLink() {
    // t("import") = "Import" / "インポート"
    return this.page.getByRole("link", { name: /^Import$|^インポート$/i });
  }

  // --- Manage section (folders and tags) ---

  /** The "管理" section header button (CollapsibleTrigger). */
  get manageSectionHeader() {
    return this.page.locator("nav").getByRole("button", { name: /^Manage$|^管理$/i });
  }

  /** Plus button that opens the folder/tag creation dropdown in the Manage section. */
  get manageCreateButton() {
    // The Plus icon button (lucide-plus) sits next to the "管理" collapsible header.
    // It has no accessible name — locate it by the SVG class within nav scope.
    return this.page
      .locator("nav")
      .locator("button:has(svg.lucide-plus)")
      .first();
  }

  get createFolderMenuItem() {
    // t("createFolder") = "New Folder" / "新規フォルダ"
    return this.page.getByRole("menuitem", { name: /New Folder|新規フォルダ/i });
  }

  get createTagMenuItem() {
    // t("createTag") = "New Tag" / "新規タグ"
    return this.page.getByRole("menuitem", { name: /New Tag|新規タグ/i });
  }

  /** Expand the Manage section if it is currently collapsed. */
  async expandManageSection(): Promise<void> {
    const header = this.manageSectionHeader;
    const expanded = await header.getAttribute("aria-expanded");
    if (expanded !== "true") {
      await header.click();
    }
  }

  // --- Section header triggers for expanding collapsed sections ---

  /**
   * Collapsible trigger for the Tools section.
   * t("tools") = "Tools" / "ツール"
   */
  get toolsSectionHeader() {
    return this.page.locator("nav").getByRole("button", { name: /^Tools$|^ツール$/i });
  }

  /**
   * Collapsible trigger for the Security section.
   * t("security") = "Security" / "セキュリティ"
   */
  get securitySectionHeader() {
    return this.page.locator("nav").getByRole("button", { name: /^Security$|^セキュリティ$/i });
  }

  /** Expand the Tools section if it is currently collapsed. */
  async expandToolsSection(): Promise<void> {
    // Wait for the section header to appear (nav finishes loading after unlock)
    const header = this.toolsSectionHeader;
    await header.waitFor({ timeout: 10_000 });
    const expanded = await header.getAttribute("aria-expanded", { timeout: 5_000 });
    if (expanded !== "true") {
      await header.click();
    }
  }

  /** Expand the Security section if it is currently collapsed. */
  async expandSecuritySection(): Promise<void> {
    // Wait for the section header to appear (nav finishes loading after unlock)
    const header = this.securitySectionHeader;
    await header.waitFor({ timeout: 10_000 });
    const expanded = await header.getAttribute("aria-expanded", { timeout: 5_000 });
    if (expanded !== "true") {
      await header.click();
    }
  }

  /**
   * Navigate to a top-level view by clicking the corresponding sidebar link
   * and waiting for the URL to reflect the target view.
   * Expands collapsed sidebar sections as needed before clicking the link.
   */
  async navigateTo(
    view: "passwords" | "favorites" | "archive" | "trash" | "shareLinks" | "watchtower" | "auditLog" | "settings" | "export" | "import" | "teams" | "tenantSettings" | "emergencyAccess"
  ): Promise<void> {
    // Expand collapsed sidebar sections as needed before clicking the link.
    // The Tools section (export/import) is collapsed by default.
    // The Security section (watchtower/emergencyAccess) is open by default but
    // may have been collapsed by a previous test.
    // Archive, Trash, Share Links, and Audit Log are in VaultManagementSection
    // which has no collapsible wrapper and is always visible.
    if (view === "export" || view === "import") {
      await this.expandToolsSection();
    } else if (view === "watchtower" || view === "emergencyAccess") {
      await this.expandSecuritySection();
    }

    const linkMap = {
      passwords: this.allPasswordsLink,
      favorites: this.favoritesLink,
      archive: this.archiveLink,
      trash: this.trashLink,
      shareLinks: this.shareLinksLink,
      watchtower: this.watchtowerLink,
      auditLog: this.auditLogLink,
      settings: this.settingsLink,
      export: this.exportLink,
      import: this.importLink,
      teams: this.teamsLink,
      tenantSettings: this.tenantSettingsLink,
      emergencyAccess: this.emergencyAccessLink,
    };
    const urlPatternMap: Record<string, RegExp> = {
      passwords: /\/dashboard$/,
      favorites: /\/favorites/,
      archive: /\/archive/,
      trash: /\/trash/,
      shareLinks: /\/share-links/,
      watchtower: /\/watchtower/,
      auditLog: /\/audit-logs/,
      settings: /\/settings/,
      export: /\/export/,
      import: /\/import/,
      teams: /\/teams$/,
      tenantSettings: /\/tenant$/,
      emergencyAccess: /\/emergency-access$/,
    };
    await linkMap[view].click();
    await this.page.waitForURL(urlPatternMap[view], { timeout: 10_000 });
  }

  /** Open the Manage section's create dropdown, then click "New Folder". */
  async createFolder(name: string): Promise<void> {
    await this.manageCreateButton.click();
    await this.createFolderMenuItem.click();
    // Fill in the folder name dialog
    const dialog = this.page.locator("[role='dialog']");
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.getByRole("textbox").fill(name);
    // The submit button says "作成" (Create) for new folders, "保存" (Save) for edits
    await dialog.getByRole("button", { name: /Save|保存|Create|作成/i }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
    // Expand the Manage section so the newly created folder is visible
    await this.expandManageSection();
  }

  /** Open the Manage section's create dropdown, then click "New Tag". */
  async createTag(name: string): Promise<void> {
    await this.manageCreateButton.click();
    await this.createTagMenuItem.click();
    const dialog = this.page.locator("[role='dialog']");
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.getByRole("textbox").fill(name);
    // The submit button says "作成" (Create) for new tags, "保存" (Save) for edits
    await dialog.getByRole("button", { name: /Save|保存|Create|作成/i }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
    // Expand the Manage section so the newly created tag is visible
    await this.expandManageSection();
  }
}
