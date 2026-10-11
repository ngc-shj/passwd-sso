// Credit-card field detection, side-effect-free. detectCreditCardFields is the
// CC detector's own claim (one field per role); ccClaimedFields lists those
// claims; ccFormFields is the card form as LOGIN detection must avoid it.
// Imports only the pattern table and the field-query leaf, so the LOGIN modules
// can depend on it without a cycle back through form-detector-lib.

import {
  CC_DETECT_RE,
  CC_CONF_NUM_RE,
  CC_NUMBER_JA_RE,
  CC_NAME_JA_RE,
  CC_EXPIRY_RE,
  CC_EXPIRY_JA_RE,
  CC_EXPIRY_MONTH_JA_RE,
  CC_EXPIRY_YEAR_JA_RE,
  CC_CVV_JA_RE,
  CARD_NEIGHBOUR_PATTERNS,
  CARD_FILLABLE_INPUT_TYPES,
} from "../lib/cc-patterns";
import {
  isUsableFieldOfType,
  isElementVisible,
  getHintString,
  findFieldByAutocomplete,
  findFieldByRegex,
} from "./field-query-lib";

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

// ── Fillable input types ──
// Only free-text-like input types can receive CC autofill. Radio / checkbox /
// hidden / submit etc. must never be claimed as card fields — a payment-method
// radio like `<input type="radio" id="card_number_pay">` would otherwise match
// by hint and trigger the CC dropdown on focus. `password` is included because
// CVV fields are commonly masked.
const FILLABLE_INPUT_TYPES: ReadonlySet<string> = new Set(CARD_FILLABLE_INPUT_TYPES);

const isUsableField = (el: HTMLInputElement | HTMLSelectElement): boolean =>
  isUsableFieldOfType(el, FILLABLE_INPUT_TYPES);

/** Visible + usable + allowlisted: the detector's own admission rule for a field. */
export const isCreditCardFillable = (el: HTMLInputElement | HTMLSelectElement): boolean =>
  isElementVisible(el) && isUsableField(el);

// ── Autocomplete attributes (standard) ──

const AC_CC_NUMBER = "cc-number";
const AC_CC_NAME = "cc-name";
const AC_CC_EXP = "cc-exp";
const AC_CC_EXP_MONTH = "cc-exp-month";
const AC_CC_EXP_YEAR = "cc-exp-year";
const AC_CC_CSC = "cc-csc";

// ── Field finder ──

/** A `conf_number` field only looks like a CVV if it carries a CVV-specific
 * signal: masked input (type=password) or a 3–4 char length cap. A generic
 * confirmation-number text field has neither. */
function looksLikeCvvField(el: HTMLInputElement): boolean {
  if (el.type === "password") return true;
  return el.maxLength === 3 || el.maxLength === 4;
}

/**
 * True when the candidate is co-located with the card-number field:
 * - both belong to the same <form>, OR
 * - (form-less pages) both live in the SAME <table>. A page-wrapper ancestor
 *   (#app, main, ...) is deliberately NOT enough — SPAs wrap the whole page in
 *   one, which would re-admit an unrelated confirmation-number section. Only a
 *   shared <table> counts as "same local group" on form-less markup.
 */
function isCoLocatedWith(candidate: HTMLElement, cardNumber: HTMLElement): boolean {
  const cardForm = cardNumber.closest("form");
  const candForm = candidate.closest("form");
  if (cardForm || candForm) return cardForm !== null && cardForm === candForm;

  // Form-less: require a shared <table> (not merely any common ancestor).
  const candTable = candidate.closest("table");
  return candTable !== null && candTable === cardNumber.closest("table");
}

/**
 * Find a `conf.?num`-hinted CVV candidate, but ONLY when it is co-located with
 * the already-detected card-number field (same <form>, or same <table> on
 * form-less pages) AND carries a CVV-specific signal (masked / length-capped).
 * This scopes the generic "confirmation number" match to genuine card forms
 * and prevents an unrelated order/booking confirmation-number field elsewhere
 * on the page from receiving the CVV write.
 */
