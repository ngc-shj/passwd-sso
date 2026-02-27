import { describe, expect, it, vi } from "vitest";
import type { CreditCardFormTranslator } from "@/lib/translation-types";

const handleTeamCardNumberChangeMock = vi.fn();

vi.mock("@/components/team/team-password-form-actions", () => ({
  handleTeamCardNumberChange: (...args: unknown[]) => handleTeamCardNumberChangeMock(...args),
}));

import {
  buildTeamCardNumberChangeCallback,
  buildTeamCardPresentationProps,
} from "@/hooks/team-password-form-presenter-card";

describe("buildTeamCardNumberChangeCallback", () => {
  it("delegates to handleTeamCardNumberChange with values and setters", () => {
    handleTeamCardNumberChangeMock.mockReset();
    const setCardNumber = vi.fn();
    const setBrand = vi.fn();

    const callback = buildTeamCardNumberChangeCallback(
      { brand: "visa", brandSource: "manual" },
      { setCardNumber, setBrand },
    );
    callback("4111 1111 1111 1111");

    expect(handleTeamCardNumberChangeMock).toHaveBeenCalledOnce();
    expect(handleTeamCardNumberChangeMock).toHaveBeenCalledWith({
      value: "4111 1111 1111 1111",
      brand: "visa",
      brandSource: "manual",
      setCardNumber,
      setBrand,
    });
  });
});

describe("buildTeamCardPresentationProps", () => {
  const tcc: CreditCardFormTranslator = (key, opts) =>
    opts && "brand" in opts ? `${key}:${opts.brand}` : key;

  it("returns translated detectedBrand when brand is present", () => {
    const result = buildTeamCardPresentationProps({
      cardValidation: { detectedBrand: "Visa", digits: "4242" },
      hasBrandHint: true,
      tcc,
    });
    expect(result.detectedBrand).toBe("cardNumberDetectedBrand:Visa");
    expect(result.hasBrandHint).toBe(true);
  });

  it("returns undefined detectedBrand when brand is null", () => {
    const result = buildTeamCardPresentationProps({
      cardValidation: { detectedBrand: null, digits: "1234" },
      hasBrandHint: true,
      tcc,
    });
    expect(result.detectedBrand).toBeUndefined();
    expect(result.hasBrandHint).toBe(true);
  });

  it("returns hasBrandHint false when digits are empty", () => {
    const result = buildTeamCardPresentationProps({
      cardValidation: { detectedBrand: "Visa", digits: "" },
      hasBrandHint: true,
      tcc,
    });
    expect(result.hasBrandHint).toBe(false);
  });

  it("returns hasBrandHint false when hasBrandHint arg is false", () => {
    const result = buildTeamCardPresentationProps({
      cardValidation: { detectedBrand: "Visa", digits: "4242" },
      hasBrandHint: false,
      tcc,
    });
    expect(result.hasBrandHint).toBe(false);
  });
});
