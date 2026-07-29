import { describe, expect, it } from "vitest";
import {
  UNSAFE_DISPLAY_CHARS_GLOBAL_RE,
  UNSAFE_DISPLAY_CHARS_RE,
} from "./unsafe-display-chars";

// Code points rather than literals: several of these are invisible or would
// alter the rendering of this source file. The list is the union of the two
// predicates this module replaced, plus the six neither of them had (round-1
// Sec F6) — named individually so a narrowing of the class fails here rather
// than at a display surface.
const UNSAFE_CODE_POINTS: ReadonlyArray<[string, number]> = [
  ["NULL", 0x0000],
  ["LINE FEED", 0x000a],
  ["UNIT SEPARATOR", 0x001f],
  ["DELETE", 0x007f],
  ["C1 PAD", 0x0080],
  ["C1 APC", 0x009f],
  ["SOFT HYPHEN", 0x00ad],
  ["ARABIC LETTER MARK", 0x061c],
  ["MONGOLIAN VOWEL SEPARATOR", 0x180e],
  ["ZERO WIDTH SPACE", 0x200b],
  ["ZERO WIDTH JOINER", 0x200d],
  ["LEFT-TO-RIGHT MARK", 0x200e],
  ["RIGHT-TO-LEFT MARK", 0x200f],
  ["LINE SEPARATOR", 0x2028],
  ["PARAGRAPH SEPARATOR", 0x2029],
  ["LEFT-TO-RIGHT EMBEDDING", 0x202a],
  ["RIGHT-TO-LEFT OVERRIDE", 0x202e],
  ["WORD JOINER", 0x2060],
  ["LEFT-TO-RIGHT ISOLATE", 0x2066],
  ["POP DIRECTIONAL ISOLATE", 0x2069],
  ["ZERO WIDTH NO-BREAK SPACE (BOM)", 0xfeff],
];

describe("unsafe display characters", () => {
  it.each(UNSAFE_CODE_POINTS)("detects %s", (_label, cp) => {
    expect(UNSAFE_DISPLAY_CHARS_RE.test(`a${String.fromCodePoint(cp)}b`)).toBe(true);
  });

  it.each(UNSAFE_CODE_POINTS)("strips %s", (_label, cp) => {
    const withChar = `a${String.fromCodePoint(cp)}b`;
    expect(withChar.replace(UNSAFE_DISPLAY_CHARS_GLOBAL_RE, "")).toBe("ab");
  });

  it("leaves printable text, accented Latin, CJK and emoji alone", () => {
    for (const safe of ["alias.example", "résumé", "保管庫", "password 🔐", "a b"]) {
      expect(UNSAFE_DISPLAY_CHARS_RE.test(safe)).toBe(false);
      expect(safe.replace(UNSAFE_DISPLAY_CHARS_GLOBAL_RE, "")).toBe(safe);
    }
  });

  it("the detection regex is not stateful across calls", () => {
    // A /g regex would alternate true/false here via lastIndex, and the reject
    // boundary calls .test() repeatedly on the shared instance.
    const zwsp = `a${String.fromCodePoint(0x200b)}b`;
    expect(UNSAFE_DISPLAY_CHARS_RE.test(zwsp)).toBe(true);
    expect(UNSAFE_DISPLAY_CHARS_RE.test(zwsp)).toBe(true);
  });

  it("strips every occurrence, not only the first", () => {
    const value = [0x200b, 0x202e, 0x00ad]
      .map((cp) => String.fromCodePoint(cp))
      .reduce((acc, char, i) => `${acc}${char}${"abc"[i]}`, "");
    expect(value.replace(UNSAFE_DISPLAY_CHARS_GLOBAL_RE, "")).toBe("abc");
  });
});
