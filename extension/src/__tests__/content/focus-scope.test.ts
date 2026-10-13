/**
 * @vitest-environment jsdom
 */
// C3 (#886): card and identity fill take their T0 fields from the block the
// focused field is in (focusScopedFields), not from the page's first form.
// Every focused field here is visible (T8).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { performCreditCardAutofill } from "../../content/autofill-cc-lib";
import { performIdentityAutofill } from "../../content/autofill-identity-lib";
import { __resetFillSequenceForTests } from "../../content/fill-sequence-lib";
import { EXT_MSG } from "../../lib/constants";
import type { CreditCardAutofillPayload, IdentityAutofillPayload } from "../../types/messages";

if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
}

const NO_WAIT = { lateFieldWindowMs: 0 };

beforeEach(() => {
  Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
});

afterEach(() => {
  __resetFillSequenceForTests();
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.body.innerHTML = "";
});

const CARD: CreditCardAutofillPayload = {
  type: EXT_MSG.AUTOFILL_CC_FILL,
  cardholderName: "",
  cardNumber: "4111111111111111",
  expiryMonth: "12",
  expiryYear: "2027",
  cvv: "123",
};

function card(overrides: Partial<CreditCardAutofillPayload> = {}): CreditCardAutofillPayload {
  return { ...CARD, ...overrides };
}

function identity(overrides: Partial<IdentityAutofillPayload>): IdentityAutofillPayload {
  return {
    type: EXT_MSG.AUTOFILL_IDENTITY_FILL,
    fullName: "",
    givenName: "",
    familyName: "",
    familyNameKana: "",
    givenNameKana: "",
    address: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    country: "",
    phone: "",
    email: "",
    dateOfBirth: "",
    nationality: "",
    ...overrides,
  };
}

function focus(id: string): void {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (!el) throw new Error(`no #${id}`);
  el.focus();
  expect(document.activeElement).toBe(el);
}

/** Values of the given ids, in order. */
function values(...ids: string[]): string[] {
  return ids.map((id) => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) throw new Error(`no #${id}`);
    return el.value;
  });
}

// The #886 reproduction: form 2's expiry is a split MM / YY pair.
const ISSUE_886 = `
  <form id="f1"><label>Card number <input id="n1" name="card_number"></label> <label>Expiry month <input id="m1" name="exp_month"></label> <label>Expiry year <input id="y1" name="exp_year"></label></form>
  <form id="f2"><label>Card number <input id="n2" name="card_number"></label> <label>Expiry date <input id="m2" name="m" placeholder="MM"></label> / <input id="y2" name="y" placeholder="YY"></form>
`;

// The same two forms with a wrapper <div> around each field.
const ISSUE_886_WRAPPED = `
  <form id="f1">
    <div><label>Card number <input id="n1" name="card_number"></label></div>
    <div><label>Expiry month <input id="m1" name="exp_month"></label></div>
    <div><label>Expiry year <input id="y1" name="exp_year"></label></div>
  </form>
  <form id="f2">
    <div><label>Card number <input id="n2" name="card_number"></label></div>
    <div><label>Expiry month <input id="m2" name="exp_month"></label></div>
    <div><label>Expiry year <input id="y2" name="exp_year"></label></div>
  </form>
`;

