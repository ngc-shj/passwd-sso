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

  test.beforeAll(async ({ browser }) => {
    const { teamOwner, teamMember } = getAuthState();

    // Owner: navigate to admin teams page (no vault unlock needed for list view)
    ownerContext = await browser.newContext();
    await ownerContext.grantPermissions(["clipboard-read", "clipboard-write"]);
    await injectSession(ownerContext, teamOwner.sessionToken);
    ownerPage = await ownerContext.newPage();
    await ownerPage.goto("/ja/admin/tenant/teams");

    // Member: navigate to dashboard and unlock vault
    memberContext = await browser.newContext();
    await injectSession(memberContext, teamMember.sessionToken);
    memberPage = await memberContext.newPage();
    await memberPage.goto("/ja/dashboard");
    const memberLock = new VaultLockPage(memberPage);
    await expect(memberLock.passphraseInput).toBeVisible({ timeout: 15_000 });
    await memberLock.unlockAndWait(teamMember.passphrase!);
  });

  test.afterAll(async () => {
    await ownerContext?.close();
    await memberContext?.close();
  });

  // ── Pre-seeded team assertions ───────────────────────────────

  test("teamOwner: pre-seeded team is visible in teams list", async () => {
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
    const { teamOwner } = getAuthState();
    const teamsPage = new TeamsPage(ownerPage);
    await expect(teamsPage.createTeamButton).toBeVisible({ timeout: 10_000 });

    // Open dialog — vault is locked, so inline unlock form appears
    await teamsPage.createTeamButton.click();
    await ownerPage.locator("[role='dialog']").waitFor({ timeout: 5_000 });

    // Unlock vault within the dialog
    const passphraseInput = ownerPage.locator("#unlock-passphrase");
    await expect(passphraseInput).toBeVisible({ timeout: 5_000 });
    await passphraseInput.fill(teamOwner.passphrase!);
    await ownerPage
      .locator("[role='dialog']")
      .getByRole("button", { name: /^Unlock$|^解錠$|^アンロック$/i })
      .click();

    // Wait for unlock to complete and create form to appear
    await expect(ownerPage.locator("#team-name")).toBeVisible({
      timeout: 20_000,
    });

    // Fill in team details and submit
    await teamsPage.teamNameInput.fill(TEAM_NAME);
    await teamsPage.teamSlugInput.fill(TEAM_SLUG);
    await teamsPage.createButton.click();
    await ownerPage.locator("[role='dialog']").waitFor({
      state: "hidden",
      timeout: 10_000,
    });

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
