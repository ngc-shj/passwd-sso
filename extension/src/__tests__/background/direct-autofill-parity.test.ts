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
  // DIVERGENCE (reported, not fixed — see the final report): directAutofill's
  // username fallback walk accepts the nearest preceding usable text field with
  // no hint check; performAutofill's findUsernameInput additionally requires the
  // hint to look username-like. The hidden card-number field here is not a card
  // candidate (invisible, so no exclusion applies to it either) and sits between
  // the password and the real "username" field: directAutofill's walk stops on
  // it (then its own write-time visibility check silently drops the write, so
  // nothing is filled), while performAutofill's hint filter skips it and reaches
  // "username". Both still agree that nothing is EXCLUDED (FR3/C2's point for
  // this fixture); they disagree on the fallback username target.
  it("a hidden (display:none) card number is not detected; nothing is excluded", async () => {
    const html = `
      <input id="username" type="text" name="username">
      <form>
        <input id="ccnum" type="text" name="card_number" style="display:none">
        <input id="cvv" type="password" name="cvv">
      </form>
    `;
    const direct = await runDirect(html);
    const content = await runContent(html);
    expect(direct.password).toBe("cvv");
    expect(content.password).toBe("cvv");
    // Pinned divergence, not parity: directAutofill fills no username (the
    // hidden ccnum blocks its naive walk); performAutofill fills "username".
    expect(direct.username).toBeNull();
    expect(content.username).toBe("username");
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
});
