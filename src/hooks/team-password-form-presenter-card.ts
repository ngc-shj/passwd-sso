"use client";

import { handleOrgCardNumberChange } from "@/components/team/team-password-form-actions";
import type { TeamPasswordFormValues, TeamPasswordFormSettersState } from "@/hooks/use-team-password-form-state";
import type { CreditCardFormTranslator } from "@/lib/translation-types";

export function buildTeamCardNumberChangeCallback(
  values: Pick<TeamPasswordFormValues, "brand" | "brandSource">,
  setters: Pick<TeamPasswordFormSettersState, "setCardNumber" | "setBrand">,
): (value: string) => void {
  return (value: string) => {
    handleOrgCardNumberChange({
      value,
      brand: values.brand,
      brandSource: values.brandSource,
      setCardNumber: setters.setCardNumber,
      setBrand: setters.setBrand,
    });
  };
}

export function buildTeamCardPresentationProps({
  cardValidation,
  hasBrandHint,
  tcc,
}: {
  cardValidation: { detectedBrand: string | null; digits: string };
  hasBrandHint: boolean;
  tcc: CreditCardFormTranslator;
}): {
  detectedBrand: string | undefined;
  hasBrandHint: boolean;
} {
  return {
    detectedBrand: cardValidation.detectedBrand
      ? tcc("cardNumberDetectedBrand", { brand: cardValidation.detectedBrand })
      : undefined,
    hasBrandHint: hasBrandHint && cardValidation.digits.length > 0,
  };
}
