// Credit-card field hint patterns and the LOGIN autocomplete roles. DOM-free:
// the content detectors import them, and the service worker passes them to the
// self-contained direct-autofill func as { source, flags } args, so every
// matcher shares one definition.

export const CC_DETECT_RE = {
  number:      /card.?num|cc.?num|\bcard.?no\b|\bccno\b|\bpan\b/i,
  name:        /card.?holder|holder.?name|cc.?name|card.?name|name.?on.?card|meigi/i,
  expiryMonth: /exp(?:ir(?:y|e|ation))?[^a-z0-9]{0,2}month|card.?month|cc.?month|expire\W{0,2}mm?\b/i,
  expiryYear:  /exp(?:ir(?:y|e|ation))?[^a-z0-9]{0,2}year|card.?year|cc.?year|expire\W{0,2}yy?\b/i,
  cvv:         /cvv|cvc|csc|cv2|security.?code|security.?cd|\bcard.?verif|card.?code/i,
} as const;

// `conf.?num` (matches fields like `conf_number`) is deliberately NOT in
// CC_DETECT_RE.cvv: it also matches generic "confirmation number" fields (order/booking pages),
// and since regex fallback picks the first DOM match, an unrelated conf-number
// field appearing before the real CVV would receive the CVV write. It is only
// used as a CVV candidate when the field lives in the SAME form as the detected
// card-number field (see findConfNumCvvInForm).
export const CC_CONF_NUM_RE = /conf.?num/i;

export const CC_NUMBER_JA_RE = /カード番号/;
export const CC_NAME_JA_RE = /名義|カード名義/;

export const CC_EXPIRY_RE = /expir|exp.?date|valid.?thru|card.?exp/i;
export const CC_EXPIRY_JA_RE = /有効期限/;

export const CC_EXPIRY_MONTH_JA_RE = /月/;
export const CC_EXPIRY_YEAR_JA_RE = /年/;

export const CC_CVV_JA_RE = /セキュリティコード/;

// `autocomplete` tokens with which a page explicitly declares a LOGIN role. A
// field carrying one stays a LOGIN candidate even inside a card form: the
// page's own declaration wins over the card heuristics.
export const LOGIN_AUTOCOMPLETE_TOKENS: readonly string[] = [
  "username",
  "email",
  "current-password",
  "one-time-code",
];

// Hints that mark a card-number field, and hints that mark a field as part of
// the card form besides the number. The single-character JA month/year
// patterns (月 / 年) are left out of the neighbours: detectCreditCardFields uses
// them only next to an already-found card number, and here they would let a
// birth-date or any dated field anchor a card block.
export const CARD_NUMBER_PATTERNS: readonly RegExp[] = [CC_DETECT_RE.number, CC_NUMBER_JA_RE];
export const CARD_NEIGHBOUR_PATTERNS: readonly RegExp[] = [
  CC_DETECT_RE.cvv,
  CC_CVV_JA_RE,
  CC_DETECT_RE.name,
  CC_NAME_JA_RE,
  CC_DETECT_RE.expiryMonth,
  CC_DETECT_RE.expiryYear,
  CC_EXPIRY_RE,
  CC_EXPIRY_JA_RE,
];

/** A RegExp as plain data, for an executeScript arg (RegExp does not serialize). */
export type PatternSource = { source: string; flags: string };

export type CardPatternSources = {
  number: PatternSource[];
  neighbour: PatternSource[];
};

const toSource = (re: RegExp): PatternSource => ({ source: re.source, flags: re.flags });

export const CARD_PATTERN_SOURCES: CardPatternSources = {
  number: CARD_NUMBER_PATTERNS.map(toSource),
  neighbour: CARD_NEIGHBOUR_PATTERNS.map(toSource),
};
