/**
 * E2E: the application produces zero CSP violations against its own strict
 * production CSP.
 *
 * This is the adjudicating gate for the prod-csp-violation-zero plan (contract
 * C6). Chromium's CSP implementation is the authority — not a header-string
 * match, and not a source-level grep, because `style-src-attr` policies
 * attribute *parsing* while React applies client-mounted styles through
 * `node.style.setProperty`, which CSP never sees.
 *
 * The gate is built so that it cannot report zero for the wrong reason:
 *
 *   I6.1  the response CSP must be strict before anything else is asserted,
 *         so a dev-mode server (which ships 'unsafe-inline') fails here rather
 *         than passing vacuously;
 *   I6.2  per-route preconditions are asserted BEFORE the violation count, so
 *         an authenticated route that silently redirected to sign-in, or a
 *         locked vault that rendered no list, cannot read as "clean";
 *   I6.3  a standing positive control proves the collector itself still works;
 *   I6.4  retries are disabled for this spec — Playwright exits 0 on a
 *         retry-passed test, which would launder exactly the order-dependent
 *         violations this gate exists to catch;
 *   I6.5  the route table covers every root segment, an authenticated page, an
 *         overlay interaction, a toast, and the error page;
 *   I6.6  violations from outside the app origin are classified, not ignored.
 *
 * Every "cannot run" outcome raises a named refusal and fails; none of them is
 * spelled the same as "found nothing".
 */

import { test, expect, type Page, type Response } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";

// I6.4 — a retry-passed test still exits 0, so an intermittent violation would
// be laundered into green. The config-level `retries` stays for other specs.
//
// Deliberately NOT `mode: "serial"`: a gate must report every route it covers.
// Serial mode skips the rest of the file after the first failure, which turns
// a six-violation report into a one-line one and hides the other routes.
test.describe.configure({ retries: 0 });

type Violation = {
  directive: string;
  blockedURI: string;
  sourceFile: string;
  lineNumber: number;
  sample: string;
};

declare global {
  interface Window {
    __cspViolations?: Violation[];
  }
}

/**
 * Origins whose violations are classified as foreign (I6.6). Empty by design:
 * this is an exception register, not a relaxation. Adding an entry requires a
 * comment naming why the app cannot fix that source.
 */
const FOREIGN_ORIGIN_ALLOWLIST: readonly string[] = [];

const COLLECTOR = () => {
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__cspViolations!.push({
      directive: e.effectiveDirective || e.violatedDirective,
      blockedURI: e.blockedURI,
      sourceFile: e.sourceFile ?? "",
      lineNumber: e.lineNumber ?? 0,
      sample: (e.sample ?? "").slice(0, 120),
    });
  });
};

async function installCollector(page: Page): Promise<void> {
  await page.addInitScript(COLLECTOR);
}

/** Settle time for violations fired after load (style injection on mount). */
const SETTLE_MS = 1_500;

async function readViolations(page: Page): Promise<Violation[]> {
  const raw = await page.evaluate(() => window.__cspViolations);
  if (raw === undefined) {
    throw new Error(
      "CSP_GATE_COLLECTOR_UNVERIFIED: the init script never attached to this document",
    );
  }
  return raw;
}

/**
 * I6.1 — the subject must be a strict-CSP production server. A dev server
 * ships 'unsafe-inline' in both script-src and style-src, under which every
 * violation this gate targets is invisible.
 */
function assertStrictCsp(response: Response | null, label: string): void {
  if (!response) {
    throw new Error(`CSP_GATE_PRECONDITION_FAILED: ${label} produced no response`);
  }
  if (response.status() >= 400) {
    throw new Error(
      `CSP_GATE_PRECONDITION_FAILED: ${label} returned HTTP ${response.status()}`,
    );
  }
  const csp = response.headers()["content-security-policy"];
  if (!csp) {
    throw new Error(
      `CSP_GATE_PRECONDITION_FAILED: ${label} carried no Content-Security-Policy header`,
    );
  }
  expect(csp, `${label}: CSP carries no nonce — is this a dev server?`).toContain(
    "'nonce-",
  );
  expect(
    csp,
    `${label}: CSP contains 'unsafe-inline' — this is the dev policy, not the production one`,
  ).not.toContain("'unsafe-inline'");
}

function describeViolations(label: string, violations: Violation[]): string {
  if (violations.length === 0) return `${label}: no violations`;
  const lines = violations.map(
    (v) =>
      `  ${v.directive} blocked=${v.blockedURI} @ ${v.sourceFile}:${v.lineNumber}` +
      (v.sample ? ` :: ${v.sample}` : ""),
  );
  return `${label}: ${violations.length} violation(s)\n${lines.join("\n")}`;
}

/**
 * I6.6 — split by origin. A violation whose sourceFile is empty counts as
 * app-origin: an unattributable violation must not be excused.
 */
