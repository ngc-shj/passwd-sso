import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { EmergencyAccessPage } from "../page-objects/emergency-access.page";
import { SidebarNavPage } from "../page-objects/sidebar-nav.page";

// Unique email for dynamic grant creation (avoids duplicate-grant conflict with pre-seeded grant)
const NEW_GRANTEE_EMAIL = `e2e-new-grantee-${Date.now()}@test.local`;

test.describe.serial("Emergency Access", () => {
  let grantorContext: BrowserContext;
  let granteeContext: BrowserContext;
  let grantorPage: Page;
  let granteePage: Page;

  test.beforeAll(async ({ browser }) => {
    const { eaGrantor, eaGrantee } = getAuthState();

    grantorContext = await browser.newContext();
    // Grant clipboard-write so the invite URL copy after grant creation succeeds
    await grantorContext.grantPermissions(["clipboard-read", "clipboard-write"]);
    await injectSession(grantorContext, eaGrantor.sessionToken);
    grantorPage = await grantorContext.newPage();
    // Navigate directly to the emergency-access page so the vault unlock and
    // the target page share the same React tree — no full reload needed after unlock.
    await grantorPage.goto("/ja/dashboard/emergency-access");
    const grantorLock = new VaultLockPage(grantorPage);
    await expect(grantorLock.passphraseInput).toBeVisible({ timeout: 10_000 });
    await grantorLock.unlockAndWait(eaGrantor.passphrase!);

    granteeContext = await browser.newContext();
    await injectSession(granteeContext, eaGrantee.sessionToken);
    granteePage = await granteeContext.newPage();
    await granteePage.goto("/ja/dashboard/emergency-access");
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
    // beforeAll already unlocked on /ja/dashboard/emergency-access — we are already here.
    // GrantCard shows the grantee's display name (name || email), so match by name.

    const eaPage = new EmergencyAccessPage(grantorPage);
    await expect(eaPage.grantByUser(eaGrantee.name)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("eaGrantor: pre-seeded grant card shows IDLE status", async () => {
    const { eaGrantee } = getAuthState();
    // Navigate back via sidebar click to preserve vault state.
    const sidebar = new SidebarNavPage(grantorPage);
    await sidebar.navigateTo("emergencyAccess");

    const eaPage = new EmergencyAccessPage(grantorPage);
    // GrantCard shows the IDLE status as "準備完了" (ja) — match by name then check status
    const card = eaPage.grantByUser(eaGrantee.name);
    await expect(card).toBeVisible({ timeout: 10_000 });
    // IDLE status: "Ready" (en) / "準備完了" (ja)
    await expect(card.getByText(/Ready|準備完了|Idle|IDLE|アイドル/i).first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test("eaGrantee: pre-seeded grant from grantor is visible in Trusted by Others section", async () => {
    const { eaGrantor } = getAuthState();
    // granteePage was also unlocked directly on /ja/dashboard/emergency-access.

    const eaPage = new EmergencyAccessPage(granteePage);
    // Wait for the section to load before asserting the card
    await expect(
      granteePage.getByText(/Trusted by Others|他のユーザーから信頼|委任を受けた保管庫/i),
    ).toBeVisible({ timeout: 10_000 });

    // GrantCard shows the grantor's display name
    const card = eaPage.grantByUser(eaGrantor.name);
    await expect(card).toBeVisible({ timeout: 10_000 });
  });

  // ── Dynamic grant creation ────────────────────────────────────

  test("eaGrantor: navigate to /emergency-access page", async () => {
    const sidebar = new SidebarNavPage(grantorPage);
    await sidebar.navigateTo("emergencyAccess");

    // Page heading should be visible
    await expect(
      grantorPage.locator("h1").filter({ hasText: /Emergency Access|緊急アクセス/i }),
    ).toBeVisible({ timeout: 10_000 });

    // "Add Trusted Contact" button should be present
    const eaPage = new EmergencyAccessPage(grantorPage);
    await expect(eaPage.addTrustedContactButton).toBeVisible({ timeout: 10_000 });
  });

  test("eaGrantor: create a new grant via Add Trusted Contact dialog", async () => {
    const sidebar = new SidebarNavPage(grantorPage);
    await sidebar.navigateTo("emergencyAccess");

    const eaPage = new EmergencyAccessPage(grantorPage);
    await expect(eaPage.addTrustedContactButton).toBeVisible({ timeout: 10_000 });

    // Create a grant with a unique email to avoid duplicate-grant conflict
    await eaPage.createGrant(NEW_GRANTEE_EMAIL, 7);

    // After creation, a grant card for the new grantee should appear
    // Use grantByUser() to avoid strict mode violations from nested section container cards
    await expect(eaPage.grantByUser(NEW_GRANTEE_EMAIL)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("eaGrantee: emergency access page loads without error", async () => {
    const sidebar = new SidebarNavPage(granteePage);
    await sidebar.navigateTo("emergencyAccess");

    // Page heading should render
    await expect(
      granteePage.locator("h1").filter({ hasText: /Emergency Access|緊急アクセス/i }),
    ).toBeVisible({ timeout: 10_000 });

    // The page should render two sections: "Trusted Contacts" and "Trusted by Others"
    await expect(
      granteePage.locator("[data-slot='card-title']").filter({ hasText: /Trusted Contacts|信頼(できる|する)連絡先/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      granteePage.locator("[data-slot='card-title']").filter({ hasText: /Trusted by Others|他のユーザーから信頼|委任を受けた保管庫/i }),
    ).toBeVisible({ timeout: 5_000 });
  });
});
