import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { WatchtowerPage } from "../page-objects/watchtower.page";

/**
 * Watchtower security scan tests.
 *
 * Uses the shared `vaultReady` user (non-destructive read-only operations).
 */
test.describe("Watchtower", () => {
  test("scan completes and displays security score", async ({
    context,
    page,
  }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    await test.step("navigate to Watchtower", async () => {
      await page.goto("/ja/dashboard/watchtower");

      const watchtower = new WatchtowerPage(page);
      // Either the run hint card or the scan button should be visible
      await expect(watchtower.scanButton).toBeVisible({ timeout: 10_000 });
    });

    const watchtower = new WatchtowerPage(page);

    await test.step("trigger security scan", async () => {
      await watchtower.startScan();
    });

    await test.step("verify results are displayed", async () => {
      // After analysis, the score card should always appear
      await expect(watchtower.scoreCard).toBeVisible({ timeout: 10_000 });

      // Either a "no issues" card or individual issue sections should be shown
      const noIssues = watchtower.noIssuesCard;
      const issueSections = page.locator("[data-slot='card']").filter({
        hasText:
          /Weak|Breached|Reused|Old|Unsecured|Duplicate|脆弱|侵害|再利用|古い|非セキュア|重複/i,
      });

      const noIssuesVisible = await noIssues.isVisible();
      const issueVisible = await issueSections.first().isVisible();

      expect(noIssuesVisible || issueVisible).toBeTruthy();
    });
  });

  test("run hint is shown before first scan", async ({ context, page }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // Navigate directly; do NOT click scan
    await page.goto("/ja/dashboard/watchtower");

    const watchtower = new WatchtowerPage(page);
    await expect(watchtower.scanButton).toBeVisible({ timeout: 10_000 });

    // Score card should not yet be visible
    await expect(watchtower.scoreCard).not.toBeVisible();
  });
});
