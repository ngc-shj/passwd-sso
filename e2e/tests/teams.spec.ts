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
    // Grant clipboard-write so invitation URL copy succeeds inside handleInvite
    await ownerContext.grantPermissions(["clipboard-read", "clipboard-write"]);
    await injectSession(ownerContext, teamOwner.sessionToken);
    ownerPage = await ownerContext.newPage();
    // Navigate directly to the teams page so the vault unlock and the target
    // page share the same React tree — no full reload needed after unlock.
    // Unlock vault on dashboard first (admin pages don't have VaultGate)
    await ownerPage.goto("/ja/dashboard");
    const ownerLock = new VaultLockPage(ownerPage);
    await expect(ownerLock.passphraseInput).toBeVisible({ timeout: 10_000 });
    await ownerLock.unlockAndWait(teamOwner.passphrase!);
    await ownerPage.goto("/ja/admin/tenant/teams");
    await ownerPage.waitForLoadState("networkidle");

    memberContext = await browser.newContext();
    await injectSession(memberContext, teamMember.sessionToken);
    memberPage = await memberContext.newPage();
    await memberPage.goto("/ja/dashboard");
    const memberLock = new VaultLockPage(memberPage);
    await expect(memberLock.passphraseInput).toBeVisible({ timeout: 10_000 });
    await memberLock.unlockAndWait(teamMember.passphrase!);
    await memberPage.goto("/ja/admin/tenant/teams");
    await memberPage.waitForLoadState("networkidle");
  });

  test.afterAll(async () => {
    await ownerContext.close();
    await memberContext.close();
  });

  // ── Pre-seeded team assertions ───────────────────────────────

  test("teamOwner: pre-seeded team is visible in teams list", async () => {
    // afterAll unlocked the vault directly on /ja/dashboard/teams — we are already here.
    const teamsPage = new TeamsPage(ownerPage);
    await expect(ownerPage.locator("a.rounded-xl").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(teamsPage.teamByName(PRE_SEEDED_TEAM_NAME)).toBeVisible();
  });

  test("teamMember: pre-seeded team is visible in vault selector", async () => {
    // Member can see their team in the vault selector on the dashboard
    await memberPage.goto("/ja/dashboard");
    await memberPage.waitForLoadState("networkidle");
    // The vault selector should list the pre-seeded team
    await expect(
      memberPage.getByText(PRE_SEEDED_TEAM_NAME)
    ).toBeVisible({ timeout: 10_000 });
  });

  // ── Dynamic team creation ────────────────────────────────────

  test("teamOwner: navigate to /teams and create a new team", async () => {
    // Navigate back to teams list via sidebar click (client-side, vault stays unlocked).
    await ownerPage.goto("/ja/admin/tenant/teams");
    await ownerPage.waitForLoadState("networkidle");

    const teamsPage = new TeamsPage(ownerPage);
    await expect(teamsPage.createTeamButton).toBeVisible({ timeout: 10_000 });

    await teamsPage.createTeam(TEAM_NAME, TEAM_SLUG);

    // After creation the dialog should close and the new team should appear in the list
    await expect(teamsPage.teamByName(TEAM_NAME)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("teamOwner: team appears in teams list", async () => {
    // Navigate back to teams list via sidebar click.
    await ownerPage.goto("/ja/admin/tenant/teams");
    await ownerPage.waitForLoadState("networkidle");

    const teamsPage = new TeamsPage(ownerPage);
    await expect(ownerPage.locator("a.rounded-xl").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(teamsPage.teamByName(TEAM_NAME)).toBeVisible();
  });

  test("teamOwner: create a password entry in team vault", async () => {
    // Navigate back to teams list via sidebar click.
    await ownerPage.goto("/ja/admin/tenant/teams");
    await ownerPage.waitForLoadState("networkidle");

    const teamsPage = new TeamsPage(ownerPage);
    await expect(teamsPage.teamByName(TEAM_NAME)).toBeVisible({
      timeout: 10_000,
    });
    // openTeamVault: clicks card (→ settings), then sidebar Passwords link (→ team vault)
    await teamsPage.openTeamVault(TEAM_NAME);

    // On the team vault page, create a new password entry
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

    // After test 5 we are on the team vault page (/teams/{id}).
    // The sidebar "Team Settings" link (in team context) goes to /admin/teams/{id}/general
    // — navigate there via client-side click to preserve vault state.
    const teamSettingsLink = ownerPage.getByRole("link", {
      name: /Team Settings|チーム設定/i,
    });
    await teamSettingsLink.click();
    await ownerPage.waitForURL(/\/admin\/teams\/[^/]+\/general/, { timeout: 10_000 });

    const teamDashboard = new TeamDashboardPage(ownerPage);
    await teamDashboard.inviteMember(teamMember.email);

    // Invitation created — toast shows invitedWithLink or invited
    // t("invitedWithLink") = "Invitation sent. Invite URL copied to clipboard." / "招待を送信しました。..."
    // t("invited") = "Invitation sent" / "招待を送信しました"
    await expect(
      ownerPage.getByText(/Invitation sent|招待を送信しました/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("teamMember: teams page renders without errors", async () => {
    // Navigate to the teams list to stay in the React tree.
    await memberPage.goto("/ja/admin/tenant/teams");
    await memberPage.waitForLoadState("networkidle");

    await expect(
      memberPage.locator("h1").filter({ hasText: /Teams|チーム/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
