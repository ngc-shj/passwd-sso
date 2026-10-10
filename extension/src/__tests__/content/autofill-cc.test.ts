/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { performCreditCardAutofill } from "../../content/autofill-cc-lib";
import { performIdentityAutofill } from "../../content/autofill-identity-lib";
import {
  __resetFillSequenceForTests,
  DEFAULT_LATE_FIELD_WINDOW_MS,
} from "../../content/fill-sequence-lib";
import { EXT_MSG } from "../../lib/constants";
import type { CreditCardAutofillPayload } from "../../types/messages";

beforeEach(() => {
  Object.defineProperty(navigator, "language", {
    value: "en-US",
    configurable: true,
  });
});

// vi.spyOn on an already-spied method returns the existing mock with its call
// history intact, and vitest.config.ts sets no restoreMocks — without this the
// console assertions below become order-dependent.
afterEach(() => {
  __resetFillSequenceForTests();
  vi.restoreAllMocks();
});

// Existing rows assert T0 targets only: a zero late-field window keeps them free
// of the deferral wait (every T0 target is still written).
const NO_WAIT = { lateFieldWindowMs: 0 };

function setupForm(html: string) {
  document.body.innerHTML = html;
}

describe("performCreditCardAutofill", () => {
  it("fills fields by autocomplete attributes", async () => {
    setupForm(`
      <input autocomplete="cc-name" />
      <input autocomplete="cc-number" />
      <input autocomplete="cc-exp-month" />
      <input autocomplete="cc-exp-year" />
      <input autocomplete="cc-csc" />
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "John Doe",
      cardNumber: "4111111111111111",
      expiryMonth: "12",
      expiryYear: "2025",
      cvv: "123",
    }, NO_WAIT);

    const inputs = document.querySelectorAll("input");
    expect((inputs[0] as HTMLInputElement).value).toBe("John Doe");
    expect((inputs[1] as HTMLInputElement).value).toBe("4111111111111111");
    expect((inputs[2] as HTMLInputElement).value).toBe("12");
    expect((inputs[3] as HTMLInputElement).value).toBe("2025");
    expect((inputs[4] as HTMLInputElement).value).toBe("123");
  });

  it("fills combined expiry field (MM/YY)", async () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <input autocomplete="cc-exp" placeholder="MM/YY" />
      <input autocomplete="cc-csc" />
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "3",
      expiryYear: "2026",
      cvv: "456",
    }, NO_WAIT);

    const expInput = document.querySelector('[autocomplete="cc-exp"]') as HTMLInputElement;
    expect(expInput.value).toBe("03/26");
  });

  it("fills select elements for expiry", async () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select autocomplete="cc-exp-month">
        <option value="">Month</option>
        <option value="01">January</option>
        <option value="02">February</option>
        <option value="12">December</option>
      </select>
      <select autocomplete="cc-exp-year">
        <option value="">Year</option>
        <option value="2025">2025</option>
        <option value="2026">2026</option>
      </select>
      <input autocomplete="cc-csc" />
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "12",
      expiryYear: "2026",
      cvv: "789",
    }, NO_WAIT);

    const monthSelect = document.querySelector('[autocomplete="cc-exp-month"]') as HTMLSelectElement;
    const yearSelect = document.querySelector('[autocomplete="cc-exp-year"]') as HTMLSelectElement;
    expect(monthSelect.value).toBe("12");
    expect(yearSelect.value).toBe("2026");
  });

  it("normalizes month select values (1 matches 01)", async () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select autocomplete="cc-exp-month">
        <option value="">Month</option>
        <option value="1">1</option>
        <option value="2">2</option>
      </select>
      <input autocomplete="cc-csc" />
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "01",
      expiryYear: "2026",
      cvv: "",
    }, NO_WAIT);

    const monthSelect = document.querySelector('[autocomplete="cc-exp-month"]') as HTMLSelectElement;
    expect(monthSelect.value).toBe("1");
  });

  it("does not fill when no card number field exists", async () => {
    setupForm(`
      <input type="text" name="username" />
      <input type="password" />
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "Test",
      cardNumber: "4111111111111111",
      expiryMonth: "12",
      expiryYear: "2025",
      cvv: "123",
    }, NO_WAIT);

    const inputs = document.querySelectorAll("input");
    expect((inputs[0] as HTMLInputElement).value).toBe("");
    expect((inputs[1] as HTMLInputElement).value).toBe("");
  });

  it("skips display:none input (visibility check)", async () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <input autocomplete="cc-name" style="display: none" />
      <input autocomplete="cc-csc" />
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "Hidden Name",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "",
      cvv: "123",
    }, NO_WAIT);

    const nameInput = document.querySelector('[autocomplete="cc-name"]') as HTMLInputElement;
    expect(nameInput.value).toBe("");
  });

  it("skips visibility:hidden select (visibility check)", async () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select autocomplete="cc-exp-month" style="visibility: hidden">
        <option value="01">01</option>
      </select>
      <input autocomplete="cc-csc" />
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "01",
      expiryYear: "",
      cvv: "",
    }, NO_WAIT);

    const monthSelect = document.querySelector('[autocomplete="cc-exp-month"]') as HTMLSelectElement;
    expect(monthSelect.value).toBe("01"); // unchanged from initial
  });

  it("wipes cvv from payload after fill", async () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <input autocomplete="cc-csc" />
    `);

    const payload = {
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "",
      cvv: "999",
    };

    await performCreditCardAutofill(payload, NO_WAIT);

    expect(payload.cvv).toBe("");
  });

  it("does NOT write cvv into an unrelated conf_number field in a separate section", async () => {
    // Security: a card form plus an order-confirmation section elsewhere. The
    // conf_number must not receive the CVV — it is not co-located with the card
    // number field. (No autocomplete=cc-csc, so the regex fallback path runs.)
    setupForm(`
      <div id="payment">
        <input name="card_no" type="text" />
      </div>
      <div id="order-summary">
        <input name="conf_number" type="text" />
      </div>
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "",
      cvv: "321",
    }, NO_WAIT);

    const conf = document.querySelector('[name="conf_number"]') as HTMLInputElement;
    expect(conf.value).toBe("");
    const card = document.querySelector('[name="card_no"]') as HTMLInputElement;
    expect(card.value).toBe("4111111111111111");
  });

  it("writes cvv into a co-located conf_number (form-less table, ドスパラ)", async () => {
    setupForm(`
      <table>
        <tr><td><input name="ccno" type="text" /></td></tr>
        <tr><td><input name="conf_number" type="password" /></td></tr>
      </table>
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "",
      cvv: "321",
    }, NO_WAIT);

    const conf = document.querySelector('[name="conf_number"]') as HTMLInputElement;
    expect(conf.value).toBe("321");
  });

  it("does not fill login fields when CC autofill runs (non-destructive)", async () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
      <input autocomplete="cc-number" />
      <input autocomplete="cc-csc" />
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "",
      cvv: "123",
    }, NO_WAIT);

    const usernameInput = document.querySelector('[autocomplete="username"]') as HTMLInputElement;
    const passwordInput = document.querySelector('[autocomplete="current-password"]') as HTMLInputElement;
    expect(usernameInput.value).toBe("");
    expect(passwordInput.value).toBe("");
  });

  // ── C3/C7: year select 2-digit / 4-digit / textContent-fallback fill ──

  it("ドスパラ style: stored 2030 fills a 2-digit <option value=\"30\">", async () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select name="exp_year">
        <option value="26">26</option>
        <option value="30">30</option>
        <option value="35">35</option>
      </select>
      <input autocomplete="cc-csc" />
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "2030",
      cvv: "",
    }, NO_WAIT);

    const yearSelect = document.querySelector('[name="exp_year"]') as HTMLSelectElement;
    expect(yearSelect.value).toBe("30");
  });

  it("さくら style: stored 2030 fills a 4-digit <option value=\"2030\">", async () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select name="expyear">
        <option value="2026">2026</option>
        <option value="2030">2030</option>
        <option value="2045">2045</option>
      </select>
      <input autocomplete="cc-csc" />
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "2030",
      cvv: "",
    }, NO_WAIT);

    const yearSelect = document.querySelector('[name="expyear"]') as HTMLSelectElement;
    expect(yearSelect.value).toBe("2030");
  });

  it("ふるさとチョイス style: stored 2030 fills via textContent-fallback (\"2030年\" text, no matching value)", async () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select name="expyear">
        <option value="opt-a">2026年</option>
        <option value="opt-b">2030年</option>
        <option value="opt-c">2045年</option>
      </select>
      <input autocomplete="cc-csc" />
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "2030",
      cvv: "",
    }, NO_WAIT);

    const yearSelect = document.querySelector('[name="expyear"]') as HTMLSelectElement;
    expect(yearSelect.value).toBe("opt-b");
  });

  // Regression: a payment-method radio whose id matches the card-number hint sits
  // next to a real card-number text field. The card number must land in the text
  // field, never the radio. Exercises the real production write path
  // (performCreditCardAutofill → detectCreditCardFields).
  it("writes the card number into the real text field, never the id=card_number_pay radio", async () => {
    setupForm(`
      <form>
        <input type="radio" name="pay_method" id="card_number_pay" value="card" />
        <input name="cardNumber" type="text" />
        <input name="cvv" type="text" />
      </form>
    `);

    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "12",
      expiryYear: "2030",
      cvv: "123",
    }, NO_WAIT);

    expect((document.getElementById("card_number_pay") as HTMLInputElement).value).toBe("card");
    expect((document.querySelector('input[name="cardNumber"]') as HTMLInputElement).value).toBe("4111111111111111");
    expect((document.querySelector('input[name="cvv"]') as HTMLInputElement).value).toBe("123");
  });
});

describe("performCreditCardAutofill — select mismatch diagnostics", () => {
  // cc-number is required or detectCreditCardFields returns null and nothing runs.
  // The year select's name must not match CC_EXPIRY_RE's combined-field pattern,
  // or expiryFormat becomes "combined" and setSelectValue is never reached.
  function setupYearSelectForm() {
    setupForm(`
      <input autocomplete="cc-number" />
      <select name="cc_exp_year" autocomplete="cc-exp-year">
        <option value="">Year</option>
        <option value="2025">2025</option>
      </select>
    `);
    return document.querySelector(
      '[autocomplete="cc-exp-year"]',
    ) as HTMLSelectElement;
  }

  function cardPayload(overrides: Record<string, string>) {
    return {
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "",
      cvv: "",
      ...overrides,
    };
  }

  it("logs the extension's own field identifier, never the expiry value, when no option matches", async () => {
    const select = setupYearSelectForm();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    // "99" normalizes to "2099", so a leak of the raw value and a leak of the
    // normalized value are distinguishable strings — asserting both is what makes
    // the normalizedTarget half of the invariant testable.
    await performCreditCardAutofill(cardPayload({ expiryYear: "99" }), NO_WAIT);

    expect(debug.mock.calls.length).toBeGreaterThan(0);
    for (const args of debug.mock.calls) {
      expect(args).toHaveLength(1);
      expect(args.every((a) => typeof a === "string")).toBe(true);
    }

    const logged = debug.mock.calls.flat().join(" ");
    expect(logged).toContain("cc-expiry-year");
    expect(logged).not.toContain("99");
    expect(logged).not.toContain("2099");
    expect(select.value).toBe("");
  });

  it("does not touch the select or dispatch events when no option matches", async () => {
    const select = setupYearSelectForm();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const onChange = vi.fn();
    const onInput = vi.fn();
    select.addEventListener("change", onChange);
    select.addEventListener("input", onInput);

    await performCreditCardAutofill(cardPayload({ expiryYear: "99" }), NO_WAIT);

    // Reachability floor: every assertion below is a denial, so all of them are
    // vacuously true if the detector stops matching this fixture.
    expect(debug.mock.calls.length).toBeGreaterThan(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(onInput).not.toHaveBeenCalled();
    expect(select.value).toBe("");
  });
});

describe("performCreditCardAutofill — combined expiry with a missing payload expiry", () => {
  function setupCombinedForm(placeholder = "MM/YY") {
    setupForm(`
      <input autocomplete="cc-number" />
      <input autocomplete="cc-exp" placeholder="${placeholder}" />
    `);
    return document.querySelector('[autocomplete="cc-exp"]') as HTMLInputElement;
  }

  function cardPayload(month: string, year: string) {
    return {
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: month,
      expiryYear: year,
      cvv: "",
    };
  }

  // formatCombinedExpiry pads empty components to "00", so before the guard these
  // wrote 00/00, 12/00 and 00/30 over whatever the user had typed into a live
  // checkout field. The split branch cannot pick up the slack: detectCreditCardFields
  // nulls expiryMonth/Year whenever a combined field is present.
  for (const [month, year, label] of [
    ["", "", "both empty"],
    ["12", "", "month only"],
    ["", "2030", "year only"],
  ]) {
    it(`leaves the combined field untouched when the entry has ${label}`, async () => {
      const field = setupCombinedForm();
      const onChange = vi.fn();
      field.addEventListener("change", onChange);

      await performCreditCardAutofill(cardPayload(month, year), NO_WAIT);

      expect(field.value).toBe("");
      expect(onChange).not.toHaveBeenCalled();
    });
  }

  for (const [placeholder, expected] of [
    ["MM/YY", "03/26"],
    ["MM/YYYY", "03/2026"],
    ["MMYY", "0326"],
    ["MMYYYY", "032026"],
  ]) {
    it(`still fills a complete expiry in ${placeholder} format`, async () => {
      const field = setupCombinedForm(placeholder);
      await performCreditCardAutofill(cardPayload("3", "2026"), NO_WAIT);
      expect(field.value).toBe(expected);
    });
  }
});

describe("hostile page cannot route a filled value into the diagnostic", () => {
  // setInputValue dispatches `input` SYNCHRONOUSLY, so a page listener runs before
  // the next field is filled. An earlier version of the diagnostic logged the
  // select's own name/id, which let the page move the card number there and have
  // the extension write it to a console only the extension can reach.
  it("does not log the card number when the page copies it into the select's name", async () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select name="benign" autocomplete="cc-exp-year">
        <option value="">Year</option>
        <option value="2025">2025</option>
      </select>
    `);
    const number = document.querySelector(
      '[autocomplete="cc-number"]',
    ) as HTMLInputElement;
    const select = document.querySelector(
      '[autocomplete="cc-exp-year"]',
    ) as HTMLSelectElement;
    number.addEventListener("input", () => {
      select.name = number.value;
      select.id = number.value;
    });

    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    await performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "99",
      cvv: "",
    }, NO_WAIT);

    // The attack must have actually run, or the assertion below is vacuous.
    expect(select.name).toBe("4111111111111111");
    expect(debug.mock.calls.length).toBeGreaterThan(0);
    const logged = debug.mock.calls.flat().join(" ");
    expect(logged).not.toContain("4111111111111111");
    expect(logged).toContain("cc-expiry-year");
  });
});

