import type { Page } from "@playwright/test";

export class AuditLogsPage {
  constructor(private page: Page) {}

  // --- Filter controls ---

  /**
   * "From" date input.
   * Label: t("dateFrom") = "From" / "開始日"
   */
  get dateFromInput() {
    return this.page
      .locator("label")
      .filter({ hasText: /^From$|^開始日$/i })
      .locator("~ input[type='date']");
  }

  /**
   * "To" date input.
   * Label: t("dateTo") = "To" / "終了日"
   */
  get dateToInput() {
    return this.page
      .locator("label")
      .filter({ hasText: /^To$|^終了日$/i })
      .locator("~ input[type='date']");
  }

  /**
   * The action filter collapsible trigger button.
   * Shows the current selection summary (e.g. "Action: All actions").
   */
  get actionFilterTrigger() {
    // CollapsibleTrigger rendered as a Button containing "Action:" text
    return this.page.getByRole("button", {
      name: /Action:|アクション:/i,
    });
  }

  /**
   * The action search input inside the expanded filter panel.
   * placeholder: t("actionSearch") = "Search actions" / "アクションを検索"
   */
  get actionSearchInput() {
    return this.page.getByPlaceholder(/Search actions|アクションを検索/i);
  }

  /**
   * "Clear" / "All actions" button that resets the action filter.
   * t("allActions") = "All actions" / "すべてのアクション"
   */
  get clearActionsButton() {
    return this.page.getByRole("button", {
      name: /All actions|すべてのアクション/i,
    });
  }

  // --- Download ---

  /**
   * Download button that opens the format dropdown.
   * td("download") = "Download" / "ダウンロード"
   */
  get downloadButton() {
    return this.page.getByRole("button", { name: /Download|ダウンロード/i });
  }

  /** "CSV" download option inside the download dropdown. */
  get downloadCsvMenuItem() {
    return this.page.getByRole("menuitem", { name: /CSV/i });
  }

  /** "JSONL" download option inside the download dropdown. */
  get downloadJsonlMenuItem() {
    return this.page.getByRole("menuitem", { name: /JSONL/i });
  }

  // --- Log list ---

  /**
   * The card containing log entries (divide-y card).
   */
  get logListCard() {
    return this.page.locator("[data-testid='audit-log-list']");
  }

  /** All individual log entry rows. */
  get logRows() {
    return this.page.locator("[data-testid='audit-log-row']");
  }

  /** "Load more" pagination button. */
  get loadMoreButton() {
    // t("loadMore") = "Load more" / "さらに読み込む"
    return this.page.getByRole("button", { name: /Load more|さらに読み込む/i });
  }

  // --- Methods ---

  /**
   * Open the action filter panel, search for an action string, and click its
   * checkbox. Provide the action label as it appears in the UI (e.g. "Logged in").
   */
  async filterByAction(actionLabel: string): Promise<void> {
    // Open the collapsible filter panel if not already open
    const isOpen = await this.actionSearchInput.isVisible();
    if (!isOpen) {
      await this.actionFilterTrigger.click();
      await this.actionSearchInput.waitFor({ timeout: 3_000 });
    }
    await this.actionSearchInput.fill(actionLabel);
    // Click the matching checkbox label
    await this.page
      .locator("label")
      .filter({ hasText: actionLabel })
      .first()
      .click();
  }

  /**
   * Set the "From" date filter.
   * @param date ISO date string, e.g. "2024-01-01"
   */
  async setDateFrom(date: string): Promise<void> {
    await this.dateFromInput.fill(date);
  }

  /**
   * Set the "To" date filter.
   * @param date ISO date string, e.g. "2024-12-31"
   */
  async setDateTo(date: string): Promise<void> {
    await this.dateToInput.fill(date);
  }

  /** Click "Load more" to append the next page of logs. */
  async loadMore(): Promise<void> {
    await this.loadMoreButton.click();
    await this.page.waitForLoadState("networkidle");
  }
}
