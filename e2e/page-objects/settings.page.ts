import type { Page, Locator } from "@playwright/test";

export class SettingsPage {
  constructor(private page: Page) {}

  // --- Route-based navigation ---

  async gotoAccount(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/account");
    await this.page.waitForLoadState("networkidle");
  }

  async gotoSecurity(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/security");
    await this.page.waitForLoadState("networkidle");
  }

  async gotoDeveloper(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/developer");
    await this.page.waitForLoadState("networkidle");
  }

  // --- Content accessors ---

  /** Sessions list card rendered on the Account page. */
  get sessionsCard(): Locator {
    return this.page.locator("[data-slot='card']").first();
  }

  /** CLI token card rendered on the Developer page. */
  get cliTokenCard(): Locator {
    return this.page.locator("[data-slot='card']").filter({
      hasText: /CLI Token|CLIトークン/i,
    });
  }

  /** API key manager section rendered on the Developer page. */
  get apiKeySection(): Locator {
    // The API key manager renders a card with "API キー" or "API Key" heading
    return this.page.locator("[data-slot='card']").filter({
      hasText: /API\s*[Kk]ey|API\s*キー/i,
    });
  }

  /** Travel mode card rendered on the Security page. */
  get travelModeCard(): Locator {
    return this.page.locator("[data-slot='card']").filter({
      hasText: /Travel Mode|トラベルモード/i,
    });
  }
}
