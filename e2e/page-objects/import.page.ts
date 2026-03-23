import type { Page } from "@playwright/test";

export class ImportPage {
  constructor(private page: Page) {}

  /**
   * The hidden file input inside the drag-and-drop zone.
   * Use setInputFiles() rather than click() since the input is visually hidden.
   */
  get fileInput() {
    return this.page.locator('input[type="file"][accept=".csv,.json,.xml"]');
  }

  get importButton() {
    return this.page.getByRole("button", { name: /^Import$|^インポート$/i });
  }

  get resetButton() {
    return this.page.getByRole("button", { name: /Back|戻る/i });
  }

  get decryptPasswordInput() {
    return this.page.locator("#decrypt-password");
  }

  get decryptButton() {
    return this.page.getByRole("button", { name: /Decrypt|復号/i });
  }

  get importAnotherButton() {
    return this.page.getByRole("button", { name: /Import Another|別のファイルをインポート/i });
  }

  /**
   * Upload a file and trigger the import.
   * If the file is an encrypted export, provide the decryption password.
   * After upload the import preview is shown; clicking Import submits it.
   */
  async importFile(filePath: string, decryptPassword?: string): Promise<void> {
    await this.fileInput.setInputFiles(filePath);

    if (decryptPassword) {
      // Encrypted file: wait for decrypt step, enter password, decrypt
      await this.decryptPasswordInput.waitFor({ timeout: 5_000 });
      await this.decryptPasswordInput.fill(decryptPassword);
      await this.decryptButton.click();
    }

    // Wait for preview table to appear
    await this.importButton.waitFor({ timeout: 10_000 });
    await this.importButton.click();
  }
}
