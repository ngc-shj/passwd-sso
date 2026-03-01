import { describe, expect, it } from "vitest";
import {
  buildSymbolString,
  buildEffectiveCharset,
  SYMBOL_GROUPS,
  DEFAULT_SYMBOL_GROUPS,
  DEFAULT_GENERATOR_SETTINGS,
  AMBIGUOUS_CHARS,
  type SymbolGroupFlags,
  type EffectiveCharsetOptions,
} from "./generator-prefs";

describe("buildSymbolString", () => {
  it("returns empty string when all groups disabled", () => {
    expect(buildSymbolString(DEFAULT_SYMBOL_GROUPS)).toBe("");
  });

  it("returns single group characters when one group enabled", () => {
    const flags: SymbolGroupFlags = {
      ...DEFAULT_SYMBOL_GROUPS,
      hashEtc: true,
    };
    expect(buildSymbolString(flags)).toBe(SYMBOL_GROUPS.hashEtc);
  });

  it("concatenates multiple enabled groups", () => {
    const flags: SymbolGroupFlags = {
      ...DEFAULT_SYMBOL_GROUPS,
      punctuation: true,
      brackets: true,
    };
    const result = buildSymbolString(flags);
    expect(result).toContain(SYMBOL_GROUPS.punctuation);
    expect(result).toContain(SYMBOL_GROUPS.brackets);
    expect(result).toBe(SYMBOL_GROUPS.punctuation + SYMBOL_GROUPS.brackets);
  });

  it("includes all groups when all enabled", () => {
    const allEnabled: SymbolGroupFlags = {
      hashEtc: true,
      punctuation: true,
      quotes: true,
      slashDash: true,
      mathCompare: true,
      brackets: true,
    };
    const result = buildSymbolString(allEnabled);
    for (const key of Object.keys(SYMBOL_GROUPS) as (keyof typeof SYMBOL_GROUPS)[]) {
      expect(result).toContain(SYMBOL_GROUPS[key]);
    }
  });
});

describe("DEFAULT_GENERATOR_SETTINGS", () => {
  it("includes includeChars and excludeChars as empty strings", () => {
    expect(DEFAULT_GENERATOR_SETTINGS.includeChars).toBe("");
    expect(DEFAULT_GENERATOR_SETTINGS.excludeChars).toBe("");
  });
});

describe("buildEffectiveCharset", () => {
  const base: EffectiveCharsetOptions = {
    uppercase: false,
    lowercase: false,
    numbers: false,
    symbols: "",
    excludeAmbiguous: false,
    includeChars: "",
    excludeChars: "",
  };

  it("returns 26 characters when uppercase only", () => {
    const charset = buildEffectiveCharset({ ...base, uppercase: true });
    expect(charset).toHaveLength(26);
    expect(charset).toContain("A");
    expect(charset).toContain("Z");
  });

  it("returns 36 characters when lowercase + numbers", () => {
    const charset = buildEffectiveCharset({ ...base, lowercase: true, numbers: true });
    expect(charset).toHaveLength(36);
  });

  it("adds includeChars not already in charset", () => {
    const charset = buildEffectiveCharset({ ...base, uppercase: true, includeChars: "!@" });
    expect(charset).toHaveLength(28); // 26 + 2
    expect(charset).toContain("!");
    expect(charset).toContain("@");
  });

  it("does not increase charset size when includeChars overlap existing", () => {
    const charset = buildEffectiveCharset({ ...base, uppercase: true, includeChars: "ABC" });
    expect(charset).toHaveLength(26); // A, B, C already in uppercase
  });

  it("removes excludeChars from charset", () => {
    const charset = buildEffectiveCharset({ ...base, uppercase: true, excludeChars: "ABC" });
    expect(charset).toHaveLength(23); // 26 - 3
    expect(charset).not.toContain("A");
    expect(charset).not.toContain("B");
    expect(charset).not.toContain("C");
  });

  it("removes ambiguous characters when excludeAmbiguous is true", () => {
    const charset = buildEffectiveCharset({ ...base, uppercase: true, lowercase: true, numbers: true, excludeAmbiguous: true });
    for (const ch of AMBIGUOUS_CHARS) {
      expect(charset).not.toContain(ch);
    }
  });

  it("handles excludeChars and excludeAmbiguous together without double counting", () => {
    // "O" is ambiguous; adding it to excludeChars should not cause issues
    const charset = buildEffectiveCharset({
      ...base,
      uppercase: true,
      excludeAmbiguous: true,
      excludeChars: "OAB",
    });
    expect(charset).not.toContain("O");
    expect(charset).not.toContain("A");
    expect(charset).not.toContain("B");
    // "I" is ambiguous, should also be excluded
    expect(charset).not.toContain("I");
  });

  it("returns only includeChars when all types are off", () => {
    const charset = buildEffectiveCharset({ ...base, includeChars: "xyz" });
    expect(charset).toBe("xyz");
  });

  it("returns same charset with empty includeChars and excludeChars", () => {
    const withFields = buildEffectiveCharset({ ...base, uppercase: true, includeChars: "", excludeChars: "" });
    const withoutFields = buildEffectiveCharset({ ...base, uppercase: true });
    expect(withFields).toBe(withoutFields);
  });
});
