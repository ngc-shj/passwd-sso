/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { performCreditCardAutofill } from "../../content/autofill-cc-lib";

beforeEach(() => {
  Object.defineProperty(navigator, "language", {
    value: "en-US",
    configurable: true,
  });
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
      type: "AUTOFILL_CC_FILL",
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
      type: "AUTOFILL_CC_FILL",
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
      type: "AUTOFILL_CC_FILL",
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
      type: "AUTOFILL_CC_FILL",
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
      type: "AUTOFILL_CC_FILL",
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
      type: "AUTOFILL_CC_FILL",
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
      type: "AUTOFILL_CC_FILL",
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
      type: "AUTOFILL_CC_FILL" as const,
      cardholderName: "",
      cardNumber: "4111111111111111",
      expiryMonth: "",
      expiryYear: "",
      cvv: "999",
    };

    performCreditCardAutofill(payload);

    expect(payload.cvv).toBe("");
  });

  it("does not fill login fields when CC autofill runs (non-destructive)", () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
      <input autocomplete="cc-number" />
      <input autocomplete="cc-csc" />
    `);

    performCreditCardAutofill({
      type: "AUTOFILL_CC_FILL",
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
});
