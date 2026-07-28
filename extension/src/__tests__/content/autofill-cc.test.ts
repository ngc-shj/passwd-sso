/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { performCreditCardAutofill } from "../../content/autofill-cc-lib";
import { EXT_MSG } from "../../lib/constants";

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
  vi.restoreAllMocks();
});

function setupForm(html: string) {
  document.body.innerHTML = html;
}

describe("performCreditCardAutofill", () => {
  it("fills fields by autocomplete attributes", () => {
    setupForm(`
      <input autocomplete="cc-name" />
      <input autocomplete="cc-number" />
      <input autocomplete="cc-exp-month" />
      <input autocomplete="cc-exp-year" />
      <input autocomplete="cc-csc" />
    `);

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "John Doe",
      cardNumber: "4111111111111111",
      expiryMonth: "12",
      expiryYear: "2025",
      cvv: "123",
    });

    const inputs = document.querySelectorAll("input");
    expect((inputs[0] as HTMLInputElement).value).toBe("John Doe");
    expect((inputs[1] as HTMLInputElement).value).toBe("4111111111111111");
    expect((inputs[2] as HTMLInputElement).value).toBe("12");
    expect((inputs[3] as HTMLInputElement).value).toBe("2025");
    expect((inputs[4] as HTMLInputElement).value).toBe("123");
  });

  it("fills combined expiry field (MM/YY)", () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <input autocomplete="cc-exp" placeholder="MM/YY" />
      <input autocomplete="cc-csc" />
    `);

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "3",
      expiryYear: "2026",
      cvv: "456",
    });

    const expInput = document.querySelector('[autocomplete="cc-exp"]') as HTMLInputElement;
    expect(expInput.value).toBe("03/26");
  });

  it("fills select elements for expiry", () => {
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

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "12",
      expiryYear: "2026",
      cvv: "789",
    });

    const monthSelect = document.querySelector('[autocomplete="cc-exp-month"]') as HTMLSelectElement;
    const yearSelect = document.querySelector('[autocomplete="cc-exp-year"]') as HTMLSelectElement;
    expect(monthSelect.value).toBe("12");
    expect(yearSelect.value).toBe("2026");
  });

  it("normalizes month select values (1 matches 01)", () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select autocomplete="cc-exp-month">
        <option value="">Month</option>
        <option value="1">1</option>
        <option value="2">2</option>
      </select>
      <input autocomplete="cc-csc" />
    `);

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "01",
      expiryYear: "2026",
      cvv: "",
    });

    const monthSelect = document.querySelector('[autocomplete="cc-exp-month"]') as HTMLSelectElement;
    expect(monthSelect.value).toBe("1");
  });

  it("does not fill when no card number field exists", () => {
    setupForm(`
      <input type="text" name="username" />
      <input type="password" />
    `);

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "Test",
      cardNumber: "4111111111111111",
      expiryMonth: "12",
      expiryYear: "2025",
      cvv: "123",
    });

    const inputs = document.querySelectorAll("input");
    expect((inputs[0] as HTMLInputElement).value).toBe("");
    expect((inputs[1] as HTMLInputElement).value).toBe("");
  });

  it("skips display:none input (visibility check)", () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <input autocomplete="cc-name" style="display: none" />
      <input autocomplete="cc-csc" />
    `);

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "Hidden Name",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "",
      cvv: "123",
    });

    const nameInput = document.querySelector('[autocomplete="cc-name"]') as HTMLInputElement;
    expect(nameInput.value).toBe("");
  });

  it("skips visibility:hidden select (visibility check)", () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select autocomplete="cc-exp-month" style="visibility: hidden">
        <option value="01">01</option>
      </select>
      <input autocomplete="cc-csc" />
    `);

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "01",
      expiryYear: "",
      cvv: "",
    });

    const monthSelect = document.querySelector('[autocomplete="cc-exp-month"]') as HTMLSelectElement;
    expect(monthSelect.value).toBe("01"); // unchanged from initial
  });

  it("wipes cvv from payload after fill", () => {
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

    performCreditCardAutofill(payload);

    expect(payload.cvv).toBe("");
  });

  it("does NOT write cvv into an unrelated conf_number field in a separate section", () => {
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

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "",
      cvv: "321",
    });

    const conf = document.querySelector('[name="conf_number"]') as HTMLInputElement;
    expect(conf.value).toBe("");
    const card = document.querySelector('[name="card_no"]') as HTMLInputElement;
    expect(card.value).toBe("4111111111111111");
  });

  it("writes cvv into a co-located conf_number (form-less table, ドスパラ)", () => {
    setupForm(`
      <table>
        <tr><td><input name="ccno" type="text" /></td></tr>
        <tr><td><input name="conf_number" type="password" /></td></tr>
      </table>
    `);

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "",
      cvv: "321",
    });

    const conf = document.querySelector('[name="conf_number"]') as HTMLInputElement;
    expect(conf.value).toBe("321");
  });

  it("does not fill login fields when CC autofill runs (non-destructive)", () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
      <input autocomplete="cc-number" />
      <input autocomplete="cc-csc" />
    `);

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "",
      cvv: "123",
    });

    const usernameInput = document.querySelector('[autocomplete="username"]') as HTMLInputElement;
    const passwordInput = document.querySelector('[autocomplete="current-password"]') as HTMLInputElement;
    expect(usernameInput.value).toBe("");
    expect(passwordInput.value).toBe("");
  });

  // ── C3/C7: year select 2-digit / 4-digit / textContent-fallback fill ──

  it("ドスパラ style: stored 2030 fills a 2-digit <option value=\"30\">", () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select name="exp_year">
        <option value="26">26</option>
        <option value="30">30</option>
        <option value="35">35</option>
      </select>
      <input autocomplete="cc-csc" />
    `);

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "2030",
      cvv: "",
    });

    const yearSelect = document.querySelector('[name="exp_year"]') as HTMLSelectElement;
    expect(yearSelect.value).toBe("30");
  });

  it("さくら style: stored 2030 fills a 4-digit <option value=\"2030\">", () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select name="expyear">
        <option value="2026">2026</option>
        <option value="2030">2030</option>
        <option value="2045">2045</option>
      </select>
      <input autocomplete="cc-csc" />
    `);

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "2030",
      cvv: "",
    });

    const yearSelect = document.querySelector('[name="expyear"]') as HTMLSelectElement;
    expect(yearSelect.value).toBe("2030");
  });

  it("ふるさとチョイス style: stored 2030 fills via textContent-fallback (\"2030年\" text, no matching value)", () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select name="expyear">
        <option value="opt-a">2026年</option>
        <option value="opt-b">2030年</option>
        <option value="opt-c">2045年</option>
      </select>
      <input autocomplete="cc-csc" />
    `);

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "2030",
      cvv: "",
    });

    const yearSelect = document.querySelector('[name="expyear"]') as HTMLSelectElement;
    expect(yearSelect.value).toBe("opt-b");
  });

  // Regression: a payment-method radio whose id matches the card-number hint sits
  // next to a real card-number text field. The card number must land in the text
  // field, never the radio. Exercises the real production write path
  // (performCreditCardAutofill → detectCreditCardFields).
  it("writes the card number into the real text field, never the id=card_number_pay radio", () => {
    setupForm(`
      <form>
        <input type="radio" name="pay_method" id="card_number_pay" value="card" />
        <input name="cardNumber" type="text" />
        <input name="cvv" type="text" />
      </form>
    `);

    performCreditCardAutofill({
      type: EXT_MSG.AUTOFILL_CC_FILL,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "12",
      expiryYear: "2030",
      cvv: "123",
    });

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

  it("logs the select's name, never the expiry value, when no option matches", () => {
    const select = setupYearSelectForm();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    // "99" normalizes to "2099", so a leak of the raw value and a leak of the
    // normalized value are distinguishable strings — asserting both is what makes
    // the normalizedTarget half of the invariant testable.
    performCreditCardAutofill(cardPayload({ expiryYear: "99" }));

    expect(debug.mock.calls.length).toBeGreaterThan(0);
    for (const args of debug.mock.calls) {
      expect(args).toHaveLength(1);
      expect(args.every((a) => typeof a === "string")).toBe(true);
    }

    const logged = debug.mock.calls.flat().join(" ");
    expect(logged).toContain("cc_exp_year");
    expect(logged).not.toContain("99");
    expect(logged).not.toContain("2099");
    expect(select.value).toBe("");
  });

  it("does not touch the select or dispatch events when no option matches", () => {
    const select = setupYearSelectForm();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const onChange = vi.fn();
    const onInput = vi.fn();
    select.addEventListener("change", onChange);
    select.addEventListener("input", onInput);

    performCreditCardAutofill(cardPayload({ expiryYear: "99" }));

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
    it(`leaves the combined field untouched when the entry has ${label}`, () => {
      const field = setupCombinedForm();
      const onChange = vi.fn();
      field.addEventListener("change", onChange);

      performCreditCardAutofill(cardPayload(month, year));

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
    it(`still fills a complete expiry in ${placeholder} format`, () => {
      const field = setupCombinedForm(placeholder);
      performCreditCardAutofill(cardPayload("3", "2026"));
      expect(field.value).toBe(expected);
    });
  }
});
