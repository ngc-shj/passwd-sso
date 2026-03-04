// Pure logic module for credit card form detection (exported, testable).
// Side-effect-free — no global event registration here.

// ── Types ──

export interface CreditCardFormFields {
  cardholderName: HTMLInputElement | null;
  cardNumber: HTMLInputElement | null;
  expiryMonth: HTMLInputElement | HTMLSelectElement | null;
  expiryYear: HTMLInputElement | HTMLSelectElement | null;
  expiryCombined: HTMLInputElement | null;
  cvv: HTMLInputElement | null;
  expiryFormat: "split" | "combined";
}

// ── Visibility check (reuse pattern from form-detector-lib.ts) ──

function resolveOpacity(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 1;
}

export function isElementVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (resolveOpacity(style.opacity) <= 0.05) return false;
  return true;
}

// ── Field detection helpers ──

function getHintString(el: HTMLElement): string {
  const parts: string[] = [];
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
    if (el.name) parts.push(el.name);
    if (el.id) parts.push(el.id);
    if (el instanceof HTMLInputElement && el.placeholder) parts.push(el.placeholder);
  }
  if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label")!);
  // Walk up to find associated label
  const id = el.id;
  if (id && typeof CSS !== "undefined" && CSS.escape) {
    const label = el.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (label?.textContent) parts.push(label.textContent);
  }
  const parentLabel = el.closest("label");
  if (parentLabel?.textContent) parts.push(parentLabel.textContent);
  return parts.join(" ").toLowerCase();
}

function getAutocomplete(el: HTMLElement): string {
  return (el.getAttribute("autocomplete") ?? "").toLowerCase().trim();
}

function isUsableField(el: HTMLInputElement | HTMLSelectElement): boolean {
  if (el instanceof HTMLInputElement) {
    return !el.disabled && !el.readOnly;
  }
  return !el.disabled;
}

// ── Regex patterns ──

const CC_NUMBER_RE = /card.?num|cc.?num|pan/i;
const CC_NUMBER_JA_RE = /カード番号/;

const CC_NAME_RE = /card.?holder|cc.?name|name.?on.?card/i;
const CC_NAME_JA_RE = /名義|カード名義/;

const CC_EXPIRY_RE = /expir|exp.?date|valid.?thru|card.?exp/i;
const CC_EXPIRY_JA_RE = /有効期限/;

const CC_EXPIRY_MONTH_RE = /exp.?month|cc.?exp.?month|card.?month/i;
const CC_EXPIRY_MONTH_JA_RE = /月/;

const CC_EXPIRY_YEAR_RE = /exp.?year|cc.?exp.?year|card.?year/i;
const CC_EXPIRY_YEAR_JA_RE = /年/;

const CC_CVV_RE = /cvv|cvc|csc|cv2|security.?code|card.?code/i;
const CC_CVV_JA_RE = /セキュリティコード/;

// ── Autocomplete attributes (standard) ──

const AC_CC_NUMBER = "cc-number";
const AC_CC_NAME = "cc-name";
const AC_CC_EXP = "cc-exp";
const AC_CC_EXP_MONTH = "cc-exp-month";
const AC_CC_EXP_YEAR = "cc-exp-year";
const AC_CC_CSC = "cc-csc";

// ── Field finder ──

function findFieldByAutocomplete(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  acValue: string,
): HTMLInputElement | HTMLSelectElement | null {
  return fields.find((f) => getAutocomplete(f) === acValue && isUsableField(f)) ?? null;
}

function findFieldByRegex(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  regex: RegExp,
  regexJa: RegExp,
): HTMLInputElement | HTMLSelectElement | null {
  return (
    fields.find((f) => {
      if (!isUsableField(f)) return false;
      const hint = getHintString(f);
      return regex.test(hint) || regexJa.test(hint);
    }) ?? null
  );
}

// ── Combined expiry format detection ──