function findConfNumCvvInForm(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  cardNumber: HTMLInputElement,
): HTMLInputElement | null {
  return (
    (fields.find((f) => {
      if (!(f instanceof HTMLInputElement)) return false;
      if (!isUsableField(f)) return false;
      if (!CC_CONF_NUM_RE.test(getHintString(f))) return false;
      if (!looksLikeCvvField(f)) return false;
      return isCoLocatedWith(f, cardNumber);
    }) as HTMLInputElement | undefined) ?? null
  );
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
  let cardNumber = findFieldByAutocomplete(visibleFields, AC_CC_NUMBER, isUsableField) as HTMLInputElement | null;
  let cardholderName = findFieldByAutocomplete(visibleFields, AC_CC_NAME, isUsableField) as HTMLInputElement | null;
  let expiryCombined = findFieldByAutocomplete(visibleFields, AC_CC_EXP, isUsableField) as HTMLInputElement | null;
  let expiryMonth = findFieldByAutocomplete(visibleFields, AC_CC_EXP_MONTH, isUsableField);
  let expiryYear = findFieldByAutocomplete(visibleFields, AC_CC_EXP_YEAR, isUsableField);
  let cvv = findFieldByAutocomplete(visibleFields, AC_CC_CSC, isUsableField) as HTMLInputElement | null;

  // Priority 2: name/id/label regex fallback
  if (!cardNumber) {
    cardNumber = findFieldByRegex(visibleFields, CC_DETECT_RE.number, CC_NUMBER_JA_RE, isUsableField) as HTMLInputElement | null;
  }
  if (!cardholderName) {
    cardholderName = findFieldByRegex(visibleFields, CC_DETECT_RE.name, CC_NAME_JA_RE, isUsableField) as HTMLInputElement | null;
  }
  if (!cvv) {
    cvv = findFieldByRegex(visibleFields, CC_DETECT_RE.cvv, CC_CVV_JA_RE, isUsableField) as HTMLInputElement | null;
  }
  // Same-form-scoped `conf.?num` fallback. Only after the strong CVV
  // signals miss, and only when the candidate shares the card-number field's
  // form — never a page-wide first match.
  if (!cvv && cardNumber) {
    cvv = findConfNumCvvInForm(visibleFields, cardNumber);
  }
  if (!expiryMonth && !expiryCombined) {
    // Check for combined expiry first
    const combined = findFieldByRegex(visibleFields, CC_EXPIRY_RE, CC_EXPIRY_JA_RE, isUsableField);
    if (combined && combined instanceof HTMLInputElement) {
      expiryCombined = combined;
    } else {
      expiryMonth = findFieldByRegex(visibleFields, CC_DETECT_RE.expiryMonth, CC_EXPIRY_MONTH_JA_RE, isUsableField);
    }
  }
  if (!expiryYear && !expiryCombined) {
    expiryYear = findFieldByRegex(visibleFields, CC_DETECT_RE.expiryYear, CC_EXPIRY_YEAR_JA_RE, isUsableField);
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

/** Every field detectCreditCardFields claims, as a membership set. */
export function ccClaimedFields(root: ParentNode): Set<HTMLElement> {
  const claimed = new Set<HTMLElement>();
  const fields = detectCreditCardFields(root);
  if (!fields) return claimed;
  for (const el of [
    fields.cardholderName,
    fields.cardNumber,
    fields.expiryMonth,
    fields.expiryYear,
    fields.expiryCombined,
    fields.cvv,
  ]) {
    if (el) claimed.add(el);
  }
  return claimed;
}

// ── Card form, as LOGIN detection sees it ──

type FormField = HTMLInputElement | HTMLSelectElement;

function hasCcAutocompleteToken(el: FormField): boolean {
  return (el.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .some((token) => token.startsWith("cc-"));
}

/** A visible, fillable field whose hints or autocomplete say "card", other than the number. */
function isCardNeighbour(el: FormField): boolean {
  if (!isCreditCardFillable(el)) return false;
  if (hasCcAutocompleteToken(el)) return true;
  const hint = getHintString(el);
  return CARD_NEIGHBOUR_PATTERNS.some((re) => re.test(hint));
}

/**
 * Membership test for the card block around `cardNumber`, or null when the card
 * number has no card neighbour (a lone match, e.g. a "利用者カード番号" login ID).
 * - The card number's own form, when that form holds a neighbour; a field the
 *   form owns through `form="id"` counts as inside it.
 * - Otherwise the lowest ancestor below <body> that also holds a neighbour not
 *   owned by a different form. A form-less <table> block is one case; a
 *   <div>-only checkout is another.
 */
function cardBlock(
  cardNumber: HTMLInputElement,
  neighbours: FormField[],
): ((el: FormField) => boolean) | null {
  const form = cardNumber.form;
  if (form) {
    const inForm = (el: FormField) => el.form === form || form.contains(el);
    if (neighbours.some(inForm)) return inForm;
  }
  const sameFormOrNone = neighbours.filter((el) => el.form === null || el.form === form);
  const body = cardNumber.ownerDocument.body;
  for (
    let ancestor = cardNumber.parentElement;
    ancestor && ancestor !== body && ancestor !== cardNumber.ownerDocument.documentElement;
    ancestor = ancestor.parentElement
  ) {
    const block = ancestor;
    if (sameFormOrNone.some((el) => block.contains(el))) {
      return (el) => sameFormOrNone.includes(el) && block.contains(el);
    }
  }
  return null;
}

/**
 * The fields LOGIN detection must not treat as its own: the card number and
 * its card neighbours inside the card block, plus any field with a `cc-*`
 * autocomplete token. Built from a scan rather than from detectCreditCardFields'
 * single-valued claims, which take the first page-wide match and so can be won
 * by an unrelated `security_code` login field earlier in the page.
 */
export function ccFormFields(root: ParentNode): Set<HTMLElement> {
  const fields: FormField[] = [
    ...Array.from(root.querySelectorAll<HTMLInputElement>("input")),
    ...Array.from(root.querySelectorAll<HTMLSelectElement>("select")),
  ];
  const members = new Set<HTMLElement>(fields.filter(hasCcAutocompleteToken));
  const cardNumber = detectCreditCardFields(root)?.cardNumber ?? null;
  if (!cardNumber) return members;
  const neighbours = fields.filter((el) => el !== cardNumber && isCardNeighbour(el));
  const inBlock = cardBlock(cardNumber, neighbours);
  if (!inBlock) return members;
  members.add(cardNumber);
  for (const el of neighbours) {
    if (inBlock(el)) members.add(el);
  }
  return members;
}
