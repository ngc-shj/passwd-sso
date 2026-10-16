/**
 * @vitest-environment jsdom
 */
// C1 on every content fill path (#884): a field hidden by the shared
// visibility rule is not written, and a visible sibling in the same markup is.
// Geometry comes from the global layout stub (helpers/layout-stub.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { performCreditCardAutofill } from "../../content/autofill-cc-lib";
import { performIdentityAutofill } from "../../content/autofill-identity-lib";
import { performAutofill } from "../../content/autofill-lib";
import { ccFormFields } from "../../content/cc-field-detection-lib";
import {
  __resetFillSequenceForTests,
  DEFAULT_LATE_FIELD_WINDOW_MS,
} from "../../content/fill-sequence-lib";
import { EXT_MSG, AUTOFILL_FILL } from "../../lib/constants";
import type {
  AutofillPayload,
  CreditCardAutofillPayload,
  IdentityAutofillPayload,
} from "../../types/messages";

if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
}

const NO_WAIT = { lateFieldWindowMs: 0 };
const PAGE_HOST = new URL(window.location.href).hostname;
// Select2 / selectWoo's .select2-hidden-accessible: a clipped 1px native select.
const SELECT2 = `style="position:absolute; clip:rect(0px, 0px, 0px, 0px)" data-rect="1,1,0,0"`;

beforeEach(() => {
  Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
});

afterEach(() => {
  __resetFillSequenceForTests();
  document.body.innerHTML = "";
});

function value(id: string): string {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (!el) throw new Error(`no #${id}`);
  return el.value;
}

