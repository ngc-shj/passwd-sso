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
    // Prefer a CVV-hinted field inside the card block: the first page-wide
    // match can be an unrelated login field named "security_code" placed
    // before the card form, which would then receive the card's CVV.
    const cvvMatches = visibleFields.filter((f): f is HTMLInputElement => {
      if (!(f instanceof HTMLInputElement) || !isUsableField(f)) return false;
      const hint = getHintString(f);
      return CC_DETECT_RE.cvv.test(hint) || CC_CVV_JA_RE.test(hint);
    });
    const inBlock = cardNumber
      ? cardBlock(cardNumber, visibleFields.filter((f) => f !== cardNumber && isCardNeighbour(f)))
      : null;
    cvv = (inBlock ? cvvMatches.find(inBlock) : undefined) ?? cvvMatches[0] ?? null;
  }
  // Same-form-scoped `conf.?num` fallback. Only after the strong CVV
  // signals miss, and only when the candidate shares the card-number field's
  // form — never a page-wide first match.
  if (!cvv && cardNumber) {
    cvv = findConfNumCvvInForm(visibleFields, cardNumber);
  }
  if (cardNumber && !expiryCombined && !(expiryMonth && expiryYear)) {
    const picked = pickExpiry(visibleFields, cardNumber, { month: expiryMonth, year: expiryYear });
    expiryMonth = picked.month;
    expiryYear = picked.year;
    expiryCombined = picked.combined;
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

// ── Expiry picks ──
//
// Every expiry role comes from the card number's own form (or, for a form-less
// card number, from form-less fields), ranked by proximity to the field it pairs
// with rather than taken as the page's first match, so a dated field elsewhere in
// the page does not receive the card's expiry. Within the form, a bare month/year
// token claims nothing on a non-expiry hint; the strict patterns match as before
// (a "Passport expiry month" in the card's own form is still a candidate).

type ExpiryPart = "month" | "year";

const otherPart = (part: ExpiryPart): ExpiryPart => (part === "month" ? "year" : "month");

// Bare month/year tokens, delimiter-aware because "_" is a word character
// ("expiry_mm" must match, "exp_mmyy" must not).
const MONTH_TOKEN_RE = /(?:^|[^a-z0-9])(?:month|mm)(?![a-z0-9])/;
const YEAR_TOKEN_RE = /(?:^|[^a-z0-9])(?:years?|yy|yyyy|yr)(?![a-z0-9])/;
const CC_EXP_NAME_RE = /cc.?exp/;

// A token alone claims a part only on a hint made of expiry vocabulary, so a
// dated field about something else (birth, arrival, start...) never takes a card
// part through a token. Words of two characters or fewer and words with digits
// are neutral ("ey", "y2"); the strict patterns are exempt.
const EXPIRY_WORDS = new Set([
  "exp", "expiry", "expire", "expires", "expiration", "card", "valid", "thru", "date",
  "month", "year", "years", "yyyy",
  // Decoration that names no subject.
  "required", "optional", "please", "enter", "select", "your", "the",
]);
// A bracketed field name ("order[payment][expiry_mm]") is judged by its last segment.
const BRACKET_NAME_RE = /[a-z0-9_-]+(?:\[[^\]\s]*\])*\[([^\]\s]*)\]/g;
const JA_EXPIRY_VOCABULARY_RE = /有効期限|[月年（）()]/g;
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff]/;

function isExpiryVocabulary(hint: string): boolean {
  const rest = hint.replace(BRACKET_NAME_RE, "$1").replace(JA_EXPIRY_VOCABULARY_RE, "");
  if (CJK_RE.test(rest)) return false;
  return rest
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !/\d/.test(word))
    .every((word) => EXPIRY_WORDS.has(word));
}

function strictPart(hint: string, part: ExpiryPart): boolean {
  return part === "month"
    ? CC_DETECT_RE.expiryMonth.test(hint) || CC_EXPIRY_MONTH_JA_RE.test(hint)
    : CC_DETECT_RE.expiryYear.test(hint) || CC_EXPIRY_YEAR_JA_RE.test(hint);
}

function rawTokenPart(hint: string, part: ExpiryPart): boolean {
  return (part === "month" ? MONTH_TOKEN_RE : YEAR_TOKEN_RE).test(hint);
}

function hasExpiryContext(hint: string): boolean {
  return (
    CC_EXPIRY_RE.test(hint) ||
    CC_EXPIRY_JA_RE.test(hint) ||
    CC_EXP_NAME_RE.test(hint) ||
    CC_DETECT_RE.expiryMonth.test(hint) ||
    CC_DETECT_RE.expiryYear.test(hint)
  );
}

type PartFlags = Record<ExpiryPart, boolean>;

interface ExpiryCandidate {
  field: FormField;
  index: number;
  context: boolean;
  /** Today's patterns. */
  strict: PartFlags;
  /** Strict, or a token on an expiry-vocabulary hint. */
  loose: PartFlags;
  /** Loose, with the token counted only alongside expiry context. */
  names: PartFlags;
  /** Strict, or any token: whether the hint mentions the part at all. */
  mentions: PartFlags;
}

function describeCandidate(field: FormField, index: number): ExpiryCandidate {
  const hint = getHintString(field);
  const context = hasExpiryContext(hint);
  const vocabulary = isExpiryVocabulary(hint);
  const flags = (fn: (part: ExpiryPart) => boolean): PartFlags => ({ month: fn("month"), year: fn("year") });
  const strict = flags((part) => strictPart(hint, part));
  const token = flags((part) => rawTokenPart(hint, part));
  return {
    field,
    index,
    context,
    strict,
    loose: flags((part) => strict[part] || (token[part] && vocabulary)),
    names: flags((part) => strict[part] || (token[part] && vocabulary && context)),
    mentions: flags((part) => strict[part] || token[part]),
  };
}

