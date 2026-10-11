/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { hasExplicitLoginAutocomplete } from "../../content/login-field-eligibility";
import { ccFormFields } from "../../content/cc-field-detection-lib";

// Polyfill CSS.escape for jsdom (getHintString's label[for] lookup), as
// cc-form-detector.test.ts does.
if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
}

function setupForm(html: string): void {
  document.body.innerHTML = html;
}

function byName(name: string): HTMLInputElement {
  const el = document.querySelector(`[name="${name}"]`);
  if (!(el instanceof HTMLInputElement)) throw new Error(`fixture missing input[name=${name}]`);
  return el;
}

function input(autocomplete: string | undefined): HTMLInputElement {
  const el = document.createElement("input");
  if (autocomplete !== undefined) el.setAttribute("autocomplete", autocomplete);
  document.body.appendChild(el);
  return el;
}

describe("hasExplicitLoginAutocomplete", () => {
  it.each(["username", "email", "current-password", "one-time-code"])(
    "accepts the %s token",
    (token) => {
      expect(hasExplicitLoginAutocomplete(input(token))).toBe(true);
    },
  );

  it("accepts a token prefixed with a section- group", () => {
    expect(hasExplicitLoginAutocomplete(input("section-red username"))).toBe(true);
  });

  it("accepts a token prefixed with billing/shipping", () => {
    expect(hasExplicitLoginAutocomplete(input("billing email"))).toBe(true);
  });

  it("refuses cc-csc", () => {
    expect(hasExplicitLoginAutocomplete(input("cc-csc"))).toBe(false);
  });

  it("refuses new-password", () => {
    expect(hasExplicitLoginAutocomplete(input("new-password"))).toBe(false);
  });

  it("refuses an empty/absent autocomplete", () => {
    expect(hasExplicitLoginAutocomplete(input(undefined))).toBe(false);
  });
});

