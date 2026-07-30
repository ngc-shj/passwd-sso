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

    it("is injective: a literal <U+202E> does not render as a real U+202E", () => {
      // Round-4 F5/S2. `<`, `U`, `+`, `>` are all printable ASCII, so the
      // literal spelling passes storableClaimSchema and the C1 CHECK and can
      // be a real tenant_claims row — or an operator's `--by` label. Without
      // escaping the introducer, the two render identically and the operator
      // cannot tell which one is in the database.
      const real = escapeUnsafeDisplayChars(`acme${String.fromCodePoint(0x202e)}.example`);
      const literal = escapeUnsafeDisplayChars("acme<U+202E>.example");
      expect(real).toBe("acme<U+202E>.example");
      expect(literal).toBe("acme<U+003C>U+202E>.example");
      expect(literal).not.toBe(real);
    });

    it("escapes the introducer before the unsafe pass, so escapes are not re-escaped", () => {
      // Ordering check: the `<` this function itself emits must not be fed
      // back through the introducer pass, or one unsafe char would produce
      // `<U+003C>U+200B>`.
      expect(escapeUnsafeDisplayChars(String.fromCodePoint(0x200b))).toBe("<U+200B>");
      expect(escapeUnsafeDisplayChars("<")).toBe("<U+003C>");
      expect(escapeUnsafeDisplayChars("<<")).toBe("<U+003C><U+003C>");
    });

    it("takes no length cap — the truncation that split surrogate pairs is gone", () => {
      // Round-4 S1: the cap truncated at a UTF-16 code-unit boundary, so an
      // astral character straddling it left a lone surrogate, which Postgres
      // rejects in jsonb (22P02) and logAuditAsync swallows into a
      // dead-letter — an actor could suppress their own denial's audit row.
      // Round-5 T8: `Function.length` is NOT the guard — it stays 1 for a
      // re-added `maxLength = 255` default, which is the likeliest way a cap
      // comes back. The astral fixture below is what actually reds that.
      expect(escapeUnsafeDisplayChars.length).toBe(1);
      const astral = "a".repeat(254) + "\u{1F600}" + "x";
      const out = escapeUnsafeDisplayChars(astral);
      expect(out).toBe(astral);
      expect(out.isWellFormed()).toBe(true);
    });
  });
});