export function detectExpiryFormat(el: HTMLInputElement): "MM/YY" | "MM/YYYY" | "MMYY" | "MMYYYY" {
  const placeholder = (el.placeholder || "").toUpperCase();
  if (placeholder.includes("MM/YYYY") || placeholder.includes("MM / YYYY")) return "MM/YYYY";
  if (placeholder.includes("MM/YY") || placeholder.includes("MM / YY")) return "MM/YY";
  if (placeholder.includes("MMYYYY")) return "MMYYYY";
  if (placeholder.includes("MMYY")) return "MMYY";

  const maxLength = el.maxLength;
  if (maxLength === 7) return "MM/YYYY";
  if (maxLength === 5) return "MM/YY";
  if (maxLength === 6) return "MMYYYY";
  if (maxLength === 4) return "MMYY";

  return "MM/YY"; // default
}

export function formatCombinedExpiry(
  month: string,
  year: string,
  format: "MM/YY" | "MM/YYYY" | "MMYY" | "MMYYYY",
): string {
  const mm = month.padStart(2, "0");
  const yy = year.length > 2 ? year.slice(-2) : year.padStart(2, "0");
  const yyyy = year.length === 4 ? year : `20${yy}`;

  switch (format) {
    case "MM/YY":
      return `${mm}/${yy}`;
    case "MM/YYYY":
      return `${mm}/${yyyy}`;
    case "MMYY":
      return `${mm}${yy}`;
    case "MMYYYY":
      return `${mm}${yyyy}`;
  }
}

// ── Main detection function ──

export function detectCreditCardFields(root: ParentNode): CreditCardFormFields | null {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("input"));
  const selects = Array.from(root.querySelectorAll<HTMLSelectElement>("select"));
  const allFields: (HTMLInputElement | HTMLSelectElement)[] = [...inputs, ...selects];

  // Only consider visible fields
  const visibleFields = allFields.filter(
    (f) => isElementVisible(f) && isUsableField(f),
  );

  if (visibleFields.length === 0) return null;

  // Priority 1: autocomplete attributes
  let cardNumber = findFieldByAutocomplete(visibleFields, AC_CC_NUMBER) as HTMLInputElement | null;
  let cardholderName = findFieldByAutocomplete(visibleFields, AC_CC_NAME) as HTMLInputElement | null;
  let expiryCombined = findFieldByAutocomplete(visibleFields, AC_CC_EXP) as HTMLInputElement | null;
  let expiryMonth = findFieldByAutocomplete(visibleFields, AC_CC_EXP_MONTH);
  let expiryYear = findFieldByAutocomplete(visibleFields, AC_CC_EXP_YEAR);
  let cvv = findFieldByAutocomplete(visibleFields, AC_CC_CSC) as HTMLInputElement | null;

  // Priority 2: name/id/label regex fallback
  if (!cardNumber) {
    cardNumber = findFieldByRegex(visibleFields, CC_NUMBER_RE, CC_NUMBER_JA_RE) as HTMLInputElement | null;
  }
  if (!cardholderName) {
    cardholderName = findFieldByRegex(visibleFields, CC_NAME_RE, CC_NAME_JA_RE) as HTMLInputElement | null;
  }
  if (!cvv) {
    cvv = findFieldByRegex(visibleFields, CC_CVV_RE, CC_CVV_JA_RE) as HTMLInputElement | null;
  }
  if (!expiryMonth && !expiryCombined) {
    // Check for combined expiry first
    const combined = findFieldByRegex(visibleFields, CC_EXPIRY_RE, CC_EXPIRY_JA_RE);
    if (combined && combined instanceof HTMLInputElement) {
      expiryCombined = combined;
    } else {
      expiryMonth = findFieldByRegex(visibleFields, CC_EXPIRY_MONTH_RE, CC_EXPIRY_MONTH_JA_RE);
    }
  }
  if (!expiryYear && !expiryCombined) {
    expiryYear = findFieldByRegex(visibleFields, CC_EXPIRY_YEAR_RE, CC_EXPIRY_YEAR_JA_RE);
  }

  // Must have at least card number to consider this a CC form
  if (!cardNumber) return null;

  const hasCombined = expiryCombined !== null;

  return {
    cardholderName,
    cardNumber,
    expiryMonth: hasCombined ? null : expiryMonth,
    expiryYear: hasCombined ? null : expiryYear,
    expiryCombined: hasCombined ? expiryCombined : null,
    cvv,
    expiryFormat: hasCombined ? "combined" : "split",
  };
}
