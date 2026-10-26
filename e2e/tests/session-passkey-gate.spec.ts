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
import { MS_PER_DAY } from "@/lib/constants/time";

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
const DASHBOARD = "/ja/dashboard";
const PASSKEY_PAGE = "/ja/dashboard/settings/auth/passkey";

const SCREEN_TITLE = /続行するにはパスキーを登録してください|Register a passkey to continue/;
const REGISTER_BUTTON = /新しいパスキーを登録|Register new passkey/;
const SIGN_IN_AGAIN_DIALOG = /Sign in again to continue|再サインインが必要です/i;
const REBOOTSTRAP_BUTTON = /^有効化$|^Enable$/;

const CREDENTIALS_FETCH_ERROR = /パスキーの読み込みに失敗しました|Failed to load passkeys/;

const pathnameOf = (r: Response) => new URL(r.url()).pathname;
const callKey = (r: Response) => `${r.request().method()} ${pathnameOf(r)}`;
const isFetch = (r: Response) => ["fetch", "xhr"].includes(r.request().resourceType());

// What the minimal screen fetches on mount: the session provider's session
// read, and the passkey card's credential list and auth-provider probe.
const SCREEN_MOUNT_CALLS = [
  "GET /api/auth/session",
  "GET /api/webauthn/credentials",
  "GET /api/user/auth-provider",
] as const;

function waitForMountCalls(page: Page): Promise<Response[]> {
  return Promise.all(
    SCREEN_MOUNT_CALLS.map((key) =>
      page.waitForResponse((r) => isFetch(r) && callKey(r) === key),
    ),
  );
}

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

  test("the registration screen issues no 403 and never reloads", async () => {
    // Each /api/* body is read as its response arrives: a reload evicts the
    // bodies of the page it replaces, so a read deferred to the end would
    // come back empty for exactly the refusal that caused the reload.
    const UNREADABLE = "<unreadable>";
    const apiResponses: Promise<{ url: string; status: number; body: string }>[] = [];
    const observedCalls = new Set<string>();
    const vaultStatusRequests: string[] = [];
    let screenUp = false;
    let navigationsWhileScreenUp = 0;
    page.on("response", (r) => {
      if (!pathnameOf(r).startsWith("/api/")) return;
      if (isFetch(r)) observedCalls.add(callKey(r));
      const url = r.url();
      const status = r.status();
      apiResponses.push(
        r.text().then(
          (body) => ({ url, status, body }),
          () => ({ url, status, body: UNREADABLE }),
        ),
      );
    });
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/vault/status") vaultStatusRequests.push(r.url());
    });
    page.on("framenavigated", (frame) => {
      if (screenUp && frame === page.mainFrame()) navigationsWhileScreenUp += 1;
    });

    // The observation bound is the screen's own mount calls, each awaited by
    // name, rather than an idle network.
    const mountCalls = waitForMountCalls(page);
    await page.goto(DASHBOARD);

    // Positive control: every mount call answered 200 and the card rendered.
    for (const res of await mountCalls) {
      expect(res.status(), callKey(res)).toBe(200);
    }
    await expect(page.getByRole("heading", { name: SCREEN_TITLE })).toBeVisible();
    await expect(page.getByRole("button", { name: REGISTER_BUTTON })).toBeVisible();
    screenUp = true;

    // Nothing beyond the named set was fetched while the screen mounted.
    expect([...observedCalls].sort()).toEqual([...SCREEN_MOUNT_CALLS].sort());
    const responses = await Promise.all(apiResponses);
    // Any 403 fails, an unreadable one included: its body cannot show it was
    // not PASSKEY_REQUIRED, and nothing the screen calls is refused at all.
    expect(responses.filter((r) => r.status === 403)).toEqual([]);
    expect(navigationsWhileScreenUp, "the screen reloaded the tab").toBe(0);
    expect(vaultStatusRequests).toEqual([]);
  });

  test("a PASSKEY_REQUIRED refusal seen on the mounted screen does not reload the tab", async () => {
    // The un-intercepted cell above is the allow side; here one screen call is
    // refused, so fetchApi's PASSKEY_REQUIRED reaction runs and only the
    // screen-mounted flag keeps it from reloading. The credential list is the
    // call refused: the card fetches it once on mount (no retry), and its
    // failure toast shows only after fetchApi returned, i.e. after the
    // reaction finished — that toast bounds the observation.
    let refusalServed = false;
    let navigationsAfterRefusal = 0;
    page.on("framenavigated", (frame) => {
      if (refusalServed && frame === page.mainFrame()) navigationsAfterRefusal += 1;
    });
    page.on("request", (r) => {
      if (refusalServed && r.isNavigationRequest() && r.frame() === page.mainFrame()) {
        navigationsAfterRefusal += 1;
      }
    });
    await page.route(
      (url) => url.pathname === "/api/webauthn/credentials",
      async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        refusalServed = true;
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "PASSKEY_REQUIRED" }),
        });
      },
      { times: 1 },
    );

    const refused = page.waitForResponse(
      (r) => pathnameOf(r) === "/api/webauthn/credentials" && r.request().method() === "GET",
    );
    await page.goto(DASHBOARD);
    expect((await refused).status()).toBe(403);
    const urlAtRefusal = page.url();

    await expect(page.getByText(CREDENTIALS_FETCH_ERROR)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: SCREEN_TITLE })).toBeVisible();
    expect(navigationsAfterRefusal, "the refusal reloaded the tab").toBe(0);
    expect(page.url()).toBe(urlAtRefusal);
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
    let verified = false;
    const verify = page
      .waitForResponse((r) => pathnameOf(r) === "/api/webauthn/register/verify")
      .then((r) => {
        verified = true;
        return r;
      });
    // The reload the screen issues once registration succeeds: a main-frame
    // navigation that starts after the verify response. The URL alone cannot
    // show it — the tab is on the passkey page before the reload as well.
    const reloaded = page.waitForEvent("framenavigated", {
      predicate: (frame) => verified && frame === page.mainFrame(),
      timeout: 20_000,
    });
    await register.click();
    const optionsBody = await (await options).json();
    expect(optionsBody.options?.rp?.id, "the server's WEBAUTHN_RP_ID must be the E2E origin's host").toBe(
      E2E_WEBAUTHN_RP_ID,
    );
    expect(
      optionsBody.prfSupported,
      "the E2E server needs WEBAUTHN_PRF_SECRET (e2e/helpers/webauthn.ts) for registration to request PRF",
    ).toBe(true);
    expect((await verify).status()).toBe(201);

    // The minimal screen reloads the page it was shown on (the page proxy sent
    // the blocked navigation to the passkey settings page) into the dashboard,
    // whose vault is locked.
    await reloaded;
    await expect(page).toHaveURL(new RegExp(`${PASSKEY_PAGE}$`));
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