function cc(overrides: Partial<CreditCardAutofillPayload> = {}): CreditCardAutofillPayload {
  return {
    type: EXT_MSG.AUTOFILL_CC_FILL,
    cardholderName: "",
    cardNumber: "4111111111111111",
    expiryMonth: "12",
    expiryYear: "2027",
    cvv: "123",
    ...overrides,
  };
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

function login(overrides: Partial<AutofillPayload>): AutofillPayload {
  return {
    type: AUTOFILL_FILL,
    allowedHosts: [PAGE_HOST],
    username: "",
    password: "",
    ...overrides,
  };
}

const MONTHS = `<option value="">Month</option><option value="01">01</option><option value="12">12</option>`;
const YEARS = `<option value="">Year</option><option value="2026">2026</option><option value="2027">2027</option>`;
const COUNTRIES = `<option value="">Country</option><option value="JP">Japan</option><option value="US">United States</option>`;
const REGIONS = `<option value="">State</option><option value="CA">California</option><option value="NY">New York</option>`;

// ── Credit card ──

describe("performCreditCardAutofill — hidden fields", () => {
  it("does not write a CVV under a display:none ancestor; writes the visible CVV after it", async () => {
    document.body.innerHTML = `
      <input id="num" autocomplete="cc-number">
      <div style="display:none"><input id="cvvHidden" autocomplete="cc-csc"></div>
      <input id="cvv" autocomplete="cc-csc">
    `;
    await performCreditCardAutofill(cc(), NO_WAIT);
    expect([value("num"), value("cvvHidden"), value("cvv")]).toEqual(["4111111111111111", "", "123"]);
  });

  it("does not write a zero-rect cardholder name; writes the visible one after it", async () => {
    document.body.innerHTML = `
      <input id="nameHidden" autocomplete="cc-name" data-rect="0,0,0,0">
      <input id="name" autocomplete="cc-name">
      <input id="num" autocomplete="cc-number">
    `;
    await performCreditCardAutofill(cc({ cardholderName: "Jane Doe" }), NO_WAIT);
    expect([value("nameHidden"), value("name")]).toEqual(["", "Jane Doe"]);
  });

  it("writes Select2-style hidden expiry month and year selects", async () => {
    document.body.innerHTML = `
      <input id="num" autocomplete="cc-number">
      <select id="month" autocomplete="cc-exp-month" ${SELECT2}>${MONTHS}</select>
      <select id="year" autocomplete="cc-exp-year" ${SELECT2}>${YEARS}</select>
    `;
    await performCreditCardAutofill(cc(), NO_WAIT);
    expect([value("month"), value("year")]).toEqual(["12", "2027"]);
  });

  it("does not write expiry selects under a display:none ancestor", async () => {
    document.body.innerHTML = `
      <input id="num" autocomplete="cc-number">
      <div style="display:none">
        <select id="month" autocomplete="cc-exp-month" ${SELECT2}>${MONTHS}</select>
        <select id="year" autocomplete="cc-exp-year" ${SELECT2}>${YEARS}</select>
      </div>
    `;
    await performCreditCardAutofill(cc(), NO_WAIT);
    expect([value("num"), value("month"), value("year")]).toEqual(["4111111111111111", "", ""]);
  });

  it("does not write expiry selects in a closed <details>", async () => {
    document.body.innerHTML = `
      <input id="num" autocomplete="cc-number">
      <details><summary>Expiry</summary>
        <select id="month" autocomplete="cc-exp-month">${MONTHS}</select>
        <select id="year" autocomplete="cc-exp-year">${YEARS}</select>
      </details>
    `;
    await performCreditCardAutofill(cc(), NO_WAIT);
    expect([value("num"), value("month"), value("year")]).toEqual(["4111111111111111", "", ""]);
  });

  it("does not write an expiry text input with the Select2 geometry (the exemption is for selects)", async () => {
    document.body.innerHTML = `
      <input id="num" autocomplete="cc-number">
      <input id="month" autocomplete="cc-exp-month" ${SELECT2}>
    `;
    await performCreditCardAutofill(cc(), NO_WAIT);
    expect([value("num"), value("month")]).toEqual(["4111111111111111", ""]);
  });

  // The dropdown admits a field under a transparent ancestor (a fade-in modal);
  // the fill's own rule still denies it (visibility-detectors.test.ts).
  it.each([
    ["opacity:0", ["", ""]],
    ["opacity:1", ["4111111111111111", "123"]],
  ])("a card form under an ancestor with %s: written only when rendered", async (opacity, expected) => {
    document.body.innerHTML = `
      <div style="${opacity}"><input id="num" autocomplete="cc-number"><input id="cvv" autocomplete="cc-csc"></div>
    `;
    await performCreditCardAutofill(cc(), NO_WAIT);
    expect([value("num"), value("cvv")]).toEqual(expected);
  });
});

// ── Identity ──

describe("performIdentityAutofill — hidden fields", () => {
  it("does not write a phone in an opacity:0 wrapper; writes the visible phone after it", async () => {
    document.body.innerHTML = `
      <input id="name" autocomplete="name">
      <div style="opacity:0"><input id="telHidden" autocomplete="tel"></div>
      <input id="tel" autocomplete="tel">
    `;
    await performIdentityAutofill(identity({ fullName: "Jane Doe", phone: "555-1234" }), NO_WAIT);
    expect([value("name"), value("telHidden"), value("tel")]).toEqual(["Jane Doe", "", "555-1234"]);
  });

  it("does not write a zero-rect email; writes the visible email after it", async () => {
    document.body.innerHTML = `
      <input id="name" autocomplete="name">
      <input id="emailHidden" autocomplete="email" data-rect="0,0,0,0">
      <input id="email" autocomplete="email">
    `;
    await performIdentityAutofill(identity({ fullName: "Jane Doe", email: "j@example.com" }), NO_WAIT);
    expect([value("emailHidden"), value("email")]).toEqual(["", "j@example.com"]);
  });

  it("writes Select2-style hidden country and region selects", async () => {
    document.body.innerHTML = `
      <input id="name" autocomplete="name">
      <select id="country" autocomplete="country-name" ${SELECT2}>${COUNTRIES}</select>
      <select id="region" autocomplete="address-level1" ${SELECT2}>${REGIONS}</select>
    `;
    await performIdentityAutofill(
      identity({ fullName: "Jane Doe", country: "JP", state: "CA" }),
      NO_WAIT,
    );
    expect([value("country"), value("region")]).toEqual(["JP", "CA"]);
  });

  it("does not write a Select2-style hidden date-of-birth select", async () => {
    document.body.innerHTML = `
      <input id="name" autocomplete="name">
      <input id="tel" autocomplete="tel">
      <select id="dob" autocomplete="bday" ${SELECT2}>
        <option value=""></option><option value="1990-01-15">1990-01-15</option>
      </select>
    `;
    await performIdentityAutofill(
      identity({ fullName: "Jane Doe", phone: "555", dateOfBirth: "1990-01-15" }),
      NO_WAIT,
    );
    expect([value("name"), value("dob")]).toEqual(["Jane Doe", ""]);
  });

  it("writes the same date-of-birth select when it is rendered", async () => {
    document.body.innerHTML = `
      <input id="name" autocomplete="name">
      <input id="tel" autocomplete="tel">
      <select id="dob" autocomplete="bday">
        <option value=""></option><option value="1990-01-15">1990-01-15</option>
      </select>
    `;
    await performIdentityAutofill(
      identity({ fullName: "Jane Doe", phone: "555", dateOfBirth: "1990-01-15" }),
      NO_WAIT,
    );
    expect(value("dob")).toBe("1990-01-15");
  });

  it("does not write a country select under a display:none ancestor", async () => {
    document.body.innerHTML = `
      <input id="name" autocomplete="name">
      <input id="tel" autocomplete="tel">
      <div style="display:none"><select id="country" autocomplete="country-name" ${SELECT2}>${COUNTRIES}</select></div>
    `;
    await performIdentityAutofill(
      identity({ fullName: "Jane Doe", phone: "555", country: "JP" }),
      NO_WAIT,
    );
    expect([value("name"), value("country")]).toEqual(["Jane Doe", ""]);
  });

  it("does not write a region select in a closed <details>", async () => {
    document.body.innerHTML = `
      <input id="name" autocomplete="name">
      <input id="tel" autocomplete="tel">
      <details><summary>Address</summary>
        <select id="region" autocomplete="address-level1">${REGIONS}</select>
      </details>
    `;
    await performIdentityAutofill(
      identity({ fullName: "Jane Doe", phone: "555", state: "CA" }),
      NO_WAIT,
    );
    expect([value("name"), value("region")]).toEqual(["Jane Doe", ""]);
  });
});

// ── LOGIN ──

describe("performAutofill — username", () => {
  it("skips a hidden autocomplete=username placed before the visible one", async () => {
    document.body.innerHTML = `
      <div style="display:none"><input id="userHidden" type="text" autocomplete="username"></div>
      <input id="user" type="text" autocomplete="username">
      <input id="pw" type="password">
    `;
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("userHidden"), value("user"), value("pw")]).toEqual(["", "alice", "pw1"]);
  });

  it("the backward walk from the password skips a hidden username-like field", async () => {
    document.body.innerHTML = `
      <input id="user" type="text" name="username">
      <input id="loginHidden" type="text" name="login" data-rect="0,0,0,0">
      <input id="pw" type="password">
    `;
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("user"), value("loginHidden")]).toEqual(["alice", ""]);
  });

  it("a focused zero-rect text input is not the username; the visible one is", async () => {
    document.body.innerHTML = `
      <input id="user" type="text" name="username">
      <input id="focused" type="email" name="email" data-rect="0,0,0,0">
      <input id="pw" type="password">
    `;
    (document.getElementById("focused") as HTMLInputElement).focus();
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("focused"), value("user")]).toEqual(["", "alice"]);
  });

  it("a hinted hidden input is not the username; the visible one is", async () => {
    document.body.innerHTML = `
      <input id="user" type="text" name="username">
      <div style="display:none"><input id="hinted" type="text" name="email"></div>
      <input id="pw" type="password">
    `;
    await performAutofill(
      login({ username: "alice", password: "pw1", targetHint: { id: "hinted" } }),
      NO_WAIT,
    );
    expect([value("hinted"), value("user")]).toEqual(["", "alice"]);
  });

  it("a username hidden by the page before its write is not written", async () => {
    document.body.innerHTML = `
      <input id="memo" type="text" name="memo">
      <input id="user" type="text" name="username">
      <input id="pw" type="password">
    `;
    // The custom-field step writes first; its input handler hides the username.
    document.getElementById("memo")?.addEventListener("input", () => {
      (document.getElementById("user") as HTMLInputElement).style.display = "none";
    });
    await performAutofill(
      login({ username: "alice", password: "pw1", customFields: [{ label: "memo", value: "m" }] }),
      NO_WAIT,
    );
    expect([value("memo"), value("user"), value("pw")]).toEqual(["m", "", "pw1"]);
  });
});

