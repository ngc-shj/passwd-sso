import {
  getAllowedLengths,
  getCardNumberValidation,
  getMaxLength,
} from "@/lib/credit-card";

interface OrgCardValidationState {
  cardValidation: ReturnType<typeof getCardNumberValidation>;
  lengthHint: string;
  maxInputLength: number;
  showLengthError: boolean;
  showLuhnError: boolean;
  cardNumberValid: boolean;
  hasBrandHint: boolean;
}

export function getOrgCardValidationState(
  cardNumber: string,
  brand: string,
): OrgCardValidationState {
  const cardValidation = getCardNumberValidation(cardNumber, brand);
  const allowedLengths = getAllowedLengths(cardValidation.effectiveBrand);
  const lengthHint = allowedLengths ? allowedLengths.join("/") : "12-19";
  const maxDigits = getMaxLength(cardValidation.effectiveBrand || cardValidation.detectedBrand);
  const maxInputLength =
    cardValidation.effectiveBrand === "American Express"
      ? maxDigits + 2
      : maxDigits + Math.floor((maxDigits - 1) / 4);
  const showLengthError = cardValidation.digits.length > 0 && !cardValidation.lengthValid;
  const showLuhnError =
    cardValidation.digits.length > 0 &&
    cardValidation.lengthValid &&
    !cardValidation.luhnValid;
  const cardNumberValid =
    cardValidation.digits.length === 0 ||
    (cardValidation.lengthValid && cardValidation.luhnValid);
  const hasBrandHint = Boolean(
    cardValidation.effectiveBrand && cardValidation.effectiveBrand !== "Other",
  );

  return {
    cardValidation,
    lengthHint,
    maxInputLength,
    showLengthError,
    showLuhnError,
    cardNumberValid,
    hasBrandHint,
  };
}
