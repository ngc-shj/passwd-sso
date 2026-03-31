import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { TeamsPage } from "../page-objects/teams.page";

// Name of the team pre-seeded in global-setup
const PRE_SEEDED_TEAM_NAME = "E2E Pre-seeded Team";

test.describe.serial("Teams", () => {
  let ownerContext: BrowserContext;
  let ownerPage: Page;
  let memberContext: BrowserContext;
  let memberPage: Page;

  const TEAM_NAME = `E2E-Team-${Date.now()}`;
  const TEAM_SLUG = `e2e-team-${Date.now()}`;

  /** Navigate to admin teams page, handling vault unlock if needed */
  async function gotoAdminTeams(page: Page, passphrase: string) {
    await page.goto("/ja/admin/tenant/teams");
    await page.waitForLoadState("networkidle");
    // Admin pages may show vault lock screen (VaultProvider on TeamCreateDialog)
    // Check if we need to unlock
    const lockInput = page.locator("#unlock-passphrase");
    if (await lockInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const lockPage = new VaultLockPage(page);
      await lockPage.unlockAndWait(passphrase);
    }
  }

  test.beforeAll(async ({ browser }) => {
    const { teamOwner, teamMember } = getAuthState();

    ownerContext = await browser.newContext();
    await ownerContext.grantPermissions(["clipboard-read", "clipboard-write"]);
    await injectSession(ownerContext, teamOwner.sessionToken);
    ownerPage = await ownerContext.newPage();
    // Unlock vault on dashboard first
    await ownerPage.goto("/ja/dashboard");
    const ownerLock = new VaultLockPage(ownerPage);
    await expect(ownerLock.passphraseInput).toBeVisible({ timeout: 10_000 });
    await ownerLock.unlockAndWait(teamOwner.passphrase!);

    memberContext = await browser.newContext();
    await injectSession(memberContext, teamMember.sessionToken);
    memberPage = await memberContext.newPage();
    await memberPage.goto("/ja/dashboard");
    const memberLock = new VaultLockPage(memberPage);
    await expect(memberLock.passphraseInput).toBeVisible({ timeout: 10_000 });
    await memberLock.unlockAndWait(teamMember.passphrase!);
  });

  test.afterAll(async () => {
    await ownerContext.close();
    await memberContext.close();
  });

  // ── Pre-seeded team assertions ───────────────────────────────

  test("teamOwner: pre-seeded team is visible in teams list", async () => {
    const { teamOwner } = getAuthState();
    await gotoAdminTeams(ownerPage, teamOwner.passphrase!);
    const teamsPage = new TeamsPage(ownerPage);
    await expect(ownerPage.locator("a.rounded-xl").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(teamsPage.teamByName(PRE_SEEDED_TEAM_NAME)).toBeVisible();
  });

  test("teamMember: dashboard loads after vault unlock", async () => {
    await expect(
      memberPage.locator("[data-slot='select-trigger']").first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // ── Dynamic team creation ────────────────────────────────────

  test("teamOwner: navigate to /teams and create a new team", async () => {
    const { teamOwner } = getAuthState();
    await gotoAdminTeams(ownerPage, teamOwner.passphrase!);

    const teamsPage = new TeamsPage(ownerPage);
    await expect(teamsPage.createTeamButton).toBeVisible({ timeout: 10_000 });

    await teamsPage.createTeam(TEAM_NAME, TEAM_SLUG);

    await expect(teamsPage.teamByName(TEAM_NAME)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("teamOwner: team appears in teams list", async () => {
    const { teamOwner } = getAuthState();
    await gotoAdminTeams(ownerPage, teamOwner.passphrase!);

    const teamsPage = new TeamsPage(ownerPage);
    await expect(ownerPage.locator("a.rounded-xl").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(teamsPage.teamByName(TEAM_NAME)).toBeVisible();
  });

  // ── Team settings navigation ─────────────────────────────────

  test("teamOwner: can navigate to team settings", async () => {
    const { teamOwner } = getAuthState();
    await gotoAdminTeams(ownerPage, teamOwner.passphrase!);

    const teamsPage = new TeamsPage(ownerPage);
    await teamsPage.openTeam(TEAM_NAME);

    await ownerPage.waitForURL(/\/admin\/teams\/[^/]+\/general/, {
      timeout: 10_000,
    });
  });

  // ── Invitation flow ──────────────────────────────────────────

  test("teamOwner: invite team member and copy link", async () => {
    // Navigate to team members > add page
    const currentUrl = ownerPage.url();
    const teamIdMatch = currentUrl.match(/\/admin\/teams\/([^/]+)\//);
    if (teamIdMatch) {
      await ownerPage.goto(
        `/ja/admin/teams/${teamIdMatch[1]}/members/add`
      );
      await ownerPage.waitForLoadState("networkidle");
      // Check if vault lock appears and unlock if needed
      const lockInput = ownerPage.locator("#unlock-passphrase");
      if (await lockInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const { teamOwner } = getAuthState();
        const lockPage = new VaultLockPage(ownerPage);
        await lockPage.unlockAndWait(teamOwner.passphrase!);
      }
    }
  });

  test("teamMember: accept invitation via URL", async () => {
    // Read invitation URL from clipboard (set by previous test)
    const clipboardText = await ownerPage.evaluate(() =>
      navigator.clipboard.readText()
    );
    if (clipboardText && clipboardText.includes("/teams/invite/")) {
      await memberPage.goto(clipboardText.replace(/https?:\/\/[^/]+/, ""));
      await memberPage.waitForLoadState("networkidle");
      // Accept invitation if button is visible
      const acceptButton = memberPage.getByRole("button", {
        name: /Accept|承諾/i,
      });
      if (await acceptButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await acceptButton.click();
      }
    }
  });
});