describe("performAutofill — password", () => {
  it("does not write a password under a display:none ancestor after the visible one", async () => {
    document.body.innerHTML = `
      <input id="user" type="text" name="username">
      <input id="pw" type="password">
      <div style="display:none"><input id="pwHidden" type="password"></div>
    `;
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("pw"), value("pwHidden")]).toEqual(["pw1", ""]);
  });

  it.each([
    ["opacity:0", ""],
    ["opacity:1", "pw1"],
  ])("a password under an ancestor with %s: written only when rendered", async (opacity, expected) => {
    document.body.innerHTML = `
      <input id="user" type="text" name="username">
      <div style="${opacity}"><input id="pw" type="password"></div>
    `;
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect(value("pw")).toBe(expected);
  });

  it("does not write a password placed off the document origin (left:-9999px)", async () => {
    document.body.innerHTML = `
      <input id="user" type="text" name="username">
      <input id="pw" type="password">
      <input id="pwHidden" type="password" data-rect="100,20,-9999,10">
    `;
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("pw"), value("pwHidden")]).toEqual(["pw1", ""]);
  });

  it("does not write a password in a 2px overflow:hidden box", async () => {
    document.body.innerHTML = `
      <input id="user" type="text" name="username">
      <input id="pw" type="password">
      <div style="overflow-x:hidden; overflow-y:hidden" data-rect="2,2,0,0"><input id="pwHidden" type="password"></div>
    `;
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("pw"), value("pwHidden")]).toEqual(["pw1", ""]);
  });

  it("skips a hidden autocomplete=current-password placed before the visible password", async () => {
    document.body.innerHTML = `
      <input id="user" type="text" name="username">
      <div style="display:none"><input id="pwHidden" type="password" autocomplete="current-password"></div>
      <input id="pw" type="password" autocomplete="current-password">
    `;
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("pwHidden"), value("pw")]).toEqual(["", "pw1"]);
  });

  it("writes a field below the fold of an overflow-y:auto pane", async () => {
    document.body.innerHTML = `
      <div style="overflow-y:auto" data-rect="300,200,0,0">
        <input id="user" type="text" name="username" data-rect="100,20,10,4000">
        <input id="pw" type="password" data-rect="100,20,10,5000">
      </div>
    `;
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("user"), value("pw")]).toEqual(["alice", "pw1"]);
  });

  it("writes a field below the fold of an inner auto pane inside an outer overflow:hidden wrapper", async () => {
    document.body.innerHTML = `
      <div style="overflow-x:hidden; overflow-y:hidden" data-rect="300,200,0,0">
        <div style="overflow-y:auto" data-rect="300,200,0,0">
          <input id="user" type="text" name="username" data-rect="100,20,10,4000">
          <input id="pw" type="password" data-rect="100,20,10,5000">
        </div>
      </div>
    `;
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("user"), value("pw")]).toEqual(["alice", "pw1"]);
  });

  it.each([
    ["overflow-y:hidden; height 0", "overflow-y:hidden", "300,0,0,0"],
    ["overflow-y:auto; height 0", "overflow-y:auto", "300,0,0,0"],
    ["overflow-y:auto; height 2px", "overflow-y:auto", "300,2,0,0"],
  ])("does not write a password in a pane with %s", async (_label, style, rect) => {
    document.body.innerHTML = `
      <input id="user" type="text" name="username">
      <input id="pw" type="password">
      <div style="${style}" data-rect="${rect}"><input id="pwHidden" type="password" data-rect="100,20,10,5000"></div>
    `;
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("pw"), value("pwHidden")]).toEqual(["pw1", ""]);
  });
});

