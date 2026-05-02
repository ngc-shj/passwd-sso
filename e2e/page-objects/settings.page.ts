import type { Page, Locator } from "@playwright/test";

export class SettingsPage {
  constructor(private page: Page) {}

  // --- Route-based navigation ---

  async gotoSessions(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/devices");
    await this.page.waitForLoadState("networkidle");
  }

  async gotoPasskey(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/auth/passkey");
    await this.page.waitForLoadState("networkidle");
  }

  async gotoTravelMode(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/vault/travel-mode");
    await this.page.waitForLoadState("networkidle");
  }

  async gotoKeyRotation(): Promise<void> {
    await this.page.goto("/ja/dashboard/settings/vault/key-rotation");
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
    await this.page.goto("/ja/dashboard/settings/vault/delegation");
    await this.page.waitForLoadState("networkidle");
  }

  // --- Content accessors ---

  /** Sessions list card rendered on the Security > Sessions page. */
  get sessionsCard(): Locator {
    return this.page.locator("[data-slot='card']").filter({
      hasText: /Sessions|セッション/i,
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