// ── Sequential fill: dynamic forms (#654) ─────────────────────

describe("performCreditCardAutofill — dynamic forms (#654)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const card = (overrides: Partial<CreditCardAutofillPayload> = {}): CreditCardAutofillPayload => ({
    type: EXT_MSG.AUTOFILL_CC_FILL,
    cardholderName: "",
    cardNumber: "4111111111111111",
    expiryMonth: "3",
    expiryYear: "2030",
    cvv: "123",
    ...overrides,
  });

  function q<T extends Element = HTMLInputElement>(selector: string): T {
    const el = document.querySelector<T>(selector);
    if (!el) throw new Error(`fixture missing ${selector}`);
    return el;
  }

  const DETAILS = `<input autocomplete="cc-exp" placeholder="MM/YY" /><input autocomplete="cc-csc" />`;

  async function settle(fill: Promise<void>): Promise<void> {
    await vi.advanceTimersByTimeAsync(DEFAULT_LATE_FIELD_WINDOW_MS + 100);
    await fill;
  }

  it("fills expiry and CVV created synchronously on the number's input event", async () => {
    setupForm(`<div id="card"><input autocomplete="cc-number" /><div id="details"></div></div>`);
    q("[autocomplete=cc-number]").addEventListener(
      "input",
      () => (q("#details").innerHTML = DETAILS),
      { once: true },
    );

    await settle(performCreditCardAutofill(card()));

    expect(q("[autocomplete=cc-exp]").value).toBe("03/30");
    expect(q("[autocomplete=cc-csc]").value).toBe("123");
  });

  it("fills expiry and CVV created asynchronously after the number write", async () => {
    setupForm(`<div id="card"><input autocomplete="cc-number" /><div id="details"></div></div>`);
    q("[autocomplete=cc-number]").addEventListener(
      "input",
      () => setTimeout(() => (q("#details").innerHTML = DETAILS), 200),
      { once: true },
    );

    await settle(performCreditCardAutofill(card()));

    expect(q("[autocomplete=cc-exp]").value).toBe("03/30");
    expect(q("[autocomplete=cc-csc]").value).toBe("123");
  });

  // The replaced subtree lies below a non-body root: the shipping section holds a
  // foreign control, so the root is the card component.
  it("fills the re-rendered expiry and CVV that replace the T0 fields", async () => {
    setupForm(`
      <div id="app">
        <div id="card"><input autocomplete="cc-number" /><div id="details">${DETAILS}</div></div>
        <div id="shipping"><input type="text" name="zip" /></div>
      </div>
    `);
    const staleCvv = q("[autocomplete=cc-csc]");
    q("[autocomplete=cc-number]").addEventListener(
      "input",
      () => (q("#details").innerHTML = DETAILS),
      { once: true },
    );

    await settle(performCreditCardAutofill(card()));

    expect(staleCvv.isConnected).toBe(false);
    expect(staleCvv.value).toBe("");
    expect(q("[autocomplete=cc-exp]").value).toBe("03/30");
    expect(q("[autocomplete=cc-csc]").value).toBe("123");
  });

  it("fills an expiry year created after the month write", async () => {
    setupForm(`
      <div id="card">
        <input autocomplete="cc-number" />
        <select autocomplete="cc-exp-month">
          <option value="">--</option><option value="03">03</option>
        </select>
        <span id="year-slot"></span>
      </div>
    `);
    q("[autocomplete=cc-exp-month]").addEventListener(
      "change",
      () =>
        (q("#year-slot").innerHTML = `<select autocomplete="cc-exp-year">
          <option value="">--</option><option value="2030">2030</option>
        </select>`),
      { once: true },
    );

    await settle(performCreditCardAutofill(card({ cvv: "" })));

    expect(q<HTMLSelectElement>("[autocomplete=cc-exp-month]").value).toBe("03");
    expect(q<HTMLSelectElement>("[autocomplete=cc-exp-year]").value).toBe("2030");
  });

  it("fills a late CVV next to a hidden input in the card component", async () => {
    setupForm(`<div id="card"><input type="hidden" name="token" /><input autocomplete="cc-number" /><div id="details"></div></div>`);
    q("[autocomplete=cc-number]").addEventListener(
      "input",
      () => (q("#details").innerHTML = `<input autocomplete="cc-csc" />`),
      { once: true },
    );

    await settle(performCreditCardAutofill(card({ expiryMonth: "", expiryYear: "" })));

    expect(q("[autocomplete=cc-csc]").value).toBe("123");
  });

  it("on rapid re-selection, the second card's values win", async () => {
    setupForm(`<div id="card"><input autocomplete="cc-number" /><div id="details"></div></div>`);

    const first = performCreditCardAutofill(card({ cardNumber: "4111111111111111", cvv: "111" }));
    await vi.advanceTimersByTimeAsync(5);
    const second = performCreditCardAutofill(card({ cardNumber: "5500000000000004", cvv: "222" }));
    await vi.advanceTimersByTimeAsync(5);
    // The second request arrives while the first run's CVV step is waiting.
    q("#details").innerHTML = `<input autocomplete="cc-csc" />`;
    const writes: string[] = [];
    const cvv = q("[autocomplete=cc-csc]");
    cvv.addEventListener("input", () => writes.push(cvv.value));
    await settle(Promise.all([first, second]).then(() => {}));

    expect(writes).toEqual(["222"]);
    expect(q("[autocomplete=cc-number]").value).toBe("5500000000000004");
    expect(q("[autocomplete=cc-csc]").value).toBe("222");
  });

  // FR4: a newer request supersedes the pending fill even when its own T0
  // detection finds nothing to fill.
  it("a later fill request that finds no form still ends a pending CVV step", async () => {
    setupForm(`<div id="card"><input autocomplete="cc-number" /><div id="details"></div></div>`);

    const fill = performCreditCardAutofill(card({ expiryMonth: "", expiryYear: "" }));
    await vi.advanceTimersByTimeAsync(5);
    await performIdentityAutofill({
      type: EXT_MSG.AUTOFILL_IDENTITY_FILL,
      fullName: "Jane Doe", givenName: "", familyName: "", familyNameKana: "", givenNameKana: "",
      address: "", addressLine2: "", city: "", state: "", postalCode: "", country: "",
      phone: "", email: "", dateOfBirth: "", nationality: "",
    });
    q("#details").innerHTML = `<input autocomplete="cc-csc" />`;
    await settle(fill);

    expect(q("[autocomplete=cc-number]").value).toBe("4111111111111111");
    expect(q("[autocomplete=cc-csc]").value).toBe("");
  });

  it("drops the CVV reference at its write", async () => {
    setupForm(`<input autocomplete="cc-number" /><input autocomplete="cc-csc" />`);
    const payload = card({ expiryMonth: "", expiryYear: "" });
    const writes: string[] = [];
    q("[autocomplete=cc-csc]").addEventListener("input", () => writes.push(payload.cvv));

    await settle(performCreditCardAutofill(payload));

    expect(q("[autocomplete=cc-csc]").value).toBe("123");
    expect(writes).toEqual(["123"]);
    expect(payload.cvv).toBe("");
  });

  it("drops the CVV reference at exit when no CVV field ever appears", async () => {
    setupForm(`<input autocomplete="cc-number" />`);
    const payload = card({ expiryMonth: "", expiryYear: "" });

    await settle(performCreditCardAutofill(payload));

    expect(payload.cvv).toBe("");
  });

  // The other section holds a conf_number field that the detector does not
  // claim (not co-located with the number), so it is a foreign control.
  describe("root bounded by a foreign control (SPA #app wrapper)", () => {
    async function fillWithLateCvvIn(slotId: string): Promise<HTMLInputElement> {
      setupForm(`
        <div id="app">
          <section id="payment"><div><input autocomplete="cc-number" /></div><div id="slot"></div></section>
          <section id="booking"><input type="text" name="conf_number" maxlength="4" /><div id="far"></div></section>
        </div>
      `);
      const fill = performCreditCardAutofill(card({ expiryMonth: "", expiryYear: "" }));
      await vi.advanceTimersByTimeAsync(5);
      // Precondition: the foreign control is not a T0 target.
      expect(q("[name=conf_number]").value).toBe("");
      const late = document.createElement("input");
      late.autocomplete = "cc-csc";
      q(`#${slotId}`).appendChild(late);
      await settle(fill);
      return late;
    }

    it("writes a late CVV inside the root, outside the number's parent", async () => {
      expect((await fillWithLateCvvIn("slot")).value).toBe("123");
    });

    it("does not write a late CVV inserted beyond the foreign control", async () => {
      expect((await fillWithLateCvvIn("far")).value).toBe("");
    });
  });
});