describe("performAutofill — custom fields", () => {
  it("does not write an opacity:0 input matching the label; writes the visible match", async () => {
    document.body.innerHTML = `
      <input id="memoHidden" type="text" name="memo" style="opacity:0">
      <input id="memo" type="text" name="memo">
    `;
    await performAutofill(login({ customFields: [{ label: "memo", value: "m1" }] }), NO_WAIT);
    expect([value("memoHidden"), value("memo")]).toEqual(["", "m1"]);
  });

  it("does not write a custom field under a display:none ancestor", async () => {
    document.body.innerHTML = `
      <div style="display:none"><input id="memoHidden" type="text" name="memo"></div>
      <input id="memo" type="text" name="memo">
    `;
    await performAutofill(login({ customFields: [{ label: "memo", value: "m1" }] }), NO_WAIT);
    expect([value("memoHidden"), value("memo")]).toEqual(["", "m1"]);
  });
});

describe("performAutofill — OTP", () => {
  it("writes an opacity:0 overlay single OTP input", async () => {
    document.body.innerHTML = `
      <div class="otp-boxes"><input id="otp" type="text" autocomplete="one-time-code" style="opacity:0"></div>
    `;
    await performAutofill(login({ totpCode: "123456" }), NO_WAIT);
    expect(value("otp")).toBe("123456");
  });

  it("writes an opacity:0 overlay split OTP group", async () => {
    document.body.innerHTML = `<form>${Array.from(
      { length: 6 },
      (_, i) => `<input id="d${i}" type="text" maxlength="1" style="opacity:0">`,
    ).join("")}</form>`;
    await performAutofill(login({ totpCode: "123456" }), NO_WAIT);
    expect(Array.from({ length: 6 }, (_, i) => value(`d${i}`)).join("")).toBe("123456");
  });

  it("skips a hidden autocomplete=one-time-code placed before the visible one", async () => {
    document.body.innerHTML = `
      <div style="display:none"><input id="otpHidden" type="text" autocomplete="one-time-code"></div>
      <input id="otp" type="text" autocomplete="one-time-code">
    `;
    await performAutofill(login({ totpCode: "123456" }), NO_WAIT);
    expect([value("otpHidden"), value("otp")]).toEqual(["", "123456"]);
  });

  it("skips a hidden name=otp field placed before the visible one", async () => {
    document.body.innerHTML = `
      <input id="otpHidden" type="text" name="otp" data-rect="0,0,0,0">
      <input id="otp" type="text" name="otp">
    `;
    await performAutofill(login({ totpCode: "123456" }), NO_WAIT);
    expect([value("otpHidden"), value("otp")]).toEqual(["", "123456"]);
  });

  it("skips a hidden split-OTP group placed before the visible group", async () => {
    const group = (prefix: string) =>
      Array.from({ length: 6 }, (_, i) => `<input id="${prefix}${i}" type="text" maxlength="1">`).join("");
    document.body.innerHTML = `
      <div style="display:none"><form>${group("h")}</form></div>
      <form>${group("v")}</form>
    `;
    await performAutofill(login({ totpCode: "123456" }), NO_WAIT);
    const visible = Array.from({ length: 6 }, (_, i) => value(`v${i}`)).join("");
    const hidden = Array.from({ length: 6 }, (_, i) => value(`h${i}`)).join("");
    expect([hidden, visible]).toEqual(["", "123456"]);
  });

  it("does not write an OTP input under a display:none ancestor even with transparentOk", async () => {
    document.body.innerHTML = `
      <div style="display:none"><input id="otp" type="text" autocomplete="one-time-code" style="opacity:0"></div>
    `;
    await performAutofill(login({ totpCode: "123456" }), NO_WAIT);
    expect(value("otp")).toBe("");
  });
});

