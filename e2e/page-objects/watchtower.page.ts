import type { Page } from "@playwright/test";

export class WatchtowerPage {
  constructor(private page: Page) {}

  /**
   * The "Re-analyze" / scan trigger button.
   * t("refresh") = "Re-analyze" / "再分析"
   * Disabled during cooldown; text changes to "Retry in {n}s".
   */
  get scanButton() {
    return this.page.getByRole("button", {
      name: /Re-analyze|再分析|Retry in|後に再試行/i,
    });
  }

  /**
   * The loading spinner card shown while analysis is running.
   * Contains progress text from t("fetching") / t("decrypting") / etc.
   */
  get loadingCard() {
    return this.page.locator("[data-slot='card']").filter({
      has: this.page.locator(".animate-spin"),
    });
  }

  /**
   * The score gauge card shown after analysis completes.
   * Contains the t("overallScore") = "Security Score" / "セキュリティスコア" heading.
   */
  get scoreCard() {
    return this.page.locator("[data-slot='card']").filter({
      hasText: /Security Score|セキュリティスコア/i,
    });
  }

  /**
   * The "no issues" card shown when the vault is clean.
   * t("noIssuesDesc") text is displayed inside it.
   */
  get noIssuesCard() {
    return this.page.locator("[data-slot='card']").filter({
      hasText: /All your passwords are strong|すべてのパスワードが強力/i,
    });
  }

  /**
   * The "run hint" card shown before the first scan is initiated.
   * t("runHint") = 'Click "Re-analyze" to start checks.'
   */
  get runHintCard() {
    return this.page.locator("[data-slot='card']").filter({
      hasText: /Re-analyze|再分析/i,
    });
  }

  /** Auto-monitor toggle card (personal vault only). */
  get autoMonitorToggle() {
    // AutoMonitorToggle renders a card with t("autoMonitorLabel") = "Auto-monitor"
    return this.page.getByRole("switch", {
      name: /Auto-monitor|自動モニター/i,
    });
  }

  /**
   * Click the scan/refresh button and wait for analysis to complete.
   * Analysis is done when the loading card disappears and the score card appears.
   */
  async startScan(): Promise<void> {
    await this.scanButton.click();
    // Wait for analysis to start (loading indicator appears)
    await this.loadingCard.waitFor({ timeout: 5_000 });
    // Wait for analysis to finish (loading indicator disappears)
    await this.loadingCard.waitFor({ state: "hidden", timeout: 120_000 });
  }
}
