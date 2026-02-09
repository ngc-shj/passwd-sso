import { describe, it, expect } from "vitest";
import {
  normalizeCardNumber,
  normalizeCardBrand,
  detectCardBrand,
  getAllowedLengths,
  getMinLength,
  getMaxLength,
  isCardLengthValid,
  isValidLuhn,
  formatCardNumber,
  getCardNumberValidation,
} from "./credit-card";

describe("normalizeCardNumber", () => {
  it("strips non-digits", () => {
    expect(normalizeCardNumber("4111 1111 1111 1111")).toBe("4111111111111111");
    expect(normalizeCardNumber("4111-1111-1111-1111")).toBe("4111111111111111");
    expect(normalizeCardNumber("abc")).toBe("");
  });

  it("returns empty for empty input", () => {
    expect(normalizeCardNumber("")).toBe("");
  });
});

describe("normalizeCardBrand", () => {
  it("returns known brands as-is", () => {
    expect(normalizeCardBrand("Visa")).toBe("Visa");
    expect(normalizeCardBrand("American Express")).toBe("American Express");
    expect(normalizeCardBrand("JCB")).toBe("JCB");
  });

  it("returns empty for unknown brands", () => {
    expect(normalizeCardBrand("Unknown")).toBe("");
    expect(normalizeCardBrand(null)).toBe("");
    expect(normalizeCardBrand(undefined)).toBe("");
    expect(normalizeCardBrand("")).toBe("");
  });
});

describe("detectCardBrand", () => {
  it("detects Visa", () => {
    expect(detectCardBrand("4111111111111111")).toBe("Visa");
    expect(detectCardBrand("4")).toBe("Visa");
  });

  it("detects Mastercard (51-55 range)", () => {
    expect(detectCardBrand("5111111111111118")).toBe("Mastercard");
    expect(detectCardBrand("5500000000000004")).toBe("Mastercard");
  });

  it("detects Mastercard (2221-2720 range)", () => {
    expect(detectCardBrand("2221000000000009")).toBe("Mastercard");
    expect(detectCardBrand("2720000000000005")).toBe("Mastercard");
  });

  it("detects American Express", () => {
    expect(detectCardBrand("340000000000009")).toBe("American Express");
    expect(detectCardBrand("370000000000002")).toBe("American Express");
  });

  it("detects Discover", () => {
    expect(detectCardBrand("6011000000000004")).toBe("Discover");
    expect(detectCardBrand("6500000000000002")).toBe("Discover");
  });

  it("detects JCB", () => {
    expect(detectCardBrand("3528000000000007")).toBe("JCB");
    expect(detectCardBrand("3589000000000003")).toBe("JCB");
  });

  it("detects Diners Club", () => {
    expect(detectCardBrand("30000000000004")).toBe("Diners Club");
    expect(detectCardBrand("36000000000008")).toBe("Diners Club");
  });

  it("detects UnionPay", () => {
    expect(detectCardBrand("6200000000000005")).toBe("UnionPay");
  });

  it("returns empty for unrecognized prefixes", () => {
    expect(detectCardBrand("9999999999999999")).toBe("");
    expect(detectCardBrand("")).toBe("");
  });
});

describe("getAllowedLengths", () => {
  it("returns lengths for known brands", () => {
    expect(getAllowedLengths("Visa")).toEqual([13, 16, 19]);
    expect(getAllowedLengths("American Express")).toEqual([15]);
    expect(getAllowedLengths("Mastercard")).toEqual([16]);
  });

  it("returns null for Other or unknown", () => {
    expect(getAllowedLengths("Other")).toBeNull();
    expect(getAllowedLengths(null)).toBeNull();
    expect(getAllowedLengths("Unknown")).toBeNull();
  });
});

describe("getMinLength / getMaxLength", () => {
  it("returns brand-specific min/max", () => {
    expect(getMinLength("Visa")).toBe(13);
    expect(getMaxLength("Visa")).toBe(19);
    expect(getMinLength("American Express")).toBe(15);
    expect(getMaxLength("American Express")).toBe(15);
  });

  it("returns generic range for unknown brand", () => {
    expect(getMinLength(null)).toBe(12);
    expect(getMaxLength(null)).toBe(19);
  });
});

describe("isCardLengthValid", () => {
  it("validates brand-specific lengths", () => {
    expect(isCardLengthValid(16, "Visa")).toBe(true);
    expect(isCardLengthValid(15, "Visa")).toBe(false);
    expect(isCardLengthValid(15, "American Express")).toBe(true);
    expect(isCardLengthValid(16, "American Express")).toBe(false);
  });

  it("validates generic lengths when no brand", () => {
    expect(isCardLengthValid(16, null)).toBe(true);
    expect(isCardLengthValid(11, null)).toBe(false);
    expect(isCardLengthValid(20, null)).toBe(false);
  });
});

describe("isValidLuhn", () => {
  it("passes valid card numbers", () => {
    expect(isValidLuhn("4111111111111111")).toBe(true); // Visa test
    expect(isValidLuhn("5500000000000004")).toBe(true); // Mastercard test
    expect(isValidLuhn("340000000000009")).toBe(true);  // Amex test
  });

  it("fails invalid check digit", () => {
    expect(isValidLuhn("4111111111111112")).toBe(false);
    expect(isValidLuhn("1234567890123456")).toBe(false);
  });

  it("fails non-digit input", () => {
    expect(isValidLuhn("abcd")).toBe(false);
  });
});

describe("formatCardNumber", () => {
  it("formats in 4-4-4-4 for Visa", () => {
    expect(formatCardNumber("4111111111111111")).toBe("4111 1111 1111 1111");
  });

  it("formats in 4-6-5 for American Express", () => {
    expect(formatCardNumber("340000000000009", "American Express")).toBe(
      "3400 000000 00009"
    );
  });

  it("auto-detects Amex formatting", () => {
    expect(formatCardNumber("370000000000002")).toBe("3700 000000 00002");
  });

  it("handles partial input", () => {
    expect(formatCardNumber("4111")).toBe("4111");
    expect(formatCardNumber("41111")).toBe("4111 1");
  });

  it("returns empty for empty input", () => {
    expect(formatCardNumber("")).toBe("");
  });

  it("strips non-digits before formatting", () => {
    expect(formatCardNumber("4111-1111-1111-1111")).toBe("4111 1111 1111 1111");
  });
});

describe("getCardNumberValidation", () => {
  it("returns valid for empty input", () => {
    const result = getCardNumberValidation("");
    expect(result.digits).toBe("");
    expect(result.lengthValid).toBe(true);
    expect(result.luhnValid).toBe(true);
  });

  it("returns full validation for valid Visa", () => {
    const result = getCardNumberValidation("4111111111111111");
    expect(result.digits).toBe("4111111111111111");
    expect(result.detectedBrand).toBe("Visa");
    expect(result.effectiveBrand).toBe("Visa");
    expect(result.lengthValid).toBe(true);
    expect(result.luhnValid).toBe(true);
  });

  it("detects length error", () => {
    const result = getCardNumberValidation("411111111111");
    expect(result.lengthValid).toBe(false);
  });

  it("detects Luhn error", () => {
    const result = getCardNumberValidation("4111111111111112");
    expect(result.lengthValid).toBe(true);
    expect(result.luhnValid).toBe(false);
  });

  it("uses brand hint over auto-detection", () => {
    const result = getCardNumberValidation("4111111111111111", "Mastercard");
    expect(result.effectiveBrand).toBe("Mastercard");
    expect(result.detectedBrand).toBe("Visa");
  });
});
