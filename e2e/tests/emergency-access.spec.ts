import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { EmergencyAccessPage } from "../page-objects/emergency-access.page";

test.describe("Emergency Access", () => {
  let grantorContext: BrowserContext;
  let granteeContext: BrowserContext;
  let grantorPage: Page;
  let granteePage: Page;

  test.beforeAll(async ({ browser }) => {
    const { eaGrantor, eaGrantee } = getAuthState();

    grantorContext = await browser.newContext();
    await injectSession(grantorContext, eaGrantor.sessionToken);
    grantorPage = await grantorContext.newPage();
    await grantorPage.goto("/ja/dashboard");
    const grantorLock = new VaultLockPage(grantorPage);
    await expect(grantorLock.passphraseInput).toBeVisible({ timeout: 10_000 });
    await grantorLock.unlockAndWait(eaGrantor.passphrase!);

    granteeContext = await browser.newContext();
    await injectSession(granteeContext, eaGrantee.sessionToken);
    granteePage = await granteeContext.newPage();
    await granteePage.goto("/ja/dashboard");
    const granteeLock = new VaultLockPage(granteePage);
    await expect(granteeLock.passphraseInput).toBeVisible({ timeout: 10_000 });
    await granteeLock.unlockAndWait(eaGrantee.passphrase!);
  });

  test.afterAll(async () => {
    await grantorContext.close();
    await granteeContext.close();
  });

  // ── Pre-seeded IDLE grant assertions ────────────────────────

  test("eaGrantor: pre-seeded grant is visible in emergency access page", async () => {
    const { eaGrantee } = getAuthState();
    await grantorPage.goto("/ja/dashboard/emergency-access");

    const eaPage = new EmergencyAccessPage(grantorPage);
    await expect(eaPage.grantByEmail(eaGrantee.email)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("eaGrantor: pre-seeded grant card shows IDLE status", async () => {
    const { eaGrantee } = getAuthState();
    await grantorPage.goto("/ja/dashboard/emergency-access");

    const eaPage = new EmergencyAccessPage(grantorPage);
    const card = eaPage.grantByEmail(eaGrantee.email);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText(/Idle|IDLE|アイドル/i)).toBeVisible({
      timeout: 5_000,
    });
  });

  test("eaGrantee: pre-seeded grant from grantor is visible in Trusted by Others section", async () => {
    const { eaGrantor } = getAuthState();
    await granteePage.goto("/ja/dashboard/emergency-access");

    const eaPage = new EmergencyAccessPage(granteePage);
    await granteePage.waitForTimeout(2_000);

    const card = eaPage.grantByEmail(eaGrantor.email);
    await expect(card).toBeVisible({ timeout: 10_000 });
  });

  // ── Dynamic grant creation ────────────────────────────────────

  test("eaGrantor: navigate to /emergency-access page", async () => {
    await grantorPage.goto("/ja/dashboard/emergency-access");

    // Page heading should be visible
    await expect(
      grantorPage.locator("h1").filter({ hasText: /Emergency Access|緊急アクセス/i }),
    ).toBeVisible({ timeout: 10_000 });

    // "Add Trusted Contact" button should be present
    const eaPage = new EmergencyAccessPage(grantorPage);
    await expect(eaPage.addTrustedContactButton).toBeVisible({ timeout: 10_000 });
  });

  test("eaGrantor: create a second grant for eaGrantee", async () => {
    const { eaGrantee } = getAuthState();
    await grantorPage.goto("/ja/dashboard/emergency-access");

    const eaPage = new EmergencyAccessPage(grantorPage);
    await expect(eaPage.addTrustedContactButton).toBeVisible({ timeout: 10_000 });

    // Create a new grant with 7-day wait period
    await eaPage.createGrant(eaGrantee.email, 7);

    // After creation, a grant card should appear
    await expect(eaPage.grantByEmail(eaGrantee.email)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("eaGrantee: emergency access page loads without error", async () => {
    await granteePage.goto("/ja/dashboard/emergency-access");

    // Page heading should render
    await expect(
      granteePage.locator("h1").filter({ hasText: /Emergency Access|緊急アクセス/i }),
    ).toBeVisible({ timeout: 10_000 });

    // The page should render two sections: "Trusted Contacts" and "Trusted by Others"
    await expect(
      granteePage.getByText(/Trusted Contacts|信頼できる連絡先/i),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      granteePage.getByText(/Trusted by Others|他のユーザーから信頼/i),
    ).toBeVisible({ timeout: 5_000 });
  });
});
