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

  get adminConsoleLink() {
    // t("adminConsole") = "Admin Console" / "管理コンソール"
    return this.page.getByRole("link", { name: /Admin Console|管理コンソール/i });
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

  // --- Folders section ---

  /** The "Folders" / "フォルダ" section header button (CollapsibleTrigger). */
  get foldersSectionHeader() {
    return this.page.locator("nav").getByRole("button", { name: /^Folders$|^フォルダ$/i });
  }

  /** Plus button that opens the folder creation dialog. Has aria-label="createFolder". */
  get folderCreateButton() {
    return this.page
      .locator("nav")
      .getByRole("button", { name: /New Folder|新規フォルダ|createFolder/i });
  }

  /** Expand the Folders section if it is currently collapsed. */
  async expandFoldersSection(): Promise<void> {
    const header = this.foldersSectionHeader;
    await header.waitFor({ timeout: 10_000 });
    const expanded = await header.getAttribute("aria-expanded");
    if (expanded !== "true") {
      await header.click();
    }
  }

  // --- Tags section ---

  /** The "Tags" / "タグ" section header button (CollapsibleTrigger). */
  get tagsSectionHeader() {
    return this.page.locator("nav").getByRole("button", { name: /^Tags$|^タグ$/i });
  }

  /** Expand the Tags section if it is currently collapsed. */
  async expandTagsSection(): Promise<void> {
    const header = this.tagsSectionHeader;
    await header.waitFor({ timeout: 10_000 });
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
   * Collapsible trigger for the Insights section (formerly "Security").
   * Visible label: t("insightsGroup") = "Insights" / "インサイト".
   */
  get insightsSectionHeader() {
    return this.page.locator("nav").getByRole("button", { name: /^Insights$|^インサイト$/i });
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

  /** Expand the Insights section if it is currently collapsed. */
  async expandInsightsSection(): Promise<void> {
    // Wait for the section header to appear (nav finishes loading after unlock)
    const header = this.insightsSectionHeader;
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
    view: "passwords" | "favorites" | "archive" | "trash" | "shareLinks" | "watchtower" | "auditLog" | "settings" | "export" | "import" | "adminConsole" | "emergencyAccess"
  ): Promise<void> {
    if (view === "export" || view === "import") {
      await this.expandToolsSection();
    } else if (view === "watchtower" || view === "auditLog") {
      // emergencyAccess was promoted to a top-level sidebar item in the IA
      // redesign; only watchtower + auditLog remain inside Insights.
      await this.expandInsightsSection();
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
      adminConsole: this.adminConsoleLink,
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
      adminConsole: /\/admin/,
      emergencyAccess: /\/emergency-access$/,
    };
    await linkMap[view].click();
    await this.page.waitForURL(urlPatternMap[view], { timeout: 10_000 });
  }

  /**
   * Click the Admin Console link and wait for navigation to the admin area.
   */
  async navigateToAdmin(): Promise<void> {
    const link = this.page.getByRole("link", { name: /Admin Console|管理コンソール/i });
    await link.click();
    await this.page.waitForLoadState("networkidle");
  }

  /** Click the Folders section [+] button and create a folder via the dialog. */
  async createFolder(name: string): Promise<void> {
    await this.expandFoldersSection();
    await this.folderCreateButton.click();
    // Fill in the folder name dialog
    const dialog = this.page.locator("[role='dialog']");
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.getByRole("textbox").fill(name);
    // The submit button says "作成" (Create) for new folders, "保存" (Save) for edits
    await dialog.getByRole("button", { name: /Save|保存|Create|作成/i }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
    // Expand the Folders section so the newly created folder is visible
    await this.expandFoldersSection();
  }
}
