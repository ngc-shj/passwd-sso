import { describe, expect, it } from "vitest";
import {
  UNSAFE_DISPLAY_CHARS_GLOBAL_RE,
  UNSAFE_DISPLAY_CHARS_RE,
  UNSAFE_DISPLAY_CHAR_RANGES,
  escapeUnsafeDisplayChars,
} from "./unsafe-display-chars";

/**
 * Every code point in the class, derived from the class's own range list
 * rather than sampled by hand (round-3 T9).
 *
 * The previous table named 21 representatives of an 86-member class and its
 * comment claimed one case per member. It was per-RANGE, and endpoints only:
 * narrowing U+202A-U+202E to U+202C-U+202E — losing two live bidi controls —
 * kept both sampled members inside the surviving part and stayed green. The
 * two artefacts also drifted independently, since the class string and the
 * sample were separate hand-written lists of the same thing.
 *
 * Code points, never literals: most of these are invisible and several would
 * alter the rendering of this source file.
 */
const UNSAFE_CODE_POINTS: ReadonlyArray<[string, number]> = UNSAFE_DISPLAY_CHAR_RANGES.flatMap(
  ([lo, hi]) => {
    const points: [string, number][] = [];
    for (let cp = lo; cp <= hi; cp++) {
      points.push([`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`, cp]);
    }
    return points;
  },
);

describe("unsafe display characters", () => {
  // The derivation above is only worth anything if the ranges are the ones
  // this class has always had. Pinned as a total, plus the named members that
  // round-1 Sec F6 added when the two copied predicates were merged — so a
  // range silently dropped from the list fails HERE, where the derived table
  // would otherwise simply stop testing it.
  it("covers the 86 code points of the merged class, including F6's six additions", () => {
    expect(UNSAFE_CODE_POINTS).toHaveLength(86);
    for (const cp of [0x2028, 0x2029, 0x2060, 0x180e, 0x00ad, 0x061c]) {
      expect(UNSAFE_CODE_POINTS.some(([, c]) => c === cp)).toBe(true);
    }
    // Adjacent printable characters must NOT be swept in by a fat-fingered
    // range bound: a class that ate U+0020 (space) or U+2010 (hyphen) would
    // reject ordinary claims.
    for (const cp of [0x0020, 0x007e, 0x00ac, 0x00ae, 0x2010, 0x200a, 0x2010, 0xfefe]) {
      expect(UNSAFE_DISPLAY_CHARS_RE.test(String.fromCodePoint(cp))).toBe(false);
    }
  });

  it("the compiled regex matches exactly the derived member set", () => {
    // Ties the two artefacts the T9 split allowed to drift: if the regex is
    // ever hand-edited back to a literal, this fails.
    for (const [, cp] of UNSAFE_CODE_POINTS) {
      expect(UNSAFE_DISPLAY_CHARS_RE.test(String.fromCodePoint(cp))).toBe(true);
    }
    expect(UNSAFE_DISPLAY_CHAR_RANGES.every(([lo, hi]) => lo <= hi)).toBe(true);
  });

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

  describe("escapeUnsafeDisplayChars", () => {
    it.each(UNSAFE_CODE_POINTS)("renders %s as its visible code point", (_label, cp) => {
      const hex = cp.toString(16).toUpperCase().padStart(4, "0");
      expect(escapeUnsafeDisplayChars(`a${String.fromCodePoint(cp)}b`)).toBe(`a<U+${hex}>b`);
    });

    it("escapes rather than strips, so the rendering is not a resolvable claim", () => {
      // The distinction the function exists for: stripping prints
      // `acme.example`, which is a DIFFERENT, existing claim — the reader is
      // shown a value that resolves and told it was refused.
      const mangled = `acme${String.fromCodePoint(0x00ad)}.example`;
      expect(escapeUnsafeDisplayChars(mangled)).toBe("acme<U+00AD>.example");
      expect(escapeUnsafeDisplayChars(mangled)).not.toBe("acme.example");
    });

    it("leaves a clean value byte-identical", () => {
      for (const safe of ["alias.example", "résumé", "保管庫", "a b"]) {
        expect(escapeUnsafeDisplayChars(safe)).toBe(safe);
      }
    });

    it("escapes every occurrence, not only the first", () => {
      const value = `a${String.fromCodePoint(0x200b)}b${String.fromCodePoint(0x200b)}c`;
      expect(escapeUnsafeDisplayChars(value)).toBe("a<U+200B>b<U+200B>c");
    });

    it("caps the ESCAPED length, not the input length", () => {
      // 10 escaped chars from 1 input char: a cap applied before escaping
      // would return 8 characters here instead of 4.
      expect(escapeUnsafeDisplayChars(`ab${String.fromCodePoint(0x200b)}cd`, 4)).toBe("ab");
    });

    it("never emits a half-written escape at the cap boundary", () => {
      // "<U+200B>c" — cutting at 5 lands inside the escape. A partial `<U+2`
      // is exactly what a reader would take for literal text, so it is
      // dropped rather than shown.
      const value = `${String.fromCodePoint(0x200b)}c`;
      for (const cap of [1, 2, 3, 4, 5, 6, 7]) {
        expect(escapeUnsafeDisplayChars(value, cap)).toBe("");
      }
      expect(escapeUnsafeDisplayChars(value, 8)).toBe("<U+200B>");
      expect(escapeUnsafeDisplayChars(value, 9)).toBe("<U+200B>c");
    });

    it("leaves a value at or under the cap untouched", () => {
      expect(escapeUnsafeDisplayChars("alias.example", 13)).toBe("alias.example");
      expect(escapeUnsafeDisplayChars("alias.example", 1024)).toBe("alias.example");
    });
  });
});
