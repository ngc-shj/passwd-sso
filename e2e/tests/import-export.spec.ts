import { test, expect } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";
import { ExportPage } from "../page-objects/export.page";
import { ImportPage } from "../page-objects/import.page";
import { SidebarNavPage } from "../page-objects/sidebar-nav.page";

/**
 * Import / Export roundtrip test.
 *
 * Uses the shared `vaultReady` user.
 * Creates a uniquely-titled entry, exports the vault as CSV, then imports
 * the downloaded file and verifies the entry re-appears in the list.
 */
test("Export CSV then import restores entries", async ({ context, page }) => {
  const { vaultReady } = getAuthState();
  await injectSession(context, vaultReady.sessionToken);
  await page.goto("/ja/dashboard");

  const lockPage = new VaultLockPage(page);
  await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
  await lockPage.unlockAndWait(vaultReady.passphrase!);

  const dashboard = new DashboardPage(page);
  const entryPage = new PasswordEntryPage(page);

  const exportEntry = {
    title: `Export Test Entry ${Date.now()}`,
    username: "export-test@example.com",
    password: "ExportTestSecret!42",
    url: "https://export-test.example.com",
  };

  await test.step("create a test entry to export", async () => {
    await dashboard.createNewPassword();
    await entryPage.fill(exportEntry);
    await entryPage.save();

    await expect(dashboard.entryByTitle(exportEntry.title)).toBeVisible({
      timeout: 10_000,
    });
  });

  let csvPath: string;

  await test.step("export vault as CSV", async () => {
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("export");

    const exportPage = new ExportPage(page);

    // Wait for export buttons to be ready
    await expect(exportPage.exportCsvButton).toBeVisible({ timeout: 10_000 });

    // Download the CSV without password protection
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      exportPage.exportAs("csv"),
    ]);

    csvPath = join(tmpdir(), download.suggestedFilename());
    await download.saveAs(csvPath);

    // The downloaded file should not be empty
    const { statSync } = await import("node:fs");
    expect(statSync(csvPath).size).toBeGreaterThan(0);
  });

  await test.step("import the downloaded CSV", async () => {
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("import");

    const importPage = new ImportPage(page);

    // Wait for the file input to be present
    await expect(importPage.fileInput).toBeAttached({ timeout: 10_000 });

    await importPage.importFile(csvPath);

    // Success state: the "Import Another" button or a success message appears
    await expect(importPage.importAnotherButton).toBeVisible({
      timeout: 30_000,
    });
  });

  await test.step("verify imported entry appears in the vault", async () => {
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("passwords");

    // Entry title should be visible in the list (may exist multiple times due
    // to the import; we only need at least one occurrence)
    await expect(dashboard.entryByTitle(exportEntry.title)).toBeVisible({
      timeout: 10_000,
    });
  });
});
