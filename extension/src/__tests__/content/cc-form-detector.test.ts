/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { detectCreditCardFields, detectExpiryFormat, formatCombinedExpiry } from "../../content/cc-form-detector-lib";

// Polyfill CSS.escape for jsdom
if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
}

beforeEach(() => {
  Object.defineProperty(navigator, "language", {
    value: "en-US",
    configurable: true,
  });
});

function setupForm(html: string) {
  document.body.innerHTML = html;
}

describe("detectCreditCardFields", () => {
  it("detects fields by autocomplete attributes", () => {
    setupForm(`
      <input autocomplete="cc-name" />
      <input autocomplete="cc-number" />
      <input autocomplete="cc-exp-month" />
      <input autocomplete="cc-exp-year" />
      <input autocomplete="cc-csc" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.cardholderName).toBeTruthy();
    expect(fields!.cardNumber).toBeTruthy();
    expect(fields!.expiryMonth).toBeTruthy();
    expect(fields!.expiryYear).toBeTruthy();
    expect(fields!.cvv).toBeTruthy();
    expect(fields!.expiryFormat).toBe("split");
  });

  it("detects fields by name/id regex fallback", () => {
    setupForm(`
      <input name="cardNumber" />
      <input name="cardHolder" />
      <input name="expMonth" />
      <input name="expYear" />
      <input name="cvv" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.cardNumber).toBeTruthy();
    expect(fields!.cardholderName).toBeTruthy();
    expect(fields!.cvv).toBeTruthy();
  });

  it("detects combined expiry field", () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <input autocomplete="cc-exp" />
      <input autocomplete="cc-csc" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.expiryCombined).toBeTruthy();
    expect(fields!.expiryFormat).toBe("combined");
  });

  it("returns null when no card number field found", () => {
    setupForm(`
      <input type="text" name="username" />
      <input type="password" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).toBeNull();
  });

  it("skips disabled and readonly fields", () => {
    setupForm(`
      <input autocomplete="cc-number" disabled />
      <input autocomplete="cc-csc" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).toBeNull();
  });

  it("skips hidden fields", () => {
    setupForm(`
      <input autocomplete="cc-number" style="display: none" />
      <input autocomplete="cc-csc" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).toBeNull();
  });

  it("detects Japanese label fields", () => {
    setupForm(`
      <label for="num">カード番号</label>
      <input id="num" type="text" />
      <label for="cvv">セキュリティコード</label>
      <input id="cvv" type="text" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.cardNumber).toBeTruthy();
    expect(fields!.cvv).toBeTruthy();
  });

  it("detects select element for expiry month", () => {
    setupForm(`
      <input autocomplete="cc-number" />
      <select autocomplete="cc-exp-month">
        <option value="01">January</option>
        <option value="02">February</option>
      </select>
      <select autocomplete="cc-exp-year">
        <option value="2025">2025</option>
        <option value="2026">2026</option>
      </select>
      <input autocomplete="cc-csc" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.expiryMonth).toBeInstanceOf(HTMLSelectElement);
    expect(fields!.expiryYear).toBeInstanceOf(HTMLSelectElement);
    expect(fields!.expiryFormat).toBe("split");
  });
});

describe("detectExpiryFormat", () => {
  it("detects MM/YYYY from placeholder", () => {
    setupForm(`<input id="exp" placeholder="MM/YYYY" />`);
    const input = document.getElementById("exp") as HTMLInputElement;
    expect(detectExpiryFormat(input)).toBe("MM/YYYY");
  });

  it("detects MM/YY from placeholder", () => {
    setupForm(`<input id="exp" placeholder="MM/YY" />`);
    const input = document.getElementById("exp") as HTMLInputElement;
    expect(detectExpiryFormat(input)).toBe("MM/YY");
  });

  it("detects format from maxlength", () => {
    setupForm(`<input id="exp" maxlength="5" />`);
    const input = document.getElementById("exp") as HTMLInputElement;
    expect(detectExpiryFormat(input)).toBe("MM/YY");
  });

  it("defaults to MM/YY", () => {
    setupForm(`<input id="exp" />`);
    const input = document.getElementById("exp") as HTMLInputElement;
    expect(detectExpiryFormat(input)).toBe("MM/YY");
  });
});

describe("formatCombinedExpiry", () => {
  it("formats MM/YY", () => {
    expect(formatCombinedExpiry("3", "2025", "MM/YY")).toBe("03/25");
  });

  it("formats MM/YYYY", () => {
    expect(formatCombinedExpiry("12", "2025", "MM/YYYY")).toBe("12/2025");
  });

  it("formats MMYY", () => {
    expect(formatCombinedExpiry("1", "25", "MMYY")).toBe("0125");
  });

  it("formats MMYYYY", () => {
    expect(formatCombinedExpiry("6", "2026", "MMYYYY")).toBe("062026");
  });
});
