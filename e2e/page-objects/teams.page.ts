import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export class TeamsPage {
  constructor(private page: Page) {}

  get createTeamButton() {
    return this.page.getByRole("button", { name: /Create Team|チームを作成/i });
  }

  get teamNameInput() {
    return this.page.locator("#team-name");
  }

  get teamSlugInput() {
    return this.page.locator("#team-slug");
  }

  get teamDescriptionInput() {
    return this.page.locator("#team-desc");
  }

  get createButton() {
    // Submit button inside the create team dialog — text is "Create" / "作成" (not "Create Team")
    return this.page
      .locator("[role='dialog']")
      .getByRole("button", { name: /^Create$|^作成$/i });
  }

  /**
   * Return a locator for the team link card matching the given name.
   */
  teamByName(name: string): Locator {
    return this.page.locator("a.rounded-xl").filter({ hasText: name });
  }

  private get dialog() {
    return this.page.locator("[role='dialog']");
  }

  /**
   * Open the create team dialog, fill in the form fields, and submit.
   * If unlockPassphrase is provided, handles inline vault unlock first.
   * Slug is auto-generated from name if not provided.
   */
  async createTeam(
    name: string,
    slug?: string,
    description?: string,
    unlockPassphrase?: string,
  ): Promise<void> {
    await this.createTeamButton.click();
    await this.dialog.waitFor({ timeout: 5_000 });

    // Handle inline vault unlock if passphrase is provided
    if (unlockPassphrase) {
      const passphraseInput = this.dialog.locator("#unlock-passphrase");
      await expect(passphraseInput).toBeVisible({ timeout: 5_000 });
      await passphraseInput.fill(unlockPassphrase);
      await this.dialog
        .getByRole("button", { name: /^Unlock$|^解錠$|^アンロック$/i })
        .click();
      // Wait for PBKDF2 unlock to complete and form to appear
      await expect(this.teamNameInput).toBeVisible({ timeout: 20_000 });
    }

    await this.teamNameInput.fill(name);
    if (slug) {
      await this.teamSlugInput.fill(slug);
    }
    if (description) {
      await this.teamDescriptionInput.fill(description);
    }

    await this.createButton.click();
    // Wait for dialog to close after creation
    await this.dialog.waitFor({
      state: "hidden",
      timeout: 10_000,
    });
  }

  /**
   * Click on a team card to navigate to its admin settings page.
   * Note: team cards link to /admin/teams/{id}/general.
   * Use openTeamVault() to reach the vault page.
   */
  async openTeam(name: string): Promise<void> {
    await this.teamByName(name).click();
  }

  /**
   * Navigate to the team vault (passwords) page for the named team.
   * Clicks the team card (→ admin general page), then clicks the sidebar
   * "Passwords" link which in team context points to /teams/{id}.
   * This avoids a full page reload that would lose the vault unlock state.
   */
  async openTeamVault(name: string): Promise<void> {
    // Navigate to admin settings page first (card href goes to /admin/teams/{id}/general)
    await this.teamByName(name).click();
    // Wait for navigation to complete (URL ends with /general)
    await this.page.waitForURL(/\/admin\/teams\/[^/]+\/general/, { timeout: 10_000 });
    // Click the sidebar "Passwords" link — in team vault context this navigates
    // client-side to /dashboard/teams/{id}, preserving the React vault state.
    const passwordsLink = this.page.getByRole("link", { name: /^Passwords$|^パスワード$/i });
    await passwordsLink.click();
    await this.page.waitForURL(/\/teams\/[^/]+$/, { timeout: 10_000 });
  }
}
