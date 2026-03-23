import type { Locator, Page } from "@playwright/test";

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
    // Submit button inside the create team dialog
    return this.page
      .locator("[role='dialog']")
      .getByRole("button", { name: /Create Team|チームを作成/i });
  }

  /**
   * Return a locator for the team link card matching the given name.
   */
  teamByName(name: string): Locator {
    return this.page.locator("a.rounded-xl").filter({ hasText: name });
  }

  /**
   * Open the create team dialog, fill in the form fields, and submit.
   * Slug is auto-generated from name if not provided.
   */
  async createTeam(
    name: string,
    slug?: string,
    description?: string,
  ): Promise<void> {
    await this.createTeamButton.click();
    await this.page.locator("[role='dialog']").waitFor({ timeout: 5_000 });

    await this.teamNameInput.fill(name);
    if (slug) {
      await this.teamSlugInput.fill(slug);
    }
    if (description) {
      await this.teamDescriptionInput.fill(description);
    }

    await this.createButton.click();
    // Wait for dialog to close after creation
    await this.page.locator("[role='dialog']").waitFor({
      state: "hidden",
      timeout: 10_000,
    });
  }

  /**
   * Click on a team card to navigate to its dashboard page.
   */
  async openTeam(name: string): Promise<void> {
    await this.teamByName(name).click();
  }
}
