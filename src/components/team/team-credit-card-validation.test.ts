import { describe, expect, it } from "vitest";
import { getTeamCardValidationState } from "./team-credit-card-validation";

describe("getTeamCardValidationState", () => {
  it("returns cardNumberValid=true for empty card number", () => {
    const result = getTeamCardValidationState("", "");
    expect(result.cardNumberValid).toBe(true);
    expect(result.showLengthError).toBe(false);
    expect(result.showLuhnError).toBe(false);
  });

  it("detects valid Visa card", () => {
    // Valid Visa test number: 4111 1111 1111 1111
    const result = getTeamCardValidationState("4111 1111 1111 1111", "");
    expect(result.cardNumberValid).toBe(true);
    expect(result.hasBrandHint).toBe(true);
    expect(result.cardValidation.effectiveBrand).toBe("Visa");
  });

  it("shows length error for too-short card number", () => {
    const result = getTeamCardValidationState("4111", "");
    expect(result.showLengthError).toBe(true);
    expect(result.cardNumberValid).toBe(false);
  });

  it("shows luhn error for correct-length but invalid checksum", () => {
    // 16 digits but wrong Luhn check
    const result = getTeamCardValidationState("4111 1111 1111 1112", "");
    expect(result.showLuhnError).toBe(true);
    expect(result.cardNumberValid).toBe(false);
  });

  it("uses manual brand when provided", () => {
    const result = getTeamCardValidationState("4111 1111 1111 1111", "Mastercard");
    // Manual brand overrides detected brand
    expect(result.cardValidation.effectiveBrand).toBe("Mastercard");
  });

  it("returns proper lengthHint format", () => {
    const result = getTeamCardValidationState("4111", "Visa");
    // Visa allows 13/16/19 digits
    expect(result.lengthHint).toMatch(/\d/);
  });

  it("computes maxInputLength with separators", () => {
    const result = getTeamCardValidationState("", "Visa");
    // maxDigits + separator count
    expect(result.maxInputLength).toBeGreaterThan(16);
  });

  it("handles American Express different spacing", () => {
    // Amex: 15 digits, 4-6-5 spacing → maxDigits + 2 separators
    const result = getTeamCardValidationState("", "American Express");
    expect(result.maxInputLength).toBe(17); // 15 + 2
  });
});
