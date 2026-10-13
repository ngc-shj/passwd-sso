/**
 * @vitest-environment jsdom
 */
// C6's drift pin: directAutofill (background/direct-autofill.ts) re-implements
// the content side's card-form exclusion (ccFormFields / isLoginEligible) inline
// because executeScript serializes it with no imports. These tests run both
// implementations on the SAME markup (one after the other, on a fresh DOM built
// from the same HTML string) and assert they choose the same password and
// username target. A drift between the two is a silent LOGIN/CC leak in
// whichever implementation falls behind.
import { describe, it, expect, afterEach } from "vitest";
import { directAutofill } from "../../background/direct-autofill";
import { performAutofill } from "../../content/autofill-lib";
import { __resetFillSequenceForTests } from "../../content/fill-sequence-lib";
import { CARD_PATTERN_SOURCES, LOGIN_AUTOCOMPLETE_TOKENS } from "../../lib/cc-patterns";
import { AUTOFILL_FILL } from "../../lib/constants";
import { setCheckVisibility } from "../helpers/layout-stub";

// Polyfill CSS.escape for jsdom (label[for] lookups), as the sibling CC/identity
// detector tests do.
if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
}

const PAGE_HOST = new URL(window.location.href).hostname;
const NO_WAIT = { lateFieldWindowMs: 0 };
const USERNAME = "alice99";
const PASSWORD = "Sw0rdfish!";

afterEach(() => {
  document.body.innerHTML = "";
  __resetFillSequenceForTests();
});

interface Targets {
  username: string | null;
  password: string | null;
}

function valueOwnerId(value: string): string | null {
  const el = Array.from(document.querySelectorAll("input")).find(
    (i) => (i as HTMLInputElement).value === value,
  );
  return el?.id ?? null;
}

async function runDirect(html: string, focusId?: string): Promise<Targets> {
  document.body.innerHTML = html;
  if (focusId) (document.getElementById(focusId) as HTMLInputElement | null)?.focus();
  await directAutofill(
    USERNAME,
    PASSWORD,
    null,
    [],
    CARD_PATTERN_SOURCES,
    [...LOGIN_AUTOCOMPLETE_TOKENS],
  );
  return { username: valueOwnerId(USERNAME), password: valueOwnerId(PASSWORD) };
}

async function runContent(html: string, focusId?: string): Promise<Targets> {
  document.body.innerHTML = html;
  if (focusId) (document.getElementById(focusId) as HTMLInputElement | null)?.focus();
  await performAutofill(
    {
      type: AUTOFILL_FILL,
      allowedHosts: [PAGE_HOST],
      username: USERNAME,
      password: PASSWORD,
    },
    NO_WAIT,
  );
  return { username: valueOwnerId(USERNAME), password: valueOwnerId(PASSWORD) };
}

/** Runs both implementations on the same markup and asserts they agree. */
async function expectParity(html: string, focusId?: string): Promise<Targets> {
  const direct = await runDirect(html, focusId);
  const content = await runContent(html, focusId);
  expect(direct, "directAutofill vs performAutofill target mismatch").toEqual(content);
  return direct;
}

