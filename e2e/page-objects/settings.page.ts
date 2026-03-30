import type { Page, Locator } from "@playwright/test";

export class SettingsPage {
  constructor(private page: Page) {}

  // --- Route-based navigation ---

  async gotoAccount(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/account");
    await this.page.waitForLoadState("networkidle");
  }

  async gotoPasskey(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/security/passkey");
    await this.page.waitForLoadState("networkidle");
  }

  async gotoTravelMode(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/security/travel-mode");
    await this.page.waitForLoadState("networkidle");
  }

  async gotoKeyRotation(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/security/key-rotation");
    await this.page.waitForLoadState("networkidle");
  }

  async gotoCliToken(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/developer/cli-token");
    await this.page.waitForLoadState("networkidle");
  }

  async gotoApiKeys(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/developer/api-keys");
    await this.page.waitForLoadState("networkidle");
  }

  async gotoDelegation(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/developer/delegation");
    await this.page.waitForLoadState("networkidle");
  }

  // --- Content accessors ---

  /** Sessions list card rendered on the Account page. */
  get sessionsCard(): Locator {
    // Skip the SectionLayout header card — sessions card has divide-y rows
    return this.page.locator("[data-slot='card']").filter({
      has: this.page.locator(".divide-y"),
    });
  }

  /** CLI token card rendered on the Developer > CLI Token page. */
  get cliTokenCard(): Locator {
    return this.page.locator("[data-slot='card']").filter({
      hasText: /CLI Token|CLIトークン/i,
    });
  }

  /** API key manager section rendered on the Developer > API Keys page. */
  get apiKeySection(): Locator {
    return this.page.locator("[data-slot='card']").filter({
      hasText: /API\s*[Kk]ey|API\s*キー/i,
    });
  }

  /** Travel mode card rendered on the Security > Travel Mode page. */
  get travelModeCard(): Locator {
    return this.page.locator("[data-slot='card']").filter({
      hasText: /Travel Mode|トラベルモード/i,
    });
  }
}