describe("performCreditCardAutofill — focus scope", () => {
  it("#886 markup: focusing form 2 fills all of form 2 and none of form 1", async () => {
    document.body.innerHTML = ISSUE_886;
    focus("n2");
    await performCreditCardAutofill(card(), NO_WAIT);
    expect(values("n2", "m2", "y2")).toEqual(["4111111111111111", "12", "27"]);
    expect(values("n1", "m1", "y1")).toEqual(["", "", ""]);
  });

  it("#886 markup with a wrapper <div> per field: focusing form 2 fills all of form 2 and none of form 1", async () => {
    document.body.innerHTML = ISSUE_886_WRAPPED;
    focus("n2");
    await performCreditCardAutofill(card(), NO_WAIT);
    expect(values("n2", "m2", "y2")).toEqual(["4111111111111111", "12", "2027"]);
    expect(values("n1", "m1", "y1")).toEqual(["", "", ""]);
  });

  it("focusing form 2's expiry field (not its card number) still fills form 2", async () => {
    document.body.innerHTML = ISSUE_886_WRAPPED;
    focus("y2");
    await performCreditCardAutofill(card(), NO_WAIT);
    expect(values("n2", "m2", "y2")).toEqual(["4111111111111111", "12", "2027"]);
    expect(values("n1", "m1", "y1")).toEqual(["", "", ""]);
  });

  it("focusing form 2's expiry <select> fills form 2 and none of form 1", async () => {
    const months = `<option value="">MM</option><option value="12">12</option>`;
    const years = `<option value="">YYYY</option><option value="2027">2027</option>`;
    const form = (n: number) => `
      <form id="f${n}">
        <div><input id="n${n}" autocomplete="cc-number"></div>
        <div><select id="m${n}" autocomplete="cc-exp-month">${months}</select></div>
        <div><select id="y${n}" autocomplete="cc-exp-year">${years}</select></div>
      </form>
    `;
    document.body.innerHTML = `${form(1)}${form(2)}`;
    focus("m2");
    await performCreditCardAutofill(card(), NO_WAIT);
    expect(values("n2", "m2", "y2")).toEqual(["4111111111111111", "12", "2027"]);
    expect(values("n1", "m1", "y1")).toEqual(["", "", ""]);
  });

  it("with no focused field, form 1 is filled", async () => {
    document.body.innerHTML = ISSUE_886_WRAPPED;
    await performCreditCardAutofill(card(), NO_WAIT);
    expect(values("n1", "m1", "y1")).toEqual(["4111111111111111", "12", "2027"]);
    expect(values("n2", "m2", "y2")).toEqual(["", "", ""]);
  });

  it("focus in a third form with no card number fills form 1; form 2 stays empty", async () => {
    document.body.innerHTML = `${ISSUE_886_WRAPPED}<form id="f3"><input id="coupon" name="coupon"></form>`;
    focus("coupon");
    await performCreditCardAutofill(card(), NO_WAIT);
    expect(values("n1", "m1", "y1")).toEqual(["4111111111111111", "12", "2027"]);
    expect(values("n2", "m2", "y2")).toEqual(["", "", ""]);
  });

  // Mirror: block 1 lacks a CVV that block 2 has, so a scope that climbs past
  // block 1 would borrow block 2's CVV.
  const TWO_BLOCKS = (container: string, close: string) => `
    ${container}
      <div id="b1">
        <input id="n1" autocomplete="cc-number">
        <input id="e1" autocomplete="cc-exp" placeholder="MM/YY">
      </div>
      <div id="b2">
        <input id="n2" autocomplete="cc-number">
        <input id="e2" autocomplete="cc-exp" placeholder="MM/YY">
        <input id="c2" autocomplete="cc-csc">
      </div>
    ${close}
  `;

  it("two card blocks in one <form>: focusing block 1 leaves block 2 untouched", async () => {
    document.body.innerHTML = TWO_BLOCKS(`<form id="checkout">`, `</form>`);
    focus("n1");
    await performCreditCardAutofill(card(), NO_WAIT);
    expect(values("n1", "e1")).toEqual(["4111111111111111", "12/27"]);
    expect(values("n2", "e2", "c2")).toEqual(["", "", ""]);
  });

  it("two card blocks in div-only markup: focusing block 1 leaves block 2 untouched", async () => {
    document.body.innerHTML = TWO_BLOCKS(`<div id="checkout">`, `</div>`);
    focus("n1");
    await performCreditCardAutofill(card(), NO_WAIT);
    expect(values("n1", "e1")).toEqual(["4111111111111111", "12/27"]);
    expect(values("n2", "e2", "c2")).toEqual(["", "", ""]);
  });

  it("two card blocks in div-only markup: focusing block 2 fills block 2 only", async () => {
    document.body.innerHTML = TWO_BLOCKS(`<div id="checkout">`, `</div>`);
    focus("n2");
    await performCreditCardAutofill(card(), NO_WAIT);
    expect(values("n2", "e2", "c2")).toEqual(["4111111111111111", "12/27", "123"]);
    expect(values("n1", "e1")).toEqual(["", ""]);
  });

  it("does not widen to a parent whose detection moves a held role to a field outside the block", async () => {
    // The lone CVV before the focused block is no competing card form, but the
    // parent's detection would take it as the CVV in place of the block's own.
    document.body.innerHTML = `
      <div id="checkout">
        <div id="x"><input id="cvvOther" autocomplete="cc-csc"></div>
        <div id="b">
          <input id="n" autocomplete="cc-number">
          <input id="cvv" autocomplete="cc-csc">
        </div>
      </div>
    `;
    focus("n");
    await performCreditCardAutofill(card(), NO_WAIT);
    expect(values("n", "cvv", "cvvOther")).toEqual(["4111111111111111", "123", ""]);
  });

  it("a split card-number part in a sibling block does not stop the climb: the CVV beyond it is filled", async () => {
    document.body.innerHTML = `
      <form>
        <div id="a">
          <input id="n1" autocomplete="cc-number">
          <input id="exp" autocomplete="cc-exp" placeholder="MM/YY">
        </div>
        <div id="b"><input id="n2" name="card_number_2"></div>
        <div id="c"><input id="cvv" autocomplete="cc-csc"></div>
      </form>
    `;
    focus("n1");
    await performCreditCardAutofill(card(), NO_WAIT);
    expect(values("n1", "exp", "cvv")).toEqual(["4111111111111111", "12/27", "123"]);
  });
});

