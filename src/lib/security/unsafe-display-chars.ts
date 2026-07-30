/**
 * The single definition of "characters that must not reach a surface a human
 * or an AI agent reads": ASCII/C1 control characters, Unicode bidi controls,
 * and invisible formatting characters. They enable homoglyph spoofing
 * (`paypa<ZWSP>l.com`), visual reversal (RIGHT-TO-LEFT OVERRIDE), and prompt
 * injection through fake line breaks.
 *
 * Two call sites shared this predicate by copy before this module existed and
 * had already diverged (round-1 Sec F6) — each was missing members the other
 * had. One definition here; the *policy* stays with the caller. Both ingest
 * boundaries REJECT (the delegation metadata boundary and the tenant-claim
 * sanitizer): a value carrying one of these characters is refused, never
 * silently canonicalised into a neighbouring one. Escaping is for the third
 * kind of caller — one that has to *render* a value it already refused, or a
 * pre-existing stored value it did not adjudicate.
 *
 * The ranges below ARE the definition — the regex is built from them, and the
 * tests enumerate every code point they contain (round-3 T9). The previous
 * shape was a hand-written class string next to a hand-picked sample table,
 * which meant narrowing a range could leave the sample entirely inside the
 * surviving part: U+202A-U+202E shrunk to U+202C-U+202E stayed green,
 * because the table happened to test U+202A and U+202E and not the middle.
 * Deriving both from one list is what makes "one case per member" true rather
 * than claimed.
 */
export const UNSAFE_DISPLAY_CHAR_RANGES: ReadonlyArray<readonly [number, number]> = [
  /** C0 controls and DEL/C1 controls. */
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  /** Soft hyphen — invisible, splits a rendered word. */
  [0x00ad, 0x00ad],
  /** Arabic letter mark — bidi control. */
  [0x061c, 0x061c],
  /** Mongolian vowel separator. */
  [0x180e, 0x180e],
  /** Zero-width characters and LRM/RLM. */
  [0x200b, 0x200f],
  /** Line and paragraph separators. */
  [0x2028, 0x2029],
  /** Bidi embeddings and overrides. */
  [0x202a, 0x202e],
  /** Word joiner. */
  [0x2060, 0x2060],
  /** Bidi isolates. */
  [0x2066, 0x2069],
  /** BOM / zero-width no-break space. */
  [0xfeff, 0xfeff],
];

const hex4 = (cp: number) => `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;

const UNSAFE_DISPLAY_CHARS_CLASS = `[${UNSAFE_DISPLAY_CHAR_RANGES.map(([lo, hi]) =>
  lo === hi ? hex4(lo) : `${hex4(lo)}-${hex4(hi)}`,
).join("")}]`;

/** Non-global — safe for repeated `.test()`, which a /g regex is not. */
export const UNSAFE_DISPLAY_CHARS_RE = new RegExp(UNSAFE_DISPLAY_CHARS_CLASS);

/** Global — for rewriting every occurrence in a value before display. */
export const UNSAFE_DISPLAY_CHARS_GLOBAL_RE = new RegExp(UNSAFE_DISPLAY_CHARS_CLASS, "g");

/**
 * Render a value that must reach a human — an operator terminal, a CSV export,
 * an audit metadata field — with every unsafe character replaced by its
 * visible `<U+XXXX>` form.
 *
 * Escaping, not stripping, is the point. Stripping `ac<U+00AD>me.example`
 * prints `acme.example`, which is a *different* claim than the one that
 * arrived — the reader is shown a value that resolves and told it was refused.
 * The escape is the only rendering that is both safe to print and honest about
 * what was received.
 *
 * `maxLength` caps the ESCAPED result and never cuts an escape in half: a
 * trailing partial `<U+2` is dropped rather than shown, since a half-written
 * escape is exactly the kind of thing a reader would take for literal text.
 */
export function escapeUnsafeDisplayChars(value: string, maxLength?: number): string {
  const escaped = value.replace(
    UNSAFE_DISPLAY_CHARS_GLOBAL_RE,
    (c) => `<U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`,
  );
  if (maxLength === undefined || escaped.length <= maxLength) return escaped;
  // `{0,4}`, not `{0,3}`: `<U+200B` — the whole escape but its closing `>` —
  // is the longest partial and has four hex digits.
  return escaped.slice(0, maxLength).replace(/<(U(\+[0-9A-F]{0,4})?)?$/, "");
}