// ── Card-form exclusion keeps the own-style rule (isNotSelfHidden) ──

describe("performAutofill — card-form exclusion", () => {
  it("a card number hidden by an ancestor still excludes its CVV from LOGIN", async () => {
    document.body.innerHTML = `
      <input id="user" type="text" name="username">
      <input id="loginpw" type="password" name="password">
      <form>
        <div style="display:none"><input id="ccnum" type="text" name="card_number"></div>
        <input id="cvv" type="password" name="cvv">
      </form>
    `;
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("loginpw"), value("cvv")]).toEqual(["pw1", ""]);
  });

  it("a zero-rect card number still excludes its CVV from LOGIN", async () => {
    document.body.innerHTML = `
      <input id="user" type="text" name="username">
      <input id="loginpw" type="password" name="password">
      <form>
        <input id="ccnum" type="text" name="card_number" data-rect="0,0,0,0">
        <input id="cvv" type="password" name="cvv">
      </form>
    `;
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("loginpw"), value("cvv")]).toEqual(["pw1", ""]);
  });

  it("a card number whose only card neighbour is hidden by an ancestor is still in the card form", () => {
    document.body.innerHTML = `
      <form>
        <input id="ccnum" type="text" name="card_number">
        <div style="display:none"><input id="exp" type="text" name="exp_month"></div>
      </form>
    `;
    expect(ccFormFields(document).has(document.getElementById("ccnum") as HTMLElement)).toBe(true);
  });

  it("a hidden card form before a visible one leaves the visible CVV LOGIN-ineligible", async () => {
    document.body.innerHTML = `
      <input id="user" type="text" name="username">
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
    await performAutofill(login({ username: "alice", password: "pw1" }), NO_WAIT);
    expect([value("loginpw"), value("cvv2")]).toEqual(["pw1", ""]);
  });
});

// ── Fill-root boundary keeps the own-style rule (isNotSelfHidden) ──
//
// A foreign control hidden only by an ancestor or a zero rect still bounds the
// root, so a late password appearing beyond it is not relocated into. The
// visible-control case of the same markup is in autofill.test.ts.
describe("performAutofill — a hidden foreign control still bounds the fill root", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function fillWithLatePasswordIn(html: string, slotId: string): Promise<HTMLInputElement> {
    document.body.innerHTML = html;
    (document.getElementById("user") as HTMLInputElement).focus();
    const fill = performAutofill(login({ username: "alice", password: "secret" }));
    await vi.advanceTimersByTimeAsync(5);
    const late = document.createElement("input");
    late.type = "password";
    late.id = "late";
    (document.getElementById(slotId) as HTMLElement).appendChild(late);
    await vi.advanceTimersByTimeAsync(DEFAULT_LATE_FIELD_WINDOW_MS + 100);
    await fill;
    return late;
  }

  it.each([
    ["under a display:none ancestor", `<div style="display:none"><input id="search" type="text"></div>`],
    ["with a zero rect", `<input id="search" type="text" data-rect="0,0,0,0">`],
  ])("a foreign control %s: a late password beyond it is not written", async (_label, control) => {
    const html = `
      <div id="app">
        <section id="login"><div><input id="user" type="text"></div><div id="slot"></div></section>
        <section id="other">${control}<div id="far"></div></section>
      </div>
    `;
    expect((await fillWithLatePasswordIn(html, "far")).value).toBe("");
  });

  it("control: the same late password inside the login section is written", async () => {
    const html = `
      <div id="app">
        <section id="login"><div><input id="user" type="text"></div><div id="slot"></div></section>
        <section id="other"><div style="display:none"><input id="search" type="text"></div><div id="far"></div></section>
      </div>
    `;
    expect((await fillWithLatePasswordIn(html, "slot")).value).toBe("secret");
  });
});

describe("card and identity fill — a hidden foreign control still bounds the fill root", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const LAYOUT = (block: string) => `
    <div id="app">
      <section id="mine"><div>${block}</div><div id="slot"></div></section>
      <section id="other"><div style="display:none"><input id="search" type="text"></div><div id="far"></div></section>
    </div>
  `;

  async function withLateField(
    run: () => Promise<unknown>,
    slotId: string,
    lateAttrs: string,
  ): Promise<HTMLInputElement> {
    const fill = run();
    await vi.advanceTimersByTimeAsync(5);
    const holder = document.createElement("div");
    holder.innerHTML = `<input id="late" ${lateAttrs}>`;
    const late = holder.firstElementChild as HTMLInputElement;
    (document.getElementById(slotId) as HTMLElement).appendChild(late);
    await vi.advanceTimersByTimeAsync(DEFAULT_LATE_FIELD_WINDOW_MS + 100);
    await fill;
    return late;
  }

  for (const [slot, expected] of [["far", ""], ["slot", "123"]] as const) {
    it(`CC: a late CVV in #${slot} is ${expected ? "written" : "not written"}`, async () => {
      document.body.innerHTML = LAYOUT(`<input id="num" autocomplete="cc-number">`);
      const late = await withLateField(
        () => performCreditCardAutofill(cc()),
        slot,
        'autocomplete="cc-csc"',
      );
      expect(late.value).toBe(expected);
    });
  }

  for (const [slot, expected] of [["far", ""], ["slot", "555-1234"]] as const) {
    it(`identity: a late phone in #${slot} is ${expected ? "written" : "not written"}`, async () => {
      document.body.innerHTML = LAYOUT(
        `<input id="name" autocomplete="name"><input id="email" autocomplete="email">`,
      );
      const late = await withLateField(
        () =>
          performIdentityAutofill(
            identity({ fullName: "Jane Doe", email: "j@example.com", phone: "555-1234" }),
          ),
        slot,
        'autocomplete="tel"',
      );
      expect(late.value).toBe(expected);
    });
  }
});