describe("performIdentityAutofill — focus scope", () => {
  const TWO_FORMS = `
    <form id="f1">
      <div><input id="name1" autocomplete="name"></div>
      <div><input id="email1" type="email" autocomplete="email"></div>
      <div><input id="tel1" autocomplete="tel"></div>
    </form>
    <form id="f2">
      <div><input id="name2" autocomplete="name"></div>
      <div><input id="email2" type="email" autocomplete="email"></div>
      <div><input id="tel2" autocomplete="tel"></div>
    </form>
  `;
  const PERSON = { fullName: "Jane Doe", email: "j@example.com", phone: "555-1234" };

  it("two forms, a wrapper <div> per field: focusing form 2 fills all of form 2 and none of form 1", async () => {
    document.body.innerHTML = TWO_FORMS;
    focus("email2");
    await performIdentityAutofill(identity(PERSON), NO_WAIT);
    expect(values("name2", "email2", "tel2")).toEqual(["Jane Doe", "j@example.com", "555-1234"]);
    expect(values("name1", "email1", "tel1")).toEqual(["", "", ""]);
  });

  it("two forms, form-level markup: focusing form 2 fills all of form 2 and none of form 1", async () => {
    document.body.innerHTML = `
      <form><input id="name1" autocomplete="name"><input id="email1" type="email" autocomplete="email"><input id="tel1" autocomplete="tel"></form>
      <form><input id="name2" autocomplete="name"><input id="email2" type="email" autocomplete="email"><input id="tel2" autocomplete="tel"></form>
    `;
    focus("tel2");
    await performIdentityAutofill(identity(PERSON), NO_WAIT);
    expect(values("name2", "email2", "tel2")).toEqual(["Jane Doe", "j@example.com", "555-1234"]);
    expect(values("name1", "email1", "tel1")).toEqual(["", "", ""]);
  });

  it("with no focused field, form 1 is filled", async () => {
    document.body.innerHTML = TWO_FORMS;
    await performIdentityAutofill(identity(PERSON), NO_WAIT);
    expect(values("name1", "email1", "tel1")).toEqual(["Jane Doe", "j@example.com", "555-1234"]);
    expect(values("name2", "email2", "tel2")).toEqual(["", "", ""]);
  });

  // Mirror: block 1 lacks the phone block 2 has.
  const TWO_BLOCKS = (container: string, close: string) => `
    ${container}
      <div id="billing"><input id="name1" autocomplete="name"><input id="email1" type="email" autocomplete="email"></div>
      <div id="shipping"><input id="name2" autocomplete="name"><input id="email2" type="email" autocomplete="email"><input id="tel2" autocomplete="tel"></div>
    ${close}
  `;

  it("two blocks in one <form>: focusing block 1 leaves block 2 untouched", async () => {
    document.body.innerHTML = TWO_BLOCKS(`<form>`, `</form>`);
    focus("email1");
    await performIdentityAutofill(identity(PERSON), NO_WAIT);
    expect(values("name1", "email1")).toEqual(["Jane Doe", "j@example.com"]);
    expect(values("name2", "email2", "tel2")).toEqual(["", "", ""]);
  });

  it("two blocks in div-only markup: focusing block 1 leaves block 2 untouched", async () => {
    document.body.innerHTML = TWO_BLOCKS(`<div id="checkout">`, `</div>`);
    focus("email1");
    await performIdentityAutofill(identity(PERSON), NO_WAIT);
    expect(values("name1", "email1")).toEqual(["Jane Doe", "j@example.com"]);
    expect(values("name2", "email2", "tel2")).toEqual(["", "", ""]);
  });

  it("one form with a confirm-email row and a 3-input phone, focused on email, fills every role", async () => {
    document.body.innerHTML = `
      <form>
        <div class="row"><input id="name" autocomplete="name"><input id="email" type="email" autocomplete="email"></div>
        <div class="row">
          <input id="emailConfirm" type="email" name="confirm_email" placeholder="Confirm email">
          <input id="tel1" type="tel" autocomplete="tel" name="phone1">
          <input id="tel2" type="tel" name="phone2">
          <input id="tel3" type="tel" name="phone3">
        </div>
        <div class="row"><input id="addr" autocomplete="address-line1"><input id="zip" autocomplete="postal-code"></div>
      </form>
    `;
    focus("email");
    await performIdentityAutofill(
      identity({ ...PERSON, address: "1 Main St", postalCode: "100-0001" }),
      NO_WAIT,
    );
    expect(values("name", "email", "tel1", "addr", "zip")).toEqual([
      "Jane Doe",
      "j@example.com",
      "555-1234",
      "1 Main St",
      "100-0001",
    ]);
  });
});
