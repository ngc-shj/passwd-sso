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
   * Identified by the h2 heading with t("overallScore") = "Security Score" / "セキュリティスコア".
   * (The page header card also contains "セキュリティスコア" in its description text,
   *  so we must narrow by the h2 role to avoid false matches.)
   */
  get scoreCard() {
    return this.page.locator("[data-slot='card']").filter({
      has: this.page.locator("h2").filter({
        hasText: /Security Score|セキュリティスコア/i,
      }),
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
   * Waits up to 120s for the score card to appear (covers large vaults with
   * many HIBP checks at 1.5s per unique password).
   * The global setup clears server-side rate limits before each test run,
   * so 429 responses should not occur in normal E2E test usage.
   */
  async startScan(): Promise<void> {
    await this.scanButton.click();
    // Wait for score card — covers both fast (< 1s) and slow (many HIBP checks) scans.
    // The loading card may appear and disappear before we can observe it, so we
    // skip waiting for it and go straight to the final result.
    await this.scoreCard.waitFor({ timeout: 120_000 });
  }
}