describe("directAutofill / performAutofill parity (C6)", () => {
  // ── 1: login form + card form with masked CVV ──
  it("excludes the card-form CVV; the login password is chosen", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="loginpw" type="password" name="password">
      <form>
        <input id="ccnum" type="text" name="card_number">
        <input id="cvv" type="password" name="security_code">
      </form>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "loginpw" });
  });

  it("allow pair: without the card number, today's last-password choice is unchanged", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="loginpw" type="password" name="password">
      <form>
        <input id="cvv" type="password" name="security_code">
      </form>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "cvv" });
  });

  // ── 2: FR2 — explicit LOGIN autocomplete wins over the card-form exclusion ──
  it("FR2: a card-form field with autocomplete=current-password is filled", async () => {
    const html = `
      <form>
        <input id="ccnum" type="text" name="card_number">
        <input id="cvv" type="password" name="security_code" autocomplete="current-password">
      </form>
    `;
    const result = await expectParity(html);
    expect(result.password).toBe("cvv");
  });

  // ── 3: FR4 claim-stealing — a login password named security_code is NOT the
  // excluded field; the real CVV inside the card form is. ──
  it("FR4: a login password named security_code stays eligible; the real CVV is excluded", async () => {
    const html = `
      <input id="loginuser" type="text" name="username">
      <input id="loginpw_sc" type="password" name="security_code">
      <form>
        <input id="ccnum" type="text" name="card_number">
        <input id="realcvv" type="password" name="cvv">
      </form>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "loginuser", password: "loginpw_sc" });
  });

  it("allow pair: without the card number, the earlier security_code field is still the last/only choice", async () => {
    const html = `
      <input id="loginuser" type="text" name="username">
      <input id="loginpw_sc" type="password" name="security_code">
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "loginuser", password: "loginpw_sc" });
  });

  // ── 4: label-only JA CVV, non-matching name ──
  it("a JA label-only CVV (セキュリティコード) inside the card form is excluded by its label text", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="loginpw" type="password" name="password">
      <form>
        <input id="ccnum" type="text" name="card_number">
        <label>セキュリティコード<input id="jacvv" type="password" name="x"></label>
      </form>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "loginpw" });
  });

  it("allow pair: without the card number, the JA label-only field is the normal last-password target", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <label>セキュリティコード<input id="jacvv" type="password" name="x"></label>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "jacvv" });
  });

  // ── 5: label[for] CVV, CSS.escape polyfill ──
  it("a label[for]-linked CVV inside the card form is excluded by its label text", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="loginpw" type="password" name="password">
      <form>
        <input id="ccnum" type="text" name="card_number">
        <label for="forcvv">CVV</label>
        <input id="forcvv" type="password" name="x">
      </form>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "loginpw" });
  });

  // ── 6: form-less <table> card block ──
  it("a form-less <table> card block excludes its CVV", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="loginpw" type="password" name="password">
      <table>
        <tr><td><input id="ccnum" type="text" name="card_number"></td></tr>
        <tr><td><input id="cvv" type="password" name="cvv"></td></tr>
      </table>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "loginpw" });
  });

  it("allow pair: the same table without a card number excludes nothing", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <table>
        <tr><td><input id="cvv" type="password" name="cvv"></td></tr>
      </table>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "cvv" });
  });

  // ── 7: <div>-only card block (F-S10), no form and no table ──
  it("a <div>-only card block excludes its CVV", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="loginpw" type="password" name="password">
      <div>
        <input id="ccnum" type="text" name="card_number">
        <input id="cvv" type="password" name="cvv">
      </div>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "loginpw" });
  });

  it("allow pair: an unrelated security_code field in a sibling <div> stays eligible", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <div>
        <input id="ccnum" type="text" name="card_number">
        <input id="cvv" type="password" name="cvv">
      </div>
      <div>
        <input id="sibling_sc" type="password" name="security_code">
      </div>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "sibling_sc" });
  });

  // ── 8: hidden card number — nothing excluded ──
  //
  // The hidden card-number field is not a card candidate (so no exclusion
  // applies) and sits between the password and the real "username" field. Both
  // username walks skip a hidden field, so both reach "username"; before the
  // shared visibility rule, directAutofill's walk stopped on it and filled none.
  it("a hidden (display:none) card number is not detected; nothing is excluded", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <form>
        <input id="ccnum" type="text" name="card_number" style="display:none">
        <input id="cvv" type="password" name="cvv">
      </form>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "cvv" });
  });

  // ── 9: focused card-number field — username is not written there ──
  it("a focused card-number field is not used as the username target", async () => {
    const html = `
      <form>
        <input id="ccnum" type="text" name="card_number">
        <input id="cvv" type="password" name="security_code">
      </form>
      <input id="loginpw" type="password" name="password">
    `;
    const result = await expectParity(html, "ccnum");
    expect(result).toEqual({ username: null, password: "loginpw" });
  });

  // ── 10: three password fields — the fallback target is the last eligible one ──
  it("three password fields: the unrelated non-card field is chosen, not the card-form CVV", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="loginpw" type="password" name="password">
      <input id="otherpw" type="password" name="secret2">
      <form>
        <input id="ccnum" type="text" name="card_number">
        <input id="cvv" type="password" name="security_code">
      </form>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "otherpw" });
  });

  // ── 11: opacity-0 card number — allow: no block forms ──
  it("an opacity:0 card number is not detected; its would-be neighbour stays eligible", async () => {
    const html = `
      <input id="loginpw" type="password" name="password">
      <form>
        <input id="ccnum" type="text" name="card_number" style="opacity:0">
        <input id="cvv" type="password" name="security_code">
      </form>
    `;
    const result = await expectParity(html);
    expect(result.password).toBe("cvv");
  });

  // ── 12: a <select>-only expiry neighbour anchors the block ──
  it("a <select>-only expiry neighbour anchors the block; the card number is excluded from the username walk", async () => {
    const html = `
      <form>
        <input id="ccnum" type="text" name="card_number">
        <select id="expMonth" name="exp_month"><option value="01">01</option></select>
      </form>
      <input id="loginpw" type="password" name="password">
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: null, password: "loginpw" });
  });

  // ── 13: card form before a password-only login form ──
  it("the username walk does not land in a preceding card form", async () => {
    const html = `
      <form>
        <input id="ccnum" type="text" name="card_number">
        <input id="cvv" type="password" name="security_code">
      </form>
      <form>
        <input id="loginpw" type="password" name="password">
      </form>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: null, password: "loginpw" });
  });

  // ── 14: a lone card number plus a login security_code in a separate form ──
  //
  // DIVERGENCE (reported, not fixed): the same root cause as fixture 8. The
  // lone ccnum (no neighbour, so not excluded per C2's "lone card number is not
  // excluded" rule) sits between "username" and the chosen password in DOM
  // order. directAutofill's unfiltered walk stops on it (ccnum is visible here,
  // so the write DOES land on ccnum instead of "username");
  // performAutofill's hint filter correctly skips it.
  it("allow: a lone card number with no neighbour excludes nothing; the separate-form security_code password is eligible", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <form>
        <input id="ccnum" type="text" name="card_number">
      </form>
      <form>
        <input id="loginpw_sc" type="password" name="security_code">
      </form>
    `;
    const direct = await runDirect(html);
    const content = await runContent(html);
    expect(direct.password).toBe("loginpw_sc");
    expect(content.password).toBe("loginpw_sc");
    // Pinned divergence: directAutofill's naive walk lands on the lone,
    // not-excluded card number; performAutofill's hint filter skips it.
    expect(direct.username).toBe("ccnum");
    expect(content.username).toBe("username");
  });

  // ── 15: 利用者カード番号 + password login — allow: username is filled ──
  //
  // DIVERGENCE (reported, not fixed): the lone 利用者カード番号 field is not
  // excluded (no card neighbour), so both agree it is a valid LOGIN candidate.
  // But performAutofill's findUsernameInput additionally requires the field's
  // hint to match a username-shaped regex, and neither the Latin nor the JA
  // username pattern there matches "利用者カード番号" — so performAutofill
  // fills no username at all, while directAutofill's unfiltered walk (any
  // eligible preceding text field) fills it. This is the inverse of fixture 8/14:
  // there, directAutofill's lack of a hint filter loses to a real username;
  // here it is the only one of the two that actually fills the field the plan
  // describes as "the username is filled" (S12).
  it("a 利用者カード番号 library-card field has no card neighbour and stays eligible as a LOGIN candidate", async () => {
    const html = `
      <input id="libcard" type="text" name="利用者カード番号">
      <input id="loginpw" type="password" name="password">
    `;
    const direct = await runDirect(html);
    const content = await runContent(html);
    expect(direct.password).toBe("loginpw");
    expect(content.password).toBe("loginpw");
    // Pinned divergence: directAutofill fills libcard as the username;
    // performAutofill's hint regex does not recognize 利用者カード番号 as a
    // username hint at all, so it fills no username.
    expect(direct.username).toBe("libcard");
    expect(content.username).toBeNull();
  });

  // ── 16: form-wrapped card number + form=-associated CVV outside the form ──
  it("deny: a form=-associated CVV outside the form is still counted as inside it, and excluded", async () => {
    const html = `
      <form id="cardForm">
        <input id="ccnum" type="text" name="card_number">
      </form>
      <input id="cvv" type="password" name="security_code" form="cardForm">
      <input id="loginpw" type="password" name="password">
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: null, password: "loginpw" });
  });

  // ── Walk-filter: the username fallback must SKIP an excluded card-form field,
  // not stop at it, to reach the real username further back. ──
  it("the username fallback walk skips an excluded card-number field to reach the real username", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <form>
        <input id="ccnum" type="text" name="card_number">
        <input id="cvv" type="password" name="security_code">
      </form>
      <input id="loginpw" type="password" name="password">
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "loginpw" });
  });

  // ── Same-block collision (Known gaps, pinned "by design") ──
  it("a username field inside the card form stays eligible even though a collided CVV field does not", async () => {
    const html = `
      <form>
        <input id="ccnum" type="text" name="card_number">
        <input id="cardusername" type="text" name="username">
        <input id="account_security_code" type="password" name="account_security_code">
      </form>
      <input id="loginpw" type="password" name="password">
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "cardusername", password: "loginpw" });
  });

  // ── hinted card field: it does not scope the password search ──
  // The card form holds an unrelated eligible masked field ("pin") besides its
  // CVV. A hint on the card number must not narrow the search to that form:
  // both sides then take the last eligible password page-wide, the login one.
  it("a targetHint on a card-form field does not scope the password search to the card form", async () => {
    const html = `
      <form id="card">
        <input id="ccnum" type="text" name="card_number">
        <input id="pin" type="password" name="pin">
        <input id="cvv" type="password" name="cvv">
      </form>
      <form id="login">
        <input id="username" type="text" name="username">
        <input id="loginpw" type="password" name="password">
      </form>
    `;
    const hint = { id: "ccnum" };
    document.body.innerHTML = html;
    await directAutofill(USERNAME, PASSWORD, hint, [], CARD_PATTERN_SOURCES, [...LOGIN_AUTOCOMPLETE_TOKENS]);
    const direct = { username: valueOwnerId(USERNAME), password: valueOwnerId(PASSWORD) };
    __resetFillSequenceForTests();
    document.body.innerHTML = html;
    await performAutofill(
      { type: AUTOFILL_FILL, allowedHosts: [PAGE_HOST], username: USERNAME, password: PASSWORD, targetHint: hint },
      NO_WAIT,
    );
    const content = { username: valueOwnerId(USERNAME), password: valueOwnerId(PASSWORD) };
    expect(direct).toEqual(content);
    expect(direct.password).toBe("loginpw");
  });
});

// ── C1 twin (#884): directAutofill's inline isFieldVisible copy ──
//
// Each case puts a second password LAST in the page, after a visible one, so
// the last-password rule would pick it if visibility let it through. Deny rows
// assert the visible "pw" is filled and "pwLast" is not; allow rows (the same
// markup differing on one axis) assert "pwLast" is filled. Every row also pins
// twin = content.
describe("directAutofill twin: field visibility (C1)", () => {
  type Row = { name: string; last: string; allowed: boolean; checkVisibility?: () => void };
  const pwLast = (attrs = "") => `<input id="pwLast" type="password" ${attrs}>`;
  const rows: Row[] = [
    { name: "R1 deny: display:none ancestor", last: `<div style="display:none">${pwLast()}</div>`, allowed: false },
    { name: "R1 allow: display:block ancestor", last: `<div style="display:block">${pwLast()}</div>`, allowed: true },
    { name: "R1 deny: content-visibility:hidden ancestor", last: `<div style="content-visibility:hidden">${pwLast()}</div>`, allowed: false },
    { name: "R2 deny: inherits visibility:hidden", last: `<div style="visibility:hidden">${pwLast()}</div>`, allowed: false },
    { name: "R2 allow: visibility:visible child of a hidden parent", last: `<div style="visibility:hidden">${pwLast('style="visibility:visible"')}</div>`, allowed: true },
    { name: "R3 deny: opacity 0.2 × 0.2", last: `<div style="opacity:0.2">${pwLast('style="opacity:0.2"')}</div>`, allowed: false },
    { name: "R3 allow: opacity 0.5 × 0.5", last: `<div style="opacity:0.5">${pwLast('style="opacity:0.5"')}</div>`, allowed: true },
    { name: "R4 deny: 0×0", last: pwLast('data-rect="0,0,10,10"'), allowed: false },
    { name: "R4 deny: 3×20", last: pwLast('data-rect="3,20,10,10"'), allowed: false },
    { name: "R4 allow: 4×4", last: pwLast('data-rect="4,4,10,10"'), allowed: true },
    { name: "R4 deny: zero-width overflow-x:hidden ancestor", last: `<div style="overflow-x:hidden" data-rect="0,200,0,0">${pwLast()}</div>`, allowed: false },
    { name: "R4 deny: zero-height overflow-y:hidden ancestor", last: `<div style="overflow-y:hidden" data-rect="300,0,0,0">${pwLast()}</div>`, allowed: false },
    { name: "R4 deny: left of an overflow-x:hidden ancestor's box", last: `<div style="overflow-x:hidden" data-rect="300,200,200,0">${pwLast('data-rect="100,20,50,10"')}</div>`, allowed: false },
    { name: "R4 deny: above an overflow-y:hidden ancestor's box", last: `<div style="overflow-y:hidden" data-rect="300,200,0,200">${pwLast('data-rect="100,20,10,50"')}</div>`, allowed: false },
    { name: "R4 allow: inside an overflow:hidden ancestor's box", last: `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="300,200,0,0">${pwLast('data-rect="100,20,50,50"')}</div>`, allowed: true },
    { name: "R4 allow: zero-size ancestor with visible overflow", last: `<div data-rect="0,0,0,0">${pwLast()}</div>`, allowed: true },
    { name: "R4 deny: zero-size contain:paint ancestor", last: `<div style="contain:paint" data-rect="0,0,0,0">${pwLast()}</div>`, allowed: false },
    { name: "R4 allow: display:contents ancestor is skipped", last: `<div style="display:contents; overflow-x:hidden; overflow-y:hidden" data-rect="0,0,0,0">${pwLast()}</div>`, allowed: true },
    { name: "R4 allow: a fixed field escapes the clip", last: `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="0,0,0,0">${pwLast('style="position:fixed"')}</div>`, allowed: true },
    { name: "R4 allow: a fixed wrapper stops the walk below an outer clip", last: `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="0,0,0,0"><div style="position:fixed">${pwLast()}</div></div>`, allowed: true },
    { name: "R4 deny: overflow-y:auto window of 2px", last: `<div style="overflow-y:auto" data-rect="300,2,0,0">${pwLast()}</div>`, allowed: false },
    { name: "R4 deny: overflow-x:scroll window of 3px", last: `<div style="overflow-x:scroll" data-rect="3,200,0,0">${pwLast()}</div>`, allowed: false },
    { name: "R4 allow: below the fold of an auto pane under an overflow:hidden wrapper", last: `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="300,200,0,0"><div style="overflow-y:auto" data-rect="300,200,0,0">${pwLast('data-rect="100,20,10,5000"')}</div></div>`, allowed: true },
    { name: "R4 allow: right of the fold of a scroll pane under an overflow:hidden wrapper", last: `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="300,200,0,0"><div style="overflow-x:scroll" data-rect="300,200,0,0">${pwLast('data-rect="100,20,5000,10"')}</div></div>`, allowed: true },
    { name: "R4 deny: below the fold of an overflow:hidden wrapper", last: `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="300,200,0,0">${pwLast('data-rect="100,20,10,5000"')}</div>`, allowed: false },
    { name: "R5 deny: right edge at 0", last: pwLast('data-rect="100,20,-100,10"'), allowed: false },
    { name: "R5 allow: right edge at 1", last: pwLast('data-rect="100,20,-99,10"'), allowed: true },
    { name: "R5 deny: fixed beyond the viewport", last: pwLast(`style="position:fixed" data-rect="100,20,${window.innerWidth},10"`), allowed: false },
    { name: "R6 deny: absolute + clip rect(0px, 0px, 0px, 0px)", last: pwLast('style="position:absolute; clip:rect(0px, 0px, 0px, 0px)"'), allowed: false },
    { name: "R6 allow: static + the same clip", last: pwLast('style="position:static; clip:rect(0px, 0px, 0px, 0px)"'), allowed: true },
    { name: "R6 deny: clip-path inset(100%) ancestor", last: `<div style="clip-path:inset(100%)">${pwLast()}</div>`, allowed: false },
    { name: "R6 deny: clip-path inset(50%) ancestor", last: `<div style="clip-path:inset(50%)">${pwLast()}</div>`, allowed: false },
    { name: "R6 allow: clip-path inset(50% 0 0) ancestor (bottom half painted)", last: `<div style="clip-path:inset(50% 0px 0px)">${pwLast()}</div>`, allowed: true },
    {
      name: "R7 deny: checkVisibility false for the field",
      last: pwLast(),
      allowed: false,
      checkVisibility: () =>
        setCheckVisibility(function (this: HTMLElement) {
          return this.id !== "pwLast";
        }),
    },
    {
      name: "R7 deny: closed <details> with checkVisibility undefined",
      last: `<details><summary>more</summary>${pwLast()}</details>`,
      allowed: false,
      checkVisibility: () => setCheckVisibility(undefined),
    },
    { name: "R7 deny: opacity:0 (checkVisibility opacityProperty)", last: pwLast('style="opacity:0"'), allowed: false },
  ];

  it.each(rows)("$name", async ({ last, allowed, checkVisibility }) => {
    checkVisibility?.();
    const html = `
      <input id="username" type="text" name="username">
      <input id="pw" type="password" name="password">
      ${last}
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: allowed ? "pwLast" : "pw" });
  });

  it("skips a hidden autocomplete=current-password placed before the visible one", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <div style="display:none"><input id="pwHidden" type="password" autocomplete="current-password"></div>
      <input id="pw" type="password" autocomplete="current-password">
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "pw" });
  });

  it("the username walk skips a zero-rect text field between the username and the password", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="loginHidden" type="text" name="login" data-rect="0,0,0,0">
      <input id="pw" type="password" name="password">
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "pw" });
  });

  it("a focused zero-rect text field is not the username; the visible one is", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="focused" type="email" name="email" data-rect="0,0,0,0">
      <input id="pw" type="password" name="password">
    `;
    const result = await expectParity(html, "focused");
    expect(result).toEqual({ username: "username", password: "pw" });
  });

  it("a hinted hidden field is not the username; the visible one is", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <div style="display:none"><input id="hinted" type="text" name="email"></div>
      <input id="pw" type="password" name="password">
    `;
    const hint = { id: "hinted" };
    document.body.innerHTML = html;
    await directAutofill(USERNAME, PASSWORD, hint, [], CARD_PATTERN_SOURCES, [...LOGIN_AUTOCOMPLETE_TOKENS]);
    const direct = { username: valueOwnerId(USERNAME), password: valueOwnerId(PASSWORD) };
    __resetFillSequenceForTests();
    document.body.innerHTML = html;
    await performAutofill(
      { type: AUTOFILL_FILL, allowedHosts: [PAGE_HOST], username: USERNAME, password: PASSWORD, targetHint: hint },
      NO_WAIT,
    );
    const content = { username: valueOwnerId(USERNAME), password: valueOwnerId(PASSWORD) };
    expect(direct).toEqual(content);
    expect(direct).toEqual({ username: "username", password: "pw" });
  });

  it("a hinted hidden field does not scope the password search to its form", async () => {
    const html = `
      <form>
        <div style="display:none"><input id="hinted" type="text" name="email"></div>
        <input id="pwA" type="password" name="password">
      </form>
      <input id="pwB" type="password" name="password">
    `;
    const hint = { id: "hinted" };
    document.body.innerHTML = html;
    await directAutofill(USERNAME, PASSWORD, hint, [], CARD_PATTERN_SOURCES, [...LOGIN_AUTOCOMPLETE_TOKENS]);
    const direct = { username: valueOwnerId(USERNAME), password: valueOwnerId(PASSWORD) };
    __resetFillSequenceForTests();
    document.body.innerHTML = html;
    await performAutofill(
      { type: AUTOFILL_FILL, allowedHosts: [PAGE_HOST], username: USERNAME, password: PASSWORD, targetHint: hint },
      NO_WAIT,
    );
    const content = { username: valueOwnerId(USERNAME), password: valueOwnerId(PASSWORD) };
    expect(direct).toEqual(content);
    expect(direct).toEqual({ username: null, password: "pwB" });
  });

  it("an opacity:0 input matching a custom-field label is not written; the visible match is", async () => {
    const html = `
      <input id="memoHidden" type="text" name="memo" style="opacity:0">
      <input id="memo" type="text" name="memo">
    `;
    const custom = [{ label: "memo", value: "m1" }];
    document.body.innerHTML = html;
    await directAutofill("", "", null, custom, CARD_PATTERN_SOURCES, [...LOGIN_AUTOCOMPLETE_TOKENS]);
    const direct = valueOwnerId("m1");
    __resetFillSequenceForTests();
    document.body.innerHTML = html;
    await performAutofill(
      { type: AUTOFILL_FILL, allowedHosts: [PAGE_HOST], username: "", password: "", customFields: custom },
      NO_WAIT,
    );
    const content = valueOwnerId("m1");
    expect(direct).toBe(content);
    expect(direct).toBe("memo");
  });

  it("a password the page hides before its write is not written", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="pw" type="password" name="password">
    `;
    // The username write's input handler hides the password; each fill
    // re-checks the target in the task of its write.
    const hideOnUsernameInput = () =>
      document.getElementById("username")?.addEventListener("input", () => {
        (document.getElementById("pw") as HTMLInputElement).style.display = "none";
      });
    document.body.innerHTML = html;
    hideOnUsernameInput();
    await directAutofill(USERNAME, PASSWORD, null, [], CARD_PATTERN_SOURCES, [...LOGIN_AUTOCOMPLETE_TOKENS]);
    const direct = { username: valueOwnerId(USERNAME), password: valueOwnerId(PASSWORD) };
    __resetFillSequenceForTests();
    document.body.innerHTML = html;
    hideOnUsernameInput();
    await performAutofill(
      { type: AUTOFILL_FILL, allowedHosts: [PAGE_HOST], username: USERNAME, password: PASSWORD },
      NO_WAIT,
    );
    const content = { username: valueOwnerId(USERNAME), password: valueOwnerId(PASSWORD) };
    expect(direct).toEqual(content);
    expect(direct).toEqual({ username: "username", password: null });
  });

  it("a card number hidden by an ancestor still excludes its CVV", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="loginpw" type="password" name="password">
      <form>
        <div style="display:none"><input id="ccnum" type="text" name="card_number"></div>
        <input id="cvv" type="password" name="cvv">
      </form>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "loginpw" });
  });

  it("a zero-rect card number still excludes its CVV", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="loginpw" type="password" name="password">
      <form>
        <input id="ccnum" type="text" name="card_number" data-rect="0,0,0,0">
        <input id="cvv" type="password" name="cvv">
      </form>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "loginpw" });
  });

  it("a card number whose only card neighbour is hidden by an ancestor is still excluded", async () => {
    const html = `
      <form>
        <input id="ccnum" type="text" name="card_number">
        <div style="display:none"><input id="exp" type="text" name="exp_month"></div>
      </form>
      <input id="loginpw" type="password" name="password">
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: null, password: "loginpw" });
  });

  it("a hidden card form before a visible one leaves the visible CVV LOGIN-ineligible", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <input id="loginpw" type="password" name="password">
      <div style="display:none"><form>
        <input id="ccnum1" type="text" name="card_number">
        <input id="cvv1" type="password" name="cvv">
      </form></div>
      <form>
        <input id="ccnum2" type="text" name="card_number">
        <input id="cvv2" type="password" name="cvv">
      </form>
    `;
    const result = await expectParity(html);
    expect(result).toEqual({ username: "username", password: "loginpw" });
  });
});
