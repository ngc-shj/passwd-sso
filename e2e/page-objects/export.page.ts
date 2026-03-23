import type { Page } from "@playwright/test";

export class ExportPage {
  constructor(private page: Page) {}

  get exportProfileSelect() {
    // Native <select> with id "export-profile" (idPrefix is "" on the personal export page)
    return this.page.locator("#export-profile");
  }

  get passwordProtectSwitch() {
    return this.page.locator("#password-protect");
  }

  get exportPasswordInput() {
    return this.page.locator("#export-password");
  }

  get confirmPasswordInput() {
    return this.page.locator("#confirm-password");
  }

  get exportCsvButton() {
    return this.page.getByRole("button", { name: /Export CSV|CSVエクスポート/i });
  }

  get exportJsonButton() {
    return this.page.getByRole("button", { name: /Export JSON|JSONエクスポート/i });
  }

  /**
   * Select the export format and trigger the download.
   * Disables password protection when no exportPassword is given so that
   * the export buttons are immediately enabled.
   *
   * @param format - "csv" | "json"
   * @param exportPassword - when provided, keeps password protection on and fills both fields
   */
  async exportAs(
    format: "csv" | "json",
    exportPassword?: string,
  ): Promise<void> {
    if (exportPassword) {
      // Keep password protection on (default) and fill the password fields
      await this.exportPasswordInput.fill(exportPassword);
      await this.confirmPasswordInput.fill(exportPassword);
    } else {
      // Disable password protection so the export buttons become enabled
      const isChecked = await this.passwordProtectSwitch.isChecked();
      if (isChecked) {
        await this.passwordProtectSwitch.click();
      }
    }

    if (format === "csv") {
      await this.exportCsvButton.click();
    } else {
      await this.exportJsonButton.click();
    }
  }
}
