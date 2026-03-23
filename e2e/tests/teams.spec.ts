import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { TeamsPage } from "../page-objects/teams.page";
import { TeamDashboardPage } from "../page-objects/team-dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";

// Name for a newly created team during the test run
const TEAM_NAME = `E2E Team ${Date.now()}`;
const TEAM_SLUG = `e2e-team-${Date.now()}`;
const TEAM_ENTRY = {
  title: `Team Entry ${Date.now()}`,
  username: "team-user@example.com",
  password: "TeamSecret!456",
};

// Name of the team pre-seeded in global-setup
const PRE_SEEDED_TEAM_NAME = "E2E Pre-seeded Team";

test.describe.serial("Teams", () => {
  let ownerContext: BrowserContext;
  let memberContext: BrowserContext;
  let ownerPage: Page;
  let memberPage: Page;

  test.beforeAll(async ({ browser }) => {
    const { teamOwner, teamMember } = getAuthState();

    ownerContext = await browser.newContext();
    await injectSession(ownerContext, teamOwner.sessionToken);
    ownerPage = await ownerContext.newPage();
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
    await ownerPage.goto("/ja/dashboard/teams");

    const teamsPage = new TeamsPage(ownerPage);
    await expect(ownerPage.locator("a.rounded-xl").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(teamsPage.teamByName(PRE_SEEDED_TEAM_NAME)).toBeVisible();
  });

  test("teamMember: pre-seeded team is visible without invitation flow", async () => {
    await memberPage.goto("/ja/dashboard/teams");

    const teamsPage = new TeamsPage(memberPage);
    // teamMember was seeded directly as MEMBER in global-setup — no invitation needed
    await expect(
      memberPage.locator("a.rounded-xl").first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(teamsPage.teamByName(PRE_SEEDED_TEAM_NAME)).toBeVisible();
  });

  // ── Dynamic team creation ────────────────────────────────────

  test("teamOwner: navigate to /teams and create a new team", async () => {
    await ownerPage.goto("/ja/dashboard/teams");

    const teamsPage = new TeamsPage(ownerPage);
    await expect(teamsPage.createTeamButton).toBeVisible({ timeout: 10_000 });

    await teamsPage.createTeam(TEAM_NAME, TEAM_SLUG);

    // After creation the dialog should close and the new team should appear in the list
    await expect(teamsPage.teamByName(TEAM_NAME)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("teamOwner: team appears in teams list", async () => {
    await ownerPage.goto("/ja/dashboard/teams");

    const teamsPage = new TeamsPage(ownerPage);
    await expect(ownerPage.locator("a.rounded-xl").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(teamsPage.teamByName(TEAM_NAME)).toBeVisible();
  });

  test("teamOwner: create a password entry in team vault", async () => {
    // Navigate into the newly created team
    await ownerPage.goto("/ja/dashboard/teams");
    const teamsPage = new TeamsPage(ownerPage);
    await expect(teamsPage.teamByName(TEAM_NAME)).toBeVisible({
      timeout: 10_000,
    });
    await teamsPage.openTeam(TEAM_NAME);

    // On the team page, create a new password entry
    const teamDashboard = new TeamDashboardPage(ownerPage);
    await expect(teamDashboard.newItemButton).toBeVisible({ timeout: 10_000 });
    await teamDashboard.createNewPassword();

    const entryPage = new PasswordEntryPage(ownerPage);
    await entryPage.fill(TEAM_ENTRY);
    await entryPage.save();

    // Verify the entry appears in the team vault
    await expect(ownerPage.getByText(TEAM_ENTRY.title)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("teamOwner: invite teamMember via email", async () => {
    const { teamMember } = getAuthState();

    // Navigate to team settings page
    await ownerPage.goto("/ja/dashboard/teams");
    const teamsPage = new TeamsPage(ownerPage);
    await expect(teamsPage.teamByName(TEAM_NAME)).toBeVisible({
      timeout: 10_000,
    });
    await teamsPage.openTeam(TEAM_NAME);

    // Go to settings
    const teamDashboard = new TeamDashboardPage(ownerPage);
    await ownerPage
      .getByRole("link", { name: /Settings|設定/i })
      .first()
      .click();

    await teamDashboard.inviteMember(teamMember.email);

    // Invitation sent toast should appear
    await expect(
      ownerPage.getByText(/Invitation sent|invited|招待/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("teamMember: teams page renders without errors", async () => {
    // Navigate to the teams list to verify the page renders for the member role.
    await memberPage.goto("/ja/dashboard/teams");
    await memberPage.waitForLoadState("domcontentloaded");

    await expect(
      memberPage.locator("h1").filter({ hasText: /Teams|チーム/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
