import type { Page } from "@playwright/test";

/** Type filter values accepted by the share-links page. */
export type ShareLinkTypeFilter = "all" | "entry" | "send";

/** Status filter values accepted by the share-links page. */
export type ShareLinkStatusFilter = "all" | "active" | "expired" | "revoked";

export class ShareLinksPage {
  constructor(private page: Page) {}

  // --- Filter controls ---

  /**
   * Type filter <Select> trigger.
   * Label: t("typeFilter") = "Type" / "タイプ"
   */
  get typeFilterTrigger() {
    // The Select trigger sits next to a label with text "Type" / "タイプ"
    return this.page
      .locator("label")
      .filter({ hasText: /^Type$|^タイプ$/i })
      .locator("~ *")
      .first()
      .or(this.page.locator("[data-slot='select-trigger']").first());
  }

  /**
   * Status filter <Select> trigger.
   * Label: t("status") = "Status" / "ステータス"
   */
  get statusFilterTrigger() {
    return this.page
      .locator("label")
      .filter({ hasText: /^Status$|^ステータス$/i })
      .locator("~ *")
      .first()
      .or(this.page.locator("[data-slot='select-trigger']").nth(1));
  }

  /**
   * "New Send" button visible when not filtering by team.
   * t("newSend") = "New Send" / "新規送信"
   */
  get newSendButton() {
    return this.page.getByRole("button", { name: /New Send|新規送信/i });
  }

  /** "Load more" button at the bottom of the list. */
  get loadMoreButton() {
    // t("loadMore") = "Load more" / "さらに読み込む"
    return this.page.getByRole("button", { name: /Load more|さらに読み込む/i });
  }

  /**
   * The list container holding all share link rows.
   * Each row is a <div> inside a Card that uses divide-y.
   */
  get linkList() {
    return this.page.locator("[data-slot='card'].divide-y");
  }

  /** All individual link rows within the list card. */
  get linkRows() {
    return this.linkList.locator("> div");
  }

  /**
   * Revoke button (trash icon) for the nth link row (0-indexed).
   * The button title corresponds to t("revoked") = "Revoked" / "失効".
   * Only active, revocable links render this button.
   */
  revokeButtonAt(index: number) {
    return this.linkRows
      .nth(index)
      .getByRole("button", { name: /Revoked|失効/i });
  }

  // --- Methods ---

  /**
   * Select a value in the type filter dropdown.
   * Option labels: "All types" | "Entry shares" | "Sends"
   */
  async filterByType(type: ShareLinkTypeFilter): Promise<void> {
    const labelMap: Record<ShareLinkTypeFilter, RegExp> = {
      all: /All types|すべてのタイプ/i,
      entry: /Entry shares|エントリ共有/i,
      send: /^Sends$|^送信$/i,
    };
    await this.typeFilterTrigger.click();
    await this.page.getByRole("option", { name: labelMap[type] }).click();
  }

  /**
   * Select a value in the status filter dropdown.
   * Option labels: "All statuses" | "Active" | "Expired" | "Revoked"
   */
  async filterByStatus(status: ShareLinkStatusFilter): Promise<void> {
    const labelMap: Record<ShareLinkStatusFilter, RegExp> = {
      all: /All statuses|すべてのステータス/i,
      active: /^Active$|^アクティブ$/i,
      expired: /^Expired$|^期限切れ$/i,
      revoked: /^Revoked$|^失効$/i,
    };
    await this.statusFilterTrigger.click();
    await this.page.getByRole("option", { name: labelMap[status] }).click();
  }

  /**
   * Click the revoke button for the link at the given 0-based index.
   * The revoke is performed immediately (no confirmation dialog).
   */
  async revokeLink(index: number): Promise<void> {
    await this.revokeButtonAt(index).click();
  }
}