function commonAncestorDepth(a: Element, b: Element): number {
  for (let ancestor: Element | null = a; ancestor; ancestor = ancestor.parentElement) {
    if (!ancestor.contains(b)) continue;
    let depth = 0;
    for (let el: Element | null = ancestor; el; el = el.parentElement) depth++;
    return depth;
  }
  return 0;
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

interface ExpiryPicks {
  month: FormField | null;
  year: FormField | null;
  combined: HTMLInputElement | null;
}

/**
 * Pick the expiry roles autocomplete left open. In order:
 * 1. the context month and year nearest the card number (split), unless a
 *    combined input sits nearer than the pair;
 * 2. the context input naming both parts or neither (combined);
 * 3. for one found part, its missing partner only from the field right beside
 *    it, usual side first (a year after its month);
 * 4. with nothing found, today's patterns, nearest the card number.
 * A field mentioning both parts (生年月日, YYYY/MM/DD) is never a single part.
 */
function pickExpiry(
  fields: FormField[],
  cardNumber: HTMLInputElement,
  decided: { month: FormField | null; year: FormField | null },
): ExpiryPicks {
  // `fields` lists inputs before selects; the neighbour rule needs document order.
  const ordered = fields
    .filter((f) => f === cardNumber || (f.form === cardNumber.form && isUsableField(f)))
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const indexOf = new Map(ordered.map((f, i) => [f, i]));
  const pool = ordered
    .map((f, i) => [f, i] as const)
    .filter(([f]) => f !== cardNumber)
    .map(([f, i]) => describeCandidate(f, i));

  const proximity = (anchor: FormField, field: FormField): number[] => {
    const anchorIndex = indexOf.get(anchor) ?? 0;
    const fieldIndex = indexOf.get(field) ?? 0;
    return [
      -commonAncestorDepth(anchor, field),
      fieldIndex > anchorIndex ? 0 : 1,
      Math.abs(fieldIndex - anchorIndex),
    ];
  };
  const nearest = (anchor: FormField, candidates: ExpiryCandidate[]): FormField | null => {
    let best: ExpiryCandidate | null = null;
    for (const c of candidates) {
      if (!best || compareKeys(proximity(anchor, c.field), proximity(anchor, best.field)) < 0) best = c;
    }
    return best?.field ?? null;
  };
  const singlePart = (part: ExpiryPart, by: "strict" | "loose" | "names") =>
    pool.filter((c) => c[by][part] && !c.mentions[otherPart(part)]);

  let month = decided.month ?? nearest(cardNumber, singlePart("month", "names").filter((c) => c.context));
  let year = decided.year ?? nearest(cardNumber, singlePart("year", "names").filter((c) => c.context));
  const combined = nearest(
    cardNumber,
    pool.filter((c) => c.field instanceof HTMLInputElement && c.context && c.mentions.month === c.mentions.year),
  ) as HTMLInputElement | null;

  if (month && year) {
    // A passport month/year later in the form must not beat the card's own
    // combined field next to the card number.
    const pairKey = [proximity(cardNumber, month), proximity(cardNumber, year)].sort(compareKeys)[0];
    const fromAutocomplete = decided.month !== null || decided.year !== null;
    if (combined && !fromAutocomplete && compareKeys(proximity(cardNumber, combined), pairKey) < 0) {
      return { month: null, year: null, combined };
    }
    return { month, year, combined: null };
  }
  if (!month && !year) {
    if (combined) return { month: null, year: null, combined };
    return {
      month: nearest(cardNumber, singlePart("month", "strict")),
      year: nearest(cardNumber, singlePart("year", "strict")),
      combined: null,
    };
  }

  const anchor = (month ?? year) as FormField;
  const missing: ExpiryPart = month ? "year" : "month";
  // An anchor outside the card number's form has no neighbour in the pool.
  const anchorIndex = indexOf.get(anchor);
  const sides =
    anchorIndex === undefined
      ? []
      : missing === "year"
        ? [anchorIndex + 1, anchorIndex - 1]
        : [anchorIndex - 1, anchorIndex + 1];
  const partner =
    sides
      .map((index) => pool.find((c) => c.index === index))
      .find((c) => c !== undefined && c.loose[missing] && !c.mentions[otherPart(missing)])?.field ?? null;
  if (missing === "year") year = partner;
  else month = partner;
  return { month, year, combined: null };
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
  const members = ccCardBlockFields(root);
  for (const el of formFieldsIn(root)) {
    if (hasCcAutocompleteToken(el)) members.add(el);
  }
  return members;
}

/**
 * Only the card number and its neighbours inside the card block, anchored on
 * a detected card number; empty without one. Unlike ccFormFields it leaves out
 * a stray `cc-*` field with no card number around it, so a consumer for which
 * excluding a field is NOT the safe direction (the login detector's
 * registration-form heuristic) cannot be steered by a page adding such tokens.
 */
export function ccCardBlockFields(root: ParentNode): Set<HTMLElement> {
  const members = new Set<HTMLElement>();
  const cardNumber = detectCreditCardFields(root)?.cardNumber ?? null;
  if (!cardNumber) return members;
  const neighbours = formFieldsIn(root).filter((el) => el !== cardNumber && isCardNeighbour(el));
  const inBlock = cardBlock(cardNumber, neighbours);
  if (!inBlock) return members;
  members.add(cardNumber);
  for (const el of neighbours) {
    if (inBlock(el)) members.add(el);
  }
  return members;
}

function formFieldsIn(root: ParentNode): FormField[] {
  return [
    ...Array.from(root.querySelectorAll<HTMLInputElement>("input")),
    ...Array.from(root.querySelectorAll<HTMLSelectElement>("select")),
  ];
}
