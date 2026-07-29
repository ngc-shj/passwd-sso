/**
 * The single definition of "characters that must not reach a surface a human
 * or an AI agent reads": ASCII/C1 control characters, Unicode bidi controls,
 * and invisible formatting characters. They enable homoglyph spoofing
 * (`paypa<ZWSP>l.com`), visual reversal (RIGHT-TO-LEFT OVERRIDE), and prompt
 * injection through fake line breaks.
 *
 * Two call sites shared this predicate by copy before this module existed and
 * had already diverged (round-1 Sec F6) — each was missing members the other
 * had. One definition here; the *policy* stays with the caller (the delegation
 * metadata boundary rejects, the tenant-claim sanitizer strips).
 *
 * Members:
 *  - C0 controls, DEL, C1 controls (U+0000-U+001F, U+007F-U+009F)
 *  - Soft hyphen (U+00AD) — invisible, splits a rendered word
 *  - Arabic letter mark (U+061C) — bidi control
 *  - Mongolian vowel separator (U+180E)
 *  - Zero-width chars and LRM/RLM (U+200B-U+200F)
 *  - Line/paragraph separators (U+2028, U+2029)
 *  - Bidi embeddings and overrides (U+202A-U+202E)
 *  - Word joiner (U+2060)
 *  - Bidi isolates (U+2066-U+2069)
 *  - BOM / zero-width no-break space (U+FEFF)
 */
const UNSAFE_DISPLAY_CHARS_CLASS =
  "[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E\\u200B-\\u200F" +
  "\\u2028\\u2029\\u202A-\\u202E\\u2060\\u2066-\\u2069\\uFEFF]";

/** Non-global — safe for repeated `.test()`, which a /g regex is not. */
export const UNSAFE_DISPLAY_CHARS_RE = new RegExp(UNSAFE_DISPLAY_CHARS_CLASS);

/** Global — for stripping every occurrence from a value before display. */
export const UNSAFE_DISPLAY_CHARS_GLOBAL_RE = new RegExp(UNSAFE_DISPLAY_CHARS_CLASS, "g");