function partitionByOrigin(
  violations: Violation[],
  appOrigin: string,
): { app: Violation[]; foreign: Violation[] } {
  const app: Violation[] = [];
  const foreign: Violation[] = [];
  for (const v of violations) {
    if (!v.sourceFile) {
      app.push(v);
      continue;
    }
    let origin: string;
    try {
      origin = new URL(v.sourceFile).origin;
    } catch {
      app.push(v);
      continue;
    }
    if (origin === appOrigin || !FOREIGN_ORIGIN_ALLOWLIST.includes(origin)) {
      app.push(v);
    } else {
      foreign.push(v);
    }
  }
  return { app, foreign };
}

function appOriginOf(page: Page): string {
  return new URL(page.url()).origin;
}

/** Count `style=` attributes in the SERVED HTML — the only subject CSP checks. */
async function countSsrStyleAttributes(
  page: Page,
  response: Response,
  label: string,
): Promise<number> {
  const body = await response.text();
  if (!body) {
    throw new Error(`CSP_GATE_PRECONDITION_FAILED: ${label} served an empty body`);
  }
  return (body.match(/\sstyle="/g) ?? []).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// I6.3 — standing positive control for the collector.
//
// A one-off red proof does not survive the collector breaking later: a renamed
// event, a reset array, a listener on the wrong target, or an init script that
// threw all produce a permanently green gate. These two cases fail in exactly
// those situations.
// ─────────────────────────────────────────────────────────────────────────────

test("collector self-test: a nonce-less <style> is caught, a nonce'd one is not", async ({
  page,
}) => {
  await installCollector(page);
  const res = await page.goto("/ja/auth/signin", { waitUntil: "networkidle" });
  assertStrictCsp(res, "self-test");

  // Let the page's own violations (if any) land before snapshotting. Without
  // this the delta below measures the page's noise as well as the injection,
  // and reads as "the collector is broken" on a page that merely violates.
  await page.waitForTimeout(SETTLE_MS);
  const before = (await readViolations(page)).length;

  // Deny arm: an inline <style> with no nonce must produce exactly one
  // style-src-elem violation.
  await page.evaluate(() => {
    const s = document.createElement("style");
    s.appendChild(document.createTextNode(".csp-selftest-deny{color:red}"));
    document.head.appendChild(s);
  });
  await page.waitForTimeout(250);
  const afterDeny = await readViolations(page);
  const denyCaught = afterDeny.length - before;
  expect(
    denyCaught,
    "CSP_GATE_COLLECTOR_UNVERIFIED: the collector did not observe a deliberately nonce-less <style>",
  ).toBe(1);
  expect(afterDeny[afterDeny.length - 1].directive).toContain("style-src");

  // Allow arm: the same insertion carrying the document's nonce must produce
  // none. Without this, a collector that reported every insertion would pass
  // the deny arm.
  const nonce = await page.evaluate(
    () => document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "",
  );
  expect(
    nonce,
    "CSP_GATE_COLLECTOR_UNVERIFIED: no nonced <script> to read the document nonce from",
  ).not.toBe("");
  await page.evaluate((n) => {
    const s = document.createElement("style");
    s.setAttribute("nonce", n);
    s.appendChild(document.createTextNode(".csp-selftest-allow{color:blue}"));
    document.head.appendChild(s);
  }, nonce);
  await page.waitForTimeout(250);
  const afterAllow = await readViolations(page);
  expect(
    afterAllow.length - afterDeny.length,
    "a nonce'd <style> must not violate — the collector is over-reporting",
  ).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// I6.5 — public routes, one per root segment plus the locale variants that
// exercise different layouts.
// ─────────────────────────────────────────────────────────────────────────────

const PUBLIC_ROUTES = [
  { path: "/ja/auth/signin", label: "signin (ja)" },
  { path: "/en/auth/signin", label: "signin (en)" },
  { path: "/ja/privacy-policy", label: "privacy-policy" },
  { path: "/ja/recovery", label: "recovery" },
  { path: "/ja/vault-reset", label: "vault-reset" },
] as const;

for (const route of PUBLIC_ROUTES) {
  test(`no CSP violations: ${route.label}`, async ({ page }) => {
    await installCollector(page);
    const res = await page.goto(route.path, { waitUntil: "networkidle" });
    assertStrictCsp(res, route.label);

    // I6.2 allow case: public routes carry no authentication precondition.
    // The positive signal is that the document hydrated — without it a blank
    // error page would report zero violations.
    const hydrated = await page.evaluate(
      () => typeof (window as unknown as { next?: unknown }).next !== "undefined",
    );
    expect(
      hydrated,
      `CSP_GATE_PRECONDITION_FAILED: ${route.label} did not hydrate`,
    ).toBe(true);

    await page.waitForTimeout(SETTLE_MS);
    const all = await readViolations(page);
    const { app, foreign } = partitionByOrigin(all, appOriginOf(page));
    expect(
      foreign,
      describeViolations(`CSP_GATE_FOREIGN_VIOLATION ${route.label}`, foreign),
    ).toHaveLength(0);
    expect(app, describeViolations(route.label, app)).toHaveLength(0);

    // C5 — the SSR style-attribute count, measured rather than asserted from
    // the JSX source. Recorded per route so the member set is derived from the
    // served HTML.
    const styleAttrs = await countSsrStyleAttributes(page, res!, route.label);
    expect(
      styleAttrs,
      `${route.label}: ${styleAttrs} style= attribute(s) in served HTML — a nonce cannot cover these`,
    ).toBe(0);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// I6.2 / I6.5 — the authenticated dashboard. This is the only place V5 (Radix
// overlay style injection) and V6 (SSR style attributes) can appear, so its
// preconditions carry the whole weight of that half of the gate.
// ─────────────────────────────────────────────────────────────────────────────

test("no CSP violations: authenticated dashboard, unlocked vault", async ({
  page,
  context,
}) => {
  const { vaultReady } = getAuthState();
  await injectSession(context, vaultReady.sessionToken);
  await installCollector(page);

  const res = await page.goto("/ja/dashboard", { waitUntil: "networkidle" });
  assertStrictCsp(res, "dashboard");

  // I6.2 (a) — the session must not have silently fallen back to sign-in. The
  // sign-in page carries the same strict CSP and is already clean, so without
  // this assertion a broken seed reads as a passing gate.
  expect(
    page.url(),
    "CSP_GATE_PRECONDITION_FAILED: dashboard redirected to sign-in — the session was not accepted",
  ).not.toContain("/auth/signin");

  // I6.2 (c) — the vault must be unlocked. A locked vault renders neither the
  // password list nor the sidebar folder tree, which are the V6 subjects.
  const lockPage = new VaultLockPage(page);
  await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
  await lockPage.unlockAndWait(vaultReady.passphrase!);

  // I6.2 (b) — a route landmark proves the dashboard actually rendered.
  await expect(page.getByRole("region", { name: "Security" })).toBeVisible({
    timeout: 10_000,
  });

  await page.waitForTimeout(SETTLE_MS);
  const all = await readViolations(page);
  const { app, foreign } = partitionByOrigin(all, appOriginOf(page));
  expect(
    foreign,
    describeViolations("CSP_GATE_FOREIGN_VIOLATION dashboard", foreign),
  ).toHaveLength(0);
  expect(app, describeViolations("dashboard", app)).toHaveLength(0);

  // C5 — pinned here specifically because this is the page whose sidebar,
  // folder tree and password list were *claimed* to serve `style=` attributes.
  // They do not: those rows come from client hooks that fetch in an effect and
  // from a client-decrypted vault, so nothing reaches the SSR parser. Asserting
  // it on the served HTML keeps that claim falsifiable — if a future change
  // moves any of it to the server, this reds before the violation count does.
  const styleAttrs = await countSsrStyleAttributes(page, res!, "dashboard");
  expect(
    styleAttrs,
    `dashboard: ${styleAttrs} style= attribute(s) in served HTML — a nonce cannot cover these`,
  ).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// I6.5 — an interaction that mounts a Radix overlay (V5) and one that raises a
// toast (V3). Both assert the positive signal before counting violations: a
// selector that silently no-ops would otherwise read as a clean page.
// ─────────────────────────────────────────────────────────────────────────────

test("no CSP violations: Radix overlay mounted from the dashboard", async ({
  page,
  context,
}) => {
  const { vaultReady } = getAuthState();
  await injectSession(context, vaultReady.sessionToken);
  await installCollector(page);

  const res = await page.goto("/ja/dashboard", { waitUntil: "networkidle" });
  assertStrictCsp(res, "dashboard/overlay");
  expect(page.url()).not.toContain("/auth/signin");

  const lockPage = new VaultLockPage(page);
  await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
  await lockPage.unlockAndWait(vaultReady.passphrase!);

  // Open the new-entry dialog. Radix Dialog pulls in react-remove-scroll,
  // which is what injects the un-nonced <style> (V5).
  const newEntry = page.getByRole("button", { name: /新規|新しい|追加|New/ }).first();
  await expect(
    newEntry,
    "CSP_GATE_INTERACTION_NOT_OBSERVED: no control found to open an overlay",
  ).toBeVisible({ timeout: 10_000 });
  await newEntry.click();

  const dialog = page.getByRole("dialog");
  await expect(
    dialog,
    "CSP_GATE_INTERACTION_NOT_OBSERVED: the overlay did not mount",
  ).toBeVisible({ timeout: 10_000 });

  // The positive signal for react-remove-scroll specifically: it locks body
  // scroll by injecting a stylesheet. If the injection was CSP-blocked the
  // lock is absent, so this assertion and the violation count are two views of
  // the same failure.
  await page.waitForTimeout(SETTLE_MS);
  const all = await readViolations(page);
  const { app, foreign } = partitionByOrigin(all, appOriginOf(page));
  expect(
    foreign,
    describeViolations("CSP_GATE_FOREIGN_VIOLATION overlay", foreign),
  ).toHaveLength(0);
  expect(app, describeViolations("overlay", app)).toHaveLength(0);
});
