import { describe, expect, it, vi } from "vitest";
import type { CreditCardFormTranslator } from "@/lib/translation-types";

const handleOrgCardNumberChangeMock = vi.fn();

vi.mock("@/components/team/team-password-form-actions", () => ({
  handleOrgCardNumberChange: (...args: unknown[]) => handleOrgCardNumberChangeMock(...args),
}));

import {
  buildOrgCardNumberChangeCallback,
  buildOrgCardPresentationProps,
} from "@/hooks/team-password-form-presenter-card";

describe("buildOrgCardNumberChangeCallback", () => {
  it("delegates to handleOrgCardNumberChange with values and setters", () => {
    handleOrgCardNumberChangeMock.mockReset();
    const setCardNumber = vi.fn();
    const setBrand = vi.fn();

    const callback = buildOrgCardNumberChangeCallback(
      { brand: "visa", brandSource: "manual" },
      { setCardNumber, setBrand },
    );
    callback("4111 1111 1111 1111");

    expect(handleOrgCardNumberChangeMock).toHaveBeenCalledOnce();
    expect(handleOrgCardNumberChangeMock).toHaveBeenCalledWith({
      value: "4111 1111 1111 1111",
      brand: "visa",
      brandSource: "manual",
      setCardNumber,
      setBrand,
    });
  });
});

describe("buildOrgCardPresentationProps", () => {
  const tcc: CreditCardFormTranslator = (key, opts) =>
    opts && "brand" in opts ? `${key}:${opts.brand}` : key;

  it("returns translated detectedBrand when brand is present", () => {
    const result = buildOrgCardPresentationProps({
      cardValidation: { detectedBrand: "Visa", digits: "4242" },
      hasBrandHint: true,
      tcc,
    });
    expect(result.detectedBrand).toBe("cardNumberDetectedBrand:Visa");
    expect(result.hasBrandHint).toBe(true);
  });

  it("returns undefined detectedBrand when brand is null", () => {
    const result = buildOrgCardPresentationProps({
      cardValidation: { detectedBrand: null, digits: "1234" },
      hasBrandHint: true,
      tcc,
    });
    expect(result.detectedBrand).toBeUndefined();
    expect(result.hasBrandHint).toBe(true);
  });

  it("returns hasBrandHint false when digits are empty", () => {
    const result = buildOrgCardPresentationProps({
      cardValidation: { detectedBrand: "Visa", digits: "" },
      hasBrandHint: true,
      tcc,
    });
    expect(result.hasBrandHint).toBe(false);
  });

  it("returns hasBrandHint false when hasBrandHint arg is false", () => {
    const result = buildOrgCardPresentationProps({
      cardValidation: { detectedBrand: "Visa", digits: "4242" },
      hasBrandHint: false,
      tcc,
    });
    expect(result.hasBrandHint).toBe(false);
  });
});
