import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page, type Response } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import {
  E2E_PASSKEY_TENANT,
  TEST_PASSPHRASE,
  deleteUserWebauthnCredentials,
  makeSessionStale,
  passkeyBlockedOutboxPaths,
  seedTenant,
  setTenantPasskeyRequirement,
} from "../helpers/db";
import { seedVaultReadyUser } from "../helpers/vault-user";
import { addPrfVirtualAuthenticator, E2E_WEBAUTHN_RP_ID } from "../helpers/webauthn";
import { VaultLockPage } from "../page-objects/vault-lock.page";

/**
 * The session passkey gate end to end (plan session-api-passkey-gate, E2E
 * obligations; review T7/T8/T21–T23, T-R3-4, T-R3-5, T-R3-10).
 *
 * A dedicated tenant has the passkey requirement past its grace period, and
 * every attempt — a retry included — seeds a user of its own in it, so the
 * gate's audit dedup (one row per user and blockedPath per window) can never
 * suppress the row a retry looks for.
 */

const GRACE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DASHBOARD = "/ja/dashboard";
const PASSKEY_PAGE = "/ja/dashboard/settings/auth/passkey";

const SCREEN_TITLE = /続行するにはパスキーを登録してください|Register a passkey to continue/;
const REGISTER_BUTTON = /新しいパスキーを登録|Register new passkey/;
const SIGN_IN_AGAIN_DIALOG = /Sign in again to continue|再サインインが必要です/i;
const REBOOTSTRAP_BUTTON = /^有効化$|^Enable$/;

const pathnameOf = (r: Response) => new URL(r.url()).pathname;

test.describe("Session passkey gate", () => {
  let context: BrowserContext;
  let page: Page;
  let user: { id: string; email: string; name: string };
  let sessionToken: string;

  test.beforeAll(async () => {
    await seedTenant(E2E_PASSKEY_TENANT);
    await setTenantPasskeyRequirement(E2E_PASSKEY_TENANT.id, {
      enabledAt: new Date(Date.now() - (GRACE_DAYS + 1) * MS_PER_DAY),
      graceDays: GRACE_DAYS,
    });
  });

  test.beforeEach(async ({ browser }) => {
    const pepper = process.env.VERIFIER_PEPPER_KEY ?? "";
    expect(pepper, "VERIFIER_PEPPER_KEY is required to seed a vault user").not.toBe("");
    const suffix = randomUUID();
    user = {
      id: suffix,
      email: `e2e-passkey-gate-${suffix.slice(0, 8)}@test.local`,
      name: "E2E Passkey Gate",
    };
    ({ sessionToken } = await seedVaultReadyUser(user, pepper, E2E_PASSKEY_TENANT.id));
    await deleteUserWebauthnCredentials(user.id);

    context = await browser.newContext();
    await injectSession(context, sessionToken);
    page = await context.newPage();
  });

  test.afterEach(async () => {
    await context.close();
  });

  test("an API call from the blocked session is refused with PASSKEY_REQUIRED and audited", async () => {
    expect(await passkeyBlockedOutboxPaths(user.id)).toEqual([]);

    const res = await context.request.get("/api/passwords");
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe("PASSKEY_REQUIRED");

    // The page proxy writes the same action for page navigations; only the
    // API gate's row carries this blockedPath.
    await expect
      .poll(async () => (await passkeyBlockedOutboxPaths(user.id)).filter((p) => p === "GET /api/passwords"), {
        timeout: 10_000,
      })
      .toEqual(["GET /api/passwords"]);
  });

  test("the registration screen issues no PASSKEY_REQUIRED and never asks for the vault status", async () => {
    const refused: Response[] = [];
    const vaultStatusRequests: string[] = [];
    page.on("response", (r) => {
      if (r.status() === 403) refused.push(r);
    });
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/vault/status") vaultStatusRequests.push(r.url());
    });

    const credentialsLoaded = page.waitForResponse(
      (r) => pathnameOf(r) === "/api/webauthn/credentials" && r.request().method() === "GET",
    );
    await page.goto(DASHBOARD);

    // Positive control: the card's Tier B call answered and the card rendered.
    expect((await credentialsLoaded).status()).toBe(200);
    await expect(page.getByRole("heading", { name: SCREEN_TITLE })).toBeVisible();
    await expect(page.getByRole("button", { name: REGISTER_BUTTON })).toBeVisible();
    await page.waitForLoadState("networkidle");

    const passkeyRefusals: string[] = [];
    for (const r of refused) {
      const body = await r.json().catch(() => null);
      if (body?.error === "PASSKEY_REQUIRED") passkeyRefusals.push(r.url());
    }
    expect(passkeyRefusals).toEqual([]);
    expect(vaultStatusRequests).toEqual([]);
  });

  test("a stale sign-in is asked to sign in again before registering", async () => {
    await makeSessionStale(sessionToken);
    await page.goto(DASHBOARD);
    const register = page.getByRole("button", { name: REGISTER_BUTTON });
    await expect(register).toBeVisible({ timeout: 20_000 });

    const options = page.waitForResponse((r) => pathnameOf(r) === "/api/webauthn/register/options");
    await register.click();
    const optionsRes = await options;
    expect(optionsRes.status()).toBe(403);
    expect((await optionsRes.json()).error).toBe("SESSION_STEP_UP_REQUIRED");
    await expect(page.getByRole("alertdialog", { name: SIGN_IN_AGAIN_DIALOG })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("registers with a fresh sign-in while locked, then the API allows it and PRF auto-unlock is offered", async () => {
    await addPrfVirtualAuthenticator(page);
    await page.goto(DASHBOARD);
    const register = page.getByRole("button", { name: REGISTER_BUTTON });
    await expect(register).toBeVisible({ timeout: 20_000 });

    const options = page.waitForResponse((r) => pathnameOf(r) === "/api/webauthn/register/options");
    const verify = page.waitForResponse((r) => pathnameOf(r) === "/api/webauthn/register/verify");
    await register.click();
    const optionsBody = await (await options).json();
    expect(optionsBody.options?.rp?.id, "the server's WEBAUTHN_RP_ID must be the E2E origin's host").toBe(
      E2E_WEBAUTHN_RP_ID,
    );
    expect((await verify).status()).toBe(201);

    // The minimal screen reloads the page it was shown on (the page proxy sent
    // the blocked navigation to the passkey settings page) into the dashboard,
    // whose vault is locked.
    await expect(page).toHaveURL(new RegExp(`${PASSKEY_PAGE}$`), { timeout: 20_000 });
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 20_000 });

    const passwords = await context.request.get("/api/passwords");
    expect(passwords.status()).toBe(200);

    // Unlocked in place (a navigation would lock the vault again): the new
    // credential, registered without a PRF wrap, is offered auto-unlock.
    await lockPage.unlockAndWait(TEST_PASSPHRASE);
    await expect(page.getByRole("button", { name: REBOOTSTRAP_BUTTON })).toBeEnabled({ timeout: 20_000 });
  });
});