describe("ccFormFields", () => {
  it("is empty without a card number on the page", () => {
    setupForm(`<input type="text" name="foo" /><input type="password" name="pwd" />`);
    expect(ccFormFields(document).size).toBe(0);
  });

  it("includes the card form's fields", () => {
    setupForm(`
      <form id="card">
        <input name="cardNumber" />
        <input name="cvv" type="password" />
      </form>
    `);
    const fields = ccFormFields(document);
    expect(fields.has(byName("cardNumber"))).toBe(true);
    expect(fields.has(byName("cvv"))).toBe(true);
  });

  it("excludes a CVV-regex match that lives in a different form (FR4)", () => {
    setupForm(`
      <form id="card">
        <input name="cardNumber" />
        <input name="cvv" type="password" />
      </form>
      <form id="login">
        <input name="security_code" type="password" />
      </form>
    `);
    const fields = ccFormFields(document);
    expect(fields.has(byName("cardNumber"))).toBe(true);
    expect(fields.has(byName("cvv"))).toBe(true);
    expect(fields.has(byName("security_code"))).toBe(false);
  });

  it("includes a cc-* autocomplete field outside the card block", () => {
    setupForm(`
      <form id="card">
        <input name="cardNumber" />
        <input name="cvv" type="password" />
      </form>
      <input autocomplete="cc-exp-month" id="standalone-exp" />
    `);
    const fields = ccFormFields(document);
    expect(fields.has(document.getElementById("standalone-exp"))).toBe(true);
  });

  it("<div>-only card block: includes its CVV, excludes a sibling-form security_code (F-S10)", () => {
    setupForm(`
      <div id="checkout">
        <input name="cardNumber" />
        <input name="cvv" type="password" />
      </div>
      <div id="loginBox">
        <form><input name="security_code" type="password" /></form>
      </div>
    `);
    const fields = ccFormFields(document);
    expect(fields.has(byName("cardNumber"))).toBe(true);
    expect(fields.has(byName("cvv"))).toBe(true);
    expect(fields.has(byName("security_code"))).toBe(false);
  });

  it("a form-less <table> card block is found by the ancestor rule", () => {
    setupForm(`
      <table>
        <tr><td><input name="cardNumber" /></td></tr>
        <tr><td><input name="cvv" type="password" /></td></tr>
      </table>
    `);
    const fields = ccFormFields(document);
    expect(fields.has(byName("cardNumber"))).toBe(true);
    expect(fields.has(byName("cvv"))).toBe(true);
  });

  it("includes a form=-associated CVV declared outside the card form", () => {
    setupForm(`
      <form id="cardform"><input name="cardNumber" /></form>
      <input name="cvv" type="password" form="cardform" />
    `);
    const cvv = byName("cvv");
    const cardform = document.getElementById("cardform") as HTMLFormElement;
    // Precondition: jsdom resolves the form="" attribute to the IDL .form.
    expect(cvv.form).toBe(cardform);

    const fields = ccFormFields(document);
    expect(fields.has(byName("cardNumber"))).toBe(true);
    expect(fields.has(cvv)).toBe(true);
  });

  it("falls through to the ancestor rule when the card number's own form has no neighbour", () => {
    setupForm(`
      <div class="wrapper">
        <form id="cardform"><input name="cardNumber" /></form>
        <input name="cvv" type="password" />
      </div>
    `);
    const fields = ccFormFields(document);
    expect(fields.has(byName("cardNumber"))).toBe(true);
    expect(fields.has(byName("cvv"))).toBe(true);
  });

  it("a lone card number with no neighbour is not a member (利用者カード番号 + password login)", () => {
    setupForm(`
      <input name="利用者カード番号" />
      <input type="password" name="pwd" />
    `);
    const fields = ccFormFields(document);
    expect(fields.size).toBe(0);
    expect(fields.has(byName("pwd"))).toBe(false);
  });

  it("an opacity-0 card number forms no block", () => {
    setupForm(`
      <form>
        <input name="cardNumber" style="opacity:0" />
        <input name="cvv" type="password" />
      </form>
    `);
    expect(ccFormFields(document).size).toBe(0);
  });

  it("a <select>-only expiry neighbour anchors the block", () => {
    setupForm(`
      <form>
        <input name="cardNumber" />
        <select name="expMonth"></select>
      </form>
    `);
    const fields = ccFormFields(document);
    expect(fields.has(byName("cardNumber"))).toBe(true);
    expect(fields.has(document.querySelector('[name="expMonth"]'))).toBe(true);
  });

  it("a neighbour in a different form, reachable only via a shared page ancestor, is not swept into the block", () => {
    setupForm(`
      <div class="wrapper">
        <form id="formA"><input name="cardNumber" /></form>
        <form id="formB"><input type="password" name="cvv" /></form>
      </div>
    `);
    const fields = ccFormFields(document);
    expect(fields.has(byName("cardNumber"))).toBe(false);
    expect(fields.has(byName("cvv"))).toBe(false);
  });

  it("same-block collision: account_security_code excluded, a plain username in the same form is not a member", () => {
    setupForm(`
      <form id="card">
        <input name="cardNumber" />
        <input name="account_security_code" type="password" />
        <input name="username" type="text" />
      </form>
    `);
    const fields = ccFormFields(document);
    expect(fields.has(byName("account_security_code"))).toBe(true);
    expect(fields.has(byName("username"))).toBe(false);
  });

  it("without a card number, a field carrying a cc-* autocomplete token is still a member", () => {
    document.body.innerHTML = `
      <form><input id="lone-csc" type="password" name="pin" autocomplete="cc-csc"></form>
      <form><input id="pw" type="password" name="password"></form>
    `;
    const members = ccFormFields(document);
    expect(members.has(document.getElementById("lone-csc") as HTMLElement)).toBe(true);
    // Allow: the ordinary password on the same page is not a member.
    expect(members.has(document.getElementById("pw") as HTMLElement)).toBe(false);
  });
});
