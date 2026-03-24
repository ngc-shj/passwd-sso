import type { Page, Locator } from "@playwright/test";

/**
 * Top-level tab values used in the Settings page.
 * Corresponds to defaultValue / value props on <TabsTrigger>.
 */
export type SettingsTab = "account" | "security" | "developer";

/**
 * Sub-tab values under the "Security" tab.
 */
export type SecuritySubTab = "passkey" | "travel" | "rotate";

export class SettingsPage {
  constructor(private page: Page) {}

  // --- Top-level tabs ---

  /**
   * "Account" tab trigger.
   * t("tabAccount") = "Account" / "アカウント"
   */
  get accountTab() {
    return this.page.getByRole("tab", { name: /Account|アカウント/i });
  }

  /**
   * "Security" tab trigger.
   * t("tabSecurity") = "Security" / "セキュリティ"
   */
  get securityTab() {
    return this.page.getByRole("tab", { name: /^Security$|^セキュリティ$/i });
  }

  /**
   * "Developer" tab trigger.
   * t("tabDeveloper") = "Developer" / "開発者"
   */
  get developerTab() {
    return this.page.getByRole("tab", { name: /Developer|開発者/i });
  }

  // --- Security sub-tabs ---

  /**
   * "Passkey" sub-tab trigger inside the Security tab.
   * t("subTabPasskey") = "Passkey" / "パスキー"
   */
  get passkeySubTab() {
    return this.page.getByRole("tab", { name: /^Passkey$|^パスキー$/i });
  }

  /**
   * "Travel Mode" sub-tab trigger inside the Security tab.
   * t("subTabTravelMode") = "Travel Mode" / "トラベルモード"
   */
  get travelModeSubTab() {
    return this.page.getByRole("tab", { name: /Travel Mode|トラベルモード/i });
  }

  /**
   * "Key Rotation" sub-tab trigger inside the Security tab.
   * t("subTabKeyRotation") = "Key Rotation" / "鍵のローテーション"
   */
  get keyRotationSubTab() {
    return this.page.getByRole("tab", { name: /Key Rotation|鍵のローテーション/i });
  }

  // --- Content accessors ---

  /** Sessions list card rendered inside the Account tab. */
  get sessionsCard(): Locator {
    // The sessions card is the only [data-slot='card'] in the Account tabpanel
    return this.page
      .getByRole("tabpanel", { name: /アカウント|Account/i })
      .locator("[data-slot='card']")
      .first();
  }

  /** CLI token card rendered inside the Developer tab. */
  get cliTokenCard(): Locator {
    return this.page.locator("[data-slot='card']").filter({
      hasText: /CLI Token|CLIトークン/i,
    });
  }

  /** API key manager section rendered inside the Developer tab. */
  get apiKeySection(): Locator {
    // The API key manager renders a card with "API キー" or "API Key" heading
    return this.page.locator("[data-slot='card']").filter({
      hasText: /API\s*[Kk]ey|API\s*キー/i,
    });
  }

  /** Travel mode card rendered inside the Security → Travel sub-tab. */
  get travelModeCard(): Locator {
    return this.page.locator("[data-slot='card']").filter({
      hasText: /Travel Mode|トラベルモード/i,
    });
  }

  // --- Methods ---

  /**
   * Click a top-level settings tab by name and wait for the tab panel to become visible.
   */
  async switchTab(tab: SettingsTab): Promise<void> {
    const tabMap: Record<SettingsTab, Locator> = {
      account: this.accountTab,
      security: this.securityTab,
      developer: this.developerTab,
    };
    await tabMap[tab].click();
    // Use first() to avoid strict mode violation when nested sub-tabs are also active
    await this.page
      .locator(`[role='tabpanel'][data-state='active']`)
      .first()
      .waitFor({ timeout: 5_000 });
  }

  /**
   * Click a sub-tab inside the Security tab.
   * Assumes the Security top-level tab is already active.
   */
  async switchSecuritySubTab(subTab: SecuritySubTab): Promise<void> {
    const subTabMap: Record<SecuritySubTab, Locator> = {
      passkey: this.passkeySubTab,
      travel: this.travelModeSubTab,
      rotate: this.keyRotationSubTab,
    };
    await subTabMap[subTab].click();
    // Use first() to avoid strict mode violation when multiple panels are active
    await this.page
      .locator(`[role='tabpanel'][data-state='active']`)
      .first()
      .waitFor({ timeout: 5_000 });
  }
}
