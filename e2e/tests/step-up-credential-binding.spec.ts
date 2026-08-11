import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import {
  seedWebauthnCredential,
  deleteWebauthnCredential,
  bindSessionToWebauthnCredential,
} from "../helpers/db";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";
import { SidebarNavPage } from "../page-objects/sidebar-nav.page";
import { TrashPage } from "../page-objects/trash.page";

/**
 * Which reauth dialog a stale, provider='webauthn' session opens on a gated
 * action — the dialog-selection half of the bind-stepup-to-session-credential
 * fix (contracts C3/C4/C5). Needs no signed WebAuthn assertion, only a seeded
 * `sessions` row: the ceremony half of the fix is deferred to a future
 * virtual-authenticator harness (plan VE1), but which dialog opens is decided
 * entirely server-side by `canRecoverSessionWithPasskey` before any ceremony
 * would run, and that is what this spec drives end-to-end.
 *
 * Uses a DEDICATED user (TEST_USERS.stepUpCredentialBinding), not the shared
 * `vaultReady` user step-up-stale-window.spec.ts uses: this spec puts the
 * session's provider/auth_credential_id into webauthn states, and
 * `vaultReady` is shared by ~25 other specs under workers:1/fullyParallel:false
 * — leaving it in a bound webauthn state would make step-up-stale-window.spec.ts
 * (whose own assertion is deliberately agnostic to which dialog opens) render
 * the ceremony dialog and still pass, for the wrong reason.
 */
test.describe("Step-up reauth dialog selection by credential binding", () => {
  let context: BrowserContext;
  let page: Page;

  const ts = Date.now();
  const entryTitle = `E2E CredentialBinding ${ts}`;
  const credentialId = `e2e-cred-${ts}`;

  test.beforeAll(async ({ browser }) => {
    const { stepUpCredentialBinding } = getAuthState();
    context = await browser.newContext();
    await injectSession(context, stepUpCredentialBinding.sessionToken);
    page = await context.newPage();

    await page.goto("/ja/dashboard");
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 20_000 });
    await lockPage.unlockAndWait(stepUpCredentialBinding.passphrase!);

    // One entry, moved to trash, so "Empty Trash" (a step-up-gated mutation)
    // has something to purge — same gated action step-up-stale-window.spec.ts
    // uses, and reused across both dialog-selection attempts below since
    // neither attempt is expected to actually empty the trash.
    const dashboard = new DashboardPage(page);
    const entryPage = new PasswordEntryPage(page);
    await dashboard.createNewPassword();
    await entryPage.fill({ title: entryTitle, password: "E2ECredBindP@ss1" });
    await entryPage.save();
    await expect(dashboard.entryByTitle(entryTitle)).toBeVisible({ timeout: 10_000 });
    await entryPage.deleteEntry(entryTitle);

    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("trash");
    await expect(page.getByText(entryTitle)).toBeVisible({ timeout: 10_000 });
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("a session with no live binding opens the sign-in-again dialog, never the ceremony dialog", async () => {
    const { stepUpCredentialBinding } = getAuthState();
    const trashPage = new TrashPage(page);

    // Bind, then delete the bound row — the FK (ON DELETE SET NULL, I2)
    // leaves the session with provider='webauthn' and auth_credential_id
    // NULL, exactly the state a real "sign in with key A, then delete key A"
    // sequence produces (FR4).
    const credentialRowId = await seedWebauthnCredential(
      stepUpCredentialBinding.id,
      credentialId,
    );
    await bindSessionToWebauthnCredential(stepUpCredentialBinding.sessionToken, credentialRowId);
    await deleteWebauthnCredential(credentialRowId);

    await trashPage.emptyTrashButton.click();
    await page.locator("[role='dialog']").waitFor({ timeout: 5_000 });
    await trashPage.emptyTrashConfirmButton.click();

    const signInAgainDialog = page.getByRole("alertdialog", {
      name: /Sign in again to continue|再サインインが必要です/i,
    });
    const ceremonyDialog = page.getByRole("alertdialog", {
      name: /Passkey verification required|本人確認が必要です/i,
    });
    await expect(signInAgainDialog).toBeVisible({ timeout: 10_000 });
    await expect(ceremonyDialog).not.toBeVisible();

    // The purge was blocked — the entry is still in trash for the next case.
    await expect(page.getByText(entryTitle)).toBeVisible();

    await signInAgainDialog.getByRole("button", { name: /Cancel|キャンセル/i }).click();
    await expect(signInAgainDialog).not.toBeVisible();
  });

  test("a session with a live binding opens the passkey ceremony dialog", async () => {
    const { stepUpCredentialBinding } = getAuthState();
    const trashPage = new TrashPage(page);

    const credentialRowId = await seedWebauthnCredential(
      stepUpCredentialBinding.id,
      `${credentialId}-live`,
    );
    await bindSessionToWebauthnCredential(stepUpCredentialBinding.sessionToken, credentialRowId);

    await trashPage.emptyTrashButton.click();
    await page.locator("[role='dialog']").waitFor({ timeout: 5_000 });
    await trashPage.emptyTrashConfirmButton.click();

    const ceremonyDialog = page.getByRole("alertdialog", {
      name: /Passkey verification required|本人確認が必要です/i,
    });
    const signInAgainDialog = page.getByRole("alertdialog", {
      name: /Sign in again to continue|再サインインが必要です/i,
    });
    await expect(ceremonyDialog).toBeVisible({ timeout: 10_000 });
    await expect(signInAgainDialog).not.toBeVisible();

    await expect(page.getByText(entryTitle)).toBeVisible();

    await ceremonyDialog.getByRole("button", { name: /Cancel|キャンセル/i }).click();
    await expect(ceremonyDialog).not.toBeVisible();
  });
});
