export const CARD_BRANDS = [
  "Visa",
  "Mastercard",
  "American Express",
  "Discover",
  "Diners Club",
  "JCB",
  "UnionPay",
  "Other",
] as const;

export type CardBrand = (typeof CARD_BRANDS)[number];

const BRAND_LENGTHS: Record<CardBrand, number[]> = {
  Visa: [13, 16, 19],
  Mastercard: [16],
  "American Express": [15],
  Discover: [16, 19],
  "Diners Club": [14, 16],
  JCB: [16, 17, 18, 19],
  UnionPay: [16, 17, 18, 19],
  Other: [],
};

const MIN_GENERIC_LENGTH = 12;
const MAX_GENERIC_LENGTH = 19;

const toNumber = (value: string, length: number) =>
  Number(value.slice(0, length));

const inRange = (value: number, min: number, max: number) =>
  value >= min && value <= max;

export const normalizeCardNumber = (value: string): string =>
  value.replace(/\D/g, "");

export const normalizeCardBrand = (brand?: string | null): CardBrand | "" => {
  if (!brand) return "";
  return (CARD_BRANDS as readonly string[]).includes(brand)
    ? (brand as CardBrand)
    : "";
};

export const detectCardBrand = (digits: string): CardBrand | "" => {
  if (!digits) return "";

  if (digits.startsWith("34") || digits.startsWith("37")) return "American Express";

  const first3 = toNumber(digits, 3);
  const first2 = toNumber(digits, 2);
  const first4 = toNumber(digits, 4);
  const first6 = toNumber(digits, 6);

  if (inRange(first3, 300, 305) || first2 === 36 || inRange(first2, 38, 39)) {
    return "Diners Club";
  }

  if (
    digits.startsWith("6011") ||
    digits.startsWith("65") ||
    inRange(first3, 644, 649) ||
    inRange(first6, 622126, 622925)
  ) {
    return "Discover";
  }

  if (inRange(first4, 3528, 3589)) return "JCB";

  if (inRange(first2, 51, 55) || inRange(first4, 2221, 2720)) {
    return "Mastercard";
  }

  if (digits.startsWith("62")) return "UnionPay";

  if (digits.startsWith("4")) return "Visa";

  return "";
};

export const getAllowedLengths = (brand?: string | null): number[] | null => {
  const normalized = normalizeCardBrand(brand);
  if (!normalized || normalized === "Other") return null;
  return BRAND_LENGTHS[normalized];
};

export const getMinLength = (brand?: string | null): number => {
  const allowed = getAllowedLengths(brand);
  return allowed ? Math.min(...allowed) : MIN_GENERIC_LENGTH;
};

export const getMaxLength = (brand?: string | null): number => {
  const allowed = getAllowedLengths(brand);
  return allowed ? Math.max(...allowed) : MAX_GENERIC_LENGTH;
};

export const isCardLengthValid = (length: number, brand?: string | null): boolean => {
  const allowed = getAllowedLengths(brand);
  if (allowed) return allowed.includes(length);
  return length >= MIN_GENERIC_LENGTH && length <= MAX_GENERIC_LENGTH;
};

export const isValidLuhn = (digits: string): boolean => {
  let sum = 0;
  let doubleNext = false;

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (Number.isNaN(digit)) return false;
    if (doubleNext) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleNext = !doubleNext;
  }

  return sum % 10 === 0;
};

export const formatCardNumber = (value: string, brandHint?: string | null): string => {
  const digits = normalizeCardNumber(value);
  if (!digits) return "";

  const brand = normalizeCardBrand(brandHint) || detectCardBrand(digits);

  if (brand === "American Express") {
    const part1 = digits.slice(0, 4);
    const part2 = digits.slice(4, 10);
    const part3 = digits.slice(10, 15);
    return [part1, part2, part3].filter(Boolean).join(" ");
  }

  const groups: string[] = [];
  for (let i = 0; i < digits.length; i += 4) {
    groups.push(digits.slice(i, i + 4));
  }
  return groups.filter(Boolean).join(" ");
};

export const getCardNumberValidation = (value: string, brandHint?: string | null) => {
  const digits = normalizeCardNumber(value);
  const detectedBrand = detectCardBrand(digits);
  const normalizedBrand = normalizeCardBrand(brandHint);
  const effectiveBrand = normalizedBrand || detectedBrand || "";
  const lengthValid = digits.length === 0
    ? true
    : isCardLengthValid(digits.length, effectiveBrand);
  const luhnValid = digits.length === 0 ? true : isValidLuhn(digits);

  return {
    digits,
    detectedBrand,
    effectiveBrand,
    lengthValid,
    luhnValid,
  };
};
