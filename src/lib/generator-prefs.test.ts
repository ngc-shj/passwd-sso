import { describe, expect, it } from "vitest";
import {
  buildSymbolString,
  SYMBOL_GROUPS,
  DEFAULT_SYMBOL_GROUPS,
  type SymbolGroupFlags,
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
