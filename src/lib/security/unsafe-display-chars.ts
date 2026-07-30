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
 * Render a value that must reach a human — an operator terminal, a CSV export
 * — with every unsafe character replaced by its visible `<U+XXXX>` form.
 *
 * Escaping, not stripping, is the point. Stripping `ac<U+00AD>me.example`
 * prints `acme.example`, which is a *different*, existing claim — the reader
 * is shown a value that resolves and told it was refused.
 *
 * **The rendering is injective** (round-4 F5/S2): a literal ASCII `<` is
 * escaped too, so `<U+202E>` typed by an operator into `--by`, or stored in a
 * pre-existing `tenant_claims` row, cannot render identically to a real
 * U+202E. Without that pass the function's own promise — "honest about what
 * was received" — is false for exactly the values an adversary would choose,
 * and this is RS6's escape-the-escape-character clause in its non-backslash
 * form.
 *
 * There is deliberately NO length cap. Round 3 had one, and truncating at a
 * UTF-16 code-unit boundary split surrogate pairs; the lone surrogate then
 * made a `jsonb` audit write fail with 22P02 and be swallowed into a
 * dead-letter, which handed an actor a way to suppress the audit record of
 * their own denied sign-in (round-4 S1). Nothing needs the cap now — the audit
 * path carries a bounded ASCII diagnosis instead of a rendered value — and the
 * remaining callers all print to a terminal. Do not reintroduce one without a
 * well-formedness guarantee.
 */
export function escapeUnsafeDisplayChars(value: string): string {
  return value
    .replace(/</g, "<U+003C>")
    .replace(
      UNSAFE_DISPLAY_CHARS_GLOBAL_RE,
      (c) => `<U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`,
    );
}
