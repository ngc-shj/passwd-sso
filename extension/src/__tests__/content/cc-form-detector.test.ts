/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { detectCreditCardFields, detectExpiryFormat, formatCombinedExpiry, CC_DETECT_RE } from "../../content/cc-form-detector-lib";

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

// ── C7: per-site detection fixtures ──────────────────────────

describe("detectCreditCardFields — per-site fixtures", () => {
  it("ドスパラ: ccno / exp_month+exp_year selects / conf_number / ccmeigi", () => {
    setupForm(`
      <input name="ccno" type="text" />
      <select name="exp_month">
        <option value="01">01</option>
        <option value="12">12</option>
      </select>
      <select name="exp_year">
        <option value="26">26</option>
        <option value="35">35</option>
      </select>
      <input name="conf_number" type="password" />
      <input name="ccmeigi" type="text" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.cardNumber).toBeTruthy();
    expect(fields!.expiryMonth).toBeInstanceOf(HTMLSelectElement);
    expect(fields!.expiryYear).toBeInstanceOf(HTMLSelectElement);
    expect(fields!.cvv).toBeTruthy();
    expect(fields!.cardholderName).toBeTruthy();
  });

  it("BBexcite: card_no / card_expire[m]+[Y] selects / security_code / holder_name", () => {
    setupForm(`
      <input name="card_no" type="text" />
      <select name="card_expire[m]">
        <option value="01">01</option>
      </select>
      <select name="card_expire[Y]">
        <option value="2026">2026</option>
      </select>
      <input name="security_code" type="text" />
      <input name="holder_name" type="text" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.cardNumber).toBeTruthy();
    expect(fields!.expiryMonth).toBeInstanceOf(HTMLSelectElement);
    expect(fields!.expiryYear).toBeInstanceOf(HTMLSelectElement);
    expect(fields!.cvv).toBeTruthy();
    expect(fields!.cardholderName).toBeTruthy();
  });

  it("JustMyshop: cardNumberText/cardExpireMonth+YearSelect/cardSecurityCode/cardNameText; decoy birth selects not claimed", () => {
    setupForm(`
      <input name="cardNumberText" type="text" />
      <select name="cardBirthMonth">
        <option value="01">01</option>
      </select>
      <select name="cardBirthDay">
        <option value="01">01</option>
      </select>
      <select name="cardExpireMonthSelect">
        <option value="01">01</option>
      </select>
      <select name="cardExpireYearSelect">
        <option value="2026">2026</option>
      </select>
      <input name="cardSecurityCode" type="text" />
      <input name="cardNameText" type="text" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    const legitimateMonth = document.querySelector('[name="cardExpireMonthSelect"]');
    const legitimateYear = document.querySelector('[name="cardExpireYearSelect"]');
    expect(fields!.expiryMonth).toBe(legitimateMonth);
    expect(fields!.expiryYear).toBe(legitimateYear);
    expect(fields!.cvv).toBeTruthy();
    expect(fields!.cardholderName).toBeTruthy();
  });

  it("IIJmio: creditCardNumber/creditCardExpireYear+Month/creditCardSecurityCode; disabled owner inputs skipped", () => {
    setupForm(`
      <input name="creditCardNumber" type="text" />
      <select name="creditCardExpireMonth">
        <option value="01">01</option>
      </select>
      <select name="creditCardExpireYear">
        <option value="2026">2026</option>
      </select>
      <input name="creditCardSecurityCode" type="text" />
      <input name="creditCardOwnerName" type="text" disabled />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.cardNumber).toBeTruthy();
    expect(fields!.expiryMonth).toBeInstanceOf(HTMLSelectElement);
    expect(fields!.expiryYear).toBeInstanceOf(HTMLSelectElement);
    expect(fields!.cvv).toBeTruthy();
    expect(fields!.cardholderName).toBeNull();
  });

  it("さくら: cardnumberinput/securitycdinput/label-wrapped month+year selects/cardholdernameinput", () => {
    setupForm(`
      <input name="cardnumberinput" type="text" />
      <input name="securitycdinput" type="text" />
      <label>月<select name="expmonth">
        <option value="01">01</option>
      </select></label>
      <label>年<select name="expyear">
        <option value="2026">2026</option>
      </select></label>
      <input name="cardholdernameinput" type="text" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.cardNumber).toBeTruthy();
    expect(fields!.cvv).toBeTruthy();
    expect(fields!.expiryMonth).toBeInstanceOf(HTMLSelectElement);
    expect(fields!.expiryYear).toBeInstanceOf(HTMLSelectElement);
    expect(fields!.cardholderName).toBeTruthy();
  });

  it("ふるさとチョイス: card_no+label カード番号/holder_name/js-card_verification_code (name path)", () => {
    setupForm(`
      <label for="cno">カード番号</label>
      <input id="cno" name="card_no" type="tel" />
      <label for="holder">カード名義人</label>
      <input id="holder" name="holder_name" type="text" />
      <input name="js-card_verification_code" type="text" />
      <select name="expmonth">
        <option value="2026年01月">2026年01月</option>
      </select>
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.cardNumber).toBeTruthy();
    expect(fields!.cardholderName).toBeTruthy();
    expect(fields!.cvv).toBeTruthy();
  });

  it("ふるさとチョイス: js-card_verification_code detected via label[for]=セキュリティコード path", () => {
    setupForm(`
      <input name="card_no" type="tel" />
      <label for="cvc">セキュリティコード</label>
      <input id="cvc" name="js-card_verification_code" type="text" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.cvv).toBeTruthy();
    expect(fields!.cvv).toBe(document.getElementById("cvc"));
  });
});

describe("detectCreditCardFields — negative / counter-fixtures", () => {
  it("(a) japan_flag/company_name/expand_section with no real card field → null (pins \\bpan\\b)", () => {
    setupForm(`
      <input name="japan_flag" type="text" />
      <input name="company_name" type="text" />
      <input name="expand_section" type="text" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).toBeNull();
  });

  it("(b) lone confirmation_number field, no card number → null", () => {
    setupForm(`
      <input name="confirmation_number" type="text" />
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).toBeNull();
  });

  it("(c) export_month decoy select inside a real CC form is not claimed as expiryMonth", () => {
    setupForm(`
      <input name="card_no" type="text" />
      <select name="export_month">
        <option value="01">01</option>
      </select>
      <select name="cardExpireMonthSelect">
        <option value="01">01</option>
      </select>
    `);

    const fields = detectCreditCardFields(document);
    expect(fields).not.toBeNull();
    const legitimateExpirySelect = document.querySelector('[name="cardExpireMonthSelect"]');
    expect(fields!.expiryMonth).toBe(legitimateExpirySelect);
  });

  it("(d) loyalty/insurance *_card_no fields (member-card numbers) are not claimed as a card number", () => {
    setupForm(`
      <input name="loyalty_card_no" type="text" />
      <input name="insurance_card_no" type="text" />
      <input name="student_card_no" type="text" />
    `);

    // \bcard.?no\b requires a word boundary before "card" — a member-card
    // number field (loyalty_card_no etc.) must NOT trigger a CC-number match.
    const fields = detectCreditCardFields(document);
    expect(fields).toBeNull();
  });
});

describe("CC_DETECT_RE — regex matrix (T12)", () => {
  it.each([
    // number positives
    ["ccno", "number", true],
    ["card_no", "number", true],
    ["cardnumbertext", "number", true],
    ["creditcardnumber", "number", true],
    ["cardnumberinput", "number", true],
    // number decoys (must reject)
    ["japan_flag", "number", false],
    ["company_name", "number", false],
    ["expand_section", "number", false],
    ["loyalty_card_no", "number", false],
    ["insurance_card_no", "number", false],
    ["student_card_no", "number", false],
    // name positives
    ["ccmeigi", "name", true],
    ["holder_name", "name", true],
    ["cardnametext", "name", true],
    ["cardholdernameinput", "name", true],
    // expiryMonth positives
    ["exp_month", "expiryMonth", true],
    ["cardexpiremonth", "expiryMonth", true],
    ["creditcardexpiremonth", "expiryMonth", true],
    ["card_expire[m]", "expiryMonth", true],
    // expiryMonth decoys (must reject)
    ["export_month", "expiryMonth", false],
    ["expected_month", "expiryMonth", false],
    ["experience_month", "expiryMonth", false],
    ["cardbirthmonth", "expiryMonth", false],
    // expiryYear positives
    ["exp_year", "expiryYear", true],
    ["cardexpireyearselect", "expiryYear", true],
    ["creditcardexpireyear", "expiryYear", true],
    ["card_expire[y]", "expiryYear", true],
    // cvv positives
    ["conf_number", "cvv", true],
    ["security_code", "cvv", true],
    ["cardsecuritycode", "cvv", true],
    ["securitycdinput", "cvv", true],
    ["js-card_verification_code", "cvv", true],
    // cvv decoys (must reject)
    ["verification_code", "cvv", false],
    ["discard verification", "cvv", false],
    ["card_note", "cvv", false],
  ] as const)("%s → CC_DETECT_RE.%s matches:%s", (hint, field, expected) => {
    expect(CC_DETECT_RE[field].test(hint)).toBe(expected);
  });
});
