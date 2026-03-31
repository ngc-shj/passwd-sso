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

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(60_000);
    const { teamOwner, teamMember } = getAuthState();

    ownerContext = await browser.newContext();
    await ownerContext.grantPermissions(["clipboard-read", "clipboard-write"]);
    await injectSession(ownerContext, teamOwner.sessionToken);
    ownerPage = await ownerContext.newPage();
    // Navigate to admin teams page — VaultGate will show lock screen
    await ownerPage.goto("/ja/admin/tenant/teams");
    const ownerLock = new VaultLockPage(ownerPage);
    await expect(ownerLock.passphraseInput).toBeVisible({ timeout: 15_000 });
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
    // ownerPage is on admin/tenant/teams after beforeAll unlock
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

  test("teamOwner: create a new team", async () => {
    // ownerPage is still on admin/tenant/teams — no navigation needed
    const teamsPage = new TeamsPage(ownerPage);
    await expect(teamsPage.createTeamButton).toBeVisible({ timeout: 10_000 });

    await teamsPage.createTeam(TEAM_NAME, TEAM_SLUG);

    await expect(teamsPage.teamByName(TEAM_NAME)).toBeVisible({
      timeout: 15_000,
    });
  });

  // ── Team settings navigation ─────────────────────────────────

  test("teamOwner: can navigate to team settings", async () => {
    const teamsPage = new TeamsPage(ownerPage);
    await teamsPage.openTeam(TEAM_NAME);

    await ownerPage.waitForURL(/\/admin\/teams\/[^/]+\/general/, {
      timeout: 10_000,
    });
  });
});
